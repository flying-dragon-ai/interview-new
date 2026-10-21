import type { GameEvent, InterviewFormat, Message, PhaseId, RoleCard, SimulationState, VisualFeatureRow } from '../../types.ts';
import { USER_INFO } from '../../data/userInfo.ts';
import {
  tickPhase,
  advancePhaseByKeyword,
  currentPhase,
  currentOpeningSpeaker,
  phaseRemainingMs,
  phaseProgress,
  stageUrgency,
  type PhaseConfig,
  type PhaseState,
  getPhaseDefs,
} from '../../engine/phaseEngine.ts';
import {
  createTurnState,
  selectNextSpeaker,
  evaluateInterrupt,
  evaluateUserCalledNoResponse,
  registerSpeak,
  registerInterrupt,
  registerUserMissedTurn,
  INTERRUPT_RULES,
  type TurnTakingState,
} from '../../engine/turnTaking.ts';
import { extractKeyPoints, MAX_DISCUSSIONS_PER_KEY_POINT } from '../../engine/keyPoints.ts';
import { generateAIReply, type ReplyParams, type ReplyResult } from '../../services/geminiService.ts';
import { guidesToNextKeyPoint, proposesSummary } from '../../engine/discourseSignals.ts';
import { VoiceService } from '../../services/voiceService.ts';
import { RealtimeClient, type RealtimeClientOptions } from '../../services/realtimeClient.ts';
import type { VoiceLanePool } from '../../services/voiceLanes.ts';
import { RealtimeVoiceRouter, type VoiceSpeaker } from '../../services/realtimeVoiceRouter.ts';
import { HOST_CARD, isHostCard } from '../../data/interviewerCards.ts';
import { saveMessage, saveEvents } from '../api.ts';
import { VisionClient } from '../vision/visionClient.ts';
import { createSessionStore, makeInitialSnapshot, type SessionStore } from './sessionStore.ts';

/**
 * SessionController —— 会话引擎持有者（M7 Phase 1，从 DiscussionPanel 抽出的全部副作用）
 * - 无 React 依赖：组件经 useSession 创建并持有；沉浸/经典双模式共用同一实例（P4）
 * - 行为承诺：与重构前 DiscussionPanel 完全一致（引擎测试 + ui-wiring 看守）
 * - 测试钩子（生产默认值不变）：deps.generateReply / deps.phaseDurationsMs
 */

export const TICK_MS = 250;

/** 阵型 B（panel）阶段时长：审题 5s → 自我介绍 1min → 问答 8min → 收尾 2min */
export const PANEL_PHASE_DURATIONS_MS: Partial<Record<PhaseId, number>> = {
  READING: 5 * 1000,
  OPENING: 60 * 1000,
  FREE_DISCUSSION: 8 * 60 * 1000,
  SUMMARY: 2 * 60 * 1000,
};

/** panel 自我介绍说完后自动进入问答的等待窗 */
export const PANEL_OPENING_ADVANCE_MS = 8_000;

/** AI 发言者身份（驱动服务端 prompt 分支） */
export type SpeakerKind = 'candidate' | 'host' | 'interviewer';

export interface SessionDeps {
  state: SimulationState;
  roles: RoleCard[];
  sessionId: number | null;
  consentSaveTranscript: boolean;
  cameraEnabled: boolean;
  facingMode: 'user' | 'environment';
  /** 群面阵型：lgd = 1 面试官 + 4 候选人（含我）；panel = 3 面试官 + 1 候选人。缺省 lgd（向后兼容） */
  format?: InterviewFormat;
  onFinish: (history: Message[], events: GameEvent[], sessionStartAt: number, visualRows?: VisualFeatureRow[]) => void;
  /** 测试注入：替换 LLM 调用（默认 generateAIReply） */
  generateReply?: (params: ReplyParams, onChunk: (chunk: string) => void) => Promise<ReplyResult>;
  /** 测试注入：阶段时长覆盖（phaseEngine 自带测试通道） */
  phaseDurationsMs?: Partial<Record<PhaseId, number>>;
  /** 测试注入：替换 Realtime 建链（默认 RealtimeClient.create） */
  createRealtimeClient?: (opts: RealtimeClientOptions) => Promise<RealtimeClient>;
  /**
   * 测试注入：替换音色分路池。
   * 未注入且未替换 RealtimeClient 时，默认按本场角色卡各开一条锁定音色的播报连接。
   */
  createVoiceLanes?: (voices: string[]) => Promise<VoiceLanePool>;
}

function buildOpeningOrder(cards: RoleCard[], format: InterviewFormat): string[] {
  if (format === 'panel') return ['user']; // 阵型 B：个人陈述 = 仅候选人自我介绍
  // 个人陈述顺序：3 AI + 用户，用户位置随机（避免固定最后）
  const order = cards.map((c) => c.id);
  const pos = Math.floor(Math.random() * (order.length + 1));
  order.splice(pos, 0, 'user');
  return order;
}

