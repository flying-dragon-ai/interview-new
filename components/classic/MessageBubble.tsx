import React, { memo } from 'react';
import type { Message, RoleCard } from '../../types';
import { findAvatarPreset } from '../../data/avatars.ts';

/** 经典模式聊天气泡（M7 Phase 1 从 DiscussionPanel 抽取，渲染不变） */

interface Props {
  msg: Message;
  roles: RoleCard[];
}

/** memo：快照 4Hz 更新（阶段/流式文本）不再逐气泡重渲；roles 引用由 DiscussionPanel memo 保证稳定 */
const MessageBubble = memo(function MessageBubble({ msg, roles }: Props) {
  const isUser = msg.senderId === 'user';
  const card = roles.find((c) => c.id === msg.senderId);
  const preset = card ? findAvatarPreset(card.avatar.preset_id) : undefined;
  return (
    <div className={`flex ${isUser ? 'justify-end' : 'justify-start'} fade-up`}>
      <div
        className={`max-w-[80%] rounded-2xl px-5 py-4 ${
          isUser
            ? 'gradient-ring bg-white/10 text-white rounded-tr-none'
            : 'bg-white/[0.08] border border-white/15 text-white/90 rounded-tl-none'
        }`}
      >
        {isUser ? (
          <div className="flex items-center justify-end mb-2 gap-2">
            <span className="text-[9px] text-white/40 tabular-nums">
              {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
            <span className="w-5 h-5 rounded-full bg-white/10 border border-white/20 flex items-center justify-center text-[8px] text-white/70">我</span>
          </div>
        ) : (
          <div className="flex items-center mb-2 gap-2">
            {card && preset?.asset_url && (
              <img src={preset.asset_url} alt={card.name} className="w-5 h-5 rounded-full border border-white/20" />
            )}
            {card && <span className="text-[10px] font-black text-white/85 uppercase tracking-widest">{card.name}</span>}
            {msg.emotion && msg.emotion !== 'neutral' && (
              <span className="glass-chip text-[9px] px-1.5 py-0.5 text-white/60">{msg.emotion}</span>
            )}
            <span className="text-[9px] text-white/30 tabular-nums ml-auto">
              {new Date(msg.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}
            </span>
          </div>
        )}
        <p className="text-[14px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
      </div>
    </div>
  );
});

export default MessageBubble;
