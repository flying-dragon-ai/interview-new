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
 * 系统音色是 2026-10-22 对 `stepaudio-3-realtime-preview` 的真 key 握手结果。
 * `GET /v1/audio/system_voices?model=step-tts-2` 的英文 id（soft-spoken-gentleman、
 * vibrant-youth、lively-girl 等）在这个 Realtime 模型上会 400，不能再映射过去。
 * 若上游改名，只改本文件。
 */

export const REALTIME_SYSTEM_VOICES = [
  'boyinnansheng',
  'cixingnansheng',
  'elegantgentle-female',
  'jingdiannvsheng',
  'jilingshaonv',
  'lengyanyujie',
  'linjiajiejie',
  'linjiameimei',
  'livelybreezy-female',
  'qingchunshaonv',
  'qingniandaxuesheng',
  'qinqienvsheng',
  'ruyananshi',
  'shenchennanyin',
  'shuangkuaijiejie',
  'wenrounansheng',
  'wenrounvsheng',
  'youyanvsheng',
  'yuanqinansheng',
  'yuanqishaonv',
  'zhengpaiqingnian',
  'zhixingjiejie',
] as const;

export type RealtimeSystemVoice = (typeof REALTIME_SYSTEM_VOICES)[number];

/**
 * 角色卡仍在用、但 Realtime 模型不接受的旧 TTS id。
 * 正派青年 / 深沉男音 / 知性姐姐已经能直接作为 Realtime voice，不必再映射。
 * 爽快男声、干练女声会被 400，改接到听感接近、且和主持不撞车的系统音色。
 */
export const LEGACY_TTS_TO_REALTIME: Record<string, RealtimeSystemVoice> = {
  shuangkuainansheng: 'yuanqinansheng',
  ganliannvsheng: 'elegantgentle-female',
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
