/**
 * 讨论语篇信号（engine 层共享谓词）
 * 消费方：SessionController（阶段推进/要点切换判定）+ api/_lib/prompts.ts（LLM 上下文提示）。
 * 收敛自两处手抄关键词对，避免引擎推进与 prompt 内容各自漂移。
 */

/** 是否在引导进入下一段/下一个要点（如「接下来我们讨论方案」） */
export function guidesToNextKeyPoint(text: string): boolean {
  const hasLead = ['接下来', '现在', '应该', '进入'].some((k) => text.includes(k));
  const hasFollow = ['讨论', '规划', '设计', '分析'].some((k) => text.includes(k));
  return hasLead && hasFollow;
}

/** 是否在做总结/汇报引导或主动请缨（如「谁来做总结」「我来汇报」） */
export function proposesSummary(text: string): boolean {
  return (
    (text.includes('总结') && (text.includes('汇报') || text.includes('谁愿意') || text.includes('谁来'))) ||
    text.includes('我来总结') ||
    text.includes('我来汇报')
  );
}
