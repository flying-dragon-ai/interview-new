import type { GameEvent, PhaseDef, PhaseId } from '../types';

/**
 * 真实计时四阶段引擎（PRD 4.1.3 / 附录 B.3）
 * 审题 10s → 个人陈述每人 1min → 自由讨论 ≤15min → 总结 3min
 * - 倒计时为阶段推进主信号；关键词检测降级为辅助/兜底（D4）
 * - 废弃 25 轮上限，改为时间盒；要点跟踪（每要点 10 次）保留
 */

export const PHASE_DEFS: PhaseDef[] = [
  {
    id: 'READING',
    label: '审题',
    promptPhase: '审题阶段（阅读题目，暂不发言）',
    durationMs: 10 * 1000,
    allowSpeech: false,
  },
  {
    id: 'OPENING',
    label: '个人陈述',
    promptPhase: '开局框架阶段',
    durationMs: 4 * 60 * 1000, // 4 人（3 AI + 用户）× 每人 1min
    allowSpeech: true,
  },
  {
    id: 'FREE_DISCUSSION',
    label: '自由讨论',
    promptPhase: '深入讨论与方案贡献',
    durationMs: 15 * 60 * 1000,
    allowSpeech: true,
  },
  {
    id: 'SUMMARY',
    label: '总结陈词',
    promptPhase: '引导与总结陈词',
    durationMs: 3 * 60 * 1000,
    allowSpeech: true,
  },
];

/** 个人陈述每人的时长（PRD：每人 1min） */
export const OPENING_TURN_MS = 60 * 1000;

export interface PhaseConfig {
  /** 阶段时长覆盖（测试用） */
  durationsMs?: Partial<Record<PhaseId, number>>;
  /** 个人陈述发言顺序（speaker id 列表，'user' 表示用户） */
  openingOrder?: string[];
}

export interface PhaseState {
  phaseIndex: number;
  phaseStartedAt: number;
  /** 个人陈述当前发言者下标 */
  openingIndex: number;
  openingStartedAt: number;
  finished: boolean;
}

export interface TickResult {
  state: PhaseState;
  /** 本次 tick 产生的事件（stage_change / finished） */
  events: GameEvent[];
  changed: boolean;
}

export function getPhaseDefs(config?: PhaseConfig): PhaseDef[] {
  if (!config?.durationsMs) return PHASE_DEFS;
  return PHASE_DEFS.map((p) => ({
    ...p,
    durationMs: config.durationsMs?.[p.id] ?? p.durationMs,
  }));
}

export function initPhaseEngine(now: number, config?: PhaseConfig): PhaseState {
  return {
    phaseIndex: 0,
    phaseStartedAt: now,
    openingIndex: 0,
    openingStartedAt: now,
    finished: false,
  };
}

export function currentPhase(state: PhaseState, config?: PhaseConfig): PhaseDef {
  return getPhaseDefs(config)[Math.min(state.phaseIndex, PHASE_DEFS.length - 1)];
}

export function phaseRemainingMs(state: PhaseState, now: number, config?: PhaseConfig): number {
  const def = currentPhase(state, config);
  return Math.max(0, def.durationMs - (now - state.phaseStartedAt));
}

/** 个人陈述当前发言者（仅 OPENING 阶段有效） */
export function currentOpeningSpeaker(
  state: PhaseState,
  config?: PhaseConfig
): string | null {
  const order = config?.openingOrder ?? [];
  if (currentPhase(state, config).id !== 'OPENING') return null;
  if (state.openingIndex >= order.length) return null;
  return order[state.openingIndex];
}

/** 阶段紧急度 0-1（发言权调度 w2 权重用）：越接近阶段结束越高 */
export function stageUrgency(state: PhaseState, now: number, config?: PhaseConfig): number {
  if (state.finished) return 1;
  const def = currentPhase(state, config);
  const elapsed = now - state.phaseStartedAt;
  const ratio = Math.min(1, elapsed / def.durationMs);
  // 自由讨论最后 3 分钟与总结阶段线性拉升
  if (def.id === 'FREE_DISCUSSION') {
    const lastThreeMin = 3 * 60 * 1000;
    const remain = def.durationMs - elapsed;
    return remain <= lastThreeMin ? (lastThreeMin - remain) / lastThreeMin : 0;
  }
  return ratio;
}

