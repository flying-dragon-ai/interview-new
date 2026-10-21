import type { RoleVoice } from '../types.ts';
import { RealtimeClient, type RealtimeClientOptions, type RealtimeEvents } from './realtimeClient.ts';
import { resolveVoiceBinding } from './voiceBinding.ts';

/**
 * 多角色 Realtime 编排：1 条耳会话 + 按音色去重的嘴会话。
 *
 * - 耳：用户麦克风、服务端 VAD、转写。不播角色台词（channel='ear'）。
 * - 嘴：每个不同的 realtime voice id 一条输出会话，turn detection 关闭，不采集麦克风。
 *   同一把声音的多个角色共用一条会话（音色本来就相同）。
 * - 换克隆音色只改角色卡 voice_id / realtime_voice_id，本类按解析结果建会话。
 *
 * 耳会话建连失败 → connect() 抛错，上层整路退回按键说话 + TTS。
 * 某一把嘴会话失败 → 该音色的 speak() 返回 false，上层只把这一句降级到 TTS。
 */

export interface VoiceSpeaker {
  roleId: string;
  voice: Pick<RoleVoice, 'voice_id'> & { realtime_voice_id?: string };
}

export interface RealtimeVoiceRouterOptions {
  speakers: VoiceSpeaker[];
  createClient: (opts: RealtimeClientOptions) => Promise<RealtimeClient>;
  earEvents: RealtimeEvents;
  /** 嘴会话播放态。roleId 为当前被点名播报的角色。 */
  onMouthPlayback?: (roleId: string | null, speaking: boolean) => void;
}

interface PendingLine {
  roleId: string;
  text: string;
}

export class RealtimeVoiceRouter {
  readonly ear: RealtimeClient;
  private readonly mouths = new Map<string, RealtimeClient>();
  private readonly roleToVoice = new Map<string, string>();
  private readonly opts: RealtimeVoiceRouterOptions;
  private activeRoleId: string | null = null;
  private pending: PendingLine | null = null;
  /** speak() 已提交、首包音频尚未到达时也视为在播，避免调度器立刻叠下一位 */
  private armed = false;
  private disposed = false;

  private constructor(ear: RealtimeClient, opts: RealtimeVoiceRouterOptions) {
    this.ear = ear;
    this.opts = opts;
    for (const speaker of opts.speakers) {
      const binding = resolveVoiceBinding(speaker.voice);
      if (!binding.realtimeVoiceId) continue;
      this.roleToVoice.set(speaker.roleId, binding.realtimeVoiceId);
    }
  }

  /**
   * 先建耳（失败即抛），再并行预热本场用到的嘴会话。
   * 预热是为了第一句台词不必再付一次握手延迟。
   */
  static async connect(opts: RealtimeVoiceRouterOptions): Promise<RealtimeVoiceRouter> {
    const ear = await opts.createClient({
      channel: 'ear',
      events: {
        onVadStart: () => opts.earEvents.onVadStart(),
        onVadStop: () => opts.earEvents.onVadStop(),
        onUserTranscript: (p) => opts.earEvents.onUserTranscript(p),
        onError: (e) => opts.earEvents.onError(e),
        onClose: () => opts.earEvents.onClose(),
        onAssistantTextDelta: (t) => opts.earEvents.onAssistantTextDelta?.(t),
        onAssistantTextDone: (t) => opts.earEvents.onAssistantTextDone?.(t),
        // 耳会话不代表任何角色的出声，播放态不上抛。
        onPlaybackChange: () => undefined,
      },
    });
    const router = new RealtimeVoiceRouter(ear, opts);
    // 开口瞬间停掉所有嘴（早于 400ms 确认窗），与单连接 duplex 的停声时机对齐。
    // 测试注入的假客户端可能没有该方法，缺了只影响「确认窗之前」的停声，确认窗之后仍会 stopAll。
    if (typeof ear.setLocalBargeHandler === 'function') {
      ear.setLocalBargeHandler(() => router.stopAll());
    }
    await router.openMouths();
    return router;
  }

  /** 本场实际打开的嘴会话数（按音色去重，失败的不计） */
  get mouthCount(): number {
    return this.mouths.size;
  }

  voiceForRole(roleId: string): string | undefined {
    return this.roleToVoice.get(roleId);
  }

  start(): void {
    this.ear.start();
    for (const mouth of this.mouths.values()) mouth.start();
  }

