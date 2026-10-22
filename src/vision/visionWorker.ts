import { FaceLandmarker, FilesetResolver } from '@mediapipe/tasks-vision';
import type { VisualFeatureRow } from '../../types';
import { SecondAggregator, blendshapeMap, judgeFrame } from '../../engine/visionMetrics.ts';

/**
 * M6 视觉采集 Worker（PRD 4.1 / D2：浏览器端 MediaPipe，不上传画面）
 *
 * 协议（主线程 → worker）：
 *   { type: 'frame', bitmap: ImageBitmap, timestampMs }  —— 可转移的帧（主线程 createImageBitmap(video)）
 *   { type: 'flush' }                                     —— 结束，冲刷最后不满一秒的缓冲
 * 协议（worker → 主线程）：
 *   { type: 'row', row }      —— 每秒一条聚合特征
 *   { type: 'acked' }         —— 一帧处理完（主线程背压：在途 > 2 帧就丢帧）
 *   { type: 'failed', message } —— 模型/wasm 不可用，主线程静默降级
 *   { type: 'done' }          —— flush 完成
 *
 * 模型与 wasm 走同源静态资源 /vision/*（不进 JS bundle）；推理全部在本地完成。
 */

const WASM_DIR = '/vision/wasm';
const MODEL_PATH = '/vision/face_landmarker.task';
/** ESM 版 wasm 胶水（与 FilesetResolver.forVisionTasks(dir, true) 选中的文件一致） */
const WASM_GLUE_PATH = `${WASM_DIR}/vision_wasm_module_internal.js`;

export type VisionWorkerIn =
  | { type: 'frame'; bitmap: ImageBitmap; timestampMs: number }
  | { type: 'flush' };

export type VisionWorkerOut =
  | { type: 'row'; row: VisualFeatureRow }
  | { type: 'acked' }
  | { type: 'failed'; message: string }
  | { type: 'done' };

/** module worker 全局对象（不引入 WebWorker lib，避免与 DOM lib 冲突） */
const ctx = self as unknown as {
  postMessage: (message: VisionWorkerOut) => void;
  addEventListener: (type: 'message', listener: (ev: MessageEvent<VisionWorkerIn>) => void) => void;
};

const aggregator = new SecondAggregator();
let landmarker: FaceLandmarker | null = null;
let initPromise: Promise<FaceLandmarker | null> | null = null;
let initFailed = false;
let lastFrameTs = 0;

/**
 * 预加载 ESM 版 wasm 胶水，确保 self.ModuleFactory 就绪。
 *
 * 两个坑都在这里绕：
 * 1. module worker 里 importScripts 不可用，胶水只能靠动态 import() 加载；
 * 2. MediaPipe 每次调用 ModuleFactory() 后都会把 self.ModuleFactory 清空，而动态
 *    import() 命中模块缓存不会重新执行模块体——GPU→CPU 回退重试前必须带查询串重新
 *    import，让模块重新求值把全局还原，否则第二次会 "ModuleFactory not set"。
 */
async function ensureWasmGlue(attempt: number): Promise<void> {
  const url = attempt > 1 ? `${WASM_GLUE_PATH}?retry=${attempt}` : WASM_GLUE_PATH;
  await import(/* @vite-ignore */ url);
}

async function createLandmarker(delegate: 'GPU' | 'CPU', attempt: number): Promise<FaceLandmarker> {
  // useModule=true 必须保留：本 worker 是 module worker，Chrome 里 importScripts 直接抛
  // TypeError，MediaPipe 只能走动态 import() 加载 wasm 胶水，而 import() 只接受 ES module
  // 版胶水（vision_wasm_module_internal.js）。默认的 classic 版在 module worker 里会因
  // "ModuleFactory not set" 失败。
  await ensureWasmGlue(attempt);
  const fileset = await FilesetResolver.forVisionTasks(WASM_DIR, true);
  return FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_PATH, delegate },
    runningMode: 'VIDEO',
    numFaces: 1,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: true,
    minFaceDetectionConfidence: 0.5,
    minFacePresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });
}

/** 懒初始化：GPU 委托不可用时退回 CPU（都不行 → failed，主线程静默降级） */
function ensureLandmarker(): Promise<FaceLandmarker | null> {
  if (initFailed) return Promise.resolve(null);
  if (landmarker) return Promise.resolve(landmarker);
  if (!initPromise) {
    initPromise = (async () => {
      try {
        try {
          landmarker = await createLandmarker('GPU', 1);
        } catch {
          landmarker = await createLandmarker('CPU', 2);
        }
        return landmarker;
      } catch (err) {
        initFailed = true;
        initPromise = null;
        ctx.postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
        return null;
      }
    })();
  }
  return initPromise;
}

function closeBitmap(bitmap: ImageBitmap | null): void {
  try {
    bitmap?.close?.();
  } catch {
    // 某些环境的 ImageBitmap 无 close：忽略
  }
}

/** 在途帧计数：flush 要等在途帧跑完，避免丢掉最后一秒的数据 */
let inFlight = 0;
const flushWaiters: Array<() => void> = [];

function frameSettled(): void {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0 && flushWaiters.length > 0) {
    const waiters = flushWaiters.splice(0);
    for (const done of waiters) done();
  }
}

function doFlush(): void {
  const row = aggregator.flush();
  if (row) ctx.postMessage({ type: 'row', row });
  ctx.postMessage({ type: 'done' });
}
async function handleFrame(bitmap: ImageBitmap, timestampMs: number): Promise<void> {
  inFlight += 1;
  try {
    const lm = await ensureLandmarker();
    if (!lm) return;
    // MediaPipe VIDEO 模式要求时间戳单调递增
    const ts = Math.max(timestampMs, lastFrameTs + 1);
    lastFrameTs = ts;

    const result = lm.detectForVideo(bitmap, ts);
    const faceCount = result.faceLandmarks?.length ?? 0;
    const single = faceCount === 1;
    const judgment = judgeFrame(
      {
        landmarks: single ? (result.faceLandmarks[0] ?? []) : [],
        blendshapes: single ? blendshapeMap(result.faceBlendshapes?.[0]?.categories) : {},
        matrix: single ? (result.facialTransformationMatrixes?.[0]?.data ?? null) : null,
      },
      faceCount,
      ts
    );
    const row = aggregator.push(judgment);
    if (row) ctx.postMessage({ type: 'row', row });
  } catch {
    // 单帧推理失败（含模型未就绪）不影响后续帧
  } finally {
    closeBitmap(bitmap);
    frameSettled();
    ctx.postMessage({ type: 'acked' });
  }
}
ctx.addEventListener('message', (ev) => {
  const msg = ev.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'frame') {
    void handleFrame(msg.bitmap, msg.timestampMs);
    return;
  }
  if (msg.type === 'flush') {
    if (inFlight > 0) flushWaiters.push(doFlush);
    else doFlush();
  }
});
