import React from 'react';
import type { Message, RoleCard } from '../../types';
import type { SessionSnapshot } from '../../src/session/sessionStore';

/**
 * CaptionStrip —— 沉浸模式字幕条（M7 P3-5，替代聊天气泡）
 * 底部一条字幕带：AI 流式生成 / 用户「你正在说」/ 最近一条发言 / 时间轴点击回跳。
 * 不占屏幕中上部。
 */

interface Props {
  snapshot: SessionSnapshot;
  roles: RoleCard[];
  /** 时间轴点击回跳的消息（5 秒自动回到实时字幕） */
  review: Message | null;
}

/** 说话人色条：用户品牌渐变；AI 按 id 哈希取色（同卡恒定） */
export function speakerColor(senderId: string): string {
  if (senderId === 'user') return 'linear-gradient(90deg,#5b6cff,#8f7bff)';
  let hash = 0;
  for (let i = 0; i < senderId.length; i++) hash = (hash * 31 + senderId.charCodeAt(i)) >>> 0;
  const hue = hash % 360;
  return `hsl(${hue} 70% 60%)`;
}

const CaptionStrip: React.FC<Props> = ({ snapshot, roles, review }) => {
  // 优先级：回跳 > 用户正在说 > AI 流式 > 思考中 > 最近一条
  let name: string;
  let text: string;
  let live = false;
  let senderId: string;

  if (review) {
    name = review.senderName;
    text = review.content;
    senderId = review.senderId;
  } else if (snapshot.userSpeaking) {
    name = '你';
    text = '你正在说…';
    live = true;
    senderId = 'user';
  } else if (snapshot.isGenerating && snapshot.streamingText) {
    const card = roles.find((c) => c.id === snapshot.activeCharId);
    name = card?.name ?? 'AI';
    text = snapshot.streamingText;
    live = true;
    senderId = snapshot.activeCharId ?? 'ai';
  } else if (snapshot.isGenerating) {
    const card = roles.find((c) => c.id === snapshot.activeCharId);
    name = card?.name ?? 'AI';
    text = '思考中…';
    live = true;
    senderId = snapshot.activeCharId ?? 'ai';
  } else {
    const last = snapshot.messages[snapshot.messages.length - 1];
    if (!last) return null;
    name = last.senderId === 'user' ? '你' : last.senderName;
    text = last.content;
    senderId = last.senderId;
  }

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-24 md:bottom-28 flex justify-center px-4 z-10">
      <div className="glass-panel max-w-3xl w-full px-4 md:px-5 py-3 flex items-start gap-3">
        <span className="w-1 self-stretch rounded-full shrink-0" style={{ background: speakerColor(senderId) }} />
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-black text-white/70 uppercase tracking-widest">{name}</span>
            {live && <span className="w-1.5 h-1.5 rounded-full bg-brand animate-pulse" />}
            {review && <span className="text-[9px] text-white/30">回跳字幕（5 秒后返回实时）</span>}
          </div>
          <p className="text-[14px] md:text-[15px] text-white/90 leading-relaxed whitespace-pre-wrap line-clamp-3">{text}</p>
        </div>
      </div>
    </div>
  );
};

export default CaptionStrip;
