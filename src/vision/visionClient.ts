import type { VisualFeatureRow } from '../../types';
import { saveVisualFeatures } from '../api.ts';
import type { VisionWorkerIn, VisionWorkerOut } from './visionWorker.ts';

/**
 * M6 视觉采集客户端（PRD 4.1 / D2 / D5）
 *
 * 职责：隐藏 video 帧泵 → module worker 推理 → 每秒一行缓冲 → 批量落库。
 * - 采样帧率：桌面 4fps / 移动端（或 ≤4 核）2fps；聚合固定 1Hz
 * - 标签页隐藏时暂停采样（暂停段不产生行）
 * - worker/模型/wasm 不可用 → 静默降级（视觉维度走 not_enabled，不阻断面试）
 * - 隐私（C3/C4）：只把数值与枚举交给 saveVisualFeatures，画面不出浏览器
 */

/** 桌面检测帧率 */
export const VISION_FPS_DESKTOP = 4;
/** 移动端 / 低核数检测帧率 */
export const VISION_FPS_MOBILE = 2;
/** 单批落库行数上限（参数化多行 INSERT） */
export const VISION_BATCH_ROWS = 60;
/** 批量冲刷间隔（ms） */
export const VISION_FLUSH_INTERVAL_MS = 10_000;
/** 在途帧上限（超过则丢帧，避免 worker 排队堆积） */
export const VISION_MAX_IN_FLIGHT = 2;
/** stop() 等 worker flush 的超时（ms） */
export const VISION_STOP_TIMEOUT_MS = 2_000;

/** 按设备能力选择采样帧率 */
export function resolveSampleFps(): number {
  if (typeof navigator === 'undefined') return VISION_FPS_MOBILE;
  const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
  const cores = typeof navigator.hardwareConcurrency === 'number' ? navigator.hardwareConcurrency : 4;
  return mobile || cores <= 4 ? VISION_FPS_MOBILE : VISION_FPS_DESKTOP;
}

export interface VisionClientOptions {
  /** 房间内已有的摄像头流（DiscussionPanel.userStreamRef） */
  stream: MediaStream;
  /** 会话 id（无会话 → 只留内存，不落库） */
  sessionId: number | null;
  /** 是否同意保存聚合特征（consentSaveTranscript） */
  persist: boolean;
  /** 降级回调（静默：不影响面试流程） */
  onDegraded?: (reason: string) => void;
}

export class VisionClient {
  private readonly stream: MediaStream;
  private readonly sessionId: number | null;
  private readonly onDegraded?: (reason: string) => void;
  private persist: boolean;
  private readonly fps: number;
  private readonly startedAt: number;

  private worker: Worker | null = null;
  private video: HTMLVideoElement | null = null;
  private pumpTimer: number | null = null;
  private inFlight = 0;
  private lastFlushAt = Date.now();
  private stopped = false;
  private rows: VisualFeatureRow[] = [];
  private unsent: VisualFeatureRow[] = [];

  constructor(options: VisionClientOptions) {
    this.stream = options.stream;
    this.sessionId = options.sessionId;
    this.persist = options.persist && options.sessionId !== null;
    this.onDegraded = options.onDegraded;
    this.fps = resolveSampleFps();
    this.startedAt = Date.now();
  }

  /** 启动：建 worker + 隐藏 video + 帧泵。失败静默降级。 */
  async start(): Promise<void> {
    if (this.stopped) return;
    if (typeof Worker === 'undefined' || typeof createImageBitmap === 'undefined') {
      this.degrade('当前浏览器不支持视觉分析');
      return;
    }
    try {
      this.worker = new Worker(new URL('./visionWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      this.degrade('视觉分析线程启动失败');
      return;
    }
    this.worker.addEventListener('message', this.onWorkerMessage as EventListener);
    this.worker.addEventListener('error', this.onWorkerError as EventListener);

    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    video.autoplay = true;
    video.srcObject = this.stream;
    video.style.cssText = 'position:fixed;left:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    document.body.appendChild(video);
    this.video = video;
    try {
      await video.play();
    } catch {
      // 自动播放被拦截时 readyState 仍可能就绪；不视为降级
    }

    this.pumpTimer = window.setInterval(this.pumpFrame, Math.max(50, Math.round(1000 / this.fps)));
    document.addEventListener('visibilitychange', this.onVisibility);
  }

  /** 停止：冲刷最后一段 + 落库 + 回收资源；返回内存行（无 DB 时供本地使用）。 */
  async stop(): Promise<VisualFeatureRow[]> {
    if (this.stopped) return this.rows;
    this.stopped = true;

    if (this.pumpTimer !== null) window.clearInterval(this.pumpTimer);
    this.pumpTimer = null;
    document.removeEventListener('visibilitychange', this.onVisibility);

    const worker = this.worker;
    if (worker) {
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, VISION_STOP_TIMEOUT_MS);
        const onDone = (ev: MessageEvent<VisionWorkerOut>) => {
          if (ev.data?.type === 'done') {
            window.clearTimeout(timer);
            worker.removeEventListener('message', onDone as EventListener);
            resolve();
          }
        };
        worker.addEventListener('message', onDone as EventListener);
        try {
          worker.postMessage({ type: 'flush' } satisfies VisionWorkerIn);
        } catch {
          window.clearTimeout(timer);
          resolve();
        }
      });
      worker.terminate();
      this.worker = null;
    }

