import React, { useState, useEffect, useRef, useCallback } from 'react';
import type { GameEvent, Message, RoleCard, SimulationState } from '../types';
import { USER_INFO } from '../data/userInfo';
import { findAvatarPreset } from '../data/avatars.ts';
import {
  initPhaseEngine,
  tickPhase,
  advancePhaseByKeyword,
  currentPhase,
  currentOpeningSpeaker,
  phaseRemainingMs,
  phaseProgress,
  stageUrgency,
  formatCountdown,
  OPENING_TURN_MS,
  type PhaseConfig,
  type PhaseState,
} from '../engine/phaseEngine';
import {
  createTurnState,
  selectNextSpeaker,
  evaluateInterrupt,
  evaluateUserCalledNoResponse,
  registerSpeak,
  registerInterrupt,
  registerUserMissedTurn,
  type TurnTakingState,
} from '../engine/turnTaking';
import { extractKeyPoints, MAX_DISCUSSIONS_PER_KEY_POINT } from '../engine/keyPoints';
import { generateAIReply } from '../services/geminiService';
import { VoiceService, type VoiceCapabilities } from '../services/voiceService';
import { saveMessage, saveEvents } from '../src/api';
import AvatarStage from './AvatarStage';

/**
 * 群面房间（PRD 4.1.3 / 4.1.4 / 4.1.5 / 4.1.6）
 * - 倒计时四阶段引擎（审题 2min → 个人陈述每人 1min → 自由讨论 ≤15min → 总结 3min）
 * - 发言权调度 v1（B.3 打分 + B.5 打断 + B.6 用户保护），洗牌队列兜底
 * - 要点跟踪（每要点 10 次）保留；关键词检测降级为辅助
 * - StepFun TTS 播报 + barge-in；ASR 主路径 + Web Speech / 文字兜底
 * - events 落库（同意后）；消息落库（同意后）
 */

interface DiscussionPanelProps {
  state: SimulationState;
  roles: RoleCard[];
  sessionId: number | null;
  consentSaveTranscript: boolean;
  cameraEnabled: boolean;
  facingMode: 'user' | 'environment';
  onFinish: (history: Message[], events: GameEvent[], sessionStartAt: number) => void;
}

const TICK_MS = 250;

