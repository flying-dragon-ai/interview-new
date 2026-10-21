/**
 * RealtimeClient —— StepFun Realtime 供应商适配层（M8：全面切换实时对话，唯一语音通道）
 *
 * 职责（全面切换后 = 双向全双工）：
 * - 用户侧：服务端 VAD（speech_started → 400ms 确认窗 → onVadStart ≤300ms 停 AI 播报）
 *   + 流式最终转写（conversation.item.input_audio_transcription.completed）
 * - AI 侧：导演台词注入（speak → conversation.item.create + response.create）
 *   → 模型语音回复 response.audio.delta（pcm16）→ RealtimePlayback 播放
 *   → response.audio_transcript.delta/done 字幕（可选消费）
 * - 模型自由发挥被抑制：speech_started 即 response.cancel（掐掉对用户语音的自动回复），
 *   台词播报通过 response.create 显式触发
 *
 * 硬约束：
 * - 所有 StepFun 专有事件名只允许出现在本文件（+ docs/stepfun-realtime-notes.md）
 * - 麦克风必须开 AEC/NS/AGC（否则 AI 语音回采导致 VAD 自我触发）
 * - 鉴权：浏览器不能设 WS 头 → 同源 /api/realtime 服务端代理（C9 前端 0 key）
 */

import { int16ArrayToBase64 } from './binary.ts';
import { RealtimePlayback } from './realtimePlayback.ts';

export interface RealtimeEvents {
  /** 用户开口（已过 400ms 确认窗 + 800ms 冷却）→ 触发打断 */
  onVadStart(): void;
  onVadStop(): void;
  onUserTranscript(p: { text: string; isFinal: boolean }): void;
  onError(e: { code: string; message: string }): void;
  /** 连接终结且重连耗尽（或 start 失败）→ 上层降级 push-to-talk */
  onClose(): void;
  /** AI 语音字幕流（response.audio_transcript.delta） */
  onAssistantTextDelta?(text: string): void;
  /** AI 语音字幕完结（response.audio_transcript.done） */
  onAssistantTextDone?(text: string): void;
  /** AI 播放态变化（开始/排空/被打断）——上层驱动 speakingCharId */
  onPlaybackChange?(speaking: boolean): void;
  /** 连接已 open 且 session.update 已发出（嘴会话用来冲刷排队台词） */
  onOpen?(): void;
}
export type RealtimeState = 'idle' | 'connecting' | 'open' | 'closed' | 'error';

/**
 * duplex：单连接双向（历史默认，耳+嘴同一把声音）
 * ear：只听用户（麦克风 + VAD + 转写），丢弃模型音频
 * mouth：只播某一把音色，不采集麦克风，不开启 VAD
 */
export type RealtimeChannel = 'duplex' | 'ear' | 'mouth';

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
  /** AI 台词播报指令（session.update instructions；缺省为逐字播报指令） */
  instructions?: string;
  /** 连接角色。缺省 duplex，保持单连接行为。 */
  channel?: RealtimeChannel;
  /** 播放器工厂（测试注入；默认 RealtimePlayback） */
  playbackFactory?: () => RealtimePlayback;
  /** VAD 起点后的确认窗（咳嗽/键盘过滤），默认 400ms */
  confirmWindowMs?: number;
  /** 打断后的冷却窗（防 AI 尾音回采连锁触发），默认 800ms */
  cooldownMs?: number;
  /** 重连退避序列，默认 [500,1000,2000]（0.5s→1s→2s，最多 3 次，上限对齐 4s 语义） */
  reconnectDelaysMs?: number[];
  /** 初始建连失败后的快速重试延迟，默认 400ms（生产无 WS 端点时 ≤1s 降级，不拖常规退避） */
  initialRetryMs?: number;
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
/**
 * 台词播报默认指令（session.update instructions）：
 * 告知模型自身是「面试室语音通道」，日常用户语音输入不回话（response.cancel 兜底），
 * 仅在收到【台词播报】指令时逐字读出台词。
 */
export const DEFAULT_BROADCAST_INSTRUCTIONS =
  '你是面试室的语音播报通道。用户说话时你不要自行回答或展开（系统会取消你的回复）。' +
  '只有当收到以【台词播报】开头的用户消息时，把其中的台词用自然、清晰的口语逐字读出，保持原语言与原语气，一字不差。';

