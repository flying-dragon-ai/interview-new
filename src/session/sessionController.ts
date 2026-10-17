import type { GameEvent, Message, PhaseId, RoleCard, SimulationState, VisualFeatureRow } from '../../types.ts';
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
} from '../../engine/phaseEngine.ts';
import {
  createTurnState,
  selectNextSpeaker,
  evaluateInterrupt,
  evaluateUserCalledNoResponse,
  registerSpeak,
  registerInterrupt,
  registerUserMissedTurn,
  type TurnTakingState,
} from '../../engine/turnTaking.ts';
import { extractKeyPoints, MAX_DISCUSSIONS_PER_KEY_POINT } from '../../engine/keyPoints.ts';
import { generateAIReply, type ReplyParams, type ReplyResult } from '../../services/geminiService.ts';
import { VoiceService } from '../../services/voiceService.ts';
import { RealtimeClient, type RealtimeClientOptions } from '../../services/realtimeClient.ts';
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

export interface SessionDeps {
  state: SimulationState;
  roles: RoleCard[];
  sessionId: number | null;
  consentSaveTranscript: boolean;
  cameraEnabled: boolean;
  facingMode: 'user' | 'environment';
  onFinish: (history: Message[], events: GameEvent[], sessionStartAt: number) => void;
  /** 测试注入：替换 LLM 调用（默认 generateAIReply） */
  generateReply?: (params: ReplyParams, onChunk: (chunk: string) => void) => Promise<ReplyResult>;
  /** 测试注入：阶段时长覆盖（phaseEngine 自带测试通道） */
  phaseDurationsMs?: Partial<Record<PhaseId, number>>;
  /** 测试注入：替换 Realtime 建链（默认 RealtimeClient.create） */
  createRealtimeClient?: (opts: RealtimeClientOptions) => Promise<RealtimeClient>;
}

