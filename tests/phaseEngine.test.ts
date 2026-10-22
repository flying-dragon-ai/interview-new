import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  initPhaseEngine,
  tickPhase,
  advancePhaseByKeyword,
  currentPhase,
  currentOpeningSpeaker,
  phaseRemainingMs,
  stageUrgency,
  phaseProgress,
  formatCountdown,
  OPENING_TURN_MS,
  PHASE_DEFS,
  type PhaseConfig,
} from '../engine/phaseEngine.ts';

/** 测试用短时长配置 */
const config: PhaseConfig = {
  durationsMs: { READING: 1000, OPENING: 4000, FREE_DISCUSSION: 10_000, SUMMARY: 2000 },
  openingOrder: ['a1', 'a2', 'user'],
};

test('PRD 4.1.3: 默认四阶段时长（审题10s/个人陈述每人1min/自由讨论15min/总结3min）', () => {
  assert.equal(PHASE_DEFS[0].durationMs, 10 * 1000);
  assert.equal(PHASE_DEFS[1].durationMs, 4 * 60 * 1000); // 4 人 × 1min
  assert.equal(PHASE_DEFS[2].durationMs, 15 * 60 * 1000);
  assert.equal(PHASE_DEFS[3].durationMs, 3 * 60 * 1000);
  assert.equal(OPENING_TURN_MS, 60 * 1000);
});

test('TC-01: 倒计时到点自动切换阶段（审题→个人陈述→自由讨论→总结→结束）', () => {
  let state = initPhaseEngine(0, config);
  assert.equal(currentPhase(state, config).id, 'READING');

  // 审题未到点：不切换
  let res = tickPhase(state, 500, config, 0);
  assert.equal(res.changed, false);
  assert.equal(currentPhase(res.state, config).id, 'READING');

  // 审题到点 → 个人陈述
  res = tickPhase(state, 1000, config, 0);
  assert.equal(res.changed, true);
  assert.equal(currentPhase(res.state, config).id, 'OPENING');
  assert.equal(res.events[0].event_type, 'stage_change');
  assert.equal(res.events[0].metadata?.reason, 'countdown');
  state = res.state;

  // 个人陈述轮流：每人 1min（测试配置 4000/3 人均分由 OPENING_TURN_MS 控制，此处用默认值验证推进逻辑）
  assert.equal(currentOpeningSpeaker(state, config), 'a1');
  res = tickPhase(state, 1000 + OPENING_TURN_MS + 1, config, 0);
  assert.equal(currentOpeningSpeaker(res.state, config), 'a2');
  assert.equal(res.events[0].event_type, 'speak_grant');
  state = res.state;

  res = tickPhase(state, 1000 + 2 * OPENING_TURN_MS + 1, config, 0);
  assert.equal(currentOpeningSpeaker(res.state, config), 'user');
  state = res.state;

  res = tickPhase(state, 1000 + 3 * OPENING_TURN_MS + 1, config, 0);
  assert.equal(currentPhase(res.state, config).id, 'FREE_DISCUSSION');
  state = res.state;

  // 自由讨论到点 → 总结
  res = tickPhase(state, 1000 + 3 * OPENING_TURN_MS + 1 + 10_000, config, 0);
  assert.equal(currentPhase(res.state, config).id, 'SUMMARY');
  state = res.state;

  // 总结到点 → 结束
  res = tickPhase(state, 1000 + 3 * OPENING_TURN_MS + 1 + 10_000 + 2000, config, 0);
  assert.equal(res.state.finished, true);
  assert.equal(res.events[0].target, 'FINISHED');
});

test('TC-01: 与关键词检测冲突时以倒计时为准（倒计时未到点，关键词推进仅兜底）', () => {
  const state = initPhaseEngine(0, config);
  // 倒计时未到点：tick 不切换
  const res = tickPhase(state, 100, config, 0);
  assert.equal(res.changed, false);
  assert.equal(currentPhase(res.state, config).id, 'READING');
  // 关键词兜底只允许 FREE_DISCUSSION → SUMMARY
  const keyword = advancePhaseByKeyword(state, 100, config, 0);
  assert.equal(keyword.changed, false); // READING 阶段关键词不可推进
});

test('关键词兜底：自由讨论中可提前进入总结', () => {
  let state = initPhaseEngine(0, config);
  state = { ...state, phaseIndex: 2, phaseStartedAt: 0 }; // FREE_DISCUSSION
  const res = advancePhaseByKeyword(state, 1000, config, 0);
  assert.equal(res.changed, true);
  assert.equal(currentPhase(res.state, config).id, 'SUMMARY');
  assert.equal(res.events[0].metadata?.reason, 'keyword');
});

test('阶段紧急度与进度', () => {
  const state = { ...initPhaseEngine(0), phaseIndex: 2, phaseStartedAt: 0 };
  // 自由讨论（默认 15min）最后 3 分钟线性拉升
  assert.equal(stageUrgency(state, 0), 0);
  assert.ok(stageUrgency(state, 15 * 60 * 1000 - 10_000) > 0.9);
  // 短配置下的进度与剩余
  const cfg: PhaseConfig = { durationsMs: { FREE_DISCUSSION: 10_000 } };
  const s2 = { ...initPhaseEngine(0, cfg), phaseIndex: 2, phaseStartedAt: 0 };
  assert.equal(phaseProgress(s2, 5000, cfg), 0.5);
  assert.equal(phaseRemainingMs(s2, 5000, cfg), 5000);
});

test('倒计时格式化', () => {
  assert.equal(formatCountdown(0), '00:00');
  assert.equal(formatCountdown(65_000), '01:05');
  assert.equal(formatCountdown(2 * 60 * 1000), '02:00');
});

test('结束后不再推进', () => {
  const state = { ...initPhaseEngine(0, config), finished: true };
  const res = tickPhase(state, 999_999, config, 0);
  assert.equal(res.changed, false);
  assert.equal(res.state.finished, true);
});
