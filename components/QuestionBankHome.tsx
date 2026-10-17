import React, { useState } from 'react';
import { INTERVIEW_CONFIG, INTERVIEW_INDUSTRIES } from '../constants';
import { autoSelectRolesForTopic } from '../engine/roleSelector';
import type { RoleCard } from '../types';
import type { PhaseState } from '../engine/phaseEngine';
import { QUESTION_BANK, pickBankQuestion } from '../data/questionBank';
import RecentPracticeList from './RecentPracticeList';

interface Props {
  onStart: (params: { topic: string; jobTitle: string; company: string; topicType: string; roles: RoleCard[]; resumeCheckpoint?: PhaseState | null; demoMode?: boolean }) => void;
  onViewLocalReport: (id: string) => void;
}

const QuestionBankHome: React.FC<Props> = ({ onStart, onViewLocalReport }) => {
  const [industry, setIndustry] = useState('internet');
  const [company, setCompany] = useState('');
  const [jobKey, setJobKey] = useState('internet_product');
  const [topicType, setTopicType] = useState('product_innovation');
  const [demoMode, setDemoMode] = useState(false);
  const legacyJobKey = jobKey.includes('product') ? 'product_manager' : jobKey.includes('operations') ? 'product_operations' : jobKey.includes('brand') ? 'management_trainee' : jobKey.includes('sales') ? 'product_operations' : jobKey.includes('management') || jobKey.includes('comprehensive') ? 'management_trainee' : jobKey.includes('analysis') || jobKey.includes('brokerage') || jobKey.includes('fund') || jobKey.includes('bank') ? 'business_analysis' : 'management_trainee';
  const industryConfig = INTERVIEW_CONFIG[industry as keyof typeof INTERVIEW_CONFIG] ?? INTERVIEW_CONFIG.internet;
  const job = industryConfig.jobs.find((item) => item.value === jobKey) ?? industryConfig.jobs[0];
  const availableTopics = industryConfig.topicsByJob?.[jobKey] ?? industryConfig.topics;
  const industryLabel = INTERVIEW_INDUSTRIES.find((item) => item.value === industry)?.label ?? '互联网';
  const legacyTopicType = topicType.includes('priority') || topicType.includes('ranking') || topicType.includes('allocation') || topicType.includes('budget') ? 'priority_ranking' : topicType.includes('debate') || topicType.includes('dilemma') || topicType.includes('social') ? 'open_debate' : 'business_case';
  const mappedIndustry = INTERVIEW_INDUSTRIES.find((item) => item.value === industry)?.roleIndustry ?? 'tech';
  const selectedQuestion = pickBankQuestion(mappedIndustry as 'tech' | 'fmcg' | 'finance' | 'manufacturing', legacyJobKey, legacyTopicType);
  const selectedTopic = selectedQuestion?.title ?? '当前分类暂未配置题目，请选择其他题型。';
  const start = () => {
    if (!selectedQuestion) return;
    let checkpoint: PhaseState | null = null;
    try { checkpoint = JSON.parse(localStorage.getItem(`lgd-checkpoint:${selectedTopic}`) || 'null') as PhaseState | null; } catch { checkpoint = null; }
    onStart({ topic: selectedTopic, jobTitle: job.label, company: company.trim() || '模拟练习', topicType, roles: autoSelectRolesForTopic(mappedIndustry, legacyTopicType, Date.now()), resumeCheckpoint: demoMode ? null : checkpoint, demoMode });
  };
  const fieldClass = 'w-full border-0 border-b-2 border-slate-200 bg-transparent px-0 py-3 text-lg font-semibold text-slate-950 outline-none transition focus:border-slate-950';
  const resetTopic = () => undefined;
  return <div className="mocksharp-home">
    <section className="mocksharp-hero"><div className="mocksharp-kicker">群面模拟器 · AI GROUP INTERVIEW</div><h1>准备好，开始你的<br /><span>群面练习。</span></h1><p>选择求职场景，从预设题目中挑选一题开始练习。</p></section>
    <section className="mocksharp-workspace">
      <div className="mocksharp-step-list"><div className="mocksharp-step active"><span>01</span><div><b>行业</b><small>你要进入哪个行业？</small></div></div><div className={`mocksharp-step ${company ? 'active' : ''}`}><span>02</span><div><b>公司</b><small>目标公司或组织</small></div></div><div className="mocksharp-step active"><span>03</span><div><b>目标岗位</b><small>你要申请的职位</small></div></div><div className="mocksharp-step active"><span>04</span><div><b>题型</b><small>你想练习的群面类型</small></div></div></div>
      <div className="mocksharp-form">
        <div className="mocksharp-field"><label>01 / 行业</label><div className="mocksharp-options">{INTERVIEW_INDUSTRIES.map((item) => <button key={item.value} type="button" className={industry === item.value ? 'selected' : ''} onClick={() => { const next = INTERVIEW_CONFIG[item.value]; const nextJob = next.jobs[0].value; setIndustry(item.value); setJobKey(nextJob); setTopicType(next.topicsByJob?.[nextJob]?.[0]?.value ?? next.topics[0].value); resetTopic(); }}>{item.label}</button>)}</div></div>
        <div className="mocksharp-field"><label>02 / 公司名称</label><input className={fieldClass} value={company} onChange={(event) => { setCompany(event.target.value); resetTopic(); }} placeholder="输入你想模拟的公司，如：字节跳动" /></div>
        <div className="mocksharp-field"><label>03 / 目标岗位</label><select className={fieldClass} value={jobKey} onChange={(event) => { const nextJob = event.target.value; const nextTopics = industryConfig.topicsByJob?.[nextJob] ?? industryConfig.topics; setJobKey(nextJob); setTopicType(nextTopics[0]?.value ?? ''); resetTopic(); }}>{industryConfig.jobs.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select></div>
        <div className="mocksharp-field"><label>04 / 题型选择</label><div className="mocksharp-topic-options">{availableTopics.map((item) => <button key={item.value} type="button" className={topicType === item.value ? 'selected' : ''} onClick={() => { setTopicType(item.value); resetTopic(); }}><strong>{item.label}</strong><span>{item.hint}</span></button>)}</div></div>
        <div className="mocksharp-generated"><div className="mocksharp-generated-label">预设题目 · {industryLabel} / {job.label}</div><p>{selectedTopic}</p><label className="mb-4 flex cursor-pointer items-start gap-2 text-sm text-slate-800"><input type="checkbox" checked={demoMode} onChange={(event) => setDemoMode(event.target.checked)} className="mt-1 accent-[#171717]" /><span><b>比赛演示模式</b><small className="block text-xs text-slate-600">群面缩短至约 1 分钟，报告由本地规则引擎生成</small></span></label><button type="button" className="mocksharp-primary" onClick={start} disabled={!selectedQuestion}>开始练习 →</button></div>
      </div>
    </section>
    <section className="mocksharp-recent"><div className="mocksharp-section-label">最近练习</div><RecentPracticeList onViewLocalReport={onViewLocalReport} onRetry={(item) => { setCompany(item.company || ''); setTopicType(item.topicType || 'priority_ranking'); }} /></section>
  </div>;
};
export default QuestionBankHome;