function buildOpeningOrder(cards: RoleCard[]): string[] {
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
  private realtimeTried = false;
  private userStream: MediaStream | null = null;
  private visionClient: VisionClient | null = null;
  private visualRows: VisualFeatureRow[] = [];

  constructor(deps: SessionDeps) {
    this.deps = deps;
    this.store = createSessionStore(makeInitialSnapshot(Date.now(), { cameraOn: deps.cameraEnabled }));
    this.phaseRef = this.store.getSnapshot().phase;
    this.phaseConfig = {
      openingOrder: buildOpeningOrder(deps.roles),
      ...(deps.phaseDurationsMs ? { durationsMs: deps.phaseDurationsMs } : {}),
    };
  }

  /** props 每渲染同步最新引用（onFinish / consent 等），与原 useCallback 闭包刷新等价 */
  updateDeps(deps: SessionDeps): void {
    this.deps = deps;
  }

  private get snap() {
    return this.store.getSnapshot();
  }

  // ---------- 生命周期 ----------

  init(): void {
    this.sessionStartAt = Date.now();
    const points = extractKeyPoints(this.deps.state.topic);
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
    this.voice?.dispose();
    this.voice = null;
    this.realtime?.dispose();
    this.realtime = null;
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
    await this.stopVision();
    this.deps.onFinish(this.snap.messages, this.snap.events, this.sessionStartAt);
  }

  // ---------- AI 发言 ----------

  async triggerAITurn(card: RoleCard): Promise<void> {
    if (this.finished) return;
    const phase = currentPhase(this.phaseRef, this.phaseConfig);
    if (!phase.allowSpeech) return;
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
          voiceMode: this.snap.caps?.outputMode === 'stepfun-tts',
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
      this.speakEndsAt = endedAt + estimateSpeakMs(content);
      this.pushEvents([
        {
          event_type: 'speak_grant',
          actor: card.id,
          target: 'all',
          timestamp_ms: endedAt - this.sessionStartAt,
        },
      ]);

      // 要点推进：达到上限或明确引导到下一要点
      this.maybeAdvanceKeyPoint(content);

      // 关键词辅助（兜底）：自由讨论中检测到总结引导 → 可提前进入总结
      if (phase.id === 'FREE_DISCUSSION' && this.shouldAdvanceByKeyword(content)) {
        const res = advancePhaseByKeyword(this.phaseRef, Date.now(), this.phaseConfig, this.sessionStartAt);
        if (res.changed) {
          this.phaseRef = res.state;
          this.store.set({ phase: res.state });
          this.pushEvents(res.events);
        }
      }

      // TTS 播报（barge-in 由用户输入/说话触发）
      if ((this.snap.caps?.outputMode === 'stepfun-tts' || this.snap.caps?.outputMode === 'webspeech-tts') && this.voice) {
        this.store.set({ speakingCharId: card.id });
        try {
          await this.voice.speak(content, {
            voiceId: card.voice.voice_id,
            rate: card.voice.rate,
            emotion: result.emotion,
            instruction: result.stepfun_tts_instruction,
          });
        } finally {
          this.store.set({ speakingCharId: null });
        }
      }
    } catch (err) {
      console.error('AI 发言失败:', err);
      this.store.set({ degraded: true });
    } finally {
      this.generating.delete(card.id);
      this.store.set({ activeCharId: null, isGenerating: false, streamingText: '' });
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
    this.store.set({ nowTs: now });

    // 1) 倒计时推进（主信号）
    const res = tickPhase(this.phaseRef, now, this.phaseConfig, this.sessionStartAt);
    if (res.changed) {
      this.phaseRef = res.state;
      this.store.set({ phase: res.state });
      this.pushEvents(res.events);
      if (res.state.finished) {
        void this.finishSession();
        return;
      }
    }

    const phase = currentPhase(this.phaseRef, this.phaseConfig);

    // 2) 个人陈述：按顺序触发
    if (phase.id === 'OPENING') {
      const idx = this.phaseRef.openingIndex;
      const speaker = currentOpeningSpeaker(this.phaseRef, this.phaseConfig);
      if (speaker && !this.openingTriggered.has(idx)) {
        this.openingTriggered.add(idx);
        if (speaker === 'user') {
          this.store.set({ awaitingUser: true });
          this.turn = { ...this.turn, userCalledAt: now };
        } else {
          const card = this.deps.roles.find((c) => c.id === speaker);
          if (card) void this.triggerAITurn(card);
        }
      }
      return;
    }

    if (phase.id === 'READING') return;

    // 3) 自由讨论 / 总结：打断规则 + 发言权调度
    // 3a. 用户被点名 5 秒未回应 → 其他 AI 接话
    const noResp = evaluateUserCalledNoResponse(this.deps.roles, this.turn, now);
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

    // 3c. 冷场/等待用户超时 → 调度（保留重构前的判定占位，行为一致：无操作）
    const nobodyActive = this.generating.size === 0 && !this.snap.activeCharId;
    const userWaitingTooLong =
      this.snap.awaitingUser && this.turn.userCalledAt !== null && now - this.turn.userCalledAt > 8000;
    if ((nobodyActive && !this.scheduled) || userWaitingTooLong) {
      // 与重构前一致：空分支（调度由 triggerAITurn finally / 用户发言后的 scheduleNextTurn 驱动）
    }
  }

  // ---------- 用户发言 ----------

  /** 文字发送（原 handleSendMessage）：barge-in → 落消息 → 登记发言权 → 调度 AI 回应 */
  sendTextMessage(text: string): void {
    const trimmed = text.trim();
    if (!trimmed || this.finished) return;

    // barge-in v1：用户输入即停止 AI 播报（TC-04：300ms 内停止）
    this.bargeIn();

    const sentAt = Date.now();
    const msg: Message = {
      id: `${sentAt}-user`,
      senderId: 'user',
      senderName: USER_INFO.name,
      content: trimmed,
      timestamp: sentAt,
      type: 'message',
      startMs: sentAt - this.sessionStartAt,
      endMs: sentAt - this.sessionStartAt + estimateSpeakMs(trimmed),
      speaker: 'user',
      source: 'text',
    };
    this.addMessage(msg);
    this.store.set({ awaitingUser: false });

    this.turn = registerSpeak(this.turn, 'user', sentAt);
    this.speakEndsAt = sentAt + estimateSpeakMs(trimmed);

    // 用户发言也可能推进要点
    this.maybeAdvanceKeyPoint(trimmed);

    // AI 在用户说完后自然回应
    const delay = estimateSpeakMs(trimmed) + 800 + Math.random() * 800;
    this.scheduleNextTurn(delay);
  }

  /** Realtime 最终转写 → 用户语音发言（P2 接线；与 sendTextMessage 同一语义，source 不同） */
  sendUserSpeech(text: string, confidence?: number): void {
    const trimmed = text.trim();
    if (!trimmed || this.finished) return;
    const sentAt = Date.now();
    const msg: Message = {
      id: `${sentAt}-user`,
      senderId: 'user',
      senderName: USER_INFO.name,
      content: trimmed,
      timestamp: sentAt,
      type: 'message',
      startMs: sentAt - this.sessionStartAt,
      endMs: sentAt - this.sessionStartAt + estimateSpeakMs(trimmed),
      confidence,
      speaker: 'user',
      source: 'realtime',
    };
    this.addMessage(msg);
    this.store.set({ awaitingUser: false, userSpeaking: false });
    this.turn = registerSpeak(this.turn, 'user', sentAt);
    this.speakEndsAt = sentAt + estimateSpeakMs(trimmed);
    this.maybeAdvanceKeyPoint(trimmed);
    const delay = estimateSpeakMs(trimmed) + 800 + Math.random() * 800;
    this.scheduleNextTurn(delay);
  }

  // ---------- barge-in ----------

  /** dock 打断按钮 / 发送消息共用（原 handleBargeIn） */
  bargeIn(): void {
    this.voice?.bargeIn();
    this.store.set({ speakingCharId: null });
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

    // 1. 停 TTS 播放（VoiceService.bargeIn 已满足 300ms）
    this.voice?.bargeIn();
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
    if (this.realtime || this.realtimeTried || this.finished) return;
    this.realtimeTried = true;
    this.store.set({ realtimeStatus: 'connecting' });
    try {
      const create = this.deps.createRealtimeClient ?? ((o: RealtimeClientOptions) => RealtimeClient.create(o));
      const client = await create({
        events: {
          onVadStart: () => this.onUserVadStart(),
          onVadStop: () => this.onUserVadStop(),
          onUserTranscript: ({ text, isFinal }) => {
            if (isFinal) this.sendUserSpeech(text);
          },
          onError: (e) => console.error('Realtime 错误:', e.code, e.message),
          onClose: () => {
            this.realtime = null;
            this.store.set({ realtimeStatus: 'fallback', userSpeaking: false });
          },
        },
      });
      this.realtime = client;
      client.setMuted(!this.snap.micOn);
      client.start();
      this.store.set({ realtimeStatus: 'active' });
    } catch (err) {
      // 503 / 网络失败 / 麦克风失败 → 退回按键说话（不白屏，E2E-6）
      console.warn('Realtime 不可用，退回按键说话:', err instanceof Error ? err.message : err);
      this.realtime = null;
      this.store.set({ realtimeStatus: 'fallback' });
    }
  }

  /** Realtime 是否接管了用户语音输入（接管时 PTT 按钮禁用） */
  isRealtimeActive(): boolean {
    return this.realtime !== null;
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
    const hasGuidanceToNext =
      (content.includes('接下来') || content.includes('现在') || content.includes('应该') || content.includes('进入')) &&
      (content.includes('讨论') || content.includes('规划') || content.includes('设计') || content.includes('分析'));
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
    const hasSummaryGuidance =
      (content.includes('总结') && (content.includes('汇报') || content.includes('谁愿意') || content.includes('谁来'))) ||
      content.includes('我来总结') ||
      content.includes('我来汇报');
    if (!hasSummaryGuidance) return false;
    const progress = phaseProgress(this.phaseRef, Date.now(), this.phaseConfig);
    return this.keyPointIndex >= this.keyPoints.length || progress > 0.8;
  }
}

function estimateSpeakMs(text: string): number {
  return Math.max(800, Math.min(6000, (text.length / 2.8) * 1000));
}
