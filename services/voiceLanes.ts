/**
 * VoiceLanePool —— 按音色分路的 StepFun Realtime 播报池。
 *
 * 官方约束（platform.stepfun.com/docs/zh/api-reference/realtime/chat）：
 * session.update 除 voice 外可随时改；voice 只能在建会话时指定，之后不可更新。
 * 因此「不同的人、不同的音色」不能靠一条 WS 中途换 voice，必须一人一条锁定音色的连接。
 *
 * 分工：
 * - 用户侧全双工（麦克风 / VAD / 转写 / 打断）仍由 RealtimeClient 一条耳朵连接负责。
 * - 本池只播报：不推麦克风，不开启 server_vad，避免分路自己开口回答。
 * - 后期音色克隆：把 create-voice 返回的 voice id 填进 RoleCard.voice.voice_id，
 *   本池原样写入建连时的 session.update.voice，不需要改协议。
 */

import { RealtimePlayback } from './realtimePlayback.ts';
import type { WsLike } from './realtimeClient.ts';

export interface LaneSpeakOptions {
  speakerName: string;
  /** LLM 的 stepfun_tts_instruction，写进口播指令，不改锁定音色 */
  instruction?: string | null;
}

export interface VoiceLaneEvents {
  onPlaybackChange?(speaking: boolean, voiceId: string): void;
  onError?(e: { code: string; message: string; voiceId: string }): void;
}

export interface VoiceLanePoolOptions {
  voices: string[];
  events?: VoiceLaneEvents;
  tokenUrl?: string;
  /** 测试注入：已带 token 的 WS 地址，跳过凭证请求 */
  wsUrl?: string;
  fetchFn?: typeof fetch;
  wsFactory?: (url: string) => WsLike;
  playbackFactory?: () => Pick<RealtimePlayback, 'enqueue' | 'stop' | 'playing' | 'dispose' | 'getPlaybackAnalyser'>;
}

export class VoiceLaneUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'VoiceLaneUnavailableError';
  }
}

/** 分路口播指令：点名说话人，禁止模型改写或串到别人的口吻。 */
export function buildLaneScript(speakerName: string, text: string, instruction?: string | null): string {
  const tone = instruction?.trim() ? `语气：${instruction.trim()}。` : '';
  return (
    `【台词播报】说话人：${speakerName}。${tone}` +
    '请用当前会话已锁定的音色，用自然口语逐字读出下面这段台词，一字不差，不要添加、解释、改写，也不要换成其他人的口吻：\n' +
    text
  );
}

interface LanePlayback {
  enqueue(base64: string): void;
  stop(): void;
  readonly playing: boolean;
  dispose(): void;
  getPlaybackAnalyser(): AnalyserNode | null;
}

class VoiceLane {
  readonly voiceId: string;
  private ws: WsLike | null = null;
  private readonly playback: LanePlayback;
  private pending: { text: string; opts: LaneSpeakOptions }[] = [];
  private opened = false;
  private disposed = false;

  constructor(
    voiceId: string,
    private readonly url: string,
    private readonly events: VoiceLaneEvents,
    private readonly wsFactory: (url: string) => WsLike,
    playbackFactory: () => LanePlayback
  ) {
    this.voiceId = voiceId;
    this.playback = playbackFactory();
  }

  start(): void {
    if (this.disposed || this.ws) return;
    const ws = this.wsFactory(this.url);
    this.ws = ws;
    ws.onopen = () => {
      this.opened = true;
      this.send({
        type: 'session.update',
        session: {
          modalities: ['text', 'audio'],
          instructions:
            '你是面试室里一条已锁定音色的播报分路。不要自行回答用户，不要切换人设。' +
            '只有收到以【台词播报】开头、且说话人与本分路一致的消息时，才逐字读出台词。',
          voice: this.voiceId,
          input_audio_format: 'pcm16',
          output_audio_format: 'pcm16',
        },
      });
      const queued = this.pending.splice(0);
      const last = queued[queued.length - 1];
      if (last) this.emitSpeak(last.text, last.opts);
    };
    ws.onmessage = (ev) => this.onMessage(ev.data);
    ws.onclose = () => {
      this.opened = false;
      if (!this.disposed) this.events.onError?.({ code: 'LANE_CLOSED', message: '音色分路断开', voiceId: this.voiceId });
    };
    ws.onerror = () => undefined;
  }

  speak(text: string, opts: LaneSpeakOptions): void {
    if (this.disposed) return;
    if (!this.opened) {
      this.pending.push({ text, opts });
      this.start();
      return;
    }
    this.emitSpeak(text, opts);
  }

  cancel(): void {
    this.pending = [];
    if (this.opened) this.send({ type: 'response.cancel' });
    this.playback.stop();
    this.events.onPlaybackChange?.(false, this.voiceId);
  }

  dispose(): void {
    this.disposed = true;
    this.cancel();
    try {
      this.ws?.close();
    } catch {
      // 忽略
    }
    this.ws = null;
    this.playback.dispose();
  }

  get analyser(): AnalyserNode | null {
    return this.playback.getPlaybackAnalyser();
  }

