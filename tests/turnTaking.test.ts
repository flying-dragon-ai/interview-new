import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TURN_WEIGHTS,
  INTERRUPT_RULES,
  USER_PROTECTION,
  createTurnState,
  computeSpeakScore,
  computeUserSpeakScore,
  recentSpeakRatio,
  selectNextSpeaker,
  evaluateInterrupt,
  evaluateUserCalledNoResponse,
  registerSpeak,
  registerInterrupt,
  registerUserMissedTurn,
} from '../engine/turnTaking.ts';
import { ROLE_CARDS } from '../data/roleCards.ts';
import type { TurnTakingState } from '../engine/turnTaking.ts';
const highConflict = ROLE_CARDS.find((c) => c.id === 'ib_analyst')!;
const highCoop = ROLE_CARDS.find((c) => c.id === 'strategy_consultant')!;
const neutral = ROLE_CARDS.find((c) => c.id === 'ops_director')!;
const cards = [highConflict, highCoop, neutral];

test('B.3 权重与附录一致', () => {
  assert.deepEqual({ ...TURN_WEIGHTS }, { w1: 0.25, w2: 0.2, w3: 0.15, w4: 0.2, w5: 0.15, w6: 0.05 });
});

test('B.5 打断阈值与附录一致', () => {
  assert.equal(INTERRUPT_RULES.userSpeakMs, 30_000);
  assert.equal(INTERRUPT_RULES.aiSpeakMs, 40_000);
  assert.equal(INTERRUPT_RULES.userCalledMs, 5_000);
  assert.equal(INTERRUPT_RULES.maxConsecutive, 3);
  assert.equal(USER_PROTECTION.protectMs, 3_000);
  assert.equal(USER_PROTECTION.interruptBonus, 0.3);
  assert.equal(USER_PROTECTION.missedTurnsForceGrant, 2);
});

test('B.3: 打分公式各项贡献（沉默越久、最近发言越少分越高）', () => {
  const state = createTurnState();
  const ctx = { now: 0, stageUrgency: 0, silenceMs: 0 };
  // 零上下文基准分 = w1 * speak_probability + w5 * 0.5
  // 零上下文基准分 = w1 * speak_probability + w4 * (1-0) + w5 * 0.5
  const base = computeSpeakScore(highConflict, state, ctx);
  assert.ok(Math.abs(base - (0.25 * highConflict.behavior.speak_probability + 0.2 + 0.15 * 0.5)) < 1e-9);

  // 沉默 15s → w3 满额
  const withSilence = computeSpeakScore(highConflict, state, { ...ctx, silenceMs: 15_000 });
  assert.ok(withSilence - base >= 0.15 - 1e-9);

  // 阶段紧急 → w2 贡献
  const withUrgency = computeSpeakScore(highConflict, state, { ...ctx, stageUrgency: 1 });
  assert.ok(withUrgency - base >= 0.2 - 1e-9);

  // 打断罚分 → w6 扣减
  const penalized = registerInterrupt(state, 'user', highConflict.id);
  const afterPenalty = computeSpeakScore(highConflict, penalized, ctx);
  assert.ok(afterPenalty < base);
});

test('B.6: 用户被打断后下次发言意愿 +0.3', () => {
  const state = createTurnState();
  const before = computeUserSpeakScore(state, { now: 0, stageUrgency: 0, silenceMs: 0 });
  const after = computeUserSpeakScore(registerInterrupt(state, 'user', highConflict.id), { now: 0, stageUrgency: 0, silenceMs: 0 });
  assert.ok(Math.abs(after - before - 0.3) < 1e-9);
});

test('B.3: 最近发言占比降低得分（w4）', () => {
  let state = createTurnState();
  state = registerSpeak(state, highConflict.id, 0);
  state = registerSpeak(state, highConflict.id, 1000);
  state = registerSpeak(state, neutral.id, 2000);
  assert.equal(recentSpeakRatio(state, highConflict.id, 2500), 2 / 3);
  const score = computeSpeakScore(highConflict, state, { now: 2500, stageUrgency: 0, silenceMs: 0 });
  // 最近发言多 → w4 项为负贡献，分数低于中性卡同等条件
  const neutralScore = computeSpeakScore(neutral, state, { now: 2500, stageUrgency: 0, silenceMs: 0 });
  assert.ok(score < neutralScore);
});

test('B.6: 用户连续 2 次未获发言权 → 强制分配', () => {
  let state = createTurnState();
  state = registerUserMissedTurn(state);
  state = registerUserMissedTurn(state);
  const decision = selectNextSpeaker(cards, state, { now: 0, stageUrgency: 0, silenceMs: 0 });
  assert.equal(decision.speakerId, 'user');
  assert.equal(decision.reason, 'force_grant_user');
});

test('B.5: 同一 AI 连续发言 3 次 → 强制让出', () => {
  let state = createTurnState();
  state = registerSpeak(state, highConflict.id, 0);
  state = registerSpeak(state, highConflict.id, 1000);
  state = registerSpeak(state, highConflict.id, 2000);
  const decision = selectNextSpeaker(cards, state, { now: 2500, stageUrgency: 0, silenceMs: 0 });
  assert.notEqual(decision.speakerId, highConflict.id);
});

test('B.6: 用户发言前 3 秒不被打断；超 30 秒高冲突角色可打断', () => {
  // 保护期内：不打断
  let state = createTurnState();
  state = registerSpeak(state, 'user', 0); // userProtectedUntil = 3000
  const protectedRes = evaluateInterrupt(cards, state, 1000, () => 0.99);
  assert.equal(protectedRes.type, 'none');

  // 超过 30 秒：高冲突角色按 interrupt_probability 打断
  const late = { ...state, userProtectedUntil: 0, currentSpeakStartAt: 0 };
  const res = evaluateInterrupt(cards, late, 31_000, () => 0.01);
  assert.equal(res.type, 'interrupt');
  if (res.type === 'interrupt') {
    assert.equal(res.targetId, 'user');
    assert.equal(res.rule, 'user_over_30s');
    assert.equal(res.interrupterId, highConflict.id);
  }
});

test('B.5: AI 发言超 40 秒其他 AI 可抢话', () => {
  let state = createTurnState();
  state = registerSpeak(state, highConflict.id, 0);
  const res = evaluateInterrupt(cards, state, 41_000, () => 0.01);
  assert.equal(res.type, 'interrupt');
  if (res.type === 'interrupt') {
    assert.equal(res.targetId, highConflict.id);
    assert.equal(res.rule, 'ai_over_40s');
  }
});

test('B.5: 用户被点名 5 秒未回应 → 其他 AI 接话', () => {
  const state: TurnTakingState = { ...createTurnState(), userCalledAt: 0, currentSpeaker: 'user' };
  assert.equal(evaluateUserCalledNoResponse(cards, state, 3000).type, 'none');
  const res = evaluateUserCalledNoResponse(cards, state, 6000);
  assert.equal(res.type, 'interrupt');
  if (res.type === 'interrupt') {
    assert.equal(res.targetId, 'user');
    assert.equal(res.rule, 'user_called_no_response');
  }
});

test('调度：正常路径按打分公式选最高分', () => {
  const state = createTurnState();
  const decision = selectNextSpeaker(cards, state, { now: 0, stageUrgency: 0, silenceMs: 0 });
  // speak_probability 最高者胜出（ib_analyst 0.85）
  assert.equal(decision.speakerId, highConflict.id);
  assert.equal(decision.reason, 'score');
});
