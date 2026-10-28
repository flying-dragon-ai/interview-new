/**
 * VoiceLanePool —— 按音色分路的 StepFun Realtime 播报池。
 *
 * 官方约束：voice 只能在建会话时指定，之后不可更新。
 * 不同的人、不同的音色不能靠一条连接中途换 voice，必须一把音色一条锁定的连接。
 *
 * 本池是嘴会话的唯一登记处。RealtimeVoiceRouter 管耳会话和「哪个角色在说」，
 * 播报交给这里。每条分路是一个 channel=mouth 的 RealtimeClient：
 * 不推麦克风、不开启 VAD。协议与代理文本帧留在 RealtimeClient，
 * 不再另养一条原始 WebSocket 栈。
 *
 * 复刻音色：把 create-voice 返回的 id 填进 RoleCard.voice.voice_id
 * （或 realtime_voice_id）。调用方解析后放进 voices，本池原样锁定。
 */

import {
  RealtimeClient,
  type RealtimeClientOptions,
  type RealtimeEvents,
} from './realtimeClient.ts';

export interface LaneSpeakOptions {
  speakerName: string;
  /** LLM 的 stepfun_tts_instruction，写进口播指令，不改锁定音色 */
  instruction?: string | null;
}

export interface VoiceLaneEvents {
  onPlaybackChange?(speaking: boolean, voiceId: string): void;
  onError?(e: { code: string; message: string; voiceId: string }): void;
  onClose?(voiceId: string): void;
}

export interface VoiceLanePoolOptions {
  voices: string[];
  events?: VoiceLaneEvents;
  /**
   * 每条分路的建连。缺省为 RealtimeClient.create。
   * 路由器传入会话的 createRealtimeClient，测试即可注入同一套 mock。
   */
  createClient?: (opts: RealtimeClientOptions) => Promise<RealtimeClient>;
  tokenUrl?: string;
  /** 测试注入：已带 token 的 WS 地址，跳过默认地址拼接 */
  wsUrl?: string;
  fetchFn?: typeof fetch;
  wsFactory?: RealtimeClientOptions['wsFactory'];
  playbackFactory?: RealtimeClientOptions['playbackFactory'];
}

/**
 * 嘴分路的致命错误判定：
 * - invalid_request_error：请求本身非法（音色被拒等）→ 重连也没用，摘掉分路
 * - REALTIME_RECONNECT_FAILED：重连耗尽 → 摘掉分路
 * 其余（server_error / rate_limit 等瞬时错误）保留分路，等客户端自身重连。
 */
