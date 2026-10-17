import React from 'react';
import type { GameEvent, Message, RoleCard, SimulationState } from '../types';
import DiscussionPanel from './DiscussionPanel';
import { detectCapabilities, type VoiceCapabilities } from '../services/voiceService';
import type { PhaseState } from '../engine/phaseEngine';

/**
 * VoiceRoom —— 语音群面房间外壳（PRD 6.1-1 组件化：DeviceCheck / VoiceRoom / AvatarStage / EvidenceReport）
 * 职责：房间上下文条（公司/岗位/角色/语音模式/退出）+ 装配 DiscussionPanel（倒计时引擎 + 发言权调度 + 语音）。
 */

interface VoiceRoomProps {
  state: SimulationState;
  roles: RoleCard[];
  sessionId: number | null;
  consentSaveTranscript: boolean;
  cameraEnabled: boolean;
  facingMode: 'user' | 'environment';
  voiceCaps?: VoiceCapabilities | null;
  onFinish: (history: Message[], events: GameEvent[], sessionStartAt: number) => void;
  onExit: () => void;
  resumeCheckpoint?: PhaseState | null;
  demoMode?: boolean;
}

const VoiceRoom: React.FC<VoiceRoomProps> = ({
  state,
  roles,
  sessionId,
  consentSaveTranscript,
  cameraEnabled,
  facingMode,
  voiceCaps,
  onFinish,
  onExit,
  resumeCheckpoint,
  demoMode = false,
}) => {
  const caps = voiceCaps ?? detectCapabilities();
  const inputLabel =
    caps.inputMode === 'stepfun-asr' ? 'StepFun ASR' : caps.inputMode === 'webspeech' ? '浏览器语音（兜底）' : '纯文字（降级）';
  const outputLabel = caps.outputMode === 'stepfun-tts' ? 'StepFun TTS' : caps.outputMode === 'webspeech-tts' ? '浏览器语音（兜底）' : '纯文字（降级）';

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* 房间上下文条 */}
      <div className="hidden md:flex items-center gap-3 px-4 py-1.5 bg-slate-900 text-white text-[11px]">
        <span className="font-bold">{state.company || '未填写公司'}</span>
        <span className="text-slate-400">·</span>
        <span>{state.jobTitle || '未填写岗位'}</span>
        <span className="text-slate-400">·</span>
        <span>{roles.length} 位 AI 候选人</span>
        {demoMode && <span className="bg-[#dfff00] px-2 py-0.5 font-black text-[#171717]">演示模式</span>}
        <span className="text-slate-400">·</span>
        <span>
          输入 {inputLabel} / 输出 {outputLabel}
        </span>
        {!sessionId && <span className="text-amber-300">· 本地模式（未落库）</span>}
        <button onClick={onExit} className="ml-auto px-3 py-0.5 bg-white/10 hover:bg-white/20 rounded-full font-bold">
          退出房间
        </button>
      </div>

      <div className="flex-1 min-h-0">
        <DiscussionPanel
          state={state}
          roles={roles}
          sessionId={sessionId}
          consentSaveTranscript={consentSaveTranscript}
          cameraEnabled={cameraEnabled}
          facingMode={facingMode}
          onFinish={onFinish}
          resumeCheckpoint={resumeCheckpoint}
          demoMode={demoMode}
        />
      </div>
    </div>
  );
};

export default VoiceRoom;