/** 耳会话人设：只做听写，不生成可播放的回答 */
export const DEFAULT_EAR_INSTRUCTIONS =
  '你是面试室的听写通道，只负责感知用户是否在说话。不要回答，不要播报，不要展开任何内容。';

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
  private readonly playback: RealtimePlayback;
  private muted = false;
  private disposed = false;
  private intentionalClose = false;
  private reconnectAttempt = 0;
  /** 至少成功建连一次（决定 close 后走常规退避还是快速降级） */
  private everOpened = false;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private vadConfirmTimer: ReturnType<typeof setTimeout> | null = null;
  private lastBargeAt = -Infinity;
  private _state: RealtimeState = 'idle';
  private readonly channel: RealtimeChannel;
  /** 晚绑定：多音色路由在耳会话建好后挂上，用于开口瞬间停掉其他嘴 */
  private localBargeHandler: (() => void) | null = null;

  private constructor(opts: RealtimeClientOptions & { url: string; model: string }) {
    this.events = opts.events;
    this.channel = opts.channel ?? 'duplex';
    this.playback = (opts.playbackFactory ?? (() => new RealtimePlayback()))();
    this.opts = {
      ...opts,
      confirmWindowMs: opts.confirmWindowMs ?? 400,
      cooldownMs: opts.cooldownMs ?? 800,
      reconnectDelaysMs: opts.reconnectDelaysMs ?? [500, 1000, 2000],
      initialRetryMs: opts.initialRetryMs ?? 400,
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
    this.playback.stop();
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
    this.playback.dispose();
  }
  /** 静音：停止上行帧（采集保持，避免重复 getUserMedia 权限弹窗） */
  setMuted(muted: boolean): void {
    this.muted = muted;
  }

  /**
   * 用户开口瞬间的额外回调（确认窗之前）。
   * 多音色路由用它同步停掉其他 voice 会话，不把 StepFun 事件名泄漏到路由层。
   */
  setLocalBargeHandler(handler: (() => void) | null): void {
    this.localBargeHandler = handler;
  }

  // ==================== AI 台词播报（全面切换实时对话 M8） ====================

  /**
   * 导演台词注入：conversation.item.create（user 文本，含逐字播报指令）→ response.create。
   * 模型以语音回复（response.audio.delta），本类直接入队播放；字幕经 onAssistantTextDelta/Done 上抛。
   * 非连接态静默丢弃（上层经 state 判断，降级链路接管）。
   */
  speak(text: string): void {
    const line = text.trim();
    if (!line) return;
    this.sendJson({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: `【台词播报】请用自然口语逐字读出下面这段台词，一字不差，不要添加、解释或改写任何内容：\n${line}` }],
      },
    });
    this.sendJson({ type: 'response.create' });
  }

  /** AI 是否正在播报（播放队列未排空） */
  isAIPlaying(): boolean {
    return this.playback.playing;
  }

  /** 手动停止 AI 播报（dock 打断按钮 / 文字消息 barge-in 复用） */
  stopAISpeech(): void {
    this.sendJson({ type: 'response.cancel' });
    if (this.playback.playing) {
      this.playback.stop();
      this.events.onPlaybackChange?.(false);
    }
  }

  /** 播放分析器（口型/灯光律动；无播放器/无 AudioContext 时回落 VoiceService 侧） */
  getPlaybackAnalyser(): AnalyserNode | null {
    return this.playback.getPlaybackAnalyser();
  }

  // ==================== 内部 ====================

  private connect(): void {
    this._state = 'connecting';
    const ws = (this.opts.wsFactory ?? ((url: string) => new WebSocket(url) as unknown as WsLike))(this.opts.url);
    this.ws = ws;

    ws.onopen = () => {
      this.everOpened = true;
      this.reconnectAttempt = 0;
      // 会话配置：开启服务端 VAD + 台词播报指令（AI 语音走 response.audio，模型自由发挥被 response.cancel 抑制）
      const session: Record<string, unknown> = {
        modalities: ['text', 'audio'],
        instructions:
          this.opts.instructions ??
          (this.channel === 'ear' ? DEFAULT_EAR_INSTRUCTIONS : DEFAULT_BROADCAST_INSTRUCTIONS),
        ...(this.opts.voice ? { voice: this.opts.voice } : {}),
        input_audio_format: 'pcm16',
        output_audio_format: 'pcm16',
      };
      // 嘴会话关闭 VAD：不接收麦克风，避免空转推理；文档默认即关闭。
      if (this.channel !== 'mouth') {
        session.turn_detection = {
          type: 'server_vad',
          prefix_padding_ms: 500,
          silence_duration_ms: 100,
          energy_awakeness_threshold: 2500,
        };
      }
      this.sendJson({ type: 'session.update', session });
      this._state = 'open';
      this.events.onOpen?.();
      if (this.channel !== 'mouth') void this.startMic();
    };

    ws.onmessage = (ev) => this.handleMessage(ev.data);

    ws.onclose = () => {
      this.stopMic();
      this.clearVadConfirm();
      if (this.intentionalClose || this.disposed) {
        this._state = 'closed';
        return;
      }
      // 从未成功建连（生产无 WS 端点/断网）：快速重试一次后直接降级，不走 3.5s 常规退避
      if (!this.everOpened) {
        if (this.reconnectAttempt === 0) {
          this.reconnectAttempt = this.opts.reconnectDelaysMs.length; // 不再进入常规退避
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (!this.disposed && !this.intentionalClose) this.connect();
          }, this.opts.initialRetryMs);
          return;
        }
        this._state = 'error';
        this.events.onError({ code: 'REALTIME_RECONNECT_FAILED', message: 'Realtime 初始建连不可达' });
        this.events.onClose();
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
        // 嘴会话不听麦克风，误触发的 VAD 不能取消正在播的台词
        if (this.channel !== 'mouth') this.handleVadStart();
        break;
      case 'input_audio_buffer.speech_stopped':
        // 耳会话在说话结束时再取消一次，掐掉 server VAD 在句尾自动拉起的回复
        if (this.channel === 'ear') this.sendJson({ type: 'response.cancel' });
        this.handleVadStop();
        break;
      case 'conversation.item.input_audio_transcription.completed':
        if (typeof msg.transcript === 'string' && msg.transcript.trim()) {
          this.events.onUserTranscript({ text: msg.transcript, isFinal: true });
        }
        break;
      case 'response.audio.delta':
        // 耳会话的模型音频一律丢弃，避免和嘴会话双声道齐播
        if (this.channel === 'ear') break;
        if (typeof (msg as { delta?: unknown }).delta === 'string' && (msg as { delta: string }).delta) {
          this.playback.enqueue((msg as { delta: string }).delta);
          this.events.onPlaybackChange?.(true);
        }
        break;
      case 'response.audio_transcript.delta':
        if (typeof (msg as { delta?: unknown }).delta === 'string' && (msg as { delta: string }).delta) {
          this.events.onAssistantTextDelta?.((msg as { delta: string }).delta);
        }
        break;
      case 'response.audio_transcript.done':
        this.events.onAssistantTextDone?.(String((msg as { text?: unknown }).text ?? ''));
        break;
      case 'response.done':
        // 一次台词播报结束（音频排空由 playback.onended 兜底，这里同步收敛播放态）
        if (!this.playback.playing) this.events.onPlaybackChange?.(false);
        break;
      case 'error': {
        const code = msg.error?.type ?? 'REALTIME_ERROR';
        // response.cancel 在无响应时返回的错误属正常噪音，吞掉。
        // 其他 invalid_request_error（例如音色 ID 被拒）必须上抛，嘴会话才能降级。
        if (code === 'invalid_request_error' && /cancel/i.test(msg.error?.message ?? '')) return;
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
    // 掐掉模型对用户语音的自动回复（AI 台词经显式 response.create 触发）
    this.sendJson({ type: 'response.cancel' });
    this.localBargeHandler?.();
    if (this.playback.playing) {
      this.playback.stop();
      this.events.onPlaybackChange?.(false);
    }
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
  const emit = (input: Float32Array) => {
    const pcm16 = downsampleToPcm16(input, ctx.sampleRate, REALTIME_INPUT_SAMPLE_RATE);
    onFrame(int16ArrayToBase64(pcm16));
  };

  // AudioWorklet 优先（采集/聚合在音频线程，不与 250ms tick + 视觉帧泵抢主线程）；
  // iOS Safari / 旧环境回退 ScriptProcessor
  let worklet: AudioWorkletNode | null = null;
  try {
    const blob = new Blob([MIC_WORKLET_SOURCE], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    await ctx.audioWorklet.addModule(url);
    URL.revokeObjectURL(url);
    worklet = new AudioWorkletNode(ctx, 'mic-tap');
    worklet.port.onmessage = (e: MessageEvent<Float32Array>) => emit(e.data);
    source.connect(worklet); // 不连 destination：免回采
  } catch {
    worklet = null;
  }

  let processor: ScriptProcessorNode | null = null;
  if (!worklet) {
    processor = ctx.createScriptProcessor(2048, 1, 1);
    processor.onaudioprocess = (e) => emit(e.inputBuffer.getChannelData(0));
    source.connect(processor);
    processor.connect(ctx.destination); // ScriptProcessor 必须入图才回调（AEC 抑制回采）
  }

  return {
    stop() {
      try {
        if (worklet) {
          worklet.port.onmessage = null;
          worklet.disconnect();
        }
        if (processor) {
          processor.onaudioprocess = null;
          processor.disconnect();
        }
        source.disconnect();
      } catch {
        // 忽略
      }
      stream.getTracks().forEach((t) => t.stop());
      void ctx.close().catch(() => undefined);
    },
  };
}

/** AudioWorklet 源码（Blob 注入；2048 样本聚合一帧再 postMessage，降消息频率） */
const MIC_WORKLET_SOURCE = `
class MicTapProcessor extends AudioWorkletProcessor {
  constructor() { super(); this._buf = new Float32Array(2048); this._n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    let i = 0;
    while (i < ch.length) {
      const take = Math.min(ch.length - i, this._buf.length - this._n);
      this._buf.set(ch.subarray(i, i + take), this._n);
      this._n += take; i += take;
      if (this._n === this._buf.length) { this.port.postMessage(this._buf.slice(0)); this._n = 0; }
    }
    return true;
  }
}
registerProcessor('mic-tap', MicTapProcessor);
`;

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