const DiscussionPanel: React.FC<DiscussionPanelProps> = ({
  state,
  roles,
  sessionId,
  consentSaveTranscript,
  cameraEnabled,
  facingMode,
  onFinish,
}) => {
  const [messages, setMessages] = useState<Message[]>([]);
  const [phaseState, setPhaseState] = useState<PhaseState>(() => initPhaseEngine(Date.now()));
  const [nowTs, setNowTs] = useState(Date.now());
  const [activeCharId, setActiveCharId] = useState<string | null>(null);
  const [speakingCharId, setSpeakingCharId] = useState<string | null>(null);
  const [streamingText, setStreamingText] = useState<string>('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [events, setEvents] = useState<GameEvent[]>([]);
  const [inputValue, setInputValue] = useState('');
  const [isListening, setIsListening] = useState(false);
  const [asrPartial, setAsrPartial] = useState('');
  const [voiceCaps, setVoiceCaps] = useState<VoiceCapabilities | null>(null);
  const [awaitingUser, setAwaitingUser] = useState(false);
  const [topicOpen, setTopicOpen] = useState(true);
  const [micOn, setMicOn] = useState(true);
  const [cameraOn, setCameraOn] = useState(cameraEnabled);
  const [degraded, setDegraded] = useState(false);
  const [currentKeyPoint, setCurrentKeyPoint] = useState<string | null>(null);

  const scrollRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<Message[]>([]);
  const eventsRef = useRef<GameEvent[]>([]);
  const phaseRef = useRef<PhaseState>(phaseState);
  const turnRef = useRef<TurnTakingState>(createTurnState());
  const keyPointsRef = useRef<string[]>([]);
  const keyPointIndexRef = useRef(0);
  const keyPointCountRef = useRef(0);
  const generatingRef = useRef<Set<string>>(new Set());
  const openingTriggeredRef = useRef<Set<number>>(new Set());
  const scheduledRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCharIdRef = useRef<string | null>(null);
  const awaitingUserRef = useRef(false);
  const speakEndsAtRef = useRef<number>(0);
  const bargedInAtRef = useRef<number>(0);
  const finishedRef = useRef(false);
  const sessionStartAtRef = useRef(Date.now());
  const voiceRef = useRef<VoiceService | null>(null);
  const userStreamRef = useRef<MediaStream | null>(null);

  const phaseConfig: PhaseConfig = {
    openingOrder: buildOpeningOrder(roles),
  };

  function buildOpeningOrder(cards: RoleCard[]): string[] {
    // 个人陈述顺序：3 AI + 用户，用户位置随机（避免固定最后）
    const order = cards.map((c) => c.id);
    const pos = Math.floor(Math.random() * (order.length + 1));
    order.splice(pos, 0, 'user');
    return order;
  }

  // ---------- 初始化 ----------
  useEffect(() => {
    sessionStartAtRef.current = Date.now();
    const points = extractKeyPoints(state.topic);
    keyPointsRef.current = points;
    keyPointIndexRef.current = 0;
    keyPointCountRef.current = 0;
    setCurrentKeyPoint(points[0] ?? null);

    const voice = new VoiceService();
    voiceRef.current = voice;
    voice.init().then(setVoiceCaps).catch(() => setVoiceCaps(voice.getCapabilities()));

    // 摄像头流（房间内预览）
    if (cameraEnabled) {
      navigator.mediaDevices
        ?.getUserMedia({ video: { facingMode }, audio: false })
        .then((stream) => {
          userStreamRef.current = stream;
        })
        .catch(() => setCameraOn(false));
    }

    return () => {
      voice.dispose();
      userStreamRef.current?.getTracks().forEach((t) => t.stop());
      if (scheduledRef.current) clearTimeout(scheduledRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 事件上报 ----------
  const pushEvents = useCallback(
    (newEvents: GameEvent[]) => {
      if (newEvents.length === 0) return;
      eventsRef.current = [...eventsRef.current, ...newEvents];
      setEvents(eventsRef.current);
      if (consentSaveTranscript && sessionId) {
        saveEvents(sessionId, newEvents); // 聚合特征（同意后保存）
      }
    },
    [consentSaveTranscript, sessionId]
  );

  // ---------- 消息 ----------
  const addMessage = useCallback(
    (msg: Message) => {
      messagesRef.current = [...messagesRef.current, msg];
      setMessages(messagesRef.current);
      // 要点讨论计数（AI + 用户）
      if (keyPointsRef.current.length > 0 && keyPointIndexRef.current < keyPointsRef.current.length) {
        keyPointCountRef.current += 1;
      }
      // 落库（同意后保存转写）
      if (consentSaveTranscript && sessionId) {
        saveMessage({
          sessionId,
          speaker: msg.senderId === 'user' ? 'user' : msg.senderId,
          speakerType: msg.senderId === 'user' ? 'user' : 'ai',
          speakerId: msg.senderId,
          speakerName: msg.senderName,
          message: msg.content,
          round: messagesRef.current.length,
          startMs: msg.startMs,
          endMs: msg.endMs,
          confidence: msg.confidence,
          stepfunSegmentId: msg.stepfunSegmentId ?? null,
        });
      }
    },
    [consentSaveTranscript, sessionId]
  );

  // ---------- 完成 ----------
  const finishSession = useCallback(() => {
    if (finishedRef.current) return;
    finishedRef.current = true;
    if (scheduledRef.current) clearTimeout(scheduledRef.current);
    onFinish(messagesRef.current, eventsRef.current, sessionStartAtRef.current);
  }, [onFinish]);

  // ---------- AI 发言 ----------
  const triggerAITurn = useCallback(
    async (card: RoleCard) => {
      if (finishedRef.current) return;
      const phase = currentPhase(phaseRef.current, phaseConfig);
      if (!phase.allowSpeech) return;
      if (generatingRef.current.has(card.id)) return;
      generatingRef.current.add(card.id);

      setActiveCharId(card.id);
      activeCharIdRef.current = card.id;
      setIsGenerating(true);
      setStreamingText('');
      setAwaitingUser(false);
      awaitingUserRef.current = false;

      const startedAt = Date.now();
      try {
        const remainingMs = phaseRemainingMs(phaseRef.current, startedAt, phaseConfig);
        const result = await generateAIReply(
          {
            card,
            topic: state.topic,
            jobTitle: state.jobTitle,
            history: messagesRef.current,
            phase: phase.promptPhase,
            currentKeyPoint: keyPointsRef.current[keyPointIndexRef.current] ?? null,
            keyPointDiscussionCount: keyPointCountRef.current,
            allKeyPointsDiscussed: keyPointIndexRef.current >= keyPointsRef.current.length,
            allKeyPoints: keyPointsRef.current,
            currentKeyPointIndex: keyPointIndexRef.current,
            voiceMode: voiceCaps?.outputMode === 'stepfun-tts',
            phaseRemainingMs: remainingMs,
            sessionId,
          },
          (chunk) => setStreamingText((prev) => prev + chunk)
        );

        const content = result.content?.trim();
        if (!content) throw new Error('空回复');

        const endedAt = Date.now();
        addMessage({
          id: `${Date.now()}-${card.id}`,
          senderId: card.id,
          senderName: card.name,
          content,
          timestamp: endedAt,
          type: 'message',
          startMs: startedAt - sessionStartAtRef.current,
          endMs: endedAt - sessionStartAtRef.current,
          emotion: result.emotion,
        });

        turnRef.current = registerSpeak(turnRef.current, card.id, endedAt);
        speakEndsAtRef.current = endedAt + estimateSpeakMs(content);
        pushEvents([
          {
            event_type: 'speak_grant',
            actor: card.id,
            target: 'all',
            timestamp_ms: endedAt - sessionStartAtRef.current,
          },
        ]);

        // 要点推进：达到上限或明确引导到下一要点
        maybeAdvanceKeyPoint(content);

        // 关键词辅助（兜底）：自由讨论中检测到总结引导 → 可提前进入总结
        if (phase.id === 'FREE_DISCUSSION' && shouldAdvanceByKeyword(content)) {
          const res = advancePhaseByKeyword(phaseRef.current, Date.now(), phaseConfig, sessionStartAtRef.current);
          if (res.changed) {
            phaseRef.current = res.state;
            setPhaseState(res.state);
            pushEvents(res.events);
          }
        }

        // TTS 播报（barge-in 由用户输入/说话触发）
        if (voiceCaps?.outputMode === 'stepfun-tts' && voiceRef.current) {
          setSpeakingCharId(card.id);
          try {
            await voiceRef.current.speak(content, {
              voiceId: card.voice.voice_id,
              rate: card.voice.rate,
              emotion: result.emotion,
              instruction: result.stepfun_tts_instruction,
            });
          } finally {
            setSpeakingCharId(null);
          }
        }
      } catch (err) {
        console.error('AI 发言失败:', err);
        setDegraded(true);
      } finally {
        generatingRef.current.delete(card.id);
        activeCharIdRef.current = null;
        setActiveCharId(null);
        setIsGenerating(false);
        setStreamingText('');
        // 调度下一个发言者（barge-in 后短暂等待用户）
        scheduleNextTurn();
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [addMessage, pushEvents, state.topic, state.jobTitle, sessionId, voiceCaps]
  );

  const triggerAITurnRef = useRef(triggerAITurn);
  useEffect(() => {
    triggerAITurnRef.current = triggerAITurn;
  }, [triggerAITurn]);

  function estimateSpeakMs(text: string): number {
    return Math.max(800, Math.min(6000, (text.length / 2.8) * 1000));
  }

  function maybeAdvanceKeyPoint(content: string) {
    if (keyPointsRef.current.length === 0 || keyPointIndexRef.current >= keyPointsRef.current.length) return;
    const hasGuidanceToNext =
      (content.includes('接下来') || content.includes('现在') || content.includes('应该') || content.includes('进入')) &&
      (content.includes('讨论') || content.includes('规划') || content.includes('设计') || content.includes('分析'));
    if (keyPointCountRef.current >= MAX_DISCUSSIONS_PER_KEY_POINT || hasGuidanceToNext) {
      if (keyPointIndexRef.current + 1 < keyPointsRef.current.length) {
        keyPointIndexRef.current += 1;
        keyPointCountRef.current = 0;
      } else {
        keyPointIndexRef.current = keyPointsRef.current.length;
      }
      setCurrentKeyPoint(keyPointsRef.current[keyPointIndexRef.current] ?? null);
    }
  }

  function shouldAdvanceByKeyword(content: string): boolean {
    // 辅助信号：明确出现总结/汇报引导且要点已讨论完（或阶段已过 80%）
    const hasSummaryGuidance =
      (content.includes('总结') && (content.includes('汇报') || content.includes('谁愿意') || content.includes('谁来'))) ||
      content.includes('我来总结') ||
      content.includes('我来汇报');
    if (!hasSummaryGuidance) return false;
    const progress = phaseProgress(phaseRef.current, Date.now(), phaseConfig);
    return keyPointIndexRef.current >= keyPointsRef.current.length || progress > 0.8;
  }

  // ---------- 调度 ----------
  const scheduleNextTurn = useCallback(
    (delayMs?: number) => {
      if (finishedRef.current) return;
      if (scheduledRef.current) clearTimeout(scheduledRef.current);

      const fire = () => {
        scheduledRef.current = null;
        if (finishedRef.current) return;
        const phase = currentPhase(phaseRef.current, phaseConfig);
        if (!phase.allowSpeech) return;
        if (generatingRef.current.size > 0) return;

        const now = Date.now();
        const urgency = stageUrgency(phaseRef.current, now, phaseConfig);
        const silenceMs = Math.max(0, now - Math.max(speakEndsAtRef.current, sessionStartAtRef.current));
        const decision = selectNextSpeaker(roles, turnRef.current, { now, stageUrgency: urgency, silenceMs });

        // barge-in 后 12 秒内优先等用户输入
        const sinceBarge = now - bargedInAtRef.current;
        if (sinceBarge >= 0 && sinceBarge < 12000 && decision.speakerId !== 'user') {
          scheduledRef.current = setTimeout(fire, 2000);
          return;
        }

        if (decision.speakerId === 'user') {
          setAwaitingUser(true);
          awaitingUserRef.current = true;
          turnRef.current = { ...turnRef.current, userCalledAt: now };
        } else {
          setAwaitingUser(false);
          awaitingUserRef.current = false;
          const card = roles.find((c) => c.id === decision.speakerId);
          if (card) {
            turnRef.current = registerUserMissedTurn(turnRef.current);
            triggerAITurnRef.current(card);
          }
        }
      };

      const delay = delayMs ?? 1200 + Math.random() * 1500;
      scheduledRef.current = setTimeout(fire, delay);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [roles]
  );

  // ---------- 主循环 ----------
  useEffect(() => {
    const interval = setInterval(() => {
      if (finishedRef.current) return;
      const now = Date.now();
      setNowTs(now);

      // 1) 倒计时推进（主信号）
      const res = tickPhase(phaseRef.current, now, phaseConfig, sessionStartAtRef.current);
      if (res.changed) {
        phaseRef.current = res.state;
        setPhaseState(res.state);
        pushEvents(res.events);
        if (res.state.finished) {
          finishSession();
          return;
        }
      }

      const phase = currentPhase(phaseRef.current, phaseConfig);

      // 2) 个人陈述：按顺序触发
      if (phase.id === 'OPENING') {
        const idx = phaseRef.current.openingIndex;
        const speaker = currentOpeningSpeaker(phaseRef.current, phaseConfig);
        if (speaker && !openingTriggeredRef.current.has(idx)) {
          openingTriggeredRef.current.add(idx);
          if (speaker === 'user') {
            setAwaitingUser(true);
            awaitingUserRef.current = true;
            turnRef.current = { ...turnRef.current, userCalledAt: now };
            setAwaitingUser(true);
            turnRef.current = { ...turnRef.current, userCalledAt: now };
          } else {
            const card = roles.find((c) => c.id === speaker);
            if (card) triggerAITurnRef.current(card);
          }
        }
        return;
      }

      if (phase.id === 'READING') return;

      // 3) 自由讨论 / 总结：打断规则 + 发言权调度
      // 3a. 用户被点名 5 秒未回应 → 其他 AI 接话
      const noResp = evaluateUserCalledNoResponse(roles, turnRef.current, now);
      if (noResp.type === 'interrupt') {
        turnRef.current = registerInterrupt(turnRef.current, noResp.targetId, noResp.interrupterId);
        pushEvents([
          {
            event_type: 'interrupt',
            actor: noResp.interrupterId,
            target: noResp.targetId,
            timestamp_ms: now - sessionStartAtRef.current,
            metadata: { rule: noResp.rule },
          },
        ]);
        // 接管后重置计数，避免「强制分配→5秒接管→再强制分配」死循环（B.6 语义修正）
        turnRef.current = { ...turnRef.current, userCalledAt: null, userMissedTurns: 0 };
        setAwaitingUser(false);
        const card = roles.find((c) => c.id === noResp.interrupterId);
        if (card) triggerAITurnRef.current(card);
        return;
      }

      // 3b. 发言超时打断（用户 >30s / AI >40s）
      if (now < speakEndsAtRef.current && turnRef.current.currentSpeaker) {
        const interrupt = evaluateInterrupt(roles, turnRef.current, now);
        if (interrupt.type === 'interrupt') {
          voiceRef.current?.bargeIn();
          setSpeakingCharId(null);
          turnRef.current = registerInterrupt(turnRef.current, interrupt.targetId, interrupt.interrupterId);
          pushEvents([
            {
              event_type: 'interrupt',
              actor: interrupt.interrupterId,
              target: interrupt.targetId,
              timestamp_ms: now - sessionStartAtRef.current,
              metadata: { rule: interrupt.rule },
            },
          ]);
          const card = roles.find((c) => c.id === interrupt.interrupterId);
          if (card) triggerAITurnRef.current(card);
          return;
        }
      }

      // 3c. 冷场/等待用户超时 → 调度
      const nobodyActive = generatingRef.current.size === 0 && !activeCharIdRef.current;
      const userWaitingTooLong =
        awaitingUserRef.current && turnRef.current.userCalledAt !== null && now - turnRef.current.userCalledAt > 8000;
      if ((nobodyActive && !scheduledRef.current) || userWaitingTooLong) {
      }
    }, TICK_MS);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pushEvents, scheduleNextTurn, finishSession]);

  // ---------- 滚动 ----------
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, streamingText]);

  // ---------- 用户发言 ----------
  const handleSendMessage = () => {
    const text = inputValue.trim();
    if (!text || finishedRef.current) return;

    // barge-in v1：用户输入即停止 AI 播报（TC-04：300ms 内停止）
    voiceRef.current?.bargeIn();
    setSpeakingCharId(null);
    bargedInAtRef.current = Date.now();

    const sentAt = Date.now();
    const msg: Message = {
      id: `${sentAt}-user`,
      senderId: 'user',
      senderName: USER_INFO.name,
      content: text,
      timestamp: sentAt,
      type: 'message',
      startMs: sentAt - sessionStartAtRef.current,
      endMs: sentAt - sessionStartAtRef.current + estimateSpeakMs(text),
    };
    addMessage(msg);
    setInputValue('');
    setAwaitingUser(false);
    awaitingUserRef.current = false;

    turnRef.current = registerSpeak(turnRef.current, 'user', sentAt);
    speakEndsAtRef.current = sentAt + estimateSpeakMs(text);

    // 用户发言也可能推进要点
    maybeAdvanceKeyPoint(text);

    // AI 在用户说完后自然回应
    const delay = estimateSpeakMs(text) + 800 + Math.random() * 800;
    scheduleNextTurn(delay);
  };

  // ---------- 语音输入 ----------
  const toggleListening = async () => {
    const voice = voiceRef.current;
    if (!voice) return;
    // 抢话：AI 播报中用户开始说话 → barge-in
    if (!isListening && (speakingCharId || isGenerating)) {
      voice.bargeIn();
      setSpeakingCharId(null);
      bargedInAtRef.current = Date.now();
    }
    if (isListening) {
      const finalText = await voice.stopAsr();
      setIsListening(false);
      setAsrPartial('');
      if (finalText) setInputValue((prev) => (prev ? `${prev}${finalText}` : finalText));
      return;
    }
    setIsListening(true);
    await voice.startAsr(
      (partial) => setAsrPartial(partial),
      (final) => {
        setAsrPartial('');
        setInputValue((prev) => (prev ? `${prev}${final}` : final));
      }
    );
  };

  // ---------- 渲染 ----------
  const phase = currentPhase(phaseState, phaseConfig);
  const remaining = phaseRemainingMs(phaseState, nowTs, phaseConfig);
  const progress = phaseProgress(phaseState, nowTs, phaseConfig);
  const openingSpeaker = currentOpeningSpeaker(phaseState, phaseConfig);
  const openingRemaining =
    phase.id === 'OPENING'
      ? Math.max(0, OPENING_TURN_MS - (nowTs - phaseState.openingStartedAt))
      : 0;
  const displayRemaining = phase.id === 'OPENING' ? Math.min(remaining, openingRemaining) : remaining;

  return (
    <div className="flex h-full bg-slate-50 overflow-hidden relative flex-col md:flex-row">
      {/* 主列（桌面 + 移动端共用） */}
      <div className="flex-1 flex flex-col min-w-0">
      {/* 顶部：阶段 + 倒计时 + 题目折叠 */}
      <div className="bg-white border-b border-slate-200 p-3 md:p-4 shadow-sm z-10">
        <div className="flex justify-between items-center mb-3">
          <div className="flex items-center gap-3">
            <div className="p-2 bg-blue-50 rounded-xl text-blue-600">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zM9.555 7.168A1 1 0 008 8v4a1 1 0 001.555.832l3-2a1 1 0 000-1.664l-3-2z" clipRule="evenodd" />
              </svg>
            </div>
            <div>
              <h2 className="text-sm font-black text-slate-800 tracking-tight">
                {phase.label}
                {phase.id === 'OPENING' && openingSpeaker && (
                  <span className="ml-2 text-blue-600">
                    {openingSpeaker === 'user' ? '轮到你陈述' : `${roles.find((c) => c.id === openingSpeaker)?.name ?? ''} 陈述中`}
                  </span>
                )}
              </h2>
              <div className="flex items-center gap-2 mt-1">
                <div className="h-1 w-32 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-blue-600 transition-all duration-500" style={{ width: `${progress * 100}%` }} />
                </div>
                <span className="text-[10px] text-slate-400 font-bold">阶段进度</span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            <div className="text-right">
              <div className="text-2xl font-black text-slate-900 tabular-nums">{formatCountdown(displayRemaining)}</div>
              <div className="text-[10px] text-slate-400 font-bold uppercase">剩余时间</div>
            </div>
            <button
              onClick={() => setTopicOpen((v) => !v)}
              className="px-3 py-2 bg-slate-100 text-slate-600 rounded-xl text-xs font-bold hover:bg-slate-200 md:hidden"
            >
              {topicOpen ? '收起题目' : '查看题目'}
            </button>
            <button
              onClick={() => finishSession()}
              className="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-black hover:bg-slate-700 shadow-lg active:scale-95"
            >
              提交评估
            </button>
          </div>
        </div>

        {degraded && (
          <div className="text-[11px] text-amber-600 bg-amber-50 border border-amber-200 rounded-lg px-3 py-1.5">
            ⚠️ 部分能力降级中（LLM/语音异常已自动降级），讨论仍可继续
          </div>
        )}

      </div>

      {/* 移动端：可折叠题目卡 */}
      {topicOpen && (
        <div className="md:hidden mx-3 mt-2 p-3 bg-white rounded-xl border border-slate-100 max-h-40 overflow-y-auto">
          <div className="text-[11px] font-black text-slate-800 uppercase tracking-widest mb-1">题目</div>
          <p className="text-[13px] text-slate-600 leading-relaxed font-medium whitespace-pre-wrap">{state.topic}</p>
          {currentKeyPoint && <div className="mt-2 text-[11px] text-blue-600 font-bold">当前要点：{currentKeyPoint}</div>}
        </div>
      )}

      {/* 形象台（移动端横向滑动；桌面见右侧栏） */}
      <div className="md:hidden px-3 pt-3">
        <AvatarStage
          cards={roles}
          activeCardId={activeCharId}
          speakingCardId={speakingCharId}
          cameraEnabled={cameraOn}
          facingMode={facingMode}
          micOn={micOn}
          userStream={userStreamRef.current}
        />
      </div>

      {/* 发言区 */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto p-4 space-y-4 scrollbar-hide bg-[#f8fafc]">
        {phase.id === 'READING' && (
          <div className="text-center py-10">
            <div className="text-4xl mb-3">📖</div>
            <div className="text-lg font-bold text-slate-700">审题阶段</div>
            <p className="text-sm text-slate-500 mt-1">请阅读题目，倒计时结束后进入个人陈述（每人 1 分钟）</p>
          </div>
        )}

        {messages.map((msg) => {
          const isUser = msg.senderId === 'user';
          const card = roles.find((c) => c.id === msg.senderId);
          return (
            <div key={msg.id} className={`flex ${isUser ? 'justify-end' : 'justify-start'} animate-in fade-in slide-in-from-bottom-3 duration-500`}>
              <div className={`max-w-[80%] rounded-2xl px-5 py-4 shadow-sm ${isUser ? 'bg-slate-900 text-white rounded-tr-none' : 'bg-white text-slate-800 rounded-tl-none border border-slate-200/50'}`}>
                {!isUser && card && (
                  <div className="flex items-center mb-2 gap-2">
                    <span className="text-[10px] font-black text-blue-600 uppercase tracking-widest">{card.name}</span>
                    {msg.emotion && msg.emotion !== 'neutral' && (
                      <span className="text-[9px] px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500 font-bold">{msg.emotion}</span>
                    )}
                  </div>
                )}
                <p className="text-[14px] leading-relaxed whitespace-pre-wrap font-medium">{msg.content}</p>
              </div>
            </div>
          );
        })}

        {isGenerating && streamingText && (
          <div className="flex justify-start">
            <div className="max-w-[80%] bg-white border border-slate-200 rounded-2xl px-5 py-4 shadow-sm">
              <p className="text-[14px] leading-relaxed whitespace-pre-wrap font-medium text-slate-800">{streamingText}</p>
              <span className="inline-block w-1.5 h-4 bg-blue-500 animate-pulse ml-0.5" />
            </div>
          </div>
        )}

        {isGenerating && !streamingText && (
          <div className="flex justify-start">
            <div className="bg-white border border-slate-200 rounded-2xl px-4 py-3 shadow-sm flex items-center gap-3">
              <div className="typing-indicator flex space-x-1">
                <span></span>
                <span></span>
                <span></span>
              </div>
              <span className="text-[11px] font-bold text-slate-400">思考中</span>
            </div>
          </div>
        )}

        {awaitingUser && (
          <div className="text-center">
            <span className="inline-block bg-blue-50 text-blue-600 text-xs font-bold px-4 py-2 rounded-full animate-pulse">
              🎤 轮到你发言（说点什么或输入文字）
            </span>
          </div>
        )}
      </div>

      {/* 发言轨迹（PRD 4.1.3 底部发言时间轴） */}
      {messages.length > 0 && (
        <div className="px-3 md:px-4 py-1.5 bg-white border-t border-slate-50 flex items-center gap-2">
          <span className="text-[10px] text-slate-400 font-bold shrink-0">发言轨迹</span>
          <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {messages.slice(-50).map((m) => (
              <span
                key={m.id}
                title={`${m.senderName}：${m.content.slice(0, 30)}`}
                className={`h-2 rounded-full shrink-0 ${m.senderId === 'user' ? 'bg-slate-900 w-7' : 'bg-indigo-300 w-3.5'}`}
              />
            ))}
          </div>
          <span className="text-[10px] text-slate-400 shrink-0">共 {messages.length} 次发言</span>
        </div>
      )}
      {/* 底部输入 */}
      <div className="p-3 md:p-4 bg-white border-t border-slate-100">
        <div className="max-w-4xl mx-auto flex gap-2 md:gap-3 items-end">
          <button
            onClick={() => setMicOn((v) => !v)}
            className={`p-3 rounded-2xl shrink-0 ${micOn ? 'bg-slate-100 text-slate-600' : 'bg-red-500 text-white'}`}
            title={micOn ? '静音' : '取消静音'}
          >
            {micOn ? '🎙️' : '🔇'}
          </button>
          <button
            onClick={() => setCameraOn((v) => !v)}
            className={`p-3 rounded-2xl shrink-0 ${cameraOn ? 'bg-slate-100 text-slate-600' : 'bg-slate-200 text-slate-400'}`}
            title={cameraOn ? '关闭摄像头' : '开启摄像头'}
          >
            {cameraOn ? '📷' : '📵'}
          </button>
          <div className="flex-1 relative">
            <textarea
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder={
                voiceCaps?.inputMode === 'text'
                  ? '纯文字模式：输入你的观点...'
                  : isListening
                    ? asrPartial || '正在录音，再次点击麦克风结束...'
                    : '输入观点，或点击麦克风语音发言...'
              }
              className={`w-full bg-slate-50 border border-slate-200 focus:border-blue-500 focus:bg-white rounded-2xl pl-5 pr-14 py-4 text-sm text-slate-900 resize-none h-20 transition-all outline-none ${
                isListening ? 'ring-4 ring-blue-100 border-blue-500' : ''
              }`}
            />
            <button
              onClick={toggleListening}
              disabled={voiceCaps?.inputMode === 'text'}
              className={`absolute right-4 bottom-4 p-2.5 rounded-full transition-all ${
                isListening ? 'bg-red-500 text-white animate-pulse' : 'bg-slate-200 text-slate-500 hover:bg-slate-300'
              } disabled:opacity-30`}
              title={voiceCaps?.inputMode === 'text' ? '当前环境不支持语音输入' : '语音输入'}
            >
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M7 4a3 3 0 016 0v4a3 3 0 11-6 0V4zm4 10.93A7.001 7.001 0 0017 8a1 1 0 10-2 0A5 5 0 015 8a1 1 0 00-2 0 7.001 7.001 0 006 6.93V17H6a1 1 0 100 2h8a1 1 0 100-2h-3v-2.07z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
          <button
            onClick={handleSendMessage}
            disabled={!inputValue.trim()}
            className="bg-slate-900 text-white w-16 h-20 rounded-2xl flex flex-col items-center justify-center hover:bg-blue-600 disabled:opacity-30 transition-all shadow-xl active:scale-95 shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 mb-1" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={3} d="M12 19l9 2-9-18-9 18 9-2zm0 0v-8" />
            </svg>
            <span className="text-[10px] font-black uppercase">发送</span>
          </button>
        </div>
        <div className="max-w-4xl mx-auto mt-2 flex items-center justify-between text-[10px] text-slate-400">
          <span>
            语音输入：{voiceCaps?.inputMode === 'stepfun-asr' ? 'StepFun ASR' : voiceCaps?.inputMode === 'webspeech' ? '浏览器语音（兜底）' : '纯文字（降级）'}
            {' · '}
            语音输出：{voiceCaps?.outputMode === 'stepfun-tts' ? 'StepFun TTS' : '纯文字（降级）'}
          </span>
          <span>发言权由调度器分配 · 倒计时到点强制切换阶段</span>
        </div>
      </div>
      </div>

      {/* 桌面右侧栏：题目卡 + 角色形象 + 阶段说明 + 发言权提示（PRD 4.1.3 桌面布局） */}
      <aside className="hidden md:flex md:w-80 lg:w-96 border-l border-slate-200 bg-white flex-col overflow-y-auto p-4 gap-4 shrink-0">
        <div>
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 bg-slate-900 text-white rounded-xl flex items-center justify-center shadow-lg">
              <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10.392A7.968 7.968 0 015.5 14c1.255 0 2.443.29 3.5.804V4.804zM11 4.804A7.968 7.968 0 0114.5 4c1.255 0-2.443.29-3.5.804v10.392a7.968 7.968 0 003.5-.804c1.255 0 2.443.29 3.5.804V4.804z" />
              </svg>
            </div>
            <h3 className="text-lg font-black text-slate-900 tracking-tight">题目</h3>
          </div>
          <div className="p-4 bg-slate-50 rounded-2xl border border-slate-100 max-h-56 overflow-y-auto">
            <p className="text-[13px] text-slate-600 leading-relaxed font-medium whitespace-pre-wrap">{state.topic}</p>
            {currentKeyPoint && <div className="mt-2 text-[11px] text-blue-600 font-bold">当前要点：{currentKeyPoint}</div>}
          </div>
        </div>

        <div>
          <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest mb-2">面试官形象</h3>
          <div className="grid grid-cols-2 gap-2">
            {roles.map((card) => {
              const preset = findAvatarPreset(card.avatar.preset_id);
              const isSpeaking = speakingCharId === card.id;
              const isActive = activeCharId === card.id;
              return (
                <div
                  key={card.id}
                  className={`flex flex-col items-center p-2 rounded-xl border transition-all ${
                    isSpeaking ? 'border-indigo-500 bg-indigo-50 shadow' : isActive ? 'border-indigo-300 bg-white' : 'border-slate-100 bg-slate-50 opacity-70'
                  }`}
                >
                  <img src={preset?.asset_url} alt={card.name} className={`w-12 h-12 rounded-full ${isSpeaking ? 'ring-2 ring-indigo-400' : ''}`} />
                  <span className="mt-1 text-[11px] font-semibold text-slate-700 whitespace-nowrap">{card.name}</span>
                  <span className="text-[9px] text-slate-400 whitespace-nowrap">{card.voice.voice_id.replace('stepfun_', '')} · ×{card.voice.rate}</span>
                </div>
              );
            })}
          </div>
        </div>

        <div>
          <h3 className="text-xs font-black text-slate-800 uppercase tracking-widest mb-2">阶段说明</h3>
          <ol className="text-[11px] text-slate-500 space-y-1 list-decimal pl-4">
            <li>审题（2 分钟，不发言）</li>
            <li>个人陈述（每人 1 分钟）</li>
            <li>自由讨论（≤15 分钟，可打断）</li>
            <li>总结陈词（3 分钟）</li>
          </ol>
        </div>

        <div className="mt-auto p-4 bg-blue-50/60 rounded-2xl border border-blue-100">
          <div className="flex items-center gap-2 mb-2">
            <span className="relative flex h-2 w-2">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-blue-500 opacity-75"></span>
              <span className="relative inline-flex rounded-full h-2 w-2 bg-blue-500"></span>
            </span>
            <span className="text-[10px] font-black text-blue-600 uppercase tracking-wider">发言权提示</span>
          </div>
          <p className="text-[11px] text-blue-700 font-medium leading-relaxed">
            {awaitingUser
              ? '当前发言权在你手中，请发表观点。'
              : speakingCharId
                ? `${roles.find((c) => c.id === speakingCharId)?.name ?? 'AI'} 正在发言，你可以随时抢话（barge-in）。`
                : isGenerating
                  ? 'AI 正在思考...'
                  : '等待调度器分配发言权...'}
          </p>
        </div>
      </aside>
    </div>
  );
};

export default DiscussionPanel;
