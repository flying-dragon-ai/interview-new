import React from 'react';
import type { GameEvent, InterviewFormat, Message, RoleCard, SimulationState } from '../types';
import { HOST_CARD } from '../data/interviewerCards';
import DiscussionPanel from './DiscussionPanel';
import { detectCapabilities, type VoiceCapabilities } from '../services/voiceService';
/**
 * VoiceRoom —— 语音群面房间外壳（PRD 6.1-1 组件化：DeviceCheck / VoiceRoom / AvatarStage / EvidenceReport）
 * 职责：房间上下文条（公司/岗位/角色/语音模式/退出）+ 装配 DiscussionPanel（倒计时引擎 + 发言权调度 + 语音）。
 */

interface VoiceRoomProps {
  state: SimulationState;
  roles: RoleCard[];
  format?: InterviewFormat;
  sessionId: number | null;
  consentSaveTranscript: boolean;
  cameraEnabled: boolean;
  facingMode: 'user' | 'environment';
  voiceCaps?: VoiceCapabilities | null;
  onFinish: (history: Message[], events: GameEvent[], sessionStartAt: number, visualRows?: import('../types').VisualFeatureRow[]) => void;
  onExit: () => void;
}

const VoiceRoom: React.FC<VoiceRoomProps> = ({
  state,
  roles,
  format = 'lgd',
  sessionId,
  consentSaveTranscript,
  cameraEnabled,
  facingMode,
  voiceCaps,
  onFinish,
  onExit,
}) => {
  const caps = voiceCaps ?? detectCapabilities();
  const inputLabel =
    caps.inputMode === 'stepfun-asr' ? 'StepFun ASR' : caps.inputMode === 'webspeech' ? '浏览器语音（兜底）' : '纯文字（降级）';
  const outputLabel = caps.outputMode === 'stepfun-tts' ? 'StepFun TTS' : caps.outputMode === 'webspeech-tts' ? '浏览器语音（兜底）' : '纯文字（降级）';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 房间上下文条 */}
      <div className="hidden md:flex items-center gap-3 px-4 py-1.5 backdrop-blur-xl bg-white/[0.06] border-b border-white/10 text-white/60 text-[11px]">
        <span className="font-bold text-white">{state.company || '未填写公司'}</span>
        <span className="text-white/25">·</span>
        <span>{state.jobTitle || '未填写岗位'}</span>
        <span className="text-white/25">·</span>
        <span>{format === 'panel' ? `${roles.length} 位面试官 · 你是候选人` : `${roles.length} 位 AI 候选人 + 1 位主持面试官`}</span>
        <span className="text-white/25">·</span>
        <span>
          输入 {inputLabel} / 输出 {outputLabel}
        </span>
        {!sessionId && <span className="glass-chip badge-warning text-[10px] px-2 py-0.5">本地模式（未落库）</span>}
        <button onClick={onExit} className="ml-auto glass-btn-danger rounded-full px-3 py-0.5 text-[11px] font-bold">
          退出房间
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <DiscussionPanel
          state={state}
          roles={roles}
          format={format}
          sessionId={sessionId}
          consentSaveTranscript={consentSaveTranscript}
          cameraEnabled={cameraEnabled}
          facingMode={facingMode}
          onFinish={onFinish}
        />
      </div>
    </div>
  );
};

export default VoiceRoom;
