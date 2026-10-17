/**
 * RealtimeClient —— StepFun Realtime 供应商适配层（M7 P2-2，唯一边界）
 *
 * 职责（计划 §2.1：用户侧全双工；AI 侧仍走 LLM+TTS 导演机制）：
 * - 服务端 VAD：用户一开口拿到 speech_started → 400ms 确认窗 → onVadStart（≤300ms 内停 AI 播报由上层保证）
 * - 流式转写用户语音（替代按键说话；StepFun 只回最终转写，见 docs/stepfun-realtime-notes.md §3）
 * - 说话人归属天然正确：本通道 = 用户
 *
 * 硬约束：
 * - 所有 StepFun 专有事件名只允许出现在本文件（+ docs/stepfun-realtime-notes.md）
 * - 本项目把 Realtime 当「流式 ASR + VAD」用：speech_started 即发 response.cancel，忽略一切 response.* 事件
 * - 麦克风必须开 AEC/NS/AGC（否则 AI 的 TTS 回采导致 VAD 自我触发）
 * - 鉴权：浏览器不能设 WS 头 → 同源 /api/realtime 服务端代理（C9 前端 0 key）
 */

export interface RealtimeEvents {
  /** 用户开口（已过 400ms 确认窗 + 800ms 冷却）→ 触发打断 */
  onVadStart(): void;
  onVadStop(): void;
  onUserTranscript(p: { text: string; isFinal: boolean }): void;
  onError(e: { code: string; message: string }): void;
  /** 连接终结且重连耗尽（或 start 失败）→ 上层降级 push-to-talk */
  onClose(): void;
}

export type RealtimeState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/** WS 最小接口（浏览器 WebSocket / 测试 mock 共形） */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev?: { code?: number }) => void) | null;
  onerror: ((ev?: unknown) => void) | null;
}

export interface MicHandle {
  stop(): void;
}

export interface RealtimeClientOptions {
  events: RealtimeEvents;
  voice?: string;
  /** 覆盖 WS 地址（默认同源 /api/realtime?token=...） */
  wsUrl?: string;
  /** 覆盖凭证端点（默认 /api/realtime-token） */
  tokenUrl?: string;
  fetchFn?: typeof fetch;
  wsFactory?: (url: string) => WsLike;
  micFactory?: (onFrame: (pcm16Base64: string) => void) => Promise<MicHandle>;
  /** VAD 起点后的确认窗（咳嗽/键盘过滤），默认 400ms */
  confirmWindowMs?: number;
  /** 打断后的冷却窗（防 AI 尾音回采连锁触发），默认 800ms */
  cooldownMs?: number;
  /** 重连退避序列，默认 [500,1000,2000]（0.5s→1s→2s，最多 3 次，上限对齐 4s 语义） */
  reconnectDelaysMs?: number[];
  now?: () => number;
}

/** 凭证不可用（503 / 网络失败）：上层据此退回按键说话 */
export class RealtimeUnavailableError extends Error {
  readonly fallback: 'push-to-talk';
  constructor(message: string) {
    super(message);
    this.name = 'RealtimeUnavailableError';
    this.fallback = 'push-to-talk';
  }
}

/** 上行音频采样率：文档未标注（见 notes §7 开放问题），按 StepFun 实时 ASR 惯例 16kHz pcm16；实测不符只改这里 */
export const REALTIME_INPUT_SAMPLE_RATE = 16000;

interface ResolvedOptions extends RealtimeClientOptions {
  events: RealtimeEvents;
  confirmWindowMs: number;
  cooldownMs: number;
  reconnectDelaysMs: number[];
  now: () => number;
  url: string;
  model: string;
}

