import React, { useEffect, useMemo, useRef } from 'react';
import type { SessionSnapshot } from '../../src/session/sessionStore';
import type { VoiceCapabilities } from '../../services/voiceService';

/**
 * VoiceOrb —— 音频反应状态光球（M7 P3-5，typing indicator 的沉浸替代）
 * 7 状态契约（参考 amunozdev/voiceorbs）：
 * idle / listening / thinking / speaking / interrupted / error / degraded
 * 光球随 TTS 分析器 RMS 呼吸缩放。
 */

export type OrbState = 'idle' | 'listening' | 'thinking' | 'speaking' | 'interrupted' | 'error' | 'degraded';

/** 快照 → 状态机（单出处，ui-wiring 可测） */
export function resolveOrbState(snapshot: SessionSnapshot, caps: VoiceCapabilities | null): OrbState {
  if (snapshot.degraded) return 'degraded';
  if (caps && caps.outputMode === 'text-only' && caps.inputMode === 'text') return 'error';
  // 用户打断中：开口时 AI 仍在生成
  if (snapshot.userSpeaking && snapshot.isGenerating) return 'interrupted';
  if (snapshot.userSpeaking) return 'listening';
  if (snapshot.speakingCharId) return 'speaking';
  if (snapshot.isGenerating) return 'thinking';
  return 'idle';
}

const ORB_STYLE: Record<OrbState, { core: string; glow: string; label: string }> = {
  idle: { core: 'radial-gradient(circle at 35% 35%, #3a4468, #1a2138)', glow: '0 0 18px rgba(90,108,255,0.25)', label: '待命' },
  listening: { core: 'radial-gradient(circle at 35% 35%, #34d399, #0c5b43)', glow: '0 0 26px rgba(52,211,153,0.55)', label: '聆听中' },
  thinking: { core: 'radial-gradient(circle at 35% 35%, #a78bfa, #4c1d95)', glow: '0 0 24px rgba(167,139,250,0.5)', label: '思考中' },
  speaking: { core: 'radial-gradient(circle at 35% 35%, #60a5fa, #1e3a8a)', glow: '0 0 28px rgba(96,165,250,0.6)', label: '发言中' },
  interrupted: { core: 'radial-gradient(circle at 35% 35%, #fbbf24, #92400e)', glow: '0 0 30px rgba(251,191,36,0.6)', label: '已打断' },
  error: { core: 'radial-gradient(circle at 35% 35%, #f87171, #7f1d1d)', glow: '0 0 24px rgba(248,113,113,0.5)', label: '语音不可用' },
  degraded: { core: 'radial-gradient(circle at 35% 35%, #fbbf24, #78350f)', glow: '0 0 22px rgba(251,191,36,0.4)', label: '降级中' },
};

interface Props {
  snapshot: SessionSnapshot;
  caps: VoiceCapabilities | null;
  analyser: { current: AnalyserNode | null };
}

const VoiceOrb: React.FC<Props> = ({ snapshot, caps, analyser }) => {
  const state = resolveOrbState(snapshot, caps);
  const style = ORB_STYLE[state];
  const orbRef = useRef<HTMLDivElement>(null);
  const buffer = useMemo(() => new Uint8Array(512), []);

  // RMS 呼吸缩放（rAF 直写 DOM，不进 React 状态）
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const el = orbRef.current;
      const analyserNode = analyser.current;
      if (!el) return;
      let rms = 0;
      if (analyserNode) {
        analyserNode.getByteTimeDomainData(buffer);
        let sum = 0;
        for (let i = 0; i < buffer.length; i++) {
          const v = (buffer[i] - 128) / 128;
          sum += v * v;
        }
        rms = Math.sqrt(sum / buffer.length);
      }
      const scale = 1 + Math.min(1, rms * 5) * 0.35;
      el.style.transform = `scale(${scale.toFixed(3)})`;
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [analyser, buffer]);

  return (
    <div className="absolute top-16 right-4 md:top-4 md:right-20 z-10 flex flex-col items-center gap-1">
      <div
        ref={orbRef}
        className="w-12 h-12 rounded-full transition-shadow duration-300"
        style={{ background: style.core, boxShadow: style.glow, transition: 'transform 80ms linear' }}
        aria-label={`语音状态：${style.label}`}
      />
      <span className="text-[9px] font-bold text-white/50">{style.label}</span>
    </div>
  );
};

export default VoiceOrb;
