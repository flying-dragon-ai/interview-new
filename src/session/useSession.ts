import { useEffect, useRef } from 'react';
import { SessionController, type SessionDeps } from './sessionController.ts';
import { useSessionSnapshot } from './sessionStore.ts';
import type { SessionSnapshot, SessionStore } from './sessionStore.ts';

/**
 * useSession —— 组件侧入口（M7 Phase 1）
 * - 组件不再持有会话 useState/useRef：创建一次 controller，派发动作 + 订阅快照
 * - controller 挂在 ref 上，重渲染不重建；P4 由 VoiceRoom 持有并下传两种模式（切换不重置会话）
 */
export interface SessionHandle {
  controller: SessionController;
  store: SessionStore;
  snapshot: SessionSnapshot;
}

export function useSession(deps: SessionDeps): SessionHandle {
  const holder = useRef<SessionController | null>(null);
  if (!holder.current) {
    holder.current = new SessionController(deps);
  }
  const controller = holder.current;
  // 每次渲染同步最新 props（等价于原 useCallback 依赖刷新）
  controller.updateDeps(deps);

  useEffect(() => {
    controller.init();
    return () => controller.dispose();
  }, [controller]);

  const snapshot = useSessionSnapshot(controller.store);
  return { controller, store: controller.store, snapshot };
}
