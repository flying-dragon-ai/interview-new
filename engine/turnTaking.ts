import type { RoleCard } from '../types';

/**
 * 发言权调度 v1（PRD 4.1.4 / 附录 B）
 * B.3 打分公式 + B.5 打断规则 + B.6 用户发言保护。
 * 在现有洗牌队列 + 用户保护基础上叠加打分公式（洗牌队列保留为兜底）。
 */

export const TURN_WEIGHTS = {
  w1: 0.25, // persona.speak_probability
  w2: 0.2, // stage_urgency
  w3: 0.15, // silence_duration
  w4: 0.2, // 1 - recent_speak_ratio
  w5: 0.15, // topic_relevance
  w6: 0.05, // interrupt_penalty
} as const;

/** 打断规则阈值（附录 B.5） */
export const INTERRUPT_RULES = {
  /** 用户发言超 30 秒，高冲突角色可打断 */
  userSpeakMs: 30_000,
  /** AI 发言超 40 秒，其他 AI 可抢话 */
  aiSpeakMs: 40_000,
  /** 用户被点名 5 秒未回应，其他 AI 接话 */
  userCalledMs: 5_000,
  /** 同一 AI 连续发言 3 次，强制让出 */
  maxConsecutive: 3,
} as const;

/** 用户保护（附录 B.6） */
export const USER_PROTECTION = {
  /** 用户发言前 3 秒不被打断 */
  protectMs: 3_000,
  /** 被打断后下次发言意愿分加成 */
  interruptBonus: 0.3,
  /** 连续 2 次未获发言权，强制分配一次 */
  missedTurnsForceGrant: 2,
} as const;

/** 最近发言统计窗口 */
const RECENT_WINDOW_MS = 60_000;

export interface TurnTakingState {
  /** speaker → 最近发言时间戳列表（窗口内） */
  recentSpeaks: Record<string, number[]>;
  /** speaker → 连续发言次数 */
  consecutiveSpeaks: Record<string, number>;
  /** speaker → 打断罚分（可累加） */
  interruptPenalty: Record<string, number>;
  /** speaker → 主题相关度 0-1 */
  topicRelevance: Record<string, number>;
  /** 用户发言保护截止时间戳 */
  userProtectedUntil: number;
  /** 用户被打断后的意愿加成 */
  userInterruptBonus: number;
  /** 用户连续未获发言权次数 */
  userMissedTurns: number;
  /** 当前发言者 */
  currentSpeaker: string | null;
  /** 当前发言开始时间 */
  currentSpeakStartAt: number | null;
  /** 用户被点名时间（无人回应时其他 AI 接话） */
  userCalledAt: number | null;
}

export function createTurnState(): TurnTakingState {
  return {
    recentSpeaks: {},
    consecutiveSpeaks: {},
    interruptPenalty: {},
    topicRelevance: {},
    userProtectedUntil: 0,
    userInterruptBonus: 0,
    userMissedTurns: 0,
    currentSpeaker: null,
    currentSpeakStartAt: null,
    userCalledAt: null,
  };
}

export interface ScoreContext {
  now: number;
  /** 阶段紧急度 0-1（phaseEngine.stageUrgency） */
  stageUrgency: number;
  /** 当前冷场时长（无人发言）ms */
  silenceMs: number;
  /** 用户被打断加成（B.6） */
  userInterruptBonus?: number;
}

function clamp01(x: number): number {
  return Math.max(0, Math.min(1, x));
}

function pick<T>(arr: T[], rng: () => number): T {
  return arr[Math.floor(rng() * arr.length)];
}

/** 最近发言占比：该 speaker 窗口内发言次数 / 窗口内总发言次数 */
export function recentSpeakRatio(state: TurnTakingState, speaker: string, now: number): number {
  const windowStart = now - RECENT_WINDOW_MS;
  let total = 0;
  let mine = 0;
  for (const [id, times] of Object.entries(state.recentSpeaks)) {
    const count = times.filter((t) => t >= windowStart).length;
    total += count;
    if (id === speaker) mine = count;
  }
  if (total === 0) return 0;
  return mine / total;
}

