import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractKeyPoints, MAX_DISCUSSIONS_PER_KEY_POINT } from '../engine/keyPoints.ts';

const TOPIC = `一、背景
某电商平台用户增长放缓，需要设计拉新方案。

二、问题
请你们在小组讨论中，设计出解决方案框架。方案需包含以下核心要点：
1、用户行为与竞品分析
2、拉新渠道策略设计
3、预算分配与效果评估
4、风险预案与落地节奏

三、时间分配
1、阅读材料：2分钟。
2、小组讨论：15分钟。
3、总结汇报：3分钟。`;

test('要点提取：从「问题」段提取 4 个要点（沿用现有正则）', () => {
  const points = extractKeyPoints(TOPIC);
  assert.equal(points.length, 4);
  assert.equal(points[0], '用户行为与竞品分析');
  assert.equal(points[3], '风险预案与落地节奏');
});

test('要点提取：优先「核心要点」段', () => {
  const topic = `核心要点：
1、要点甲
2、要点乙

三、其他`;
  assert.deepEqual(extractKeyPoints(topic), ['要点甲', '要点乙']);
});

test('要点提取：空题目返回空数组', () => {
  assert.deepEqual(extractKeyPoints(''), []);
  assert.deepEqual(extractKeyPoints('没有要点的纯文本'), []);
});

test('每个要点最大讨论次数为 10（PRD 4.1.3 保留）', () => {
  assert.equal(MAX_DISCUSSIONS_PER_KEY_POINT, 10);
});
