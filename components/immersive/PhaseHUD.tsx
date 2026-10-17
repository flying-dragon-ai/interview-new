import React from 'react';
import type { RoleCard } from '../../types';
import {
  currentPhase,
  currentOpeningSpeaker,
  phaseRemainingMs,
  phaseProgress,
  formatCountdown,
  OPENING_TURN_MS,
  type PhaseConfig,
  type PhaseState,
} from '../../engine/phaseEngine';
import { STAGES } from '../classic/ClassicPhaseHeader';

/**
 * PhaseHUD —— 沉浸模式阶段抬头显示（M7 P3-5，替代顶部阶段卡）
 * 顶部玻璃胶囊：阶段名 + 倒计时 + 迷你进度环 + 当前发言权提示。
 */

interface Props {
  phaseState: PhaseState;
  nowTs: number;
  phaseConfig: PhaseConfig;
  roles: RoleCard[];
  awaitingUser: boolean;
  speakingCharId: string | null;
  isGenerating: boolean;
}

const PhaseHUD: React.FC<Props> = ({ phaseState, nowTs, phaseConfig, roles, awaitingUser, speakingCharId, isGenerating }) => {
  const phase = currentPhase(phaseState, phaseConfig);
  const remaining = phaseRemainingMs(phaseState, nowTs, phaseConfig);
  const progress = phaseProgress(phaseState, nowTs, phaseConfig);
  const openingSpeaker = currentOpeningSpeaker(phaseState, phaseConfig);
  const openingRemaining = phase.id === 'OPENING' ? Math.max(0, OPENING_TURN_MS - (nowTs - phaseState.openingStartedAt)) : 0;
  const displayRemaining = phase.id === 'OPENING' ? Math.min(remaining, openingRemaining) : remaining;

  const stageIdx = Math.max(0, STAGES.findIndex((s) => s.id === phase.id));
  const stageColor = STAGES[stageIdx].color;
  const RING_C = 2 * Math.PI * 14;

  const hint = awaitingUser
    ? '轮到你发言'
    : speakingCharId
      ? `${roles.find((c) => c.id === speakingCharId)?.name ?? 'AI'} 发言中（可直接打断）`
      : isGenerating
        ? 'AI 思考中'
        : phase.id === 'OPENING' && openingSpeaker
          ? openingSpeaker === 'user'
            ? '轮到你陈述'
            : `${roles.find((c) => c.id === openingSpeaker)?.name ?? ''} 陈述中`
          : '等待调度';

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-10 flex items-center gap-3 px-4 py-2 rounded-full bg-black/35 backdrop-blur-md border border-white/10">
      <span className="glass-chip px-2.5 py-1 text-[10px] font-bold" style={{ color: stageColor, borderColor: `${stageColor}60` }}>
        {phase.label}
      </span>
      <svg viewBox="0 0 36 36" className="w-8 h-8 -rotate-90" aria-label="阶段倒计时">
        <circle cx="18" cy="18" r="14" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="3.5" />
        <circle
          cx="18"
          cy="18"
          r="14"
          fill="none"
          stroke={stageColor}
          strokeWidth="3.5"
          strokeLinecap="round"
          strokeDasharray={RING_C}
          strokeDashoffset={RING_C * (1 - Math.min(1, Math.max(0, progress)))}
        />
      </svg>
      <span className="text-base font-black text-white tabular-nums leading-none">{formatCountdown(displayRemaining)}</span>
      <span className="text-[11px] text-white/60 font-bold">{hint}</span>
    </div>
  );
};

export default PhaseHUD;
