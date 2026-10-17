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

async function createLandmarker(delegate: 'GPU' | 'CPU'): Promise<FaceLandmarker> {
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
          landmarker = await createLandmarker('GPU');
        } catch {
          landmarker = await createLandmarker('CPU');
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