  /**
   * 把导演台词交给该角色的音色会话。
   * @returns false 表示这把声音没有可用的嘴会话，调用方应走 TTS / 文字降级。
   */
  speak(roleId: string, text: string): boolean {
    if (this.disposed) return false;
    const line = text.trim();
    if (!line) return false;
    const voiceId = this.roleToVoice.get(roleId);
    if (!voiceId) return false;
    const mouth = this.mouths.get(voiceId);
    if (!mouth || mouth.state === 'closed' || mouth.state === 'error' || mouth.state === 'idle') return false;

    for (const [id, other] of this.mouths) {
      if (id !== voiceId) other.stopAISpeech();
    }
    this.activeRoleId = roleId;
    this.armed = true;
    if (mouth.state === 'connecting') {
      this.pending = { roleId, text: line };
      return true;
    }
    this.pending = null;
    mouth.speak(line);
    return true;
  }

  isAIPlaying(): boolean {
    if (this.pending || this.armed) return true;
    for (const mouth of this.mouths.values()) {
      if (mouth.isAIPlaying()) return true;
    }
    return false;
  }

  /**
   * 台词超时兜底：清掉「已提交但没有音频」的占用。
   * 若音频仍在播，isAIPlaying() 仍为 true。
   */
  disarm(roleId: string): void {
    if (this.activeRoleId !== roleId) return;
    this.armed = false;
    this.pending = null;
  }

  /** 打断：取消所有嘴会话的 response，并清空尚未发出的排队台词 */
  stopAll(): void {
    this.pending = null;
    this.armed = false;
    for (const mouth of this.mouths.values()) mouth.stopAISpeech();
  }

  getPlaybackAnalyser(): AnalyserNode | null {
    const voiceId = this.activeRoleId ? this.roleToVoice.get(this.activeRoleId) : undefined;
    const mouth = voiceId ? this.mouths.get(voiceId) : undefined;
    return mouth?.getPlaybackAnalyser() ?? this.ear.getPlaybackAnalyser();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.pending = null;
    this.armed = false;
    this.ear.dispose();
    for (const mouth of this.mouths.values()) mouth.dispose();
    this.mouths.clear();
  }

  private async openMouths(): Promise<void> {
    const voiceIds = [...new Set(this.roleToVoice.values())];
    await Promise.all(
      voiceIds.map(async (voiceId) => {
        try {
          const mouth = await this.opts.createClient({
            channel: 'mouth',
            voice: voiceId,
            events: this.mouthEvents(voiceId),
          });
          if (this.disposed) {
            mouth.dispose();
            return;
          }
          this.mouths.set(voiceId, mouth);
        } catch (err) {
          console.warn(`Realtime 嘴会话不可用（${voiceId}），该音色降级 TTS:`, err instanceof Error ? err.message : err);
        }
      })
    );
  }

  private mouthEvents(voiceId: string): RealtimeEvents {
    return {
      onVadStart: () => undefined,
      onVadStop: () => undefined,
      onUserTranscript: () => undefined,
      onError: (e) => {
        console.warn(`Realtime 嘴会话错误（${voiceId}）:`, e.code, e.message);
        this.dropMouth(voiceId);
      },
      onClose: () => this.dropMouth(voiceId),
      onOpen: () => this.flushPending(voiceId),
      onPlaybackChange: (speaking) => {
        const roleId = this.activeRoleId;
        const activeVoice = roleId ? this.roleToVoice.get(roleId) : undefined;
        if (activeVoice !== voiceId) return;
        if (speaking) {
          this.armed = true;
          this.opts.onMouthPlayback?.(roleId, true);
          return;
        }
        this.armed = false;
        this.opts.onMouthPlayback?.(roleId, false);
      },
    };
  }

  private flushPending(voiceId: string): void {
    const pending = this.pending;
    if (!pending) return;
    if (this.roleToVoice.get(pending.roleId) !== voiceId) return;
    const mouth = this.mouths.get(voiceId);
    if (!mouth || mouth.state !== 'open') return;
    this.pending = null;
    mouth.speak(pending.text);
  }

  private dropMouth(voiceId: string): void {
    const mouth = this.mouths.get(voiceId);
    if (mouth) {
      this.mouths.delete(voiceId);
      mouth.dispose();
    }
    const roleId = this.activeRoleId;
    if (roleId && this.roleToVoice.get(roleId) === voiceId) {
      this.armed = false;
      this.pending = null;
      this.opts.onMouthPlayback?.(roleId, false);
    }
  }
}
