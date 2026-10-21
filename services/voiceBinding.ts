import type { RoleVoice } from '../types.ts';

/**
 * 角色音色绑定。
 *
 * Realtime 一条连接在产出音频之后不能再改 voice（见 docs/stepfun-realtime-notes.md §2）。
 * 因此「这个角色用哪把声音」必须在建会话前解析完毕，并且换克隆音色不需要改调用方。
 *
 * 解析顺序：
 * 1. 显式 realtime_voice_id
 * 2. voice_id 已是当前文档列出的 Realtime 系统音色 → 原样使用
 * 3. voice_id 是本仓库旧 TTS 音色 → 映射到听感最近的系统音色（保证默认可播）
 * 4. 其余 ID 视为语音复刻 ID，原样透传给 session.update.voice 和 TTS
 *
 * 系统音色清单来自 StepFun Realtime Chat 文档（Voices，2026-10 抓取）。
 * 官方控制台 README 里的示例（qingchunshaonv 等）属于更早的 step-audio-2 命名，
 * 不在此白名单内；若上游改名，只改本文件的映射表。
 */

export const REALTIME_SYSTEM_VOICES = [
  'soft-spoken-gentleman',
  'magnetic-voiced-male',
  'vibrant-youth',
  'lively-girl',
  'livelybreezy-female',
  'elegantgentle-female',
  'zixinnansheng',
] as const;

export type RealtimeSystemVoice = (typeof REALTIME_SYSTEM_VOICES)[number];

/**
 * 旧 TTS 音色 → Realtime 系统音色。
 * 主持占用 soft-spoken-gentleman，livelybreezy-female 留给以后的复刻/新角色，避免默认撞声。
 */
export const LEGACY_TTS_TO_REALTIME: Record<string, RealtimeSystemVoice> = {
  zhengpaiqingnian: 'vibrant-youth',
  shenchennanyin: 'magnetic-voiced-male',
  shuangkuainansheng: 'zixinnansheng',
  ganliannvsheng: 'lively-girl',
  zhixingjiejie: 'elegantgentle-female',
};

export type VoiceBindingSource = 'explicit' | 'system' | 'legacy-map' | 'clone';

export interface VoiceBinding {
  /** 角色卡上的 voice_id（TTS 降级与落库配置都用它） */
  voiceId: string;
  /** 写入 Realtime session.update.voice 的 ID */
  realtimeVoiceId: string;
  /** 未知 ID，按复刻音色透传 */
  cloned: boolean;
  source: VoiceBindingSource;
}

const SYSTEM_SET = new Set<string>(REALTIME_SYSTEM_VOICES);

export function isRealtimeSystemVoice(voiceId: string): voiceId is RealtimeSystemVoice {
  return SYSTEM_SET.has(voiceId);
}

export function resolveVoiceBinding(voice: Pick<RoleVoice, 'voice_id'> & { realtime_voice_id?: string }): VoiceBinding {
  const voiceId = voice.voice_id.trim();
  const explicit = voice.realtime_voice_id?.trim();
  if (explicit) {
    return {
      voiceId,
      realtimeVoiceId: explicit,
      cloned: !isRealtimeSystemVoice(explicit),
      source: 'explicit',
    };
  }
  if (isRealtimeSystemVoice(voiceId)) {
    return { voiceId, realtimeVoiceId: voiceId, cloned: false, source: 'system' };
  }
  const mapped = LEGACY_TTS_TO_REALTIME[voiceId];
  if (mapped) {
    return { voiceId, realtimeVoiceId: mapped, cloned: false, source: 'legacy-map' };
  }
  return { voiceId, realtimeVoiceId: voiceId, cloned: true, source: 'clone' };
}
