import React from 'react';
import type { RoleCard } from '../types';
import { findAvatarPreset } from '../data/avatars';
import { cardDisplayRole } from '../data/roleCards';

/**
 * 形象占位版（PRD 4.1.8 / 6.3-7）
 * 静态图 + 说话高亮 + 音色绑定；viseme 口型为 P1（资源为 null 时降级高亮）。
 */

interface AvatarStageProps {
  cards: RoleCard[];
  interviewerCard?: RoleCard | null;
  /** 当前被调度发言的角色（发言权） */
  activeCardId: string | null;
  /** 正在 TTS 播报的角色 */
  speakingCardId: string | null;
  /** 用户摄像头是否开启 */
  cameraEnabled?: boolean;
  facingMode?: 'user' | 'environment';
  micOn?: boolean;
  userStream?: MediaStream | null;
}

const ROLE_BADGE: Record<string, { label: string; className: string }> = {
  AGGRESSIVE: { label: '高冲突', className: 'bg-red-500' },
  STRUCTURED: { label: '高协作', className: 'bg-blue-500' },
  DETAIL: { label: '中立', className: 'bg-emerald-500' },
};

const EMOTION_EMOJI: Record<string, string> = {
  neutral: '😐',
  positive: '🙂',
  tense: '😠',
  serious: '🧐',
};

const AvatarStage: React.FC<AvatarStageProps> = ({
  cards,
  interviewerCard,
  activeCardId,
  speakingCardId,
  cameraEnabled = false,
  facingMode = 'user',
  micOn = true,
  userStream,
}) => {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2 scrollbar-hide">
      {cards.map((card) => {
        const preset = findAvatarPreset(card.avatar.preset_id);
        const isActive = activeCardId === card.id;
        const isSpeaking = speakingCardId === card.id;
        const badge = ROLE_BADGE[cardDisplayRole(card)] ?? ROLE_BADGE.DETAIL;
        return (
          <div
            key={card.id}
            className={`relative flex flex-col items-center p-3 rounded-xl transition-all duration-300 min-w-[92px] shrink-0 ${
              isSpeaking
                ? 'bg-white shadow-lg scale-105 border-2 border-indigo-500 ring-4 ring-indigo-100'
                : isActive
                  ? 'bg-white shadow border-2 border-indigo-300'
                  : 'opacity-70 bg-slate-100 border-2 border-transparent'
            }`}
          >
            <div className="relative">
              <img
                src={preset?.asset_url}
                alt={card.name}
                className={`w-14 h-14 rounded-full border-2 ${isSpeaking ? 'border-indigo-500' : 'border-transparent'}`}
              />
              {isSpeaking && (
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex items-end gap-0.5 h-3">
                  <span className="w-1 bg-indigo-500 rounded-full animate-bounce" style={{ height: '60%', animationDelay: '0ms' }} />
                  <span className="w-1 bg-indigo-500 rounded-full animate-bounce" style={{ height: '100%', animationDelay: '150ms' }} />
                  <span className="w-1 bg-indigo-500 rounded-full animate-bounce" style={{ height: '40%', animationDelay: '300ms' }} />
                </span>
              )}
            </div>
            <span className="mt-2 text-xs font-semibold text-slate-700 whitespace-nowrap">{card.name}</span>
            <span className={`mt-1 text-[9px] px-1.5 py-0.5 rounded text-white ${badge.className}`}>{badge.label}</span>
            <span className="mt-1 text-[9px] text-slate-400 whitespace-nowrap">
              {EMOTION_EMOJI[card.voice.emotion_default] ?? '😐'} {card.voice.voice_id.replace('stepfun_', '')} · ×{card.voice.rate}
            </span>
          </div>
        );
      })}

      {interviewerCard && (
        <div className="relative flex flex-col items-center p-3 rounded-xl bg-white border-2 border-slate-300 min-w-[92px] shrink-0">
          <div className="w-14 h-14 rounded-full bg-slate-800 text-white flex items-center justify-center text-xl">面</div>
          <span className="mt-2 text-xs font-semibold text-slate-700 whitespace-nowrap">面试官</span>
          <span className="mt-1 text-[9px] px-1.5 py-0.5 rounded text-white bg-slate-700">提问 / 控场</span>
        </div>
      )}

      {/* 用户小窗 */}
      <div className="flex flex-col items-center p-3 rounded-xl bg-slate-900 text-white min-w-[92px] shrink-0 border-2 border-slate-900">
        <div className="relative w-14 h-14">
          {cameraEnabled ? (
            <video
              muted
              playsInline
              autoPlay
              ref={(el) => {
                if (el && userStream && el.srcObject !== userStream) el.srcObject = userStream;
              }}
              className="w-14 h-14 rounded-full object-cover border-2 border-white/80"
              style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }}
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-slate-700 flex items-center justify-center text-lg">我</div>
          )}
          <span className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-slate-900 ${micOn ? 'bg-emerald-400' : 'bg-red-500'}`} />
        </div>
        <span className="mt-2 text-xs font-semibold">陈明 (我)</span>
        <span className="mt-1 text-[9px] text-slate-400">{cameraEnabled ? '摄像头开' : '纯语音'}</span>
      </div>
    </div>
  );
};

export default AvatarStage;
