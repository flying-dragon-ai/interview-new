import React, { useState } from 'react';
import { generateTopicStream } from '../services/geminiService';
import { ROLE_CARDS, inferIndustry, cardDisplayRole } from '../data/roleCards';
import { findAvatarPreset } from '../data/avatars';
import { autoSelectPanel, autoSelectRoles, validatePanelSelection, validateSelection, resolveRoleCards } from '../engine/roleSelector';
import { TOPIC_TYPES } from '../constants';
import { DEFAULT_PANEL_SIZE, type InterviewFormat, type PanelSize, type RoleCard } from '../types';
/**
 * 准备页（PRD 4.1.2 / 5.2）
 * 公司/岗位 → 面试模式 → 群面题型或单面面试官 → 生成内容 → 设备检测 → 房间。
 */

interface SetupFormProps {
  onStart: (params: {
    topic: string;
    jobTitle: string;
    company: string;
    topicType: string;
    format: InterviewFormat;
    roles: RoleCard[];
  }) => void;
}

const ROLE_BADGE: Record<string, { label: string; className: string }> = {
  AGGRESSIVE: { label: '高冲突', className: 'bg-red-400/15 border-red-400/30 text-red-300' },
  STRUCTURED: { label: '高协作', className: 'bg-blue-400/15 border-blue-400/30 text-blue-300' },
  DETAIL: { label: '中立', className: 'bg-emerald-400/15 border-emerald-400/30 text-emerald-300' },
};

