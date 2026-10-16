import React, { useState } from 'react';
import { generateTopicStream } from '../services/geminiService';
import { ROLE_CARDS, inferIndustry, cardDisplayRole } from '../data/roleCards';
import { findAvatarPreset } from '../data/avatars';
import { autoSelectRoles, validateSelection, resolveRoleCards } from '../engine/roleSelector';
import { TOPIC_TYPES } from '../constants';
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
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [topicType, setTopicType] = useState<string>('business_case');
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const selectedCards = resolveRoleCards(selectedIds);
  const violations = validateSelection(selectedCards);

  const toggleCard = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= 3) return prev; // 最多 3 张
      return [...prev, id];
    });
  };

  const handleAutoSelect = () => {
    const industry = inferIndustry(jobTitle || company);
    const cards = autoSelectRoles(industry, Date.now() % 100000);
    setSelectedIds(cards.map((c) => c.id));
  };

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
      setTopic('题目生成失败，请手动输入。');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!topic || !jobTitle || !company) return;
    if (selectedCards.length !== 3) {
      alert('请选择 3 个面试官角色（或点击随机分配）');
      return;
    }
    if (violations.length > 0) {
      alert(`角色组合不满足约束：${violations.map((v) => v.message).join('；')}`);
      return;
    }
    onStart({ topic, jobTitle, company, topicType, roles: selectedCards });
  };

  return (
    <div className="w-full max-w-3xl mx-auto bg-white rounded-2xl shadow-lg border border-slate-200 overflow-hidden">
      <div className="bg-blue-600 px-8 py-6">
        <h1 className="text-2xl font-bold text-white text-center">开始练习</h1>
        <p className="text-blue-100 text-center text-sm mt-1">填写信息 · 选择面试官形象 · 生成专属题目</p>
      </div>

      <form onSubmit={handleSubmit} className="p-8 space-y-6">
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
            <input
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="如：产品经理、运营专员"
              className="w-full px-4 py-3 rounded-lg border border-slate-300 focus:border-blue-500 focus:ring-2 focus:ring-blue-100 outline-none transition"
              required
            />
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold text-slate-700 mb-2">题目类型</label>
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

        {/* 角色选择（12 角色卡抽 3） */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <label className="block text-sm font-semibold text-slate-700">
              选择面试官形象（{selectedIds.length}/3）
            </label>
            <button
              type="button"
              onClick={handleAutoSelect}
              className="text-sm text-blue-600 hover:underline font-medium"
            >
              随机分配（按岗位匹配）
            </button>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2 max-h-72 overflow-y-auto p-1">
            {ROLE_CARDS.map((card) => {
              const preset = findAvatarPreset(card.avatar.preset_id);
              const selected = selectedIds.includes(card.id);
              const badge = ROLE_BADGE[cardDisplayRole(card)];
              return (
                <button
                  key={card.id}
                  type="button"
                  onClick={() => toggleCard(card.id)}
                  className={`flex flex-col items-center p-2 rounded-xl border transition-all ${
                    selected ? 'border-blue-500 bg-blue-50 shadow' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <img src={preset?.asset_url} alt={card.name} className="w-12 h-12 rounded-full" />
                  <span className="mt-1 text-xs font-semibold text-slate-700 whitespace-nowrap">{card.name}</span>
                  <span className={`mt-0.5 text-[9px] px-1.5 py-0.5 rounded text-white ${badge.className}`}>{badge.label}</span>
                  <span className="text-[9px] text-slate-400 mt-0.5">{card.industry}</span>
                </button>
              );
            })}
          </div>
          {selectedIds.length > 0 && violations.length > 0 && (
            <div className="mt-2 text-xs text-amber-600 space-y-0.5">
              {violations.map((v) => (
                <div key={v.rule}>⚠️ {v.message}</div>
              ))}
            </div>
          )}
          {selectedIds.length === 3 && violations.length === 0 && (
            <div className="mt-2 text-xs text-emerald-600">✅ 组合满足约束：音色/形象/策略不重复，性格互补</div>
          )}
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
            disabled={selectedCards.length !== 3 || violations.length > 0}
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