export function isFatalLaneError(code: string | undefined): boolean {
  if (!code) return false;
  return code === 'invalid_request_error' || code === 'REALTIME_RECONNECT_FAILED';
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

interface Lane {
  client: RealtimeClient;
  pending: { text: string; opts: LaneSpeakOptions } | null;
}

export class VoiceLanePool {
  static async create(opts: VoiceLanePoolOptions): Promise<VoiceLanePool> {
    const voices = [...new Set(opts.voices.map((v) => v.trim()).filter(Boolean))];
    if (voices.length === 0) throw new VoiceLaneUnavailableError('没有可锁定的音色');
    const pool = new VoiceLanePool(opts);
    await pool.open(voices);
    return pool;
  }

  private readonly lanes = new Map<string, Lane>();
  private activeVoiceId: string | null = null;
  private disposed = false;
  private readonly events: VoiceLaneEvents;
  private readonly createClient: (opts: RealtimeClientOptions) => Promise<RealtimeClient>;

  private constructor(opts: VoiceLanePoolOptions) {
    this.events = opts.events ?? {};
    const injected = opts.createClient;
    this.createClient =
      injected ??
      ((clientOpts) =>
        RealtimeClient.create({
          ...clientOpts,
          tokenUrl: opts.tokenUrl,
          wsUrl: opts.wsUrl,
          fetchFn: opts.fetchFn,
          wsFactory: opts.wsFactory,
          playbackFactory: opts.playbackFactory,
        }));
  }

  get size(): number {
    return this.lanes.size;
  }

  has(voiceId: string): boolean {
    return this.lanes.has(voiceId);
  }

  start(): void {
    for (const lane of this.lanes.values()) lane.client.start();
  }

  /**
   * 把台词送到该音色的分路。未知音色、或分路已关闭，返回 false，调用方退回 TTS。
   * 开播前取消其他分路，保证同一时刻只有一个说话人出声。
   * 分路还在握手时先排队，open 后补发最后一句。
   */
  speak(voiceId: string, text: string, opts: LaneSpeakOptions): boolean {
    if (this.disposed) return false;
    const line = text.trim();
    const lane = this.lanes.get(voiceId);
    if (!line || !lane) return false;
    const state = lane.client.state;
    if (state === 'closed' || state === 'error') return false;
    for (const [id, other] of this.lanes) {
      if (id === voiceId) continue;
      other.pending = null;
      other.client.stopAISpeech();
    }
    this.activeVoiceId = voiceId;
    if (state !== 'open') {
      lane.pending = { text: line, opts };
      return true;
    }
    lane.pending = null;
    this.emit(lane, line, opts);
    return true;
  }

  cancelAll(): void {
    for (const lane of this.lanes.values()) {
      lane.pending = null;
      lane.client.stopAISpeech();
    }
    this.activeVoiceId = null;
  }

  /** 丢掉尚未发出的排队台词，不打断已经在播的音频。 */
  releasePending(voiceId: string): void {
    const lane = this.lanes.get(voiceId);
    if (lane) lane.pending = null;
  }

  /** 有排队台词，或任一播放器仍在出声 */
  isPlaying(): boolean {
    for (const lane of this.lanes.values()) {
      if (lane.pending || lane.client.isAIPlaying()) return true;
    }
    return false;
  }

  getPlaybackAnalyser(): AnalyserNode | null {
    if (!this.activeVoiceId) return null;
    return this.lanes.get(this.activeVoiceId)?.client.getPlaybackAnalyser() ?? null;
  }

  drop(voiceId: string): void {
    const lane = this.lanes.get(voiceId);
    if (!lane) return;
    this.lanes.delete(voiceId);
    lane.pending = null;
    if (this.activeVoiceId === voiceId) this.activeVoiceId = null;
    lane.client.dispose();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const voiceId of [...this.lanes.keys()]) this.drop(voiceId);
    this.activeVoiceId = null;
  }

  private async open(voices: string[]): Promise<void> {
    const opened = await Promise.all(
      voices.map(async (voiceId) => {
        try {
          const client = await this.createClient({
            channel: 'mouth',
            voice: voiceId,
            events: this.laneEvents(voiceId),
          });
          return { voiceId, client };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.events.onError?.({ code: 'LANE_UNAVAILABLE', message, voiceId });
          return null;
        }
      })
    );
    for (const item of opened) {
      if (!item) continue;
      if (this.disposed) {
        item.client.dispose();
        continue;
      }
      this.lanes.set(item.voiceId, { client: item.client, pending: null });
    }
  }

  private laneEvents(voiceId: string): RealtimeEvents {
    return {
      onVadStart: () => undefined,
      onVadStop: () => undefined,
      onUserTranscript: () => undefined,
      onOpen: () => this.flush(voiceId),
      onPlaybackChange: (speaking) => {
        if (this.activeVoiceId !== voiceId) return;
        this.events.onPlaybackChange?.(speaking, voiceId);
      },
      onError: (e) => {
        // 只有「不可恢复」的错误才摘掉分路；瞬时错误（server_error 等）交给客户端自身重连，
        // 摘掉 = 该音色整场退回 TTS（听起来像角色中途换了个人说话）
        if (!isFatalLaneError(e.code)) {
          this.events.onError?.({ code: e.code, message: e.message, voiceId });
          return;
        }
        this.forget(voiceId);
        this.events.onError?.({ code: e.code, message: e.message, voiceId });
      },
      onClose: () => {
        if (!this.lanes.has(voiceId)) return;
        this.forget(voiceId);
        this.events.onClose?.(voiceId);
      },
    };
  }

  /** 从池中摘掉分路并断开。先摘再断，避免断开回调把同一条分路处理两次。 */
  private forget(voiceId: string): void {
    const lane = this.lanes.get(voiceId);
    if (!lane) return;
    this.lanes.delete(voiceId);
    lane.pending = null;
    if (this.activeVoiceId === voiceId) this.activeVoiceId = null;
    lane.client.dispose();
  }

  private flush(voiceId: string): void {
    const lane = this.lanes.get(voiceId);
    if (!lane?.pending || lane.client.state !== 'open') return;
    const pending = lane.pending;
    lane.pending = null;
    this.emit(lane, pending.text, pending.opts);
  }

  private emit(lane: Lane, text: string, opts: LaneSpeakOptions): void {
    lane.client.speak(buildLaneScript(opts.speakerName, text, opts.instruction), 'verbatim');
  }
}
