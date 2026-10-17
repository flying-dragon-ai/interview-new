import type { MessageSource, Speaker } from '../../types.ts';

/**
 * 说话人归属（M7 P2-3，计划 §6 冻结契约）
 * 纯函数、可单测；归属规则：
 * - Realtime 通道来的转写 → speaker: 'user', source: 'realtime'
 * - LLM+TTS 通道来的发言 → speaker: `ai:${cardId}`, source: 'llm'
 * - textarea 手动输入 → speaker: 'user', source: 'text'
 * - 系统提示 → speaker: 'system'
 */

export type SpeakerEvent =
  | { via: 'realtime' }
  | { via: 'llm'; cardId: string }
  | { via: 'text' }
  | { via: 'system' };

export function resolveSpeaker(ev: SpeakerEvent): { speaker: Speaker; source?: MessageSource } {
  switch (ev.via) {
    case 'realtime':
      return { speaker: 'user', source: 'realtime' };
    case 'llm':
      return { speaker: `ai:${ev.cardId}`, source: 'llm' };
    case 'text':
      return { speaker: 'user', source: 'text' };
    case 'system':
      return { speaker: 'system' };
  }
}

/** 旧数据兜底：缺省 speaker 时由 senderId 派生（行为与 M7 前一致） */
export function deriveSpeaker(senderId: string): Speaker {
  if (senderId === 'user') return 'user';
  if (senderId === 'system') return 'system';
  return `ai:${senderId}`;
}