export class SessionController {
  readonly store: SessionStore;
  /** 阶段配置（openingOrder 在构造时定一次；原实现每渲染重算，属同一语义的稳定化） */
  readonly phaseConfig: PhaseConfig;

  private deps: SessionDeps;
  private phaseRef: PhaseState;
  private turn: TurnTakingState = createTurnState();
  private keyPoints: string[] = [];
  private keyPointIndex = 0;
  private keyPointCount = 0;
  private generating = new Set<string>();
  private openingTriggered = new Set<number>();
  private scheduled: ReturnType<typeof setTimeout> | null = null;
  private tickInterval: ReturnType<typeof setInterval> | null = null;
  private speakEndsAt = 0;
  private bargedInAt = 0;
  private finished = false;
  private sessionStartAt = Date.now();
  private voice: VoiceService | null = null;
  private realtime: RealtimeClient | null = null;
  /** 耳会话 + 按音色去重的嘴会话。耳失败时为 null，整路降级。 */
  private router: RealtimeVoiceRouter | null = null;
  private realtimeTried = false;
  /** realtime AI 语音播放中的角色（onPlaybackChange 驱动 speakingCharId） */
  private realtimeSpeakingCharId: string | null = null;
  /** panel：用户最近一次发言时间戳（OPENING 自我介绍后自动进问答） */
  private lastUserSpeechAt = 0;
  /** 已做阶段开场白标记（phaseId → 已播） */
  private stageEnterAnnounced = new Set<string>();
  private lastHostNudgeAt = 0;
  private userStream: MediaStream | null = null;
  private visionClient: VisionClient | null = null;
  private visualRows: VisualFeatureRow[] = [];
  /** AI 台词播报兜底定时器（speakingCharId 收敛用；dispose 时统一清理） */
  private playbackTimers = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.store = createSessionStore(makeInitialSnapshot(Date.now(), { cameraOn: deps.cameraEnabled }));
    this.phaseRef = this.store.getSnapshot().phase;
    const format = deps.format ?? 'lgd';
    const panelDurations = format === 'panel' ? PANEL_PHASE_DURATIONS_MS : undefined;
    this.phaseConfig = {
      openingOrder: buildOpeningOrder(deps.roles, format),
      durationsMs: { ...panelDurations, ...(deps.phaseDurationsMs ?? {}) },
    };
  }
  /** props 每渲染同步最新引用（onFinish / consent 等），与原 useCallback 闭包刷新等价 */
  updateDeps(deps: SessionDeps): void {
    this.deps = deps;
  }

  /** 群面阵型（lgd = 1 面试官 + 4 候选人；panel = 3 面试官 + 1 候选人） */
  get format(): InterviewFormat {
    return this.deps.format ?? 'lgd';
  }

  private get snap() {
    return this.store.getSnapshot();
  }

  // ---------- 生命周期 ----------

  init(): void {
    this.sessionStartAt = Date.now();
    // panel 阵型不做要点跟踪（问答流程不消费要点）；lgd 保持原行为
    const points = this.format === 'panel' ? [] : extractKeyPoints(this.deps.state.topic);
    this.keyPoints = points;
    this.keyPointIndex = 0;
    this.keyPointCount = 0;
    this.store.set({ currentKeyPoint: points[0] ?? null });

    const voice = new VoiceService();
    this.voice = voice;
    voice
      .init()
      .then((caps) => this.store.set({ caps }))
      .catch(() => this.store.set({ caps: voice.getCapabilities() }));

    // 降级 TTS 播报态：驱动 speakingCharId 高亮 + 打断窗口收敛（Realtime 链路由 onPlaybackChange 驱动）
    voice.onSpeakingChange((speaking) => {
      if (speaking) {
        if (this.snap.activeCharId) this.store.set({ speakingCharId: this.snap.activeCharId });
      } else {
        if (this.snap.speakingCharId) this.store.set({ speakingCharId: null });
        this.speakEndsAt = 0;
      }
    });
    // 摄像头流（房间内预览 + 视觉采集）；失败静默降级，不阻断面试
    if (this.deps.cameraEnabled && typeof navigator !== 'undefined' && navigator.mediaDevices?.getUserMedia) {
      navigator.mediaDevices
        .getUserMedia({ video: { facingMode: this.deps.facingMode }, audio: false })
        .then((stream) => {
          this.userStream = stream;
          this.startVision(stream);
        })
        .catch(() => this.store.set({ cameraOn: false }));
    }

    this.tickInterval = setInterval(() => this.tick(), TICK_MS);

    // M7 P2：用户侧全双工（失败自动退回按键说话，不阻断）
    void this.initRealtime();
  }

  dispose(): void {
    if (this.tickInterval) clearInterval(this.tickInterval);
    this.tickInterval = null;
    if (this.scheduled) clearTimeout(this.scheduled);
    this.scheduled = null;
    for (const t of this.playbackTimers) clearTimeout(t);
    this.playbackTimers.clear();
    this.voice?.dispose();
    this.voice = null;
    const router = this.router;
    const realtime = this.realtime;
    this.router = null;
    this.realtime = null;
    if (router) router.dispose();
    else realtime?.dispose();
    void this.stopVision();
    this.userStream?.getTracks().forEach((t) => t.stop());
    this.userStream = null;
  }

  // ---------- 事件上报 ----------

  pushEvents(newEvents: GameEvent[]): void {
    if (newEvents.length === 0) return;
    const events = [...this.snap.events, ...newEvents];
    this.store.set({ events });
    if (this.deps.consentSaveTranscript && this.deps.sessionId) {
      saveEvents(this.deps.sessionId, newEvents); // 聚合特征（同意后保存）
    }
  }

  // ---------- 消息 ----------

  addMessage(msg: Message): void {
    const messages = [...this.snap.messages, msg];
    this.store.set({ messages });
    // 要点讨论计数（AI + 用户）
    if (this.keyPoints.length > 0 && this.keyPointIndex < this.keyPoints.length) {
      this.keyPointCount += 1;
    }
    // 落库（同意后保存转写）
    if (this.deps.consentSaveTranscript && this.deps.sessionId) {
      saveMessage({
        sessionId: this.deps.sessionId,
        speaker: msg.senderId === 'user' ? 'user' : msg.senderId,
        speakerType: msg.senderId === 'user' ? 'user' : 'ai',
        speakerId: msg.senderId,
        speakerName: msg.senderName,
        message: msg.content,
        round: messages.length,
        startMs: msg.startMs,
        endMs: msg.endMs,
        confidence: msg.confidence,
        stepfunSegmentId: msg.stepfunSegmentId ?? null,
      });
    }
  }

  // ---------- 完成 ----------

  async finishSession(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    if (this.scheduled) clearTimeout(this.scheduled);
    // 先把视觉聚合行冲刷落库，再触发面后分析（analyze 需要读到 visual_features）
    const visualRows = await this.stopVision();
    this.deps.onFinish(this.snap.messages, this.snap.events, this.sessionStartAt, visualRows);
  }

  // ---------- AI 发言 ----------

  async triggerAITurn(card: RoleCard, opts?: { speakerKind?: SpeakerKind; force?: boolean }): Promise<void> {
    if (this.finished) return;
    const phase = currentPhase(this.phaseRef, this.phaseConfig);
    if (!phase.allowSpeech && !opts?.force) return;
    const speakerKind: SpeakerKind = opts?.speakerKind ?? (isHostCard(card) ? 'host' : 'candidate');
    if (this.generating.has(card.id)) return;
    this.generating.add(card.id);

    this.store.set({ activeCharId: card.id, isGenerating: true, streamingText: '', awaitingUser: false });

    const reply = this.deps.generateReply ?? generateAIReply;
    const startedAt = Date.now();
    try {
      const remainingMs = phaseRemainingMs(this.phaseRef, startedAt, this.phaseConfig);
      const result = await reply(
        {
          card,
          topic: this.deps.state.topic,
          jobTitle: this.deps.state.jobTitle,
          history: this.snap.messages,
          phase: phase.promptPhase,
          currentKeyPoint: this.keyPoints[this.keyPointIndex] ?? null,
          keyPointDiscussionCount: this.keyPointCount,
          allKeyPointsDiscussed: this.keyPointIndex >= this.keyPoints.length,
          allKeyPoints: this.keyPoints,
          currentKeyPointIndex: this.keyPointIndex,
          voiceMode: this.isRealtimeVoiceActive() || this.snap.caps?.outputMode === 'stepfun-tts',
          speakerKind,
          phaseRemainingMs: remainingMs,
          sessionId: this.deps.sessionId,
        },
        (chunk) => this.store.set({ streamingText: this.snap.streamingText + chunk })
      );

      const content = result.content?.trim();
      if (!content) throw new Error('空回复');

      const endedAt = Date.now();
      this.addMessage({
        id: `${Date.now()}-${card.id}`,
        senderId: card.id,
        senderName: card.name,
        content,
        timestamp: endedAt,
        type: 'message',
        startMs: startedAt - this.sessionStartAt,
        endMs: endedAt - this.sessionStartAt,
        emotion: result.emotion,
        speaker: `ai:${card.id}`,
        source: 'llm',
      });

      this.turn = registerSpeak(this.turn, card.id, endedAt);
      this.speakEndsAt = endedAt + estimateSpeechMs(content);
      this.pushEvents([
        {
          event_type: 'speak_grant',
          actor: card.id,
          target: 'all',
          timestamp_ms: endedAt - this.sessionStartAt,
        },
      ]);

      // 要点推进：达到上限或明确引导到下一要点（仅 lgd 候选人消费要点）
      if (speakerKind === 'candidate') this.maybeAdvanceKeyPoint(content);

      // 关键词辅助（兜底）：自由讨论中检测到总结引导 → 可提前进入总结（仅 lgd 候选人触发）
      if (this.format === 'lgd' && speakerKind === 'candidate' && phase.id === 'FREE_DISCUSSION' && this.shouldAdvanceByKeyword(content)) {
        const res = advancePhaseByKeyword(this.phaseRef, Date.now(), this.phaseConfig, this.sessionStartAt);
        if (res.changed) {
          this.phaseRef = res.state;
          this.store.set({ phase: res.state });
          this.pushEvents(res.events);
        }
      }

      // 语音输出：该角色的 Realtime 嘴会话优先（每把音色一条连接）；
      // 这把声音没有嘴会话时降级 StepFun TTS / 浏览器语音（二选一，禁止双声道齐播）
      const voicedByMouth = this.router?.speak(card.id, content) ?? false;
      if (voicedByMouth || (!this.router && this.isRealtimeVoiceActive() && this.realtime)) {
        this.realtimeSpeakingCharId = card.id;
        this.store.set({ speakingCharId: card.id });
        if (!voicedByMouth) this.realtime?.speak(content);
        // 播完（或被打断）由 onPlaybackChange(false) 收敛 speakingCharId 并关闭打断窗口；
        // 估算时长兜底，防止 onPlaybackChange 丢失导致高亮悬挂
        const charId = card.id;
        const fallbackTimer = setTimeout(() => {
          this.playbackTimers.delete(fallbackTimer);
          if (this.realtimeSpeakingCharId === charId) {
            this.realtimeSpeakingCharId = null;
            this.store.set({ speakingCharId: null });
          }
          this.router?.disarm(charId);
        }, estimateSpeechMs(content) + 1500);
        this.playbackTimers.add(fallbackTimer);
      } else {
        this.store.set({ speakingCharId: card.id });
        try {
          // TTS 播报播完才返回（waitForDrain），避免下一位发言盖上来
          await this.voice?.speak(content, {
            voiceId: card.voice.voice_id,
            rate: card.voice.rate,
            emotion: result.emotion,
            instruction: result.stepfun_tts_instruction,
          });
        } finally {
          if (this.snap.speakingCharId === card.id) this.store.set({ speakingCharId: null });
        }
      }
    } catch (err) {
      console.error('AI 发言失败:', err);
      this.store.set({ degraded: true });
    } finally {
      this.generating.delete(card.id);
      this.store.set({ activeCharId: null, isGenerating: false, streamingText: '' });
      if (this.format === 'panel' && speakerKind === 'interviewer' && !this.finished) {
        // 阵型 B：面试官问完 → 等候选人回答（不再调度其他面试官盖上去）
        const now = Date.now();
        this.store.set({ awaitingUser: true });
        this.turn = { ...this.turn, userCalledAt: now };
        return;
      }
      // 调度下一个发言者（barge-in 后短暂等待用户）
      this.scheduleNextTurn();
    }
  }

  // ---------- 调度 ----------

  scheduleNextTurn(delayMs?: number): void {
    if (this.finished) return;
    if (this.scheduled) clearTimeout(this.scheduled);

    const fire = () => {
      this.scheduled = null;
      if (this.finished) return;
      const phase = currentPhase(this.phaseRef, this.phaseConfig);
      if (!phase.allowSpeech) return;
      if (this.generating.size > 0) return;
      // Realtime AI 语音还在播 → 等播完（或被打断）再调度，避免下一位盖上来
      if (this.aiVoicePlaying()) {
        this.scheduled = setTimeout(fire, 800);
        return;
      }

      const now = Date.now();
      const urgency = stageUrgency(this.phaseRef, now, this.phaseConfig);
      const silenceMs = Math.max(0, now - Math.max(this.speakEndsAt, this.sessionStartAt));
      const decision = selectNextSpeaker(this.deps.roles, this.turn, { now, stageUrgency: urgency, silenceMs });

      // barge-in 后 12 秒内优先等用户输入
      const sinceBarge = now - this.bargedInAt;
      if (sinceBarge >= 0 && sinceBarge < 12000 && decision.speakerId !== 'user') {
        this.scheduled = setTimeout(fire, 2000);
        return;
      }

      if (decision.speakerId === 'user') {
        this.store.set({ awaitingUser: true });
        this.turn = { ...this.turn, userCalledAt: now };
      } else {
        this.store.set({ awaitingUser: false });
        const card = this.deps.roles.find((c) => c.id === decision.speakerId);
        if (card) {
          this.turn = registerUserMissedTurn(this.turn);
          void this.triggerAITurn(card);
        }
      }
    };

    const delay = delayMs ?? 1200 + Math.random() * 1500;
    this.scheduled = setTimeout(fire, delay);
  }

  // ---------- 主循环 ----------

  private tick(): void {
    if (this.finished) return;
    const now = Date.now();
    // 1) 倒计时推进（主信号）
    // 1) 倒计时推进（主信号）
    const res = tickPhase(this.phaseRef, now, this.phaseConfig, this.sessionStartAt);
    if (res.changed) {
      const prevPhaseId = currentPhase(this.phaseRef, this.phaseConfig).id;
      this.phaseRef = res.state;
      this.store.set({ phase: res.state });
      this.pushEvents(res.events);
      if (res.state.finished) {
        void this.finishSession();
        return;
      }
      const nextPhaseId = currentPhase(this.phaseRef, this.phaseConfig).id;
      if (nextPhaseId !== prevPhaseId) this.onStageEnter(nextPhaseId);
    }

    const phase = currentPhase(this.phaseRef, this.phaseConfig);

    // 2) 个人陈述：按顺序触发
    if (phase.id === 'OPENING') {
      const idx = this.phaseRef.openingIndex;
      const speaker = currentOpeningSpeaker(this.phaseRef, this.phaseConfig);
      // panel：自我介绍已说完 → 稍候片刻自动进入问答，不等满 60s
      if (
        this.format === 'panel' &&
        this.lastUserSpeechAt > 0 &&
        now - this.lastUserSpeechAt > PANEL_OPENING_ADVANCE_MS
      ) {
        const nextIndex = Math.min(this.phaseRef.phaseIndex + 1, this.phaseConfigLength());
        this.phaseRef = { ...this.phaseRef, phaseIndex: nextIndex, phaseStartedAt: now };
        this.store.set({ phase: this.phaseRef });
        this.pushEvents([
          {
            event_type: 'stage_change',
            actor: 'system',
            target: 'FREE_DISCUSSION',
            timestamp_ms: now - this.sessionStartAt,
            metadata: { reason: 'panel_intro_done' },
          },
        ]);
        this.onStageEnter('FREE_DISCUSSION');
        return;
      }
      if (speaker && !this.openingTriggered.has(idx)) {
        this.openingTriggered.add(idx);
        if (speaker === 'user') {
          this.store.set({ awaitingUser: true });
          this.turn = { ...this.turn, userCalledAt: now };
        } else {
          const card = this.deps.roles.find((c) => c.id === speaker);
          if (card) void this.triggerAITurn(card, { speakerKind: this.format === 'panel' ? 'interviewer' : 'candidate' });
        }
      }
      return;
    }

    // 2) panel/阵型 A：审题阶段由主持面试官开场（触发一次）
    if (phase.id === 'READING') {
      if (this.format === 'lgd' && !this.stageEnterAnnounced.has('READING') && now > this.sessionStartAt + 500) {
        this.stageEnterAnnounced.add('READING');
        void this.triggerAITurn(HOST_CARD, { speakerKind: 'host', force: true });
      }
      return;
    }

    // 3) 自由讨论 / 总结：打断规则 + 发言权调度
    // 3a. 用户被点名未回应 → 其他 AI 接话（panel 给候选人更长思考窗）
    const noRespGraceMs = this.format === 'panel' ? 15_000 : INTERRUPT_RULES.userCalledMs;
    const noResp = evaluateUserCalledNoResponse(this.deps.roles, this.turn, now, noRespGraceMs);
    if (noResp.type === 'interrupt') {
      this.turn = registerInterrupt(this.turn, noResp.targetId, noResp.interrupterId);
      this.pushEvents([
        {
          event_type: 'interrupt',
          actor: noResp.interrupterId,
          target: noResp.targetId,
          timestamp_ms: now - this.sessionStartAt,
          metadata: { rule: noResp.rule },
        },
      ]);
      // 接管后重置计数，避免「强制分配→5秒接管→再强制分配」死循环（B.6 语义修正）
      this.turn = { ...this.turn, userCalledAt: null, userMissedTurns: 0 };
      this.store.set({ awaitingUser: false });
      const card = this.deps.roles.find((c) => c.id === noResp.interrupterId);
      if (card) void this.triggerAITurn(card);
      return;
    }

    // 3b. 发言超时打断（用户 >30s / AI >40s）
    if (now < this.speakEndsAt && this.turn.currentSpeaker) {
      const interrupt = evaluateInterrupt(this.deps.roles, this.turn, now);
      if (interrupt.type === 'interrupt') {
        this.voice?.bargeIn();
        this.store.set({ speakingCharId: null });
        this.turn = registerInterrupt(this.turn, interrupt.targetId, interrupt.interrupterId);
        this.pushEvents([
          {
            event_type: 'interrupt',
            actor: interrupt.interrupterId,
            target: interrupt.targetId,
            timestamp_ms: now - this.sessionStartAt,
            metadata: { rule: interrupt.rule },
          },
        ]);
        const card = this.deps.roles.find((c) => c.id === interrupt.interrupterId);
        if (card) void this.triggerAITurn(card);
        return;
      }
    }

    // 3c. 冷场/等待用户超时 → 调度 + 主持面试官救场（仅 lgd 自由讨论阶段）
    const nobodyActive = this.generating.size === 0 && !this.snap.activeCharId;
    const userWaitingTooLong =
      this.snap.awaitingUser && this.turn.userCalledAt !== null && now - this.turn.userCalledAt > 8000;
    if (
      this.format === 'lgd' &&
      phase.id === 'FREE_DISCUSSION' &&
      nobodyActive &&
      !this.scheduled &&
      !this.aiVoicePlaying() &&
      now - Math.max(this.speakEndsAt, this.bargedInAt, this.sessionStartAt) > 20_000 &&
      now - this.lastHostNudgeAt > 30_000
    ) {
      // 冷场 ≥20s：主持人邀请沉默者发言（30s 节流）
      this.lastHostNudgeAt = now;
      void this.triggerAITurn(HOST_CARD, { speakerKind: 'host', force: true });
      return;
    }
    if (userWaitingTooLong && !this.scheduled && !this.generating.size) {
      this.scheduleNextTurn(0);
    }
  }

  /**
   * 阶段切换开场白（stage_change 后触发一次）：
   * - lgd：主持面试官在自由讨论/总结入口做流程衔接；READING 开场由审题分支触发
   * - panel：OPENING 由第一位面试官做开场欢迎；SUMMARY 由面试官收尾
   */
  private onStageEnter(phaseId: PhaseId): void {
    if (this.finished) return;
    if (this.stageEnterAnnounced.has(phaseId)) return;
    this.stageEnterAnnounced.add(phaseId);
    if (this.format === 'lgd') {
      if (phaseId === 'FREE_DISCUSSION' || phaseId === 'SUMMARY') {
        void this.triggerAITurn(HOST_CARD, { speakerKind: 'host', force: true });
      }
      return;
    }
    if (phaseId === 'OPENING' || phaseId === 'SUMMARY') {
      const first = this.deps.roles[0];
      if (first) void this.triggerAITurn(first, { speakerKind: 'interviewer', force: true });
    }
  }

  /** 当前 PhaseConfig 的阶段数（阶段推进上界） */
  private phaseConfigLength(): number {
    return getPhaseDefs(this.phaseConfig).length;
  }

  // ---------- 用户发言 ----------

  /** 文字发送（原 handleSendMessage）：barge-in → 落消息 → 登记发言权 → 调度 AI 回应 */
  sendTextMessage(text: string): void {
    // barge-in v1：用户输入即停止 AI 播报（TC-04：300ms 内停止）
    this.bargeIn();
    this.submitUserMessage(text, 'text');
  }

  /** Realtime 最终转写 → 用户语音发言（P2 接线；与 sendTextMessage 同一语义，source 不同） */
  sendUserSpeech(text: string, confidence?: number): void {
    this.submitUserMessage(text, 'realtime', confidence);
  }

  /** 用户发言共用通道（文字 / Realtime 转写）：落消息 → 登记发言权 → 调度 AI 回应 */
  private submitUserMessage(text: string, source: 'text' | 'realtime', confidence?: number): void {
    const trimmed = text.trim();
    if (!trimmed || this.finished) return;
    const sentAt = Date.now();
    this.addMessage({
      id: `${sentAt}-user`,
      senderId: 'user',
      senderName: USER_INFO.name,
      content: trimmed,
      timestamp: sentAt,
      type: 'message',
      startMs: sentAt - this.sessionStartAt,
      endMs: sentAt - this.sessionStartAt + estimateSpeechMs(trimmed),
      confidence,
      speaker: 'user',
      source,
    });
    this.store.set(source === 'realtime' ? { awaitingUser: false, userSpeaking: false } : { awaitingUser: false });
    this.turn = registerSpeak(this.turn, 'user', sentAt);
    // 发言权地板：持续到估算说完（B.5 打断规则按此窗口评估，不封顶）
    this.speakEndsAt = sentAt + estimateSpeechMs(trimmed);
    this.lastUserSpeechAt = sentAt;
    // 用户发言也可能推进要点（仅 lgd）
    this.maybeAdvanceKeyPoint(trimmed);
    // AI 在用户说完后自然回应（封顶等待，避免长文拖慢调度）
    this.scheduleNextTurn(userReplyDelayMs(trimmed) + 800 + Math.random() * 800);
  }

  // ---------- barge-in ----------

  /** dock 打断按钮 / 发送消息共用（原 handleBargeIn） */
  bargeIn(): void {
    this.voice?.bargeIn();
    // Realtime：停掉所有嘴会话，并取消耳会话上可能残留的自动回复
    this.router?.stopAll();
    this.realtime?.stopAISpeech();
    this.realtimeSpeakingCharId = null;
    this.store.set({ speakingCharId: null });
    this.speakEndsAt = 0; // 播报已停 → 关闭打断评估窗口
    this.bargedInAt = Date.now();
  }

  /**
   * Realtime VAD 用户开口（P2-4 接线点）：同步停播 + 取消挂起调度 + 登记打断事件。
   * 目标 ≤300ms（对齐 TC-04）；400ms 确认窗与 800ms 冷却在 RealtimeClient 侧完成。
   */
  onUserVadStart(): void {
    // 只有在「AI 在播 / 在生成 / 有挂起调度」时才算真正的打断；否则只是用户正常开口
    const interruptedCharId = this.snap.speakingCharId ?? this.snap.activeCharId;
    const hadScheduled = Boolean(this.scheduled);
    const isBargeIn = Boolean(interruptedCharId) || this.snap.isGenerating || hadScheduled;

    // 1. 停 TTS 播放 + Realtime AI 播报（均满足 300ms 停声）
    this.voice?.bargeIn();
    this.router?.stopAll();
    this.realtime?.stopAISpeech();
    this.realtimeSpeakingCharId = null;
    this.speakEndsAt = 0; // 播报已停 → 关闭打断评估窗口
    // 2. 清生成态 + 标记用户正在说（3D 场景据此切 interrupted 表情）
    this.store.set({ speakingCharId: null, isGenerating: false, userSpeaking: true });
    // 3. 取消挂起的调度（防止 AI 立刻接话把用户盖回去）
    if (this.scheduled) {
      clearTimeout(this.scheduled);
      this.scheduled = null;
    }
    this.bargedInAt = Date.now();
    if (!isBargeIn) return;
    // 4. 登记发言权
    const now = Date.now();
    this.turn = registerSpeak(this.turn, 'user', now);
    // 5. 推 interrupt 事件
    this.pushEvents([
      {
        event_type: 'interrupt',
        actor: 'user',
        target: interruptedCharId ?? 'all',
        timestamp_ms: now - this.sessionStartAt,
        metadata: { rule: 'user_barge_in_realtime' },
      },
    ]);
  }

  /** VAD 结束（无转写也随之而来）：清空「你正在说」 */
  onUserVadStop(): void {
    if (this.snap.userSpeaking) this.store.set({ userSpeaking: false });
  }

  setUserSpeaking(v: boolean): void {
    this.store.set({ userSpeaking: v });
  }

  // ---------- Realtime 全双工（M7 P2：用户侧主链路；失败退回按键说话） ----------

  /**
   * 建立 Realtime 链路（init 时自动调用，幂等）。
   * active：转写直达 sendUserSpeech，VAD 直达 onUserVadStart；fallback：经典 PTT/文字链路不变。
   */
  async initRealtime(): Promise<void> {
    if (this.router || this.realtime || this.realtimeTried || this.finished) return;
    this.realtimeTried = true;
    this.store.set({ realtimeStatus: 'connecting' });
    try {
      const create = this.deps.createRealtimeClient ?? ((o: RealtimeClientOptions) => RealtimeClient.create(o));
      const router = await RealtimeVoiceRouter.connect({
        speakers: this.voiceSpeakers(),
        createClient: create,
        onMouthPlayback: (roleId, speaking) => {
          if (speaking && roleId) {
            this.realtimeSpeakingCharId = roleId;
            this.store.set({ speakingCharId: roleId });
            return;
          }
          if (!speaking && (!roleId || this.realtimeSpeakingCharId === roleId)) {
            this.realtimeSpeakingCharId = null;
            this.store.set({ speakingCharId: null });
            this.speakEndsAt = 0;
          }
        },
        earEvents: {
          onVadStart: () => this.onUserVadStart(),
          onVadStop: () => this.onUserVadStop(),
          onUserTranscript: ({ text, isFinal }) => {
            if (isFinal) this.sendUserSpeech(text);
          },
          onError: (e) => console.error('Realtime 错误:', e.code, e.message),
          onClose: () => {
            const dying = this.router;
            this.router = null;
            this.realtime = null;
            this.realtimeSpeakingCharId = null;
            this.store.set({ realtimeStatus: 'fallback', userSpeaking: false, speakingCharId: null });
            dying?.dispose();
          },
        },
      });
      this.router = router;
      this.realtime = router.ear;
      router.ear.setMuted(!this.snap.micOn);
      router.start();
      this.store.set({ realtimeStatus: 'active' });
    } catch (err) {
      // 503 / 网络失败 / 麦克风失败 → 退回按键说话（不白屏，E2E-6）
      console.warn('Realtime 不可用，退回按键说话:', err instanceof Error ? err.message : err);
      this.router = null;
      this.realtime = null;
      this.store.set({ realtimeStatus: 'fallback' });
    }
  }

  /** 本场需要出声的角色：无领导含主持，结构化单面只有面试官 */
  private voiceSpeakers(): VoiceSpeaker[] {
    const cards = this.format === 'lgd' ? [...this.deps.roles, HOST_CARD] : [...this.deps.roles];
    const seen = new Set<string>();
    const speakers: VoiceSpeaker[] = [];
    for (const card of cards) {
      if (seen.has(card.id)) continue;
      seen.add(card.id);
      speakers.push({ roleId: card.id, voice: card.voice });
    }
    return speakers;
  }

  /** 任一嘴会话仍在播（或台词已提交尚未收到音频） */
  private aiVoicePlaying(): boolean {
    if (this.router) return this.router.isAIPlaying();
    return Boolean(this.realtime?.isAIPlaying());
  }

  /** Realtime 是否接管了用户语音输入（接管时 PTT 按钮禁用） */
  isRealtimeActive(): boolean {
    return this.realtime !== null;
  }

  /** Realtime 是否接管了 AI 语音输出（接管时跳过 TTS 降级链路） */
  isRealtimeVoiceActive(): boolean {
    return this.realtime !== null && this.realtime.state === 'open';
  }

  /** Realtime 播放分析器（口型/灯光律动；回落 VoiceService 侧） */
  getRealtimePlaybackAnalyser(): AnalyserNode | null {
    return this.router?.getPlaybackAnalyser() ?? this.realtime?.getPlaybackAnalyser() ?? null;
  }

  // ---------- PTT 语音输入（经典模式按键说话，Realtime 不可用时的降级链路） ----------

  async startUserAsr(onPartial: (text: string) => void, onFinal: (text: string) => void): Promise<void> {
    if (!this.voice || this.isRealtimeActive()) return; // Realtime 已接管用户语音输入
    await this.voice.startAsr(onPartial, onFinal);
  }

  async stopUserAsr(): Promise<string> {
    if (!this.voice || this.isRealtimeActive()) return '';
    return this.voice.stopAsr();
  }

  // ---------- 设备 ----------

  toggleMic(): void {
    const next = !this.snap.micOn;
    this.store.set({ micOn: next });
    // Realtime 链路同步静音（停止上行帧，采集保持）
    this.realtime?.setMuted(!next);
  }

  toggleCamera(): void {
    const next = !this.snap.cameraOn;
    this.store.set({ cameraOn: next });
    const stream = this.userStream;
    if (!stream) return;
    // 关闭即停采像头轨道（指示灯熄灭）+ 停采集；已采数据保留（内存 + 已落库部分）
    stream.getVideoTracks().forEach((t) => {
      t.enabled = next;
    });
    if (next) this.startVision(stream);
    else void this.stopVision();
  }

  /** 最新一秒视觉聚合行（VisionPiP 实时眼神接触展示；未采集时为 null） */
  getVisionLatest(): VisualFeatureRow | null {
    return this.visionClient?.getLatestRow() ?? null;
  }

  /** 摄像头流（房间内预览 / VisionPiP 用） */
  getUserStream(): MediaStream | null {
    return this.userStream;
  }

  /** 语音服务（RealtimeClient 需要复用其 AudioContext / bargeIn） */
  getVoiceService(): VoiceService | null {
    return this.voice;
  }

  isFinished(): boolean {
    return this.finished;
  }

  /** 测试专用：直接写入阶段态（跳过真实倒计时，供调度/打断规则单测使用） */
  forcePhaseForTest(next: PhaseState): void {
    this.phaseRef = next;
    this.store.set({ phase: next });
  }

  // ---------- M6 视觉采集（PRD D2/D4：摄像头 + 同意后才本地推理；静默采集，无实时提示） ----------

  private startVision(stream: MediaStream): void {
    if (this.visionClient) return;
    if (!this.deps.consentSaveTranscript) return; // 未同意保存聚合特征 → 不采集（视觉维度 not_enabled）
    const client = new VisionClient({ stream, sessionId: this.deps.sessionId, persist: true });
    this.visionClient = client;
    client.start().catch(() => undefined); // 失败静默降级，不阻断面试
  }

  /** 停止采集并冲刷落库；返回内存行（无 DB 的本地模式只留内存） */
  private async stopVision(): Promise<VisualFeatureRow[]> {
    const client = this.visionClient;
    this.visionClient = null;
    if (!client) return this.visualRows;
    const rows = await client.stop().catch(() => [] as VisualFeatureRow[]);
    this.visualRows = rows;
    return rows;
  }

  // ---------- 内部 ----------

  private maybeAdvanceKeyPoint(content: string): void {
    if (this.keyPoints.length === 0 || this.keyPointIndex >= this.keyPoints.length) return;
    const hasGuidanceToNext = guidesToNextKeyPoint(content);
    if (this.keyPointCount >= MAX_DISCUSSIONS_PER_KEY_POINT || hasGuidanceToNext) {
      if (this.keyPointIndex + 1 < this.keyPoints.length) {
        this.keyPointIndex += 1;
        this.keyPointCount = 0;
      } else {
        this.keyPointIndex = this.keyPoints.length;
      }
      this.store.set({ currentKeyPoint: this.keyPoints[this.keyPointIndex] ?? null });
    }
  }

  private shouldAdvanceByKeyword(content: string): boolean {
    // 辅助信号：明确出现总结/汇报引导且要点已讨论完（或阶段已过 80%）
    const hasSummaryGuidance = proposesSummary(content);
    if (!hasSummaryGuidance) return false;
    const progress = phaseProgress(this.phaseRef, Date.now(), this.phaseConfig);
    return this.keyPointIndex >= this.keyPoints.length || progress > 0.8;
  }
}

/** 语音时长估算（2.8 字/秒，下限 800ms；不封顶——打断窗口/消息时间戳用真实口径） */
function estimateSpeechMs(text: string): number {
  return Math.max(800, (text.length / 2.8) * 1000);
}

/** 用户发言后 AI 接话的自然停顿（封顶 6s，避免长文拖慢调度） */
function userReplyDelayMs(text: string): number {
  return Math.min(6000, estimateSpeechMs(text));
}
