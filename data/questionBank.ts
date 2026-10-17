export type QuestionBankIndustry = 'tech' | 'fmcg' | 'finance' | 'manufacturing';

export interface BankQuestion {
  id: string;
  industry: QuestionBankIndustry;
  jobKeys: string[];
  topicType: 'priority_ranking' | 'business_case' | 'open_debate';
  title: string;
  difficulty?: 'easy' | 'standard' | 'hard';
  sourceType?: 'curated_bank' | 'template';
  audience?: string;
  productForm?: string;
}

/** 首期内置题库。生成服务不可用时使用，避免准备页无法进入面试。 */
export const QUESTION_BANK: BankQuestion[] = [
  { id: 'tech-ranking-01', industry: 'tech', jobKeys: ['product_manager', 'product_operations', 'user_growth'], topicType: 'priority_ranking', audience: '应届生/管培生', productForm: '互联网产品', title: '某互联网产品 DAU 连续三个月下降。请从用户、产品、运营、技术和商业化方向中选择最应优先解决的三项，并说明排序依据。' },
  { id: 'tech-case-01', industry: 'tech', jobKeys: ['product_manager', 'business_analysis'], topicType: 'business_case', audience: '应届生/管培生', productForm: '互联网产品', title: '请为一款面向年轻用户的内容产品设计一套提升次日留存的方案，说明目标用户、核心策略、资源取舍与验证指标。' },
  { id: 'tech-debate-01', industry: 'tech', jobKeys: ['product_manager', 'product_operations', 'management_trainee'], topicType: 'open_debate', audience: '应届生/管培生', productForm: '互联网产品', title: '在内容平台中，算法推荐带来的效率提升是否值得以牺牲部分内容多样性为代价？请结合平台治理和用户体验展开讨论。' },
  { id: 'fmcg-ranking-01', industry: 'fmcg', jobKeys: ['management_trainee', 'business_analysis'], topicType: 'priority_ranking', audience: '应届生/管培生', productForm: '快消品牌', title: '某快消品牌进入新市场，请从品牌认知、渠道铺设、价格策略、产品创新和促销资源五项工作中确定优先级。' },
  { id: 'fmcg-case-01', industry: 'fmcg', jobKeys: ['product_operations', 'user_growth', 'management_trainee'], topicType: 'business_case', audience: '应届生/管培生', productForm: '快消品牌', title: '请为一个销量增长放缓的日化品牌设计一套年轻化增长方案，说明人群、产品、渠道、传播和效果评估。' },
  { id: 'fmcg-debate-01', industry: 'fmcg', jobKeys: ['product_operations', 'management_trainee'], topicType: 'open_debate', audience: '应届生/管培生', productForm: '快消品牌', title: '快消品牌应优先投入长期品牌建设，还是优先追求短期销售转化？请讨论两者的适用边界。' },
  { id: 'finance-ranking-01', industry: 'finance', jobKeys: ['business_analysis', 'product_manager'], topicType: 'priority_ranking', audience: '应届生/管培生', productForm: '金融服务', title: '某金融产品投诉率上升，请从风险控制、客户体验、流程效率、产品规则和员工培训中确定最优先的改进顺序。' },
  { id: 'finance-case-01', industry: 'finance', jobKeys: ['product_manager', 'business_analysis'], topicType: 'business_case', audience: '应届生/管培生', productForm: '金融服务', title: '请设计一套面向年轻客群的普惠金融产品方案，说明客户需求、风险边界、运营方式与核心指标。' },
  { id: 'finance-debate-01', industry: 'finance', jobKeys: ['business_analysis', 'management_trainee'], topicType: 'open_debate', audience: '应届生/管培生', productForm: '金融服务', title: '金融机构推进智能化服务时，效率、隐私与公平性哪个应当优先？请给出判断框架和具体做法。' },
  { id: 'manufacturing-ranking-01', industry: 'manufacturing', jobKeys: ['management_trainee', 'business_analysis'], topicType: 'priority_ranking', audience: '应届生/管培生', productForm: '组织/公共服务', title: '央国企推进数字化转型，请从组织协同、流程再造、数据治理、人才培养和系统建设中确定优先级。' },
  { id: 'manufacturing-case-01', industry: 'manufacturing', jobKeys: ['management_trainee', 'product_operations'], topicType: 'business_case', audience: '应届生/管培生', productForm: '组织/公共服务', title: '请为一家传统企业设计数字化服务升级方案，说明现状诊断、目标用户、实施路径、风险和评估指标。' },
  { id: 'manufacturing-debate-01', industry: 'manufacturing', jobKeys: ['management_trainee', 'business_analysis'], topicType: 'open_debate', audience: '应届生/管培生', productForm: '组织/公共服务', title: '央国企改革中，稳定性与创新效率发生冲突时应如何取舍？请结合组织管理和业务结果展开讨论。' },
];

export function pickBankQuestion(industry: QuestionBankIndustry, jobKey: string, topicType: BankQuestion['topicType']): BankQuestion | undefined {
  const exact = QUESTION_BANK.filter((q) => q.industry === industry && q.topicType === topicType && q.jobKeys.includes(jobKey));
  const sameIndustry = QUESTION_BANK.filter((q) => q.industry === industry && q.topicType === topicType);
  return exact[0] ?? sameIndustry[0] ?? QUESTION_BANK.find((q) => q.topicType === topicType);
}
