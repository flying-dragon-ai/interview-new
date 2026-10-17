import React, { useMemo, useState } from 'react';
import { generateTopicStream } from '../services/geminiService';
import { cardDisplayRole } from '../data/roleCards';
import { findAvatarPreset } from '../data/avatars';
import { autoSelectRolesForTopic } from '../engine/roleSelector';
import { pickBankQuestion } from '../data/questionBank';
import { INTERVIEW_INDUSTRIES, INTERVIEW_JOBS, TOPIC_TYPES } from '../constants';
import type { RoleCard } from '../types';

/**
 * 准备页（PRD 4.1.2 / 5.2）
 * 公司/岗位 → 题型 → 形象（12 角色卡抽 3）→ 生成题目 → 设备检测 → 房间。
 */

interface SetupFormProps {
  onStart: (params: {
    topic: string;
    jobTitle: string;
    company: string;
    topicType: string;
    roles: RoleCard[];
  }) => void;
}

const ROLE_BADGE: Record<string, { label: string; className: string }> = {
  AGGRESSIVE: { label: '高冲突', className: 'bg-red-500' },
  STRUCTURED: { label: '高协作', className: 'bg-blue-500' },
  DETAIL: { label: '中立', className: 'bg-emerald-500' },
};

const SetupForm: React.FC<SetupFormProps> = ({ onStart }) => {
  const [topic, setTopic] = useState('');
  const [jobTitle, setJobTitle] = useState('产品经理');
  const [company, setCompany] = useState('');
  const [topicType, setTopicType] = useState<string>('business_case');
  const [industry, setIndustry] = useState<string>('internet');
  const [jobKey, setJobKey] = useState<string>('product_manager');
  const [isGenerating, setIsGenerating] = useState(false);

  const selectedCards = useMemo(() => {
    const selectedIndustry = INTERVIEW_INDUSTRIES.find((item) => item.value === industry)?.roleIndustry ?? 'tech';
    return autoSelectRolesForTopic(selectedIndustry, topicType, 20261017);
  }, [industry, topicType]);

  const bankQuestion = useMemo(() => {
    const selectedIndustry = INTERVIEW_INDUSTRIES.find((item) => item.value === industry)?.roleIndustry ?? 'tech';
    return pickBankQuestion(selectedIndustry as 'tech' | 'fmcg' | 'finance' | 'manufacturing', jobKey, topicType as 'priority_ranking' | 'business_case' | 'open_debate');
  }, [industry, jobKey, topicType]);

  const handleGenerate = async () => {
    if (!company || !jobTitle) {
      alert('请填写公司和岗位');
      return;
    }
    setIsGenerating(true);
    setTopic('');
    try {
      const cleaned = await generateTopicStream(company, jobTitle, (chunk) => setTopic((prev) => prev + chunk));
      setTopic(cleaned || '请手动输入题目');
    } catch (error) {
      console.error(error);
      setTopic(bankQuestion?.title ?? '题目生成失败，请手动输入。');
    } finally {
      setIsGenerating(false);
    }
  };

  const useBankQuestion = () => {
    if (bankQuestion) setTopic(bankQuestion.title);
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic || !jobTitle || !company) return;
    onStart({ topic, jobTitle, company, topicType, roles: selectedCards });
  };

  return (
    <div className="w-full max-w-3xl mx-auto bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
      <div className="bg-[#efff00] px-8 py-8">
        <div className="text-xs font-black tracking-[0.28em] text-slate-950/60 uppercase">MOCK GROUP INTERVIEW</div>
        <h1 className="text-3xl font-black text-slate-950 text-left mt-3">一个人，也能开一场群面</h1>
        <p className="text-slate-800/70 text-sm mt-2">先选行业、岗位和题型，进入多人 AI 群面流程。</p>
      </div>

      <form onSubmit={handleSubmit} className="p-8 space-y-6">
        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">第一步：选择行业</label>
          <div className="flex flex-wrap gap-2">
            {INTERVIEW_INDUSTRIES.map((item) => (
              <button key={item.value} type="button" onClick={() => setIndustry(item.value)} className={`px-4 py-2 rounded-full border text-sm font-semibold transition ${industry === item.value ? 'border-lime-400 bg-lime-300 text-slate-950' : 'border-slate-200 text-slate-600 hover:border-slate-400'}`}>{item.label}</button>
            ))}
          </div>
        </div>

        <div className="text-xs font-black tracking-widest text-slate-500 uppercase">Step 02 · 岗位与公司</div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">目标公司</label>
            <input
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="如：字节跳动、腾讯、阿里"
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition"
              required
            />
          </div>
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">应聘岗位</label>
            <select value={jobKey} onChange={(e) => { setJobKey(e.target.value); setJobTitle(INTERVIEW_JOBS.find((job) => job.value === e.target.value)?.label ?? ''); }} className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-blue-500 outline-none">
              {INTERVIEW_JOBS.map((job) => <option key={job.value} value={job.value}>{job.label}</option>)}
            </select>
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">第三步：选择群面题型</label>
          <select
            value={topicType}
            onChange={(e) => setTopicType(e.target.value)}
            className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-blue-500 outline-none"
          >
            {TOPIC_TYPES.map((t) => (
              <option key={t.value} value={t.value}>
                {t.label}
              </option>
            ))}
          </select>
        </div>

        {/* 角色预览：由行业 + 题型自动分配 */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-semibold text-slate-700">本场 AI 队友</label>
            <span className="text-xs text-slate-400">自动分配 3 名候选人</span>
          </div>
          <div className="grid grid-cols-3 gap-2 p-1">
            {selectedCards.map((card) => {
              const preset = findAvatarPreset(card.avatar.preset_id);
              const badge = ROLE_BADGE[cardDisplayRole(card)];
              return (
                <div
                  key={card.id}
                  className="flex flex-col items-center p-2 rounded-xl border border-slate-200 bg-slate-50"
                >
                  <img src={preset?.asset_url} alt={card.name} className="w-12 h-12 rounded-full" />
                  <span className="mt-1 text-xs font-semibold text-slate-700 whitespace-nowrap">{card.name}</span>
                  <span className={`mt-0.5 text-[9px] px-1.5 py-0.5 rounded text-white ${badge.className}`}>{badge.label}</span>
                  <span className="text-[9px] text-slate-400 mt-0.5">{card.industry}</span>
                </div>
              );
            })}
          </div>
          <div className="mt-2 text-xs text-slate-500">固定参与者：3 名 AI 候选人、1 名 AI 面试官、你。</div>
        </div>

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isGenerating || !company || !jobTitle}
          className="w-full py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition flex items-center justify-center gap-2"
        >
          {isGenerating ? (
            <>
              <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" strokeWidth="4" fill="none"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"></path>
              </svg>
              生成中...
            </>
          ) : (
            'AI 生成题目'
          )}
        </button>

        <button type="button" onClick={useBankQuestion} disabled={!bankQuestion || isGenerating} className="w-full py-3 border border-slate-300 text-slate-700 rounded-lg font-semibold hover:border-slate-500 disabled:opacity-50 transition">
          使用题库题目进入面试
        </button>

        {topic && (
          <div>
            <label className="block text-sm font-semibold text-slate-700 mb-2">群面题目</label>
            <textarea
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              className="w-full h-48 px-4 py-3 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition resize-none text-sm leading-relaxed"
              placeholder="生成的题目将显示在这里..."
            />
          </div>
        )}

        {topic && (
          <button
            type="submit"
            disabled={selectedCards.length !== 3}
            className="w-full py-4 bg-slate-900 text-white rounded-lg font-bold hover:bg-slate-800 transition text-base disabled:opacity-40"
          >
            下一步：设备检测
          </button>
        )}
      </form>
    </div>
  );
};

export default SetupForm;
