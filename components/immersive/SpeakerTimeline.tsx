import React from 'react';
import type { Message, RoleCard } from '../../types';

/**
 * SpeakerTimeline —— 发言轨迹条升级版（M7 P3-5）
 * 可点击的横向时间轴：用户品牌渐变条 / AI 白点，点击回跳字幕（CaptionStrip review）。
 */

interface Props {
  messages: Message[];
  roles: RoleCard[];
  selectedId: string | null;
  onSelect: (msg: Message) => void;
}

const SpeakerTimeline: React.FC<Props> = ({ messages, selectedId, onSelect }) => {
  if (messages.length === 0) return null;
  return (
    <div className="absolute inset-x-0 bottom-16 md:bottom-20 px-4 md:px-6 z-10">
      <div className="mx-auto max-w-3xl flex items-center gap-2 px-3 py-1.5 rounded-full bg-black/30 backdrop-blur-md border border-white/10">
        <span className="text-[10px] text-white/40 font-bold shrink-0">发言轨迹</span>
        <div className="flex-1 flex items-center gap-1 overflow-x-auto scrollbar-hide">
          {messages.slice(-60).map((m, i, arr) => (
            <button
              key={m.id}
              title={`${m.senderName}：${m.content.slice(0, 30)}`}
              onClick={() => onSelect(m)}
              className={`h-2 rounded-full shrink-0 transition-all cursor-pointer hover:scale-y-150 ${
                m.senderId === 'user' ? 'w-7 bg-gradient-to-r from-brand to-brand-soft' : 'w-3.5 bg-white/30 hover:bg-white/50'
              } ${m.id === selectedId ? 'scale-y-150 shadow-[0_0_10px_rgba(91,108,255,0.9)]' : i === arr.length - 1 ? 'scale-y-125' : ''}`}
            />
          ))}
        </div>
        <span className="text-[10px] text-white/40 shrink-0 tabular-nums">共 {messages.length} 次发言</span>
      </div>
    </div>
  );
};

export default SpeakerTimeline;
