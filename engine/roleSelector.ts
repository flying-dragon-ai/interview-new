import type { RoleCard } from '../types';
import { ROLE_CARDS } from '../data/roleCards.ts';

/**
 * 每场 3 张角色卡分配（PRD 附录 A.3 / 4.1.8）
 * 约束：
 *  1. 行业匹配 ≥1（优先与用户目标岗位同行业）
 *  2. 性格互补：1 高冲突 + 1 高协作 + 1 中立
 *  3. 发言策略不重复
 *  4. 音色不重复
 *  5. 形象不重复
 */

export interface SelectionViolation {
  rule: string;
  message: string;
}

/** 可复现随机数（便于测试） */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(arr: T[], rng: () => number): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function pick<T>(arr: T[], rng: () => number): T | undefined {
  if (arr.length === 0) return undefined;
  return arr[Math.floor(rng() * arr.length)];
}

/** 高协作卡：协作倾向高 */
function isHighCoop(card: RoleCard): boolean {
  return card.persona.cooperation_level >= 0.7;
}

/** 中立卡：非高冲突、非高协作 */
function isNeutral(card: RoleCard): boolean {
  return card.persona.conflict_level !== 'high' && !isHighCoop(card);
}

/** 校验一组 3 张卡是否满足分配约束（SetupForm 用户自选用） */
export function validateSelection(cards: RoleCard[]): SelectionViolation[] {
  const violations: SelectionViolation[] = [];
  if (cards.length !== 3) {
    violations.push({ rule: 'count', message: '每场必须选择 3 个角色' });
    return violations;
  }
  const voices = cards.map((c) => c.voice.voice_id);
  if (new Set(voices).size !== voices.length) {
    violations.push({ rule: 'voice_unique', message: '3 个角色音色不能重复' });
  }
  const avatars = cards.map((c) => c.avatar.preset_id);
  if (new Set(avatars).size !== avatars.length) {
    violations.push({ rule: 'avatar_unique', message: '3 个角色形象不能重复' });
  }
  const strategies = cards.map((c) => c.persona.conflict_strategy);
  if (new Set(strategies).size !== strategies.length) {
    violations.push({ rule: 'strategy_unique', message: '3 个角色发言策略不能重复' });
  }
  const conflicts = cards.filter((c) => c.persona.conflict_level === 'high').length;
  const coops = cards.filter(isHighCoop).length;
  const neutrals = cards.filter(isNeutral).length;
  if (conflicts < 1 || coops < 1 || neutrals < 1) {
    violations.push({
      rule: 'personality_mix',
      message: '性格需互补：1 高冲突 + 1 高协作 + 1 中立',
    });
  }
  return violations;
}

/**
 * 阵型 B（3 面试官 + 1 候选人）：面试官组合校验。
 * 与候选人约束的差异：不要求性格互补（面试官按分工互补即可），保留音色/形象/策略不重复。
 */
export function validatePanelSelection(cards: RoleCard[]): SelectionViolation[] {
  const violations: SelectionViolation[] = [];
  if (cards.length !== 3) {
    violations.push({ rule: 'count', message: '每场必须选择 3 个面试官' });
    return violations;
  }
  const voices = cards.map((c) => c.voice.voice_id);
  if (new Set(voices).size !== voices.length) {
    violations.push({ rule: 'voice_unique', message: '3 个面试官音色不能重复' });
  }
  const avatars = cards.map((c) => c.avatar.preset_id);
  if (new Set(avatars).size !== avatars.length) {
    violations.push({ rule: 'avatar_unique', message: '3 个面试官形象不能重复' });
  }
  return violations;
}

/**
 * 自动分配 3 张卡。
 * @param industry 用户岗位推断行业（优先匹配）
 * @param seed 随机种子（同种子结果可复现）
 */
export function autoSelectRoles(industry: string, seed: number): RoleCard[] {
  const rng = createRng(seed);
  const pool = shuffle(ROLE_CARDS, rng);

  const sameIndustry = pool.filter((c) => c.industry === industry);
  const highConflict = pool.filter((c) => c.persona.conflict_level === 'high');
  const highCoop = pool.filter(isHighCoop);
  const neutral = pool.filter(isNeutral);

  const chosen: RoleCard[] = [];
  const usedVoices = new Set<string>();
  const usedAvatars = new Set<string>();
  const usedStrategies = new Set<string>();

  const tryAdd = (candidates: RoleCard[], requireIndustry = false): boolean => {
    const filtered = candidates.filter(
      (c) =>
        !chosen.includes(c) &&
        !usedVoices.has(c.voice.voice_id) &&
        !usedAvatars.has(c.avatar.preset_id) &&
        !usedStrategies.has(c.persona.conflict_strategy) &&
        (!requireIndustry || c.industry === industry)
    );
    const c = pick(filtered, rng);
    if (!c) return false;
    chosen.push(c);
    usedVoices.add(c.voice.voice_id);
    usedAvatars.add(c.avatar.preset_id);
    usedStrategies.add(c.persona.conflict_strategy);
    return true;
  };

  // 1) 高冲突（若同行业有高冲突卡则优先）
  if (!tryAdd(sameIndustry.filter((c) => c.persona.conflict_level === 'high'))) {
    if (!tryAdd(highConflict)) {
      // 无高冲突卡时退化为任意同行业或任意卡（保证能开局）
      if (!tryAdd(sameIndustry)) tryAdd(pool);
    }
  }
  // 2) 高协作
  if (!tryAdd(highCoop)) tryAdd(pool);
  // 3) 中立
  if (!tryAdd(neutral)) tryAdd(pool);

  // 行业匹配 ≥1：若当前 3 张无同行业卡，尝试替换一张
  if (industry && !chosen.some((c) => c.industry === industry)) {
    const replacement = pick(sameIndustry, rng);
    if (replacement) {
      // 移除与新卡冲突最少的一张，再尝试加入
      for (let i = chosen.length - 1; i >= 0; i--) {
        const trial = [...chosen];
        trial[i] = replacement;
        if (validateSelection(trial).length === 0) {
          chosen.length = 0;
          chosen.push(...trial);
          break;
        }
      }
    }
  }

  return chosen.slice(0, 3);
}

/** 用户自选的卡片集合 → RoleCard（保持顺序） */
export function resolveRoleCards(ids: string[]): RoleCard[] {
  return ids
    .map((id) => ROLE_CARDS.find((c) => c.id === id))
    .filter((c): c is RoleCard => Boolean(c));
}