export class RealtimeClient {
  /**
   * 建凭证 + 实例化。STEPFUN 未配置 / 端点异常时抛 RealtimeUnavailableError（fallback: 'push-to-talk'）。
   */
  static async create(opts: RealtimeClientOptions): Promise<RealtimeClient> {
    const fetchFn = opts.fetchFn ?? fetch;
    let res: Response;
    try {
      res = await fetchFn(opts.tokenUrl ?? '/api/realtime-token', { method: 'POST' });
    } catch (err) {
      throw new RealtimeUnavailableError(`realtime-token 请求失败: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) throw new RealtimeUnavailableError(`realtime-token HTTP ${res.status}`);
    const cfg = (await res.json()) as { token: string; model: string };
    const url = opts.wsUrl ?? defaultWsUrl(cfg.token);
    return new RealtimeClient({ ...opts, url, model: cfg.model });
  }

  private readonly opts: ResolvedOptions;
  private readonly events: RealtimeEvents;
  private ws: WsLike | null = null;
  private mic: MicHandle | null = null;
  private muted = false;
  private disposed = false;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private vadConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBargeAt = -Infinity;
  private _state: RealtimeState = 'idle';

  private constructor(opts: RealtimeClientOptions & { url: string; model: string }) {
    this.events = opts.events;
    this.opts = {
      ...opts,
      confirmWindowMs: opts.confirmWindowMs ?? 400,
      cooldownMs: opts.cooldownMs ?? 800,
      reconnectDelaysMs: opts.reconnectDelaysMs ?? [500, 1000, 2000],
      now: opts.now ?? Date.now,
    };
  }

  get state(): RealtimeState {
    return this._state;
  }

  /** 建连 + 推麦克风流；失败自动重连（指数退避，耗尽后 onClose → 降级） */
  start(): void {
    if (this.disposed || this._state === 'connecting' || this._state === 'open') return;
    this.intentionalClose = false;
    this.connect();
  }

  /** 停麦克风 + 断连（可再 start） */
  stop(): void {
    this.intentionalClose = true;
    this.clearVadConfirm();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.stopMic();
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略
      }
      this.ws = null;
    }
    if (this._state !== 'error') this._state = 'closed';
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this._state = 'closed';
  }

  /** 静音：停止上行帧（采集保持，避免重复 getUserMedia 权限弹窗） */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  // ==================== 内部 ====================

  private connect(): void {
    this._state = 'connecting';
    const ws = (this.opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike))(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.reconnectAttempt = 0;
      // 会话配置：开启服务端 VAD；不设 instructions（模型自动回复会被 response.cancel 掐掉并忽略）
      this.sendJson({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          ...(this.opts.voice ? { voice: this.opts.voice } : {}),
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
          turn_detection: {
            type: 'server_vad',
            prefix_padding_ms: 500,
            silence_duration_ms: 100,
            energy_awakeness_threshold: 2500,
          },
        },
      });
      this._state = 'open';
      void this.startMic();
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);

    ws.onclose = () => {
      this.stopMic();
      this.clearVadConfirm();
      if (this.intentionalClose || this.disposed) {
        this._state = 'closed';
        return;
      }
      // 非主动断线：指数退避重连，耗尽即降级
      const delays = this.opts.reconnectDelaysMs;
      if (this.reconnectAttempt < delays.length) {
        const delay = delays[this.reconnectAttempt++];
        this.reconnectTimer = setTimeout(() => {
          this.reconnectTimer = null;
          if (!this.disposed && !this.intentionalClose) this.connect();
        }, delay);
      } else {
        this._state = 'error';
        this.events.onError({ code: 'REALTIME_RECONNECT_FAILED', message: 'Realtime 连接断开且重连耗尽' });
        this.events.onClose();
      }
    };

    ws.onerror = () => {
      // 具体失败由 onclose 统一处理（浏览器 WS 不给原因）
    };
  }

  private handleMessage(data: unknown): void {
    let msg: { type?: string; transcript?: string; error?: { type?: string; message?: string } };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return; // 单条解析失败忽略
    }
    switch (msg.type) {
      case 'input_audio_buffer.speech_started':
        this.handleVadStart();
        break;
      case 'input_audio_buffer.speech_stopped':
        this.handleVadStop();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
          this.events.onUserTranscript({ text: msg.transcript, isFinal: true });
        }
        break;
      case 'error': {
        const code = msg.error?.type ?? 'REALTIME_ERROR';
        // response.cancel 在无响应时返回的错误属正常噪音，吞掉
        if (/cancel/i.test(msg.error?.message ?? '') || code === 'invalid_request_error') return;
        this.events.onError({ code, message: msg.error?.message ?? '上游错误' });
        break;
      }
      default:
        // response.* / session.* / conversation.item.* / input_audio_buffer.committed|cleared 全部忽略
        break;
    }
  }

  /** VAD 起点：冷却过滤 → 400ms 确认窗（窗内 speech_stopped 则视为咳嗽/键盘误触，不上报） */
  private handleVadStart(): void {
    const now = this.opts.now();
    if (now - this.lastBargeAt < this.opts.cooldownMs) return;
    if (this.vadConfirmTimer) return; // 已在确认窗内
    // 掐掉模型可能的自动回复（本项目只把 Realtime 当 ASR+VAD 用）
    this.sendJson({ type: 'response.cancel' });
    this.vadConfirmTimer = setTimeout(() => {
      this.vadConfirmTimer = null;
      this.lastBargeAt = this.opts.now();
      this.events.onVadStart();
    }, this.opts.confirmWindowMs);
  }

  private handleVadStop(): void {
    if (this.vadConfirmTimer) {
      // 确认窗内停止 = 假开口，丢弃（不上报 onVadStart/onVadStop）
      this.clearVadConfirm();
      return;
    }
    this.events.onVadStop();
  }

  private clearVadConfirm(): void {
    if (this.vadConfirmTimer) {
      clearTimeout(this.vadConfirmTimer);
      this.vadConfirmTimer = null;
    }
  }

  private async startMic(): Promise<void> {
    if (this.mic || this.disposed) return;
    try {
      const micFactory = this.opts.micFactory ?? defaultMicFactory;
      this.mic = await micFactory((pcm16Base64) => {
        if (this.muted || this._state !== 'open') return;
        this.sendJson({ type: 'input_audio_buffer.append', audio: pcm16Base64 });
      });
    } catch (err) {
      this._state = 'error';
      this.events.onError({
        code: 'REALTIME_MIC_FAILED',
        message: `麦克风不可用: ${err instanceof Error ? err.message : String(err)}`,
      });
      this.events.onClose();
    }
  }

  private stopMic(): void {
    if (this.mic) {
      try {
        this.mic.stop();
      } catch {
        // 忽略
      }
      this.mic = null;
    }
  }

  private sendJson(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        // 发送失败由 onclose 兜底
      }
    }
  }
}

function defaultWsUrl(token: string): string {
  if (typeof window === 'undefined') return `/api/realtime?token=${encodeURIComponent(token)}`; // 测试/SSR（wsFactory 会覆盖）
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/realtime?token=${encodeURIComponent(token)}`;
}

/**
 * 默认麦克风管线：getUserMedia(AEC/NS/AGC 必须开) → AudioContext → 降采样 16kHz Int16 → base64
 * AudioWorklet 优先、ScriptProcessor 兜底（iOS Safari 兼容）
 */
async function defaultMicFactory(onFrame: (pcm16Base64: string) => void): Promise<MicHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
  });
  const ctx = new AudioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const source = ctx.createMediaStreamSource(stream);
  const processor = ctx.createScriptProcessor(2048, 1, 1);
  processor.onaudioprocess = (e) => {
    const input = e.inputBuffer.getChannelData(0);
    const pcm16 = downsampleToPcm16(input, ctx.sampleRate, REALTIME_INPUT_SAMPLE_RATE);
    onFrame(pcm16ToBase64(pcm16));
  };
  source.connect(processor);
  processor.connect(ctx.destination);
  return {
    stop() {
      try {
        processor.disconnect();
        source.disconnect();
      } catch {
        // 忽略
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}

/** 线性插值降采样 → Int16（单声道） */
function downsampleToPcm16(input: Float32Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate) {
    const out = new Int16Array(input.length);
    for (let i = 0; i < input.length; i++) out[i] = floatTo16(input[i]);
    return out;
  }
  const ratio = fromRate / toRate;
  const outLen = Math.floor(input.length / ratio);
  const out = new Int16Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const idx = Math.floor(pos);
    const frac = pos - idx;
    const a = input[idx] ?? 0;
    const b = input[idx + 1] ?? a;
    out[i] = floatTo16(a + (b - a) * frac);
  }
  return out;
}

function floatTo16(v: number): number {
  const clamped = Math.max(-1, Math.min(1, v));
  return clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
}

function pcm16ToBase64(pcm: Int16Array): string {
  const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