/** AI 角色发言意愿分（B.3 公式） */
export function computeSpeakScore(
  card: RoleCard,
  state: TurnTakingState,
  ctx: ScoreContext
): number {
  const w = TURN_WEIGHTS;
  const silence = clamp01(ctx.silenceMs / 15_000);
  const ratio = recentSpeakRatio(state, card.id, ctx.now);
  const relevance = state.topicRelevance[card.id] ?? 0.5;
  const penalty = state.interruptPenalty[card.id] ?? 0;
  return (
    w.w1 * card.behavior.speak_probability +
    w.w2 * clamp01(ctx.stageUrgency) +
    w.w3 * silence +
    w.w4 * (1 - ratio) +
    w.w5 * relevance -
    w.w6 * penalty
  );
}

/** 用户发言意愿分（B.3 公式对用户的适配版 + B.6 加成） */
export function computeUserSpeakScore(state: TurnTakingState, ctx: ScoreContext): number {
  const w = TURN_WEIGHTS;
  const silence = clamp01(ctx.silenceMs / 15_000);
  const ratio = recentSpeakRatio(state, 'user', ctx.now);
  const bonus = ctx.userInterruptBonus ?? state.userInterruptBonus ?? 0;
  return (
    w.w2 * clamp01(ctx.stageUrgency) +
    w.w3 * silence +
    w.w4 * (1 - ratio) +
    w.w5 * (state.topicRelevance.user ?? 0.5) +
    bonus
  );
}

export interface SpeakerDecision {
  speakerId: string;
  score: number;
  reason: 'score' | 'force_grant_user' | 'force_yield' | 'fallback_shuffle';
}

/**
 * 选择下一个发言者。
 * 优先级：B.6 用户强制分配 > B.5 连续 3 次强制让出 > 打分公式 > 洗牌兜底。
 */
export function selectNextSpeaker(
  cards: RoleCard[],
  state: TurnTakingState,
  ctx: ScoreContext,
  rng: () => number = Math.random
): SpeakerDecision {
  const candidates = cards.filter((c) => c.id !== state.currentSpeaker);

  // B.6：用户连续 2 次未获发言权 → 强制分配一次
  if (state.userMissedTurns >= USER_PROTECTION.missedTurnsForceGrant) {
    return { speakerId: 'user', score: 1, reason: 'force_grant_user' };
  }

  // B.5：同一 AI 连续发言 3 次 → 强制让出（该 AI 不再参与本轮竞争）
  const eligible = candidates.filter(
    (c) => (state.consecutiveSpeaks[c.id] ?? 0) < INTERRUPT_RULES.maxConsecutive
  );
  const pool = eligible.length > 0 ? eligible : candidates;
  if (pool.length === 0) {
    return { speakerId: 'user', score: 0, reason: 'fallback_shuffle' };
  }

  let best = pool[0];
  let bestScore = computeSpeakScore(best, state, ctx);
  const ties: RoleCard[] = [pool[0]];
  for (const c of pool.slice(1)) {
    const s = computeSpeakScore(c, state, ctx);
    if (s > bestScore + 1e-9) {
      best = c;
      bestScore = s;
      ties.length = 0;
      ties.push(c);
    } else if (Math.abs(s - bestScore) <= 1e-9) {
      ties.push(c);
    }
  }

  // B.1：洗牌队列兜底——打平或全部零分时随机（避免可预测/冷场）
  if (bestScore <= 0 || ties.length > 1) {
    best = pick(ties, rng);
    return { speakerId: best.id, score: bestScore, reason: 'fallback_shuffle' };
  }
  const reason: SpeakerDecision['reason'] =
    (state.consecutiveSpeaks[best.id] ?? 0) >= INTERRUPT_RULES.maxConsecutive ? 'force_yield' : 'score';
  return { speakerId: best.id, score: bestScore, reason };
}

export type InterruptDecision =
  | { type: 'none' }
  | {
      type: 'interrupt';
      interrupterId: string;
      targetId: string;
      rule: 'user_over_30s' | 'ai_over_40s' | 'user_called_no_response';
    };

/**
 * B.5 打断规则评估。rng 用于 interrupt_probability 掷骰（可注入以便测试）。
 */