const SetupForm: React.FC<SetupFormProps> = ({ onStart }) => {
  const [topic, setTopic] = useState('');
  const [jobTitle, setJobTitle] = useState('');
  const [company, setCompany] = useState('');
  const [topicType, setTopicType] = useState<string>('business_case');
  /** 群面阵型：lgd = 主持 + 3 位 AI 候选人 + 我；panel = 2 或 3 位面试官 + 我 */
  const [format, setFormat] = useState<InterviewFormat>('lgd');
  /** 结构化单面默认 2 位，可选 3 位。 */
  const [panelSize, setPanelSize] = useState<PanelSize>(DEFAULT_PANEL_SIZE);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [isGenerating, setIsGenerating] = useState(false);

  const roleCap = format === 'panel' ? panelSize : 3;
  const selectedCards = resolveRoleCards(selectedIds);
  const violations = format === 'panel' ? validatePanelSelection(selectedCards, panelSize) : [];

  const applyFormat = (next: InterviewFormat) => {
    if (next === format) return;
    setFormat(next);
    setTopic('');
  };

  const applyPanelSize = (next: PanelSize) => {
    setPanelSize(next);
    setSelectedIds((prev) => prev.slice(0, next));
  };

  const toggleCard = (id: string) => {
    setSelectedIds((prev) => {
      if (prev.includes(id)) return prev.filter((x) => x !== id);
      if (prev.length >= roleCap) return prev;
      return [...prev, id];
    });
  };

  const handleAutoSelect = () => {
    const industry = inferIndustry(jobTitle || company);
    const seed = Date.now() % 100000;
    const cards = autoSelectPanel(industry, seed, panelSize);
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
      const cleaned = await generateTopicStream(company, jobTitle, (chunk) => setTopic((prev) => prev + chunk), {
        format,
        ...(format === 'lgd' ? { topicType } : {}),
      });
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
    const cards = format === 'panel'
      ? selectedCards
      : autoSelectRoles(inferIndustry(jobTitle || company), Date.now() % 100000);
    if (format === 'panel' && cards.length !== panelSize) {
      alert(`请选择 ${panelSize} 个面试官角色（或点击随机分配）`);
      return;
    }
    const selectionErrors = format === 'panel' ? violations : validateSelection(cards);
    if (selectionErrors.length > 0) {
      alert(`角色组合不满足约束：${selectionErrors.map((v) => v.message).join('；')}`);
      return;
    }
    onStart({ topic, jobTitle, company, topicType: format === 'panel' ? 'structured_interview' : topicType, format, roles: cards });
  };

  return (
    <div className="w-full max-w-3xl mx-auto glass-panel overflow-hidden">
      {/* 头部：超大标题 + 品牌渐变关键词 + 英文小字（替换原蓝色实色块） */}
      <div className="px-8 pt-10 pb-6 text-center">
        <h1 className="text-4xl md:text-5xl font-black text-white tracking-tight">
          开始<span className="text-gradient-brand">练习</span>
        </h1>
        <p className="mt-3 text-[11px] md:text-xs text-white/40 tracking-widest uppercase">
          Leaderless Group Discussion Simulator
        </p>
        <p className="text-white/60 text-sm mt-3">
          {format === 'panel' ? '填写信息 · 选择面试官形象 · 生成面试提纲' : '填写信息 · 选择题目类型 · 与 3 位 AI 同场讨论'}
        </p>
      </div>

      <form onSubmit={handleSubmit} className="stagger px-8 pb-8 space-y-6">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label htmlFor="setup-company" className="block text-sm font-semibold text-white/60 mb-2">目标公司</label>
            <input
              id="setup-company"
              type="text"
              value={company}
              onChange={(e) => setCompany(e.target.value)}
              placeholder="如：字节跳动、腾讯、阿里"
              className="glass-input px-4 py-3"
              required
            />
          </div>
          <div>
            <label htmlFor="setup-job-title" className="block text-sm font-semibold text-white/60 mb-2">应聘岗位</label>
            <input
              id="setup-job-title"
              type="text"
              value={jobTitle}
              onChange={(e) => setJobTitle(e.target.value)}
              placeholder="如：产品经理、运营专员"
              className="glass-input px-4 py-3"
              required
            />
          </div>
        </div>

        {/* 先选择模式，再显示该模式需要的准备选项。 */}
        <div>
          <div className="block text-sm font-semibold text-white/60 mb-2">面试模式</div>
          <div role="group" aria-label="面试模式" className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => applyFormat('lgd')}
              disabled={isGenerating}
              aria-pressed={format === 'lgd'}
              className={`glass-card setup-choice p-4 text-left ${format === 'lgd' ? 'setup-choice-selected' : ''}`}
            >
              <div className="text-sm font-bold text-white">无领导小组讨论</div>
              <div className="text-[11px] text-white/50 mt-1 leading-relaxed">
                1 位主持面试官控场（审题 → 个人陈述 → 自由讨论 → 总结），3 位 AI 候选人与你同场，共 4 位候选人
              </div>
            </button>
            <button
              type="button"
              onClick={() => applyFormat('panel')}
              disabled={isGenerating}
              aria-pressed={format === 'panel'}
              className={`glass-card setup-choice p-4 text-left ${format === 'panel' ? 'setup-choice-selected' : ''}`}
            >
              <div className="text-sm font-bold text-white">结构化单面</div>
              <div className="text-[11px] text-white/50 mt-1 leading-relaxed">
                AI 面试官轮流提问、追问，你是唯一候选人。默认 2 位面试官，可切换为 3 位
              </div>
            </button>
          </div>
          {format === 'panel' && (
            <div className="mt-3">
              <div className="text-[11px] font-semibold text-white/50 mb-2">面试官人数</div>
              <div className="flex gap-2">
                {([2, 3] as const).map((n) => (
                  <button
                    key={n}
                    type="button"
                    onClick={() => applyPanelSize(n)}
                    aria-pressed={panelSize === n}
                    className={`glass-btn-ghost setup-choice text-xs px-3 py-1.5 ${panelSize === n ? 'setup-choice-selected' : ''}`}
                  >
                    {n} 位{n === DEFAULT_PANEL_SIZE ? '（默认）' : ''}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>

        {format === 'lgd' && (
          <div>
            <label htmlFor="setup-topic-type" className="block text-sm font-semibold text-white/60 mb-2">题目类型</label>
            <select
              id="setup-topic-type"
              value={topicType}
              onChange={(e) => { setTopicType(e.target.value); setTopic(''); }}
              disabled={isGenerating}
              className="glass-input px-4 py-3"
            >
              {TOPIC_TYPES.map((t) => (
                <option key={t.value} value={t.value}>{t.label}</option>
              ))}
            </select>
          </div>
        )}

        {/* 只有结构化单面需要选择面试官形象。 */}
        {format === 'panel' && (
          <div>
            <div className="flex items-center justify-between mb-3">
              <label className="block text-sm font-semibold text-white/60">
                选择面试官形象（<span className="tabular-nums">{selectedIds.length}</span>/{panelSize}）
              </label>
              <button
                type="button"
                onClick={handleAutoSelect}
                className="glass-btn-ghost text-xs px-3 py-1.5"
              >
                随机分配（按岗位匹配）
              </button>
            </div>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-3 max-h-80 overflow-y-auto p-1 glass-scroll">
              {ROLE_CARDS.map((card) => {
                const preset = findAvatarPreset(card.avatar.preset_id);
                const selected = selectedIds.includes(card.id);
                const badge = ROLE_BADGE[cardDisplayRole(card)];
                return (
                  <button
                    key={card.id}
                    type="button"
                    onClick={() => toggleCard(card.id)}
                    aria-pressed={selected}
                    className={`glass-card bounce-liquid flex flex-col items-center p-3 ${selected ? 'glass-selected' : ''}`}
                  >
                    <img src={preset?.asset_url} alt={card.name} className="w-14 h-14 rounded-full border border-white/15" />
                    <span className="mt-2 text-xs font-semibold text-white whitespace-nowrap">{card.name}</span>
                    <span className={`glass-chip mt-1.5 text-[10px] px-2 py-0.5 border ${badge.className}`}>{badge.label}</span>
                    <span className="text-[10px] text-white/40 mt-1">{card.industry}</span>
                  </button>
                );
              })}
            </div>
            {selectedIds.length > 0 && violations.length > 0 && (
              <div className="mt-2 text-xs text-amber-300/80 space-y-0.5">
                {violations.map((v) => (
                  <div key={v.rule}>⚠️ {v.message}</div>
                ))}
              </div>
            )}
            {selectedIds.length === roleCap && violations.length === 0 && (
              <div className="mt-2 text-xs text-emerald-300/80">
                ✅ 组合满足约束：音色/形象不重复
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          onClick={handleGenerate}
          disabled={isGenerating || !company || !jobTitle}
          className="glass-btn w-full py-3 font-medium"
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
            format === 'panel' ? 'AI 生成面试提纲' : 'AI 生成题目'
          )}
        </button>

        {topic && (
          <div>
            <label htmlFor="setup-topic" className="block text-sm font-semibold text-white/60 mb-2">
              {format === 'panel' ? '面试提纲' : '群面题目'}
            </label>
            {/* 题目卡：white/8 玻璃 + 左侧 3px 品牌渐变色条 */}
            <div className="relative glass-card p-4 pl-6">
              <div className="absolute left-3 top-4 bottom-4 w-[3px] rounded-full bg-gradient-to-b from-brand to-brand-soft" aria-hidden="true" />
              <textarea
                id="setup-topic"
                value={topic}
                onChange={(e) => setTopic(e.target.value)}
                className="w-full h-44 bg-transparent outline-none resize-none text-sm leading-relaxed text-white/85 placeholder:text-white/30"
                placeholder="生成的题目将显示在这里..."
              />
            </div>
          </div>
        )}

        {topic && (
          /* 主 CTA：液态折射层 + 品牌渐变微光，尺寸大一个量级 */
          <button
            type="submit"
            disabled={format === 'panel' && (selectedCards.length !== panelSize || violations.length > 0)}
            className="liquid glass-btn-primary w-full py-5 text-lg font-bold"
          >
            <span className="liquid-content">开始设备检测</span>
          </button>
        )}
      </form>
    </div>
  );
};

export default SetupForm;
