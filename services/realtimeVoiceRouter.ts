import type { RoleVoice } from '../types.ts';
import { RealtimeClient, type RealtimeClientOptions, type RealtimeEvents } from './realtimeClient.ts';
import { resolveVoiceBinding } from './voiceBinding.ts';
import { VoiceLanePool, type VoiceLanePoolOptions } from './voiceLanes.ts';

/**
 * 多角色 Realtime 编排：1 条耳会话 + VoiceLanePool（按音色去重的嘴会话）。
 *
 * - 耳：用户麦克风、服务端 VAD、转写。不播角色台词（channel='ear'）。
 * - 嘴：VoiceLanePool 为每个不同的 realtime voice id 建一条输出会话。
 *   同一把声音的多个角色共用一条分路（音色本来就相同）。
 * - 换克隆音色只改角色卡 voice_id / realtime_voice_id，本类按解析结果建会话。
 *
 * 耳会话建连失败 → connect() 抛错，上层整路退回按键说话 + TTS。
 * 某一把嘴会话失败 → 该音色的 speak() 返回 false，上层只把这一句降级到 TTS。
 */

export interface VoiceSpeaker {
  roleId: string;
  /** 写进播报指令的显示名。缺省用 roleId。 */
  name?: string;
  voice: Pick<RoleVoice, 'voice_id'> & { realtime_voice_id?: string };
}

export interface RealtimeVoiceRouterOptions {
  speakers: VoiceSpeaker[];
  createClient: (opts: RealtimeClientOptions) => Promise<RealtimeClient>;
  /** 测试注入：替换嘴会话分路池。缺省 VoiceLanePool.create。 */
  createLanes?: (opts: VoiceLanePoolOptions) => Promise<VoiceLanePool>;
  earEvents: RealtimeEvents;
  /** 嘴会话播放态。roleId 为当前被点名播报的角色。 */
  onMouthPlayback?: (roleId: string | null, speaking: boolean) => void;
}

export class RealtimeVoiceRouter {
  readonly ear: RealtimeClient;
  private pool: VoiceLanePool | null = null;
  private readonly roleToVoice = new Map<string, string>();
  private readonly roleNames = new Map<string, string>();
  private readonly opts: RealtimeVoiceRouterOptions;
  private activeRoleId: string | null = null;
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
      this.roleNames.set(speaker.roleId, speaker.name?.trim() || speaker.roleId);
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
    return this.pool?.size ?? 0;
  }

  voiceForRole(roleId: string): string | undefined {
    return this.roleToVoice.get(roleId);
  }

  start(): void {
    this.ear.start();
    this.pool?.start();
  }

  /**
   * 把导演台词交给该角色的音色分路。
   * @returns false 表示这把声音没有可用的嘴会话，调用方应走 TTS / 文字降级。
   */
  speak(roleId: string, text: string, instruction?: string | null): boolean {
    if (this.disposed || !this.pool) return false;
    const line = text.trim();
    if (!line) return false;
    const voiceId = this.roleToVoice.get(roleId);
    if (!voiceId) return false;
    const accepted = this.pool.speak(voiceId, line, {
      speakerName: this.roleNames.get(roleId) ?? roleId,
      instruction,
    });
    if (!accepted) return false;
    this.activeRoleId = roleId;
    this.armed = true;
    return true;
  }

  isAIPlaying(): boolean {
    if (this.armed) return true;
    return this.pool?.isPlaying() ?? false;
  }

  /**
   * 台词超时兜底：清掉「已提交但没有音频」的占用。
   * 若音频仍在播，isAIPlaying() 仍为 true。
   */
  disarm(roleId: string): void {
    if (this.activeRoleId !== roleId) return;
    this.armed = false;
    const voiceId = this.roleToVoice.get(roleId);
    if (voiceId) this.pool?.releasePending(voiceId);
  }

  /** 打断：取消所有嘴会话的 response，并清空尚未发出的排队台词 */
  stopAll(): void {
    this.armed = false;
    this.pool?.cancelAll();
  }

  getPlaybackAnalyser(): AnalyserNode | null {
    return this.pool?.getPlaybackAnalyser() ?? this.ear.getPlaybackAnalyser();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.armed = false;
    this.ear.dispose();
    this.pool?.dispose();
    this.pool = null;
  }

  private async openMouths(): Promise<void> {
    const voiceIds = [...new Set(this.roleToVoice.values())];
    if (voiceIds.length === 0) return;
    const factory = this.opts.createLanes ?? ((poolOpts) => VoiceLanePool.create(poolOpts));
    try {
      const pool = await factory({
        voices: voiceIds,
        createClient: (clientOpts) => this.opts.createClient(clientOpts),
        events: {
          onPlaybackChange: (speaking, voiceId) => this.onLanePlayback(voiceId, speaking),
          onError: (e) => {
            console.warn(`Realtime 嘴会话错误（${e.voiceId}）:`, e.code, e.message);
            this.failLane(e.voiceId);
          },
          onClose: (voiceId) => this.failLane(voiceId),
        },
      });
      if (this.disposed) {
        pool.dispose();
        return;
      }
      this.pool = pool;
    } catch (err) {
      console.warn('Realtime 嘴会话分路不可用，AI 播报降级 TTS:', err instanceof Error ? err.message : err);
      this.pool = null;
    }
  }

  private onLanePlayback(voiceId: string, speaking: boolean): void {
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
  }

  private failLane(voiceId: string): void {
    const roleId = this.activeRoleId;
    if (roleId && this.roleToVoice.get(roleId) === voiceId) {
      this.armed = false;
      this.opts.onMouthPlayback?.(roleId, false);
    }
  }
}
