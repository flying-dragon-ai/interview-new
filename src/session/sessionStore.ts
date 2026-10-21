import { useSyncExternalStore } from 'react';
import type { GameEvent, Message } from '../../types.ts';
import { initPhaseEngine, type PhaseState } from '../../engine/phaseEngine.ts';
import type { VoiceCapabilities } from '../../services/voiceService.ts';

/**
 * SessionStore —— 群面会话唯一事实源（M7 Phase 1 / 计划 §4 架构图）
 * - useSyncExternalStore 兼容的轻量 store，不引第三方状态库（假设 A6）
 * - 所有模式（沉浸/经典）、所有通道（Realtime / LLM+TTS / 手动输入）只写本 store；UI 只读
 * - React 绑定在本文件末尾（useSessionSnapshot）；store 本身无 React 依赖，可在 node 测试
 */

export interface SessionSnapshot {
  messages: Message[]; // 含 speaker / source（M7 新增可选字段）
  events: GameEvent[];
  phase: PhaseState;
  activeCharId: string | null; // 被调度选中
  speakingCharId: string | null; // 正在出声
  streamingText: string;
  isGenerating: boolean;
  awaitingUser: boolean;
  userSpeaking: boolean; // Realtime VAD 判定用户正在说（P2 写入）
  currentKeyPoint: string | null;
  degraded: boolean;
  caps: VoiceCapabilities | null;
  /** Realtime 全双工状态：active = 用户侧走 StepFun Realtime；fallback = 退回按键说话（P2） */
  realtimeStatus: 'off' | 'connecting' | 'active' | 'fallback';
  /** 设备态（跨模式共享；摄像头流本体由 SessionController 持有） */
  cameraOn: boolean;
  micOn: boolean;
}

export type SessionListener = () => void;

export interface SessionStore {
  getSnapshot(): SessionSnapshot;
  subscribe(cb: SessionListener): () => void;
  /** 浅合并补丁并通知订阅者 */
  set(patch: Partial<SessionSnapshot>): void;
}

export function makeInitialSnapshot(now: number, opts?: { cameraOn?: boolean }): SessionSnapshot {
  return {
    messages: [],
    events: [],
    phase: initPhaseEngine(now),
    activeCharId: null,
    speakingCharId: null,
    streamingText: '',
    isGenerating: false,
    awaitingUser: false,
    userSpeaking: false,
    currentKeyPoint: null,
    degraded: false,
    caps: null,
    realtimeStatus: 'off',
    cameraOn: opts?.cameraOn ?? false,
    micOn: true,
  };
}

export function createSessionStore(initial: SessionSnapshot): SessionStore {
  let snapshot = initial;
  const listeners = new Set<SessionListener>();
  const subscribe = (cb: SessionListener): (() => void) => {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  };
  return {
    getSnapshot: () => snapshot,
    subscribe,
    set(patch) {
      snapshot = { ...snapshot, ...patch };
      listeners.forEach((cb) => cb());
    },
  };
}

/** React 绑定：订阅快照（getServerSnapshot 与客户端一致，本应用无 SSR） */
export function useSessionSnapshot(store: SessionStore): SessionSnapshot {
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