export function evaluateInterrupt(
  cards: RoleCard[],
  state: TurnTakingState,
  now: number,
  rng: () => number = Math.random
): InterruptDecision {
  const speaker = state.currentSpeaker;
  const startedAt = state.currentSpeakStartAt;
  if (!speaker || startedAt === null) return { type: 'none' };
  const elapsed = now - startedAt;

  if (speaker === 'user') {
    // B.6：用户发言前 3 秒保护
    if (now < state.userProtectedUntil) return { type: 'none' };
    // 用户发言超 30 秒 → 高冲突角色可打断
    if (elapsed >= INTERRUPT_RULES.userSpeakMs) {
      const aggressors = cards.filter((c) => c.persona.conflict_level === 'high');
      for (const c of aggressors) {
        if (rng() < c.behavior.interrupt_probability) {
          return { type: 'interrupt', interrupterId: c.id, targetId: 'user', rule: 'user_over_30s' };
        }
      }
    }
    return { type: 'none' };
  }

  // AI 发言超 40 秒 → 其他 AI 可抢话
  if (elapsed >= INTERRUPT_RULES.aiSpeakMs) {
    const others = cards.filter((c) => c.id !== speaker);
    for (const c of others) {
      if (rng() < c.behavior.interrupt_probability * 0.8) {
        return { type: 'interrupt', interrupterId: c.id, targetId: speaker, rule: 'ai_over_40s' };
      }
    }
  }
  return { type: 'none' };
}

/** 用户被点名后 5 秒未回应 → 其他 AI 接话 */
export function evaluateUserCalledNoResponse(
  cards: RoleCard[],
  state: TurnTakingState,
  now: number
): InterruptDecision {
  if (state.userCalledAt === null) return { type: 'none' };
  if (now - state.userCalledAt < INTERRUPT_RULES.userCalledMs) return { type: 'none' };
  const responder = cards.find((c) => c.id !== state.currentSpeaker) ?? cards[0];
  if (!responder) return { type: 'none' };
  return { type: 'interrupt', interrupterId: responder.id, targetId: 'user', rule: 'user_called_no_response' };
}

/** 记录一次发言（更新状态；返回新状态，纯函数） */
export function registerSpeak(
  state: TurnTakingState,
  speaker: string,
  now: number
): TurnTakingState {
  const recent = { ...state.recentSpeaks };
  recent[speaker] = [...(recent[speaker] ?? []), now];
  const consecutive = { ...state.consecutiveSpeaks };
  if (state.currentSpeaker && state.currentSpeaker !== speaker) {
    consecutive[state.currentSpeaker] = 0;
  }
  consecutive[speaker] = (consecutive[speaker] ?? 0) + 1;

  return {
    ...state,
    recentSpeaks: recent,
    consecutiveSpeaks: consecutive,
    currentSpeaker: speaker,
    currentSpeakStartAt: now,
    userProtectedUntil: speaker === 'user' ? now + USER_PROTECTION.protectMs : state.userProtectedUntil,
    userCalledAt: speaker === 'user' ? null : state.userCalledAt,
    userMissedTurns: speaker === 'user' ? 0 : state.userMissedTurns,
  };
}

/** 记录一次打断：被打断者获得下次意愿加成（B.6），打断者计罚分 */
export function registerInterrupt(
  state: TurnTakingState,
  targetId: string,
  interrupterId: string
): TurnTakingState {
  const penalty = { ...state.interruptPenalty };
  penalty[interrupterId] = (penalty[interrupterId] ?? 0) + 1;
  const consecutive = { ...state.consecutiveSpeaks };
  if (targetId !== 'user') consecutive[targetId] = 0;
  return {
    ...state,
    interruptPenalty: penalty,
    consecutiveSpeaks: consecutive,
    userInterruptBonus: targetId === 'user' ? USER_PROTECTION.interruptBonus : state.userInterruptBonus,
    userMissedTurns: targetId === 'user' ? state.userMissedTurns + 1 : state.userMissedTurns,
  };
}

/** 一轮发言权未给到用户时累计（用于 B.6 强制分配） */
export function registerUserMissedTurn(state: TurnTakingState): TurnTakingState {
  return { ...state, userMissedTurns: state.userMissedTurns + 1 };
}
