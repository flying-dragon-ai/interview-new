import React from 'react';
import type { RoleCard } from '../../types';
import { findAvatarPreset } from '../../data/avatars.ts';

/**
 * 经典模式桌面右侧栏（M7 Phase 1 从 DiscussionPanel 抽取，渲染不变）：
 * 题目卡 + 角色形象 + 阶段说明 + 发言权提示
 */

interface Props {
  topic: string;
  currentKeyPoint: string | null;
  roles: RoleCard[];
  speakingCharId: string | null;
  activeCharId: string | null;
  awaitingUser: boolean;
  isGenerating: boolean;
}

const ClassicAside: React.FC<Props> = ({
  topic,
  currentKeyPoint,
  roles,
  speakingCharId,
  activeCharId,
  awaitingUser,
  isGenerating,
}) => {
  return (
    <aside className="hidden md:flex md:w-80 lg:w-96 border-l border-white/10 bg-white/[0.03] backdrop-blur-xl flex-col overflow-y-auto p-4 gap-4 shrink-0 glass-scroll">
      {/* 题目卡 */}
      <div className="glass-panel p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="glass-chip w-8 h-8 justify-center rounded-xl text-brand">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" viewBox="0 0 20 20" fill="currentColor">
              <path d="M9 4.804A7.968 7.968 0 005.5 4c-1.255 0-2.443.29-3.5.804v10.392A7.968 7.968 0 015.5 14c1.255 0 2.443.29 3.5.804V4.804zM11 4.804A7.968 7.968 0 0114.5 4c1.255 0-2.443.29-3.5.804v10.392a7.968 7.968 0 003.5-.804c1.255 0 2.443.29 3.5.804V4.804z" />
            </svg>
          </span>
          <h3 className="text-sm font-black text-white tracking-tight">题目</h3>
        </div>
        <div className="max-h-56 overflow-y-auto glass-scroll">
          <p className="text-[13px] text-white/70 leading-relaxed whitespace-pre-wrap">{topic}</p>
          {currentKeyPoint && <div className="mt-2 text-[11px] font-bold text-gradient-brand">当前要点：{currentKeyPoint}</div>}
        </div>
      </div>

      {/* 面试官形象：玻璃底座，当前发言人渐变描边 + 呼吸发光 */}
      <div>
        <h3 className="text-[11px] font-black text-white/50 uppercase tracking-widest mb-2">面试官形象</h3>
        <div className="grid grid-cols-2 gap-2">
          {roles.map((card) => {
            const preset = findAvatarPreset(card.avatar.preset_id);
            const isSpeaking = speakingCharId === card.id;
            const isActive = activeCharId === card.id;
            return (
              <div
                key={card.id}
                className={`glass-card flex flex-col items-center p-2 rounded-2xl transition-all ${
                  isSpeaking ? 'liquid speaking-frame scale-105' : isActive ? 'glass-selected' : speakingCharId ? 'opacity-50 saturate-50' : 'opacity-75'
                }`}
              >
                <img src={preset?.asset_url} alt={card.name} className="w-12 h-12 rounded-full border border-white/20" />
                <span className="mt-1 text-[11px] font-semibold text-white whitespace-nowrap">{card.name}</span>
                <span className="text-[9px] text-white/40 whitespace-nowrap">{card.voice.voice_id.replace('stepfun_', '')} · ×{card.voice.rate}</span>
              </div>
            );
          })}
        </div>
      </div>

      {/* 阶段说明 */}
      <div className="glass-panel p-4">
        <h3 className="text-[11px] font-black text-white/50 uppercase tracking-widest mb-2">阶段说明</h3>
        <ol className="text-[11px] text-white/60 space-y-1.5 list-decimal pl-4">
          <li><span className="inline-block w-1.5 h-1.5 rounded-full bg-stage-think mr-1 align-middle" />审题（2 分钟，不发言）</li>
          <li><span className="inline-block w-1.5 h-1.5 rounded-full bg-stage-speak mr-1 align-middle" />个人陈述（每人 1 分钟）</li>
          <li><span className="inline-block w-1.5 h-1.5 rounded-full bg-stage-discuss mr-1 align-middle" />自由讨论（≤15 分钟，可打断）</li>
          <li><span className="inline-block w-1.5 h-1.5 rounded-full bg-stage-summary mr-1 align-middle" />总结陈词（3 分钟）</li>
        </ol>
      </div>

      {/* 发言权提示 */}
      <div className="glass-card mt-auto p-4">
        <div className="flex items-center gap-2 mb-2">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-brand opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-brand"></span>
          </span>
          <span className="text-[10px] font-black text-gradient-brand uppercase tracking-wider">发言权提示</span>
        </div>
        <p className="text-[11px] text-white/70 leading-relaxed">
          {awaitingUser
            ? '当前发言权在你手中，请发表观点。'
            : speakingCharId
              ? `${roles.find((c) => c.id === speakingCharId)?.name ?? 'AI'} 正在发言，你可以随时抢话（barge-in）。`
              : isGenerating
                ? 'AI 正在思考...'
                : '等待调度器分配发言权...'}
        </p>
      </div>
    </aside>
  );
};

export default ClassicAside;
