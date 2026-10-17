import { USER_INFO } from './data/userInfo';
/**
 * 前端常量（v0.7-tow）
 * - SYSTEM_PROMPT_BASE 与角色性格 prompt 资产已全部迁入服务端 api/_lib/prompts.ts（PRD F.0）
 * - 角色卡统一由 data/roleCards.ts 提供（12 张，数据驱动）
 */

export { USER_INFO };

/** 题型选项（PRD E.4 topic_type） */
export const INTERVIEW_INDUSTRIES = [
  { value: 'internet', label: '互联网', roleIndustry: 'tech' },
  { value: 'fmcg', label: '快消', roleIndustry: 'fmcg' },
  { value: 'finance', label: '金融', roleIndustry: 'finance' },
  { value: 'state_owned', label: '央国企', roleIndustry: 'manufacturing' },
] as const;

/** Word 文档中的行业 → 岗位 → 题型分类。首页必须从这里读取联动选项。 */
export interface InterviewOption { value: string; label: string; hint?: string }
export const INTERVIEW_CONFIG: Record<string, { jobs: InterviewOption[]; topics: InterviewOption[]; topicsByJob?: Record<string, InterviewOption[]> }> = {
  internet: {
    jobs: [{ value: 'internet_product', label: '产品岗' }, { value: 'internet_operations', label: '运营岗' }, { value: 'internet_brand', label: '市场/品牌岗' }],
    topics: [
      { value: 'product_innovation', label: '产品创新类', hint: '设计新产品或新增功能' },
      { value: 'priority_ranking', label: '优先级排序类', hint: '资源有限时做取舍' },
      { value: 'diagnosis_optimization', label: '问题诊断与优化类', hint: '定位问题并提出方案' },
      { value: 'business_estimation', label: '商业估算类', hint: '估算市场规模与费效' },
      { value: 'activity_planning', label: '活动策划类', hint: '围绕拉新、促活或 GMV 设计活动' },
      { value: 'user_retention', label: '用户分层与留存类', hint: '制定留存与召回策略' },
      { value: 'brand_marketing', label: '品牌营销方案类', hint: '制定人群、渠道与传播方案' },
      { value: 'competitor_benchmark', label: '竞品对标类', hint: '制定差异化打法' },
    ],
  },
  fmcg: {
    jobs: [{ value: 'fmcg_brand', label: '市场/品牌岗' }, { value: 'fmcg_sales', label: '销售/通路/渠道岗' }, { value: 'fmcg_management', label: '管培生' }],
    topics: [
      { value: 'new_product_launch', label: '新品上市全案类', hint: '定位、定价、渠道和营销方案' },
      { value: 'budget_allocation', label: '营销预算分配题', hint: '在线上、线下渠道间做取舍' },
      { value: 'brand_crisis', label: '品牌危机类', hint: '处理质量、舆论与信任危机' },
      { value: 'consumer_diagnosis', label: '消费者问题诊断', hint: '从渠道、定价、竞品和消费者找原因' },
      { value: 'channel_tradeoff', label: '渠道资源取舍', hint: '选择重点城市或渠道' },
      { value: 'promotion_design', label: '促销方案设计', hint: '设计商超促销活动提升销量' },
      { value: 'comprehensive_business_case', label: '综合商业案例题', hint: '结合营收、成本和竞品材料做决策' },
    ],
  },
  finance: {
    jobs: [{ value: 'finance_bank', label: '银行岗' }, { value: 'finance_brokerage', label: '券商岗' }, { value: 'finance_fund', label: '基金/资管岗' }],
    topics: [
      { value: 'financial_product_plan', label: '金融方案策划类', hint: '设计理财、信用卡或校园金融方案' },
      { value: 'credit_risk_assessment', label: '客户案例与风险评估类', hint: '判断授信与识别风险点' },
      { value: 'priority_ranking', label: '事务优先级排序题', hint: '有限人力下排序客户与工作' },
      { value: 'social_issue_debate', label: '社会热点思辨类', hint: '围绕普惠金融与数字化提出对策' },
      { value: 'investment_decision', label: '投资决策案例', hint: '在收益与风险间选择投资组合' },
      { value: 'industry_research', label: '行业研究类', hint: '判断行业前景与并购可行性' },
      { value: 'risk_disposal', label: '风险处置类', hint: '投资踩雷后的止损与资产处置' },
      { value: 'asset_allocation', label: '资产配置题', hint: '根据客户画像配置股债现金' },
      { value: 'sector_selection', label: '行业赛道选择', hint: '选择未来值得布局的方向' },
    ],
  },
  state_owned: {
    jobs: [{ value: 'state_comprehensive', label: '综合管培/行政/党群/人力岗' }, { value: 'state_engineering', label: '工程/产业类央企' }, { value: 'state_investment', label: '投融资类央企' }],
    topics: [
      { value: 'priority_ranking', label: '多项事务优先级排序题', hint: '人手不足时排序紧急事项' },
      { value: 'social_policy', label: '社会热点对策题', hint: '围绕就业、低碳和人才提出对策' },
      { value: 'organization_planning', label: '活动组织策划', hint: '策划党建、职工文化或科普活动' },
      { value: 'value_dilemma', label: '两难选择/价值观思辨', hint: '讨论效率、公平、安全与发展' },
      { value: 'project_decision', label: '项目决策类', hint: '评估安全、成本与社会效益' },
      { value: 'project_risk', label: '项目风险识别题', hint: '识别安全、工期和舆情风险' },
      { value: 'soe_investment_review', label: '项目投资评审', hint: '兼顾经济效益、保值与社会责任' },
    ],
  },
};