  private emitSpeak(text: string, opts: LaneSpeakOptions): void {
    this.send({ type: 'response.cancel' });
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: buildLaneScript(opts.speakerName, text, opts.instruction) }],
      },
    });
    this.send({ type: 'response.create' });
  }

  private onMessage(data: unknown): void {
    let msg: { type?: string; delta?: string; error?: { type?: string; message?: string } };
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }
    switch (msg.type) {
      case 'response.audio.delta':
        if (msg.delta) {
          this.playback.enqueue(msg.delta);
          this.events.onPlaybackChange?.(true, this.voiceId);
        }
        break;
      case 'response.done':
      case 'response.audio.done':
        if (!this.playback.playing) this.events.onPlaybackChange?.(false, this.voiceId);
        break;
      case 'error': {
        const code = msg.error?.type ?? 'LANE_ERROR';
        if (/cancel/i.test(msg.error?.message ?? '') || code === 'invalid_request_error') return;
        this.events.onError?.({ code, message: msg.error?.message ?? '分路上游错误', voiceId: this.voiceId });
        break;
      }
      default:
        break;
    }
  }

  private send(obj: Record<string, unknown>): void {
    if (this.ws && this.ws.readyState === 1) {
      try {
        this.ws.send(JSON.stringify(obj));
      } catch {
        // 发送失败由 onclose 上报
      }
    }
  }
}

export class VoiceLanePool {
  static async create(opts: VoiceLanePoolOptions): Promise<VoiceLanePool> {
    const voices = [...new Set(opts.voices.map((v) => v.trim()).filter(Boolean))];
    if (voices.length === 0) throw new VoiceLaneUnavailableError('没有可锁定的音色');
    const url = opts.wsUrl ?? (await fetchLaneUrl(opts.fetchFn ?? fetch, opts.tokenUrl ?? '/api/realtime-token'));
    return new VoiceLanePool(voices, url, opts);
  }

  private readonly lanes = new Map<string, VoiceLane>();
  private activeVoiceId: string | null = null;

  private constructor(voices: string[], url: string, opts: VoiceLanePoolOptions) {
    const wsFactory = opts.wsFactory ?? ((u: string) => new WebSocket(u) as unknown as WsLike);
    const playbackFactory =
      opts.playbackFactory ??
      (() => {
        const playback = new RealtimePlayback();
        return {
          enqueue: (b: string) => playback.enqueue(b),
          stop: () => playback.stop(),
          get playing() {
            return playback.playing;
          },
          dispose: () => playback.dispose(),
          getPlaybackAnalyser: () => playback.getPlaybackAnalyser(),
        };
      });
    const events = opts.events ?? {};
    for (const voiceId of voices) {
      const lane = new VoiceLane(voiceId, url, {
        onPlaybackChange: (speaking, id) => {
          if (speaking) this.activeVoiceId = id;
          else if (this.activeVoiceId !== id) return;
          else this.activeVoiceId = null;
          events.onPlaybackChange?.(speaking, id);
        },
        onError: (e) => events.onError?.(e),
      }, wsFactory, playbackFactory);
      lane.start();
      this.lanes.set(voiceId, lane);
    }
  }

  has(voiceId: string): boolean {
    return this.lanes.has(voiceId);
  }

  /**
   * 把台词送到该音色的分路。未知音色返回 false，调用方退回按 voice_id 的 TTS。
   * 开播前取消其他分路，保证同一时刻只有一个说话人出声。
   */
  speak(voiceId: string, text: string, opts: LaneSpeakOptions): boolean {
    const line = text.trim();
    const lane = this.lanes.get(voiceId);
    if (!line || !lane) return false;
    for (const [id, other] of this.lanes) {
      if (id !== voiceId) other.cancel();
    }
    this.activeVoiceId = voiceId;
    lane.speak(line, opts);
    return true;
  }

  cancelAll(): void {
    for (const lane of this.lanes.values()) lane.cancel();
    this.activeVoiceId = null;
  }

  getPlaybackAnalyser(): AnalyserNode | null {
    if (!this.activeVoiceId) return null;
    return this.lanes.get(this.activeVoiceId)?.analyser ?? null;
  }

  dispose(): void {
    for (const lane of this.lanes.values()) lane.dispose();
    this.lanes.clear();
    this.activeVoiceId = null;
  }
}

async function fetchLaneUrl(fetchFn: typeof fetch, tokenUrl: string): Promise<string> {
  let res: Response;
  try {
    res = await fetchFn(tokenUrl, { method: 'POST' });
  } catch (err) {
    throw new VoiceLaneUnavailableError(`realtime-token 请求失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res.ok) throw new VoiceLaneUnavailableError(`realtime-token HTTP ${res.status}`);
  const cfg = (await res.json()) as { token?: string };
  if (!cfg.token) throw new VoiceLaneUnavailableError('realtime-token 缺少 token');
  return defaultLaneUrl(cfg.token);
}

function defaultLaneUrl(token: string): string {
  if (typeof window === 'undefined') return `/api/realtime?token=${encodeURIComponent(token)}`;
  const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${window.location.host}/api/realtime?token=${encodeURIComponent(token)}`;
}
