import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildReplyPrompt, buildTopicPrompt, buildAnalysisPrompt, personaDescription, formatTs } from '../api/_lib/prompts.ts';
import { ROLE_CARDS } from '../data/roleCards.ts';

const card = ROLE_CARDS.find((c) => c.id === 'ib_analyst')!;

test('F.0: 角色发言 prompt 继承现有 prompt 资产（阶段/互动/防重复/身份沉浸）', () => {
  const prompt = buildReplyPrompt({
    card,
    topic: '一、背景\n测试\n二、问题\n1、要点甲\n2、要点乙',
    jobTitle: '产品经理',
    history: [{ senderId: 'user', senderName: '陈明', content: '我认为应该先做用户调研，再分析竞品' }],
    phase: '深入讨论与方案贡献',
  });
  // SYSTEM_PROMPT_BASE 资产
  assert.ok(prompt.includes('无领导小组讨论面试'));
  assert.ok(prompt.includes('绝对严禁使用 Markdown'));
  assert.ok(prompt.includes('必须回应用户（陈明）的发言'));
  assert.ok(prompt.includes('不能有连续的10个字与前述发言者完全一样'));
  // 动态上下文注入
  assert.ok(prompt.includes('上一个发言者是用户（考生）陈明'));
  assert.ok(prompt.includes('深入讨论与方案贡献'));
  // legacy 性格文案迁移（不丢弃）
  assert.ok(prompt.includes('强势控场型'));
});

test('F.1: 语音版输出 JSON（content/emotion/target/stepfun_tts_instruction）', () => {
  const prompt = buildReplyPrompt({
    card,
    topic: '测试题目',
    jobTitle: '产品经理',
    history: [],
    phase: '开局框架阶段',
    voiceMode: true,
    phaseRemainingMs: 90_000,
  });
  assert.ok(prompt.includes('"stepfun_tts_instruction"'));
  assert.ok(prompt.includes('当前阶段剩余 90 秒'));
});

test('personaDescription：legacy 文案优先', () => {
  assert.ok(personaDescription(card).includes('强势控场型'));
  const plain = ROLE_CARDS.find((c) => c.id === 'brand_director')!;
  assert.ok(personaDescription(plain).includes('创意'));
});

test('题目生成 prompt 包含三段式与公司岗位', () => {
  const prompt = buildTopicPrompt('字节跳动', '产品经理');
  assert.ok(prompt.includes('字节跳动'));
  assert.ok(prompt.includes('一、背景'));
  assert.ok(prompt.includes('二、问题'));
  assert.ok(prompt.includes('三、时间分配'));
  assert.ok(prompt.includes('禁止使用Markdown'));
});

test('F.2: 面后分析 prompt 要求 evidence', () => {
  const prompt = buildAnalysisPrompt('测试题', [{ content: '我认为应该先调研', timestampMs: 65_000 }]);
  assert.ok(prompt.includes('01:05 我认为应该先调研'));
  assert.ok(prompt.includes('structure_score'));
  assert.ok(prompt.includes('evidence'));
});

test('formatTs', () => {
  assert.equal(formatTs(0), '00:00');
  assert.equal(formatTs(195_000), '03:15');
});