function makeEvent(type: GameEvent['event_type'], actor: string, target: string, now: number, metadata?: Record<string, unknown>): GameEvent {
  return { event_type: type, actor, target, timestamp_ms: now, metadata };
}

/**
 * 推进引擎。倒计时到点必须切换（TC-01：与关键词检测冲突时以倒计时为准）。
 */
export function tickPhase(
  state: PhaseState,
  now: number,
  config?: PhaseConfig,
  sessionStartAt: number = now
): TickResult {
  if (state.finished) return { state, events: [], changed: false };

  const defs = getPhaseDefs(config);
  const def = defs[Math.min(state.phaseIndex, defs.length - 1)];
  const events: GameEvent[] = [];
  let next = state;

  const phaseElapsed = now - state.phaseStartedAt;
  const openingOrder = config?.openingOrder ?? [];

  if (def.id === 'OPENING') {
    // 个人陈述：每人 1min，轮流推进
    const turnElapsed = now - state.openingStartedAt;
    if (turnElapsed >= OPENING_TURN_MS || state.openingIndex >= openingOrder.length) {
      if (state.openingIndex + 1 < openingOrder.length) {
        next = {
          ...next,
          openingIndex: state.openingIndex + 1,
          openingStartedAt: now,
        };
        events.push(
          makeEvent(
            'speak_grant',
            openingOrder[next.openingIndex],
            'all',
            now - sessionStartAt,
            { reason: 'opening_turn', turn: next.openingIndex }
          )
        );
        return { state: next, events, changed: true };
      }
      // 全部人陈述完 → 自由讨论
      next = {
        ...next,
        phaseIndex: Math.min(state.phaseIndex + 1, defs.length - 1),
        phaseStartedAt: now,
      };
      events.push(makeEvent('stage_change', 'system', defs[next.phaseIndex].id, now - sessionStartAt, { reason: 'opening_done' }));
      return { state: next, events, changed: true };
    }
    return { state, events: [], changed: false };
  }

  if (phaseElapsed >= def.durationMs) {
    const nextIndex = state.phaseIndex + 1;
    if (nextIndex >= defs.length) {
      // 总结阶段结束 → 整场结束
      next = { ...next, finished: true };
      events.push(makeEvent('stage_change', 'system', 'FINISHED', now - sessionStartAt, { reason: 'countdown_end' }));
      return { state: next, events, changed: true };
    }
    next = { ...next, phaseIndex: nextIndex, phaseStartedAt: now };
    if (defs[nextIndex].id === 'OPENING') {
      next = { ...next, openingIndex: 0, openingStartedAt: now };
    }
    events.push(
      makeEvent('stage_change', 'system', defs[nextIndex].id, now - sessionStartAt, {
        reason: 'countdown',
        from: def.id,
      })
    );
    return { state: next, events, changed: true };
  }

  return { state, events: [], changed: false };
}

/**
 * 关键词辅助推进（兜底）：仅在倒计时未到点且满足关键词条件时允许提前进入下一阶段。
 * 倒计时永远优先（TC-01）。
 */
export function advancePhaseByKeyword(
  state: PhaseState,
  now: number,
  config?: PhaseConfig,
  sessionStartAt: number = now
): TickResult {
  if (state.finished) return { state, events: [], changed: false };
  const defs = getPhaseDefs(config);
  const def = defs[Math.min(state.phaseIndex, defs.length - 1)];
  // 仅允许：自由讨论 → 总结（关键词检测到总结引导时提前收尾）
  if (def.id !== 'FREE_DISCUSSION') return { state, events: [], changed: false };
  const nextIndex = state.phaseIndex + 1;
  if (nextIndex >= defs.length) return { state, events: [], changed: false };
  const next = { ...state, phaseIndex: nextIndex, phaseStartedAt: now };
  return {
    state: next,
    events: [makeEvent('stage_change', 'system', defs[nextIndex].id, now - sessionStartAt, { reason: 'keyword', from: def.id })],
    changed: true,
  };
}

/** 阶段进度 0-1（UI 进度条） */
export function phaseProgress(state: PhaseState, now: number, config?: PhaseConfig): number {
  const def = currentPhase(state, config);
  const elapsed = now - state.phaseStartedAt;
  return Math.min(1, elapsed / def.durationMs);
}

/** mm:ss 格式化 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}
