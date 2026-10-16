import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROLE_CARDS, inferIndustry } from '../data/roleCards.ts';
import { autoSelectRoles, validateSelection, resolveRoleCards } from '../engine/roleSelector.ts';
import { AVATAR_PRESETS, avatarIndustryCount } from '../data/avatars.ts';

test('PRD 4.1.8: 12 张角色卡、≥8 预设形象、≥4 行业', () => {
  assert.equal(ROLE_CARDS.length, 12);
  assert.ok(AVATAR_PRESETS.length >= 8);
  assert.ok(avatarIndustryCount() >= 4);
});

test('PRD 附录 A.3: 自动分配满足全部约束（200 个种子）', () => {
  const industries = ['tech', 'finance', 'consulting', 'fmcg', 'manufacturing', 'medical_education', 'hr', 'internet'];
  for (const industry of industries) {
    for (let seed = 1; seed <= 200; seed++) {
      const cards = autoSelectRoles(industry, seed);
      assert.equal(cards.length, 3, `industry=${industry} seed=${seed}`);
      const violations = validateSelection(cards);
      assert.deepEqual(violations, [], `industry=${industry} seed=${seed} 违反: ${violations.map((v) => v.rule).join(',')}`);
    }
  }
});

test('PRD 附录 A.3: 同种子结果可复现', () => {
  const a = autoSelectRoles('tech', 42).map((c) => c.id);
  const b = autoSelectRoles('tech', 42).map((c) => c.id);
  assert.deepEqual(a, b);
});
test('PRD 附录 A.3: 行业匹配 ≥1（tech 岗位必有 tech 卡）', () => {
  for (let seed = 1; seed <= 100; seed++) {
    const cards = autoSelectRoles('tech', seed);
    assert.ok(cards.some((c) => c.industry === 'tech'), `seed=${seed} 无 tech 卡`);
  }
});
test('validateSelection 捕获违规组合', () => {
  const tech1 = ROLE_CARDS.find((c) => c.id === 'tech_visionary')!; // high, voice_01
  const crypto = ROLE_CARDS.find((c) => c.id === 'crypto_pioneer')!; // high, voice_01（音色重复）
  const consultant = ROLE_CARDS.find((c) => c.id === 'strategy_consultant')!;
  const violations = validateSelection([tech1, crypto, consultant]);
  const rules = violations.map((v) => v.rule);
  assert.ok(rules.includes('voice_unique'));
  assert.ok(rules.includes('personality_mix')); // 两个高冲突、无中立
});

test('岗位行业推断', () => {
  assert.equal(inferIndustry('产品经理'), 'internet');
  assert.equal(inferIndustry('Java开发工程师'), 'tech');
  assert.equal(inferIndustry('投资经理'), 'finance');
  assert.equal(inferIndustry('HRBP'), 'hr');
});

test('resolveRoleCards 保持顺序并过滤未知 id', () => {
  const cards = resolveRoleCards(['hr_manager', 'not_exist', 'value_investor']);
  assert.deepEqual(
    cards.map((c) => c.id),
    ['hr_manager', 'value_investor']
  );
});
