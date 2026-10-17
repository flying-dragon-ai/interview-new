import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeRuleMetrics,
  buildEvidencePool,
  buildRuleReport,
  buildSuggestions,
  type ReportInput,
} from '../engine/reportEngine.ts';
import type { GameEvent, Message } from '../types.ts';
import { FINAL_WEIGHTS, TRANSITION_WEIGHTS } from '../engine/reportEngine.ts';
import { summarizeVisual } from '../engine/visionMetrics.ts';

const SESSION_START = 1_000_000;

function msg(senderId: string, content: string, offsetMs: number, durMs = 4000): Message {
  return {
    id: `${senderId}-${offsetMs}`,
    senderId,
    senderName: senderId === 'user' ? '陈明' : senderId,
    content,
    timestamp: SESSION_START + offsetMs,
    type: 'message',
    startMs: offsetMs,
    endMs: offsetMs + durMs,
  };
}

const transcripts: Message[] = [
  msg('ai1', '我建议先明确讨论框架，按题目顺序推进。', 10_000),
  msg('user', '我认为首先应该做用户调研，其次分析竞品，最后确定方案。', 30_000, 8000),
  msg('ai2', '我同意你的调研思路，补充一点样本量要足够。', 45_000),
  msg('user', '嗯，那个，我同意补充样本量的思路，但我觉得 200 份更合理，想反驳一下成本顾虑。', 90_000, 9000),
  msg('ai3', '时间差不多了，谁来总结汇报一下？', 150_000),
  msg('user', '我来总结，首先调研、其次分析、最后落地，三方面推进。', 180_000, 10_000),
];

const events: GameEvent[] = [
  { event_type: 'stage_change', actor: 'system', target: 'FREE_DISCUSSION', timestamp_ms: 60_000, metadata: { reason: 'countdown' } },
  { event_type: 'interrupt', actor: 'ai2', target: 'user', timestamp_ms: 100_000, metadata: { rule: 'user_over_30s' } },
  { event_type: 'speak_grant', actor: 'ai1', target: 'all', timestamp_ms: 120_000 },
];

const input: ReportInput = { transcripts, events, sessionStartAt: SESSION_START, durationMs: 20 * 60 * 1000 };

test('规则引擎：话语权、填充词、打断、回应、推动次数实算', () => {
  const m = computeRuleMetrics(input);
  // 用户 3 条 / 共 6 条
  assert.equal(m.userMessageCount, 3);
  assert.equal(m.totalMessageCount, 6);
  assert.equal(m.voiceShareByCount, 50);
  // 用户发言时长 27s / 总 39s = 69%
  assert.equal(m.voiceShareByTime, 69);
  // 填充词：嗯、那个（"嗯，那个" → 2 次）
  assert.ok(m.fillerCount >= 2);
  assert.ok(m.fillerRatio > 0);
  // 被打断 1 次；恢复时长 = 120000 下一次用户发言(180000) - 100000 = 80s
  assert.equal(m.interruptedCount, 1);
  assert.equal(m.interruptRecoveryMs, 80_000);
  // 回应（同意/反驳）≥1；推动（首先/其次/最后）≥1
  assert.ok(m.responseCount >= 1);
  assert.ok(m.pushDiscussionCount >= 1);
});

test('证据池：每条用户发言带时间戳与 dimension_hint（PRD 7.3）', () => {
  const pool = buildEvidencePool(input);
  assert.ok(pool.length >= 4); // 3 条发言 + 1 条打断事件
  const first = pool[0];
  assert.equal(first.modality, 'text');
  assert.equal(first.timestamp_ms, 30_000);
  assert.ok(['content', 'voice', 'visual', 'stress', 'teamwork'].includes(first.dimension_hint));
  const stress = pool.find((e) => e.dimension_hint === 'stress');
  assert.ok(stress);
  assert.equal(stress?.modality, 'event');
});

test('报告 v1.5：维度满分与过渡权重（内容40/语音25/抗压20/协作10，视觉不参与）', () => {
  const report = buildRuleReport(input);
  assert.equal(report.dimensions.content.max, 40);
  assert.equal(report.dimensions.voice.max, 25);
  assert.equal(report.dimensions.stress.max, 20);
  assert.equal(report.dimensions.teamwork.max, 15);
  assert.equal(report.dimensions.visual.status, 'not_enabled');
  assert.ok(report.overall_score >= 0 && report.overall_score <= 100);
  assert.ok(report.suggestions.length >= 1 && report.suggestions.length <= 5);
  // 证据引用（US-06）
  assert.ok(report.dimensions.content.evidence.length > 0);
});

// ---------- M6 视觉维度 ----------

/** 造 N 秒视觉聚合行（默认良好表现） */
function visualRows(
  count: number,
  overrides: (i: number) => Partial<import('../types').VisualFeatureRow> = () => ({})
): import('../types').VisualFeatureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp_ms: i * 1000,
    eye_contact: 0.85,
    emotion: 'neutral' as const,
    head_pose: { pitch: 0, yaw: 0, roll: 0 },
    engagement: 1,
    ...overrides(i),
  }));
}

