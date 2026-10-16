import { USER_INFO } from './data/userInfo';
/**
 * 前端常量（v0.7-tow）
 * - SYSTEM_PROMPT_BASE 与角色性格 prompt 资产已全部迁入服务端 api/_lib/prompts.ts（PRD F.0）
 * - 角色卡统一由 data/roleCards.ts 提供（12 张，数据驱动）
 */

export { USER_INFO };

/** 题型选项（PRD E.4 topic_type） */
export const TOPIC_TYPES = [
  { value: 'business_case', label: '商业案例题' },
  { value: 'open_debate', label: '开放辩论题' },
  { value: 'resource_competition', label: '资源争夺题' },
  { value: 'priority_ranking', label: '优先级排序题' },
] as const;