const pickTopics = (topics: InterviewOption[], values: string[]) => topics.filter((topic) => values.includes(topic.value));
INTERVIEW_CONFIG.internet.topicsByJob = {
  internet_product: pickTopics(INTERVIEW_CONFIG.internet.topics, ['product_innovation', 'priority_ranking', 'diagnosis_optimization', 'business_estimation']),
  internet_operations: pickTopics(INTERVIEW_CONFIG.internet.topics, ['activity_planning', 'user_retention', 'priority_ranking']),
  internet_brand: pickTopics(INTERVIEW_CONFIG.internet.topics, ['brand_marketing', 'competitor_benchmark']),
};
INTERVIEW_CONFIG.fmcg.topicsByJob = {
  fmcg_brand: pickTopics(INTERVIEW_CONFIG.fmcg.topics, ['new_product_launch', 'budget_allocation', 'brand_crisis', 'consumer_diagnosis']),
  fmcg_sales: pickTopics(INTERVIEW_CONFIG.fmcg.topics, ['channel_tradeoff', 'promotion_design']),
  fmcg_management: pickTopics(INTERVIEW_CONFIG.fmcg.topics, ['comprehensive_business_case']),
};
INTERVIEW_CONFIG.finance.topicsByJob = {
  finance_bank: pickTopics(INTERVIEW_CONFIG.finance.topics, ['financial_product_plan', 'credit_risk_assessment', 'priority_ranking', 'social_issue_debate']),
  finance_brokerage: pickTopics(INTERVIEW_CONFIG.finance.topics, ['investment_decision', 'industry_research', 'risk_disposal']),
  finance_fund: pickTopics(INTERVIEW_CONFIG.finance.topics, ['asset_allocation', 'sector_selection']),
};
INTERVIEW_CONFIG.state_owned.topicsByJob = {
  state_comprehensive: pickTopics(INTERVIEW_CONFIG.state_owned.topics, ['priority_ranking', 'social_policy', 'organization_planning', 'value_dilemma']),
  state_engineering: pickTopics(INTERVIEW_CONFIG.state_owned.topics, ['project_decision', 'project_risk']),
  state_investment: pickTopics(INTERVIEW_CONFIG.state_owned.topics, ['soe_investment_review']),
};

// 兼容旧组件与历史数据；新首页使用 INTERVIEW_CONFIG 的行业联动数据。
export const INTERVIEW_JOBS = Object.values(INTERVIEW_CONFIG).flatMap((item) => item.jobs);
export const TOPIC_TYPES = [
  { value: 'priority_ranking', label: '排序题', hint: '判断优先级与取舍' },
  { value: 'business_case', label: '方案设计题', hint: '设计方案与落地路径' },
  { value: 'open_debate', label: '开放辩论题', hint: '表达观点与推动共识' },
] as const;