test('M6: 视觉数据充足 → 维度 enabled、满分 20、综合分按 FINAL_WEIGHTS', () => {
  const stats = summarizeVisual(visualRows(45));
  const report = buildRuleReport(input, undefined, stats);

  const dims = report.dimensions;
  assert.equal(dims.visual.status, 'enabled');
  assert.equal(dims.visual.max, FINAL_WEIGHTS.visual);
  assert.equal(dims.visual.score, Math.round((stats.rawScore / 100) * FINAL_WEIGHTS.visual));
  // 权重整体切换到 FINAL_WEIGHTS（视觉 20%，其余四维 ×0.8）
  assert.equal(dims.content.max, FINAL_WEIGHTS.content);
  assert.equal(dims.voice.max, FINAL_WEIGHTS.voice);
  assert.equal(dims.stress.max, FINAL_WEIGHTS.stress);
  assert.equal(dims.teamwork.max, FINAL_WEIGHTS.teamwork);
  const sum =
    dims.content.score + dims.voice.score + dims.visual.score + dims.stress.score + dims.teamwork.score;
  assert.ok(sum <= 100 && Math.abs(sum - report.overall_score) <= 5, `维度分和 ${sum} 与总分 ${report.overall_score} 不一致`);
  // metrics 徽章齐全
  for (const key of ['眼神接触', '紧张占比', '低头偏头占比', '面部检测率', '有效采样秒数']) {
    assert.ok(key in (dims.visual.metrics ?? {}), `视觉 metrics 缺少 ${key}`);
  }
  assert.equal(dims.visual.metrics!['有效采样秒数'], 45);
  assert.equal(dims.visual.note, undefined);
});

test('M6: 视觉表现好 → 总分高于同场未开视觉（过渡权重）', () => {
  const withoutVisual = buildRuleReport(input);
  const withVisual = buildRuleReport(input, undefined, summarizeVisual(visualRows(60)));
  assert.equal(withVisual.dimensions.visual.status, 'enabled');
  assert.equal(withVisual.dimensions.visual.score, 20);
  // 视觉满分时总分应不低于关闭视觉的路径（其余四维按 ×0.8 缩放后仍有空间）
  assert.ok(withVisual.overall_score >= withoutVisual.overall_score);
});

test('M6: 视觉数据不足（<30 秒）→ not_enabled + 过渡权重不变', () => {
  const report = buildRuleReport(input, undefined, summarizeVisual(visualRows(12)));
  assert.equal(report.dimensions.visual.status, 'not_enabled');
  assert.equal(report.dimensions.visual.score, 0);
  assert.equal(report.dimensions.content.max, TRANSITION_WEIGHTS.content);
  assert.equal(report.dimensions.voice.max, TRANSITION_WEIGHTS.voice);
  assert.equal(report.dimensions.stress.max, TRANSITION_WEIGHTS.stress);
  assert.equal(report.dimensions.teamwork.max, TRANSITION_WEIGHTS.teamwork);
  assert.ok(report.dimensions.visual.note?.includes('视觉数据不足'));
});

test('M6: 偏离段生成视觉证据（画面来源）+ 对应改进建议', () => {
  const stats = summarizeVisual(
    visualRows(40, (i) => (i < 15 ? { eye_contact: 0.1, head_pose: { pitch: -30, yaw: 0, roll: 0 } } : {}))
  );
  const report = buildRuleReport(input, undefined, stats);
  const evidence = report.dimensions.visual.evidence;
  assert.ok(evidence.length > 0, '应有视觉偏离段证据');
  for (const ev of evidence) {
    assert.equal(ev.modality, 'visual');
    assert.equal(ev.dimension_hint, 'visual');
    assert.match(ev.content, /^\d{2}:\d{2} 起持续 \d+ 秒/);
  }
  // 眼神接触不足 → 追加视觉建议
  assert.ok(report.suggestions.some((s) => s.includes('摄像头')), '缺少眼神接触建议');
  assert.ok(report.suggestions.some((s) => s.includes('低头')), '缺少低头/偏头建议');
  assert.ok(report.suggestions.length <= 6);
});
test('报告 v1.5：LLM 语义分注入后内容分采用 LLM 结构分', () => {
  const ruleOnly = buildRuleReport(input);
  const withLlm = buildRuleReport(input, { structureScore: 100, responseQuality: 100, stressResponseQuality: 100, conflictHandling: 100, supportOthers: 100, coordinateOthers: 100 });
  assert.ok(withLlm.dimensions.content.score >= ruleOnly.dimensions.content.score);
  assert.ok(withLlm.overall_score > ruleOnly.overall_score);
});

test('改进建议：低话语权/低协作给出可执行建议（F.4）', () => {
  const m = computeRuleMetrics(input);
  const tips = buildSuggestions({ m, content: 10, voice: 10, stress: 10, teamwork: 3 });
  assert.ok(tips.length >= 2);
  assert.ok(tips.every((t) => t.length > 5));
});

test('空输入不崩溃', () => {
  const empty: ReportInput = { transcripts: [], events: [], sessionStartAt: SESSION_START, durationMs: 60_000 };
  const m = computeRuleMetrics(empty);
  assert.equal(m.voiceShareByCount, 0);
  assert.equal(m.interruptedCount, 0);
  const report = buildRuleReport(empty);
  assert.equal(report.dimensions.visual.status, 'not_enabled');
});