    if (this.video) {
      try {
        this.video.pause();
        this.video.srcObject = null;
      } catch {
        // 忽略
      }
      this.video.remove();
      this.video = null;
    }

    await this.flushToServer();
    return this.rows;
  }


  /** M7 P3：最新一秒聚合行（VisionPiP 实时眼神接触展示用；只读，不落库路径不变） */
  getLatestRow(): VisualFeatureRow | null {
    return this.rows.length > 0 ? this.rows[this.rows.length - 1] : null;
  }

  // ---------- 内部 ----------

  private degrade(reason: string): void {
    this.onDegraded?.(reason);
    void this.stop().catch(() => undefined);
  }

  private onWorkerError = (): void => {
    this.degrade('视觉分析线程异常');
  };

  private onWorkerMessage = (ev: MessageEvent<VisionWorkerOut>): void => {
    const msg = ev.data;
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'row') {
      this.rows.push(msg.row);
      this.unsent.push(msg.row);
      this.maybeFlush();
      return;
    }
    if (msg.type === 'acked') {
      this.inFlight = Math.max(0, this.inFlight - 1);
      return;
    }
    if (msg.type === 'failed') {
      this.degrade(msg.message || '视觉模型不可用');
    }
  };

  private onVisibility = (): void => {
    if (typeof document === 'undefined') return;
    if (document.visibilityState === 'hidden') {
      if (this.pumpTimer !== null) window.clearInterval(this.pumpTimer);
      this.pumpTimer = null;
      return;
    }
    if (!this.stopped && this.pumpTimer === null) {
      this.pumpTimer = window.setInterval(this.pumpFrame, Math.max(50, Math.round(1000 / this.fps)));
    }
  };

  private pumpFrame = (): void => {
    const worker = this.worker;
    const video = this.video;
    if (!worker || !video || this.stopped) return;
    if (this.inFlight >= VISION_MAX_IN_FLIGHT) return; // 背压：丢帧不排队
    if (video.readyState < 2 || video.videoWidth === 0) return;
    this.inFlight += 1;
    createImageBitmap(video)
      .then((bitmap) => {
        if (this.stopped || !this.worker) {
          bitmap.close?.();
          this.inFlight = Math.max(0, this.inFlight - 1);
          return;
        }
        this.worker.postMessage({ type: 'frame', bitmap, timestampMs: Date.now() - this.startedAt } satisfies VisionWorkerIn, [
          bitmap,
        ]);
      })
      .catch(() => {
        this.inFlight = Math.max(0, this.inFlight - 1);
      });
  };

  private maybeFlush(): void {
    if (!this.persist || this.unsent.length === 0) return;
    if (Date.now() - this.lastFlushAt < VISION_FLUSH_INTERVAL_MS) return;
    void this.flushToServer();
  }

  /** 批量落库（单批 ≤ 60 行）；失败则停止重试，行仍留在内存 */
  private async flushToServer(): Promise<void> {
    if (!this.persist || !this.sessionId || this.unsent.length === 0) return;
    this.lastFlushAt = Date.now();
    while (this.unsent.length > 0) {
      const batch = this.unsent.splice(0, VISION_BATCH_ROWS);
      const ok = await saveVisualFeatures(this.sessionId, batch);
      if (!ok) {
        this.persist = false; // 服务端不可用：静默降级为纯内存
        return;
      }
    }
  }
}
