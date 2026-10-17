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
  AGGRESSIVE: { label: '高冲突', className: 'bg-red-400/15 border-red-400/30 text-red-300' },
  STRUCTURED: { label: '高协作', className: 'bg-blue-400/15 border-blue-400/30 text-blue-300' },
  DETAIL: { label: '中立', className: 'bg-emerald-400/15 border-emerald-400/30 text-emerald-300' },
};

const EMOTION_EMOJI: Record<string, string> = {
  neutral: '😐',
  positive: '🙂',
  tense: '😠',
  serious: '🧐',
};

const AvatarStage: React.FC<AvatarStageProps> = ({
  cards,
  activeCardId,
  speakingCardId,
  cameraEnabled = false,
  facingMode = 'user',
  micOn = true,
  userStream,
}) => {
  const anySpeaking = speakingCardId !== null;

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
            className={`relative flex flex-col items-center p-3 rounded-2xl transition-all duration-300 min-w-[96px] shrink-0 glass-card ${
              isSpeaking
                ? 'liquid speaking-frame scale-105'
                : isActive
                  ? 'glass-selected'
                  : anySpeaking
                    ? 'opacity-50 saturate-50'
                    : 'opacity-75'
            }`}
          >
            <div className="relative">
              <img
                src={preset?.asset_url}
                alt={card.name}
                className="w-14 h-14 rounded-full border border-white/20"
              />
              {isSpeaking && (
                <span className="absolute -bottom-1 left-1/2 -translate-x-1/2 flex items-end gap-0.5 h-3">
                  <span className="w-1 bg-brand rounded-full animate-bounce" style={{ height: '60%', animationDelay: '0ms' }} />
                  <span className="w-1 bg-brand rounded-full animate-bounce" style={{ height: '100%', animationDelay: '150ms' }} />
                  <span className="w-1 bg-brand rounded-full animate-bounce" style={{ height: '40%', animationDelay: '300ms' }} />
                </span>
              )}
            </div>
            <span className="mt-2 text-xs font-semibold text-white whitespace-nowrap">{card.name}</span>
            <span className={`glass-chip mt-1 text-[9px] px-1.5 py-0.5 border ${badge.className}`}>{badge.label}</span>
            <span className="glass-chip mt-1 text-[9px] px-1.5 py-0.5 text-white/50 whitespace-nowrap">
              {EMOTION_EMOJI[card.voice.emotion_default] ?? '😐'} {card.voice.voice_id.replace('stepfun_', '')} · ×{card.voice.rate}
            </span>
          </div>
        );
      })}

      {/* 用户小窗：玻璃底座 */}
      <div className="glass-card flex flex-col items-center p-3 rounded-2xl min-w-[96px] shrink-0">
        <div className="relative w-14 h-14">
          {cameraEnabled ? (
            <video
              muted
              playsInline
              autoPlay
              ref={(el) => {
                if (el && userStream && el.srcObject !== userStream) el.srcObject = userStream;
              }}
              className="w-14 h-14 rounded-full object-cover border border-white/25"
              style={{ transform: facingMode === 'user' ? 'scaleX(-1)' : 'none' }}
            />
          ) : (
            <div className="w-14 h-14 rounded-full bg-white/10 border border-white/15 flex items-center justify-center text-lg text-white">我</div>
          )}
          <span className={`absolute -bottom-1 -right-1 w-4 h-4 rounded-full border-2 border-night-950 ${micOn ? 'bg-emerald-400' : 'bg-red-400'}`} />
        </div>
        <span className="mt-2 text-xs font-semibold text-white">陈明 (我)</span>
        <span className="mt-1 text-[9px] text-white/40">{cameraEnabled ? '摄像头开' : '纯语音'}</span>
      </div>
    </div>
  );
};

export default AvatarStage;
