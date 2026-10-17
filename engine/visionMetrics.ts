import type { Evidence, VisualEmotion, VisualFeatureRow, VisualHeadPose, VisualStats, VisualStatsInput } from '../types';

/**
 * M6 视觉维度：帧级判定 / 秒级聚合 / 统计 / 评分 / 证据提取（PRD 附录 C.2 / D.4）
 *
 * 本文件只做纯计算，不 import MediaPipe：visionWorker（浏览器本地推理）与单测共用。
 * 上游输入是 FaceLandmarker 的 478 点 landmarks（含虹膜）+ blendshapes + facialTransformationMatrixes。
 * 隐私（C3/C4）：离开浏览端的只有本文件产出的数值与枚举，原始画面 0 字节上传。
 */

// ---------- 阈值常量（PRD 4.3 / 4.4；A3：上线后按内测数据调，只改这一处） ----------

/** 看镜头：头部 yaw 绝对值上限（度） */
export const EYE_CONTACT_YAW_MAX = 15;
/** 看镜头：头部 pitch 绝对值上限（度） */
export const EYE_CONTACT_PITCH_MAX = 12;
/** 看镜头：虹膜相对眼眶的归一化偏移上限 */
export const EYE_CONTACT_IRIS_MAX = 0.18;
/** 虹膜偏移的头部姿态补偿上限（转头/低头时虹膜因透视外移，需折算扣除） */
export const HEAD_GAZE_COMPENSATION_MAX = 0.12;
/** 补偿增益：yaw 到 15° 补 0.08、pitch 到 12° 补 0.06（A3：上线后按内测数据调） */
const HEAD_GAZE_COMPENSATION_GAIN = { yaw: 0.08, pitch: 0.06 };

/** happy：mouthSmileLeft/Right 均值 > 0.4 */
export const EMOTION_HAPPY_SMILE = 0.4;
/** nervous：browInnerUp*0.6 + mouthFrown*0.4 加权 > 0.45（紧张度原始值保留） */
export const EMOTION_NERVOUS_WEIGHTED = 0.45;
/** serious：browDownLeft/Right 均值 > 0.4 */
export const EMOTION_SERIOUS_BROW_DOWN = 0.4;

/** 低头：pitch < -15° */
export const HEAD_DOWN_PITCH = -15;
/** 偏头：|yaw| > 20° */
export const HEAD_TURN_YAW = 20;

/** 数据不足兜底：有效行 < 30 秒 → 视觉 not_enabled，整体回退过渡权重 */
export const VISUAL_MIN_ROWS = 30;
/** 显著偏离段：连续 ≥ 5 秒 */
export const DEVIATION_MIN_SECONDS = 5;
/** 证据条目上限 */
export const VISUAL_EVIDENCE_MAX = 3;
/** 眼神偏离判定：本秒 eye_contact < 0.5 视为偏离镜头 */
export const DEVIATION_EYE_CONTACT = 0.5;

/** 维度内满分条件（PRD C.2） */
export const VISUAL_FULL = { eyeContact: 0.7, nervous: 0.2, headPose: 0.3, engagement: 0.95 } as const;
/** 维度内零分条件（线性映射下界） */
export const VISUAL_EMPTY = { eyeContact: 0, nervous: 0, headPose: 0, engagement: 0.5 } as const;
/** 维度内权重（PRD C.2）：眼神接触 40% / 情绪稳定性 30% / 头部姿态 20% / 参与度 10% */
export const VISUAL_WEIGHTS = { eyeContact: 0.4, emotion: 0.3, headPose: 0.2, engagement: 0.1 } as const;

// ---------- 帧级输入 ----------

export interface LandmarkLike {
  x: number;
  y: number;
  z?: number;
}

export interface FaceFrameInput {
  /** FaceLandmarker 478 点（含虹膜 468-477）；无脸时传空数组 */
  landmarks: readonly LandmarkLike[];
  /** blendshapes 名称 → 分数（0-1） */
  blendshapes?: Record<string, number>;
  /** facialTransformationMatrixes 的 4x4 列主序 flattened 数据 */
  matrix?: readonly number[] | null;
}

/** 虹膜 landmark 索引（MediaPipe FaceLandmarker topology） */
const LEFT_EYE_OUTER = 33;
const LEFT_EYE_INNER = 133;
const LEFT_IRIS_CENTER = 468;
const RIGHT_EYE_OUTER = 263;
const RIGHT_EYE_INNER = 362;
const RIGHT_IRIS_CENTER = 473;

// ---------- 小工具 ----------

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function round(value: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round(value * f) / f;
}

function num(value: unknown, fallback = 0): number {
  const n = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function avg(a: number | undefined, b: number | undefined): number {
  return (num(a) + num(b)) / 2;
}

function formatTimestamp(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 线性阈值映射：value >= full 满分，<= empty 0 分（与 reportEngine.thresholdScore 同语义，避免循环依赖） */
function linearScore(value: number, full: number, empty: number): number {
  if (value >= full) return 100;
  if (value <= empty) return 0;
  return Math.round(((value - empty) / (full - empty)) * 100);
}

// ---------- 4.3 帧级判定 ----------

/**
 * 头部姿态：facialTransformationMatrixes（4x4 列主序）→ 欧拉角（度）。
 * 约定（MediaPipe 相机坐标系：+X 右、+Y 上、+Z 朝向观察者）：
 * pitch > 0 抬头 / pitch < 0 低头；yaw > 0 右转；roll > 0 右倾。
 */
export function eulerFromMatrix(matrix?: readonly number[] | null): VisualHeadPose {
  if (!matrix || matrix.length < 16) return { pitch: 0, yaw: 0, roll: 0 };
  // 列主序：R[row][col] = matrix[col * 4 + row]
  const m11 = num(matrix[0]);
  const m21 = num(matrix[1]);
  const m31 = num(matrix[2]);
  const m32 = num(matrix[6]);
  const m33 = num(matrix[10]);
  const toDeg = 180 / Math.PI;
  return {
    pitch: round(Math.atan2(m32, m33) * toDeg, 2),
    yaw: round(Math.asin(clamp(-m31, -1, 1)) * toDeg, 2),
    roll: round(Math.atan2(m21, m11) * toDeg, 2),
  };
}

/** blendshapes categories → 名称/分数映射 */
export function blendshapeMap(
  categories?: readonly { categoryName?: string | null; score?: number | null }[] | null
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of categories ?? []) {
    if (c && typeof c.categoryName === 'string' && c.categoryName.length > 0) {
      out[c.categoryName] = num(c.score);
    }
  }
  return out;
}

/** 单眼虹膜相对眼眶中心的归一化水平偏移（0 = 居中） */
function eyeIrisOffset(lm: readonly LandmarkLike[], outer: number, inner: number, iris: number): number {
  const o = lm[outer];
  const i = lm[inner];
  const ir = lm[iris];
  if (!o || !i || !ir) return 0;
  const width = Math.abs(i.x - o.x);
  if (width < 1e-4) return 0;
  return Math.abs(ir.x - (i.x + o.x) / 2) / width;
}

/** 双眼虹膜归一化偏移取较大值（无虹膜点时退化为 0） */
export function irisOffset(landmarks: readonly LandmarkLike[]): number {
  if (landmarks.length < 478) return 0;
  return Math.max(
    eyeIrisOffset(landmarks, LEFT_EYE_OUTER, LEFT_EYE_INNER, LEFT_IRIS_CENTER),
    eyeIrisOffset(landmarks, RIGHT_EYE_OUTER, RIGHT_EYE_INNER, RIGHT_IRIS_CENTER)
  );
}

/** 眼神接触：头部接近正 + 虹膜居中（头部姿态补偿后） */
export function isEyeContact(input: { irisOffset: number; yaw: number; pitch: number }): boolean {
  const compensation = Math.min(
    HEAD_GAZE_COMPENSATION_MAX,
    (Math.abs(input.yaw) / EYE_CONTACT_YAW_MAX) * HEAD_GAZE_COMPENSATION_GAIN.yaw +
      (Math.abs(input.pitch) / EYE_CONTACT_PITCH_MAX) * HEAD_GAZE_COMPENSATION_GAIN.pitch
  );
  const gazeOffset = Math.max(0, input.irisOffset - compensation);
  return (
    Math.abs(input.yaw) < EYE_CONTACT_YAW_MAX &&
    Math.abs(input.pitch) < EYE_CONTACT_PITCH_MAX &&
    gazeOffset < EYE_CONTACT_IRIS_MAX
  );
}

export interface EmotionJudgment {
  emotion: VisualEmotion;
  /** 紧张度原始值（browInnerUp*0.6 + mouthFrown*0.4），保留供调试/调阈 */
  nervousScore: number;
}

/** 情绪：blendshapes 规则映射（happy → nervous → serious → neutral） */
export function classifyEmotion(blendshapes: Record<string, number>): EmotionJudgment {
  const smile = avg(blendshapes.mouthSmileLeft, blendshapes.mouthSmileRight);
  const frown = avg(blendshapes.mouthFrownLeft, blendshapes.mouthFrownRight);
  const browInnerUp = num(blendshapes.browInnerUp);
  const browDown = avg(blendshapes.browDownLeft, blendshapes.browDownRight);
  const nervousScore = round(browInnerUp * 0.6 + frown * 0.4, 3);

  if (smile > EMOTION_HAPPY_SMILE) return { emotion: 'happy', nervousScore };
  if (nervousScore > EMOTION_NERVOUS_WEIGHTED) return { emotion: 'nervous', nervousScore };
  if (browDown > EMOTION_SERIOUS_BROW_DOWN) return { emotion: 'serious', nervousScore };
  return { emotion: 'neutral', nervousScore };
}

export interface FrameJudgment {
  timestampMs: number;
  /** 本帧检测到的脸数（恰好 1 张才算有效参与帧） */
  faceCount: number;
  eyeContact: boolean;
  emotion: VisualEmotion;
  /** 该情绪的原始强度（smile / nervousScore / browDown），用于秒内主导情绪决胜 */
  emotionIntensity: number;
  nervousScore: number;
  headPose: VisualHeadPose;
}

/**
 * 单帧判定（faceCount !== 1 → 无脸/多脸，参与度记 0，其余字段取中性值）。
 * 虹膜点缺失时退化为仅按头部姿态判断眼神接触（不把「无虹膜」当成「无脸」）。
 */
export function judgeFrame(input: FaceFrameInput, faceCount: number, timestampMs: number): FrameJudgment {
  const neutral: FrameJudgment = {
    timestampMs,
    faceCount,
    eyeContact: false,
    emotion: 'neutral',
    emotionIntensity: 0,
    nervousScore: 0,
    headPose: { pitch: 0, yaw: 0, roll: 0 },
  };
  if (faceCount !== 1 || input.landmarks.length === 0) return neutral;

  const headPose = eulerFromMatrix(input.matrix);
  const bs = input.blendshapes ?? {};
  const { emotion, nervousScore } = classifyEmotion(bs);
  const intensity =
    emotion === 'happy'
      ? avg(bs.mouthSmileLeft, bs.mouthSmileRight)
      : emotion === 'nervous'
        ? nervousScore
        : emotion === 'serious'
          ? avg(bs.browDownLeft, bs.browDownRight)
          : 0;

  return {
    timestampMs,
    faceCount,
    eyeContact: isEyeContact({ irisOffset: irisOffset(input.landmarks), yaw: headPose.yaw, pitch: headPose.pitch }),
    emotion,
    emotionIntensity: round(intensity, 3),
    nervousScore,
    headPose,
  };
}

// ---------- 4.2 秒级聚合（固定 1 Hz） ----------

/** 一秒内多帧 → 一行聚合特征（对齐 visual_features DDL） */
export function aggregateSecond(frames: readonly FrameJudgment[], secondStartMs: number): VisualFeatureRow {
  const faceFrames = frames.filter((f) => f.faceCount === 1);
  const pose: VisualHeadPose =
    faceFrames.length > 0
      ? {
          pitch: round(mean(faceFrames.map((f) => f.headPose.pitch)), 2),
          yaw: round(mean(faceFrames.map((f) => f.headPose.yaw)), 2),
          roll: round(mean(faceFrames.map((f) => f.headPose.roll)), 2),
        }
      : { pitch: 0, yaw: 0, roll: 0 };

  return {
    timestamp_ms: Math.round(secondStartMs),
    eye_contact: round(mean(faceFrames.map((f) => (f.eyeContact ? 1 : 0))), 3),
    emotion: dominantEmotion(faceFrames),
    head_pose: pose,
    engagement: round(mean(frames.map((f) => (f.faceCount === 1 ? 1 : 0))), 3),
  };
}

/** 秒内主导情绪：先比出现次数，再比强度（无脸秒 → neutral） */
function dominantEmotion(faceFrames: readonly FrameJudgment[]): VisualEmotion {
  if (faceFrames.length === 0) return 'neutral';
  const tally = new Map<VisualEmotion, { count: number; intensity: number }>();
  for (const f of faceFrames) {
    const cur = tally.get(f.emotion) ?? { count: 0, intensity: 0 };
    cur.count += 1;
    cur.intensity += f.emotionIntensity;
    tally.set(f.emotion, cur);
  }
  let best: VisualEmotion = 'neutral';
  let bestCount = -1;
  let bestIntensity = -1;
  for (const [emotion, v] of tally) {
    if (v.count > bestCount || (v.count === bestCount && v.intensity > bestIntensity)) {
      best = emotion;
      bestCount = v.count;
      bestIntensity = v.intensity;
    }
  }
  return best;
}

/**
 * 1 Hz 聚合器：push 一帧，跨秒时返回上一秒的行；暂停段不产生行（engagement 分母只计采样秒）。
 */
export class SecondAggregator {
  private frames: FrameJudgment[] = [];
  private bucketMs = -1;

  push(frame: FrameJudgment): VisualFeatureRow | null {
    const bucket = Math.floor(frame.timestampMs / 1000) * 1000;
    if (this.bucketMs === -1) this.bucketMs = bucket;
    if (bucket !== this.bucketMs) {
      const row = this.frames.length > 0 ? aggregateSecond(this.frames, this.bucketMs) : null;
      this.frames = [];
      this.bucketMs = bucket;
      this.frames.push(frame);
      return row;
    }
    this.frames.push(frame);
    return null;
  }

  /** 结束时冲刷最后不满一秒的缓冲 */
  flush(): VisualFeatureRow | null {
    if (this.frames.length === 0) {
      this.bucketMs = -1;
      return null;
    }
    const row = aggregateSecond(this.frames, this.bucketMs);
    this.frames = [];
    this.bucketMs = -1;
    return row;
  }
}

// ---------- 4.4 统计 / 评分 / 证据 ----------

/** DB 行 → VisualFeatureRow（容忍 null / 字符串数字 / 缺字段） */
export function normalizeRow(row: unknown): VisualFeatureRow {
  const r = (row ?? {}) as Record<string, unknown>;
  const pose = (r.head_pose ?? {}) as Record<string, unknown>;
  const emotion = r.emotion;
  return {
    timestamp_ms: num(r.timestamp_ms),
    eye_contact: clamp(num(r.eye_contact), 0, 1),
    emotion:
      emotion === 'happy' || emotion === 'nervous' || emotion === 'serious' || emotion === 'neutral'
        ? (emotion as VisualEmotion)
        : 'neutral',
    head_pose: { pitch: num(pose.pitch), yaw: num(pose.yaw), roll: num(pose.roll) },
    engagement: clamp(num(r.engagement), 0, 1),
  };
}

/** 视觉数据是否足以参与评分（有效行 < 30 秒 → 不足）；传行数或行数组均可 */
export function isVisualDataSufficient(rows: readonly unknown[] | number): boolean {
  return (typeof rows === 'number' ? rows : rows.length) >= VISUAL_MIN_ROWS;
}

/** 每秒一行的时序 → 视觉统计 */
export function summarizeVisual(rows: readonly unknown[]): VisualStats {
  const normalized = rows.map(normalizeRow).filter((r) => r.timestamp_ms >= 0);
  const base: VisualStatsInput = {
    validRows: normalized.length,
    eyeContactRatio: round(mean(normalized.map((r) => r.eye_contact)), 4),
    nervousRatio: round(mean(normalized.map((r) => (r.emotion === 'nervous' ? 1 : 0))), 4),
    headDownRatio: round(mean(normalized.map((r) => (r.head_pose.pitch < HEAD_DOWN_PITCH ? 1 : 0))), 4),
    headTurnRatio: round(mean(normalized.map((r) => (Math.abs(r.head_pose.yaw) > HEAD_TURN_YAW ? 1 : 0))), 4),
    headPoseRatio: round(
      mean(normalized.map((r) => (r.head_pose.pitch < HEAD_DOWN_PITCH || Math.abs(r.head_pose.yaw) > HEAD_TURN_YAW ? 1 : 0))),
      4
    ),
    engagementRatio: round(mean(normalized.map((r) => r.engagement)), 4),
  };
  return { ...base, rawScore: scoreVisual(base), evidence: extractVisualEvidence(normalized) };
}

/** 维度内原始分 0-100（PRD C.2：眼神 40% / 情绪稳定 30% / 头部姿态 20% / 参与度 10%） */
export function scoreVisual(stats: VisualStatsInput): number {
  const eyeScore = linearScore(stats.eyeContactRatio, VISUAL_FULL.eyeContact, VISUAL_EMPTY.eyeContact);
  const emotionScore = linearScore(VISUAL_FULL.nervous - stats.nervousRatio, VISUAL_FULL.nervous, VISUAL_EMPTY.nervous);
  const headScore = linearScore(VISUAL_FULL.headPose - stats.headPoseRatio, VISUAL_FULL.headPose, VISUAL_EMPTY.headPose);
  const engagementScore = linearScore(stats.engagementRatio, VISUAL_FULL.engagement, VISUAL_EMPTY.engagement);
  return Math.round(
    eyeScore * VISUAL_WEIGHTS.eyeContact +
      emotionScore * VISUAL_WEIGHTS.emotion +
      headScore * VISUAL_WEIGHTS.headPose +
      engagementScore * VISUAL_WEIGHTS.engagement
  );
}

/** 视觉维度 metrics 徽章（报告卡片展示） */
export function visualMetrics(stats: VisualStatsInput): Record<string, number | string> {
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return {
    眼神接触: pct(stats.eyeContactRatio),
    紧张占比: pct(stats.nervousRatio),
    低头偏头占比: pct(stats.headPoseRatio),
    面部检测率: pct(stats.engagementRatio),
    有效采样秒数: stats.validRows,
  };
}

type DeviationKind = 'gaze' | 'down' | 'turn' | 'nervous';

const DEVIATION_SEVERITY: Record<DeviationKind, number> = { gaze: 1, down: 1, turn: 0.9, nervous: 1.1 };

function deviationKinds(row: VisualFeatureRow): DeviationKind[] {
  const kinds: DeviationKind[] = [];
  if (row.eye_contact < DEVIATION_EYE_CONTACT) kinds.push('gaze');
  if (row.head_pose.pitch < HEAD_DOWN_PITCH) kinds.push('down');
  if (Math.abs(row.head_pose.yaw) > HEAD_TURN_YAW) kinds.push('turn');
  if (row.emotion === 'nervous') kinds.push('nervous');
  return kinds;
}

function deviationText(kind: DeviationKind, seconds: number): string {
  if (kind === 'gaze') return `持续 ${seconds} 秒视线偏离镜头`;
  if (kind === 'down') return `持续 ${seconds} 秒低头`;
  if (kind === 'turn') return `持续 ${seconds} 秒头部明显偏转`;
  return `持续 ${seconds} 秒表情紧张`;
}

/**
 * 从时序提取 ≤3 段「显著偏离段」（连续 ≥5 秒眼神偏离 / 低头 / 偏头 / 紧张）。
 * 分析端不假设行等距：段长按首尾时间戳计算。
 */
export function extractVisualEvidence(rows: readonly unknown[], maxSegments = VISUAL_EVIDENCE_MAX): Evidence[] {
  const sorted = rows.map(normalizeRow).filter((r) => r.timestamp_ms >= 0).sort((a, b) => a.timestamp_ms - b.timestamp_ms);
  const candidates: { startMs: number; seconds: number; kind: DeviationKind; severity: number }[] = [];

  for (const kind of ['gaze', 'down', 'turn', 'nervous'] as DeviationKind[]) {
    let run: VisualFeatureRow[] = [];
    const flushRun = () => {
      if (run.length >= DEVIATION_MIN_SECONDS) {
        const spanMs = run[run.length - 1].timestamp_ms - run[0].timestamp_ms;
        if (spanMs >= (DEVIATION_MIN_SECONDS - 1) * 1000) {
          const seconds = Math.round(spanMs / 1000) + 1;
          candidates.push({ startMs: run[0].timestamp_ms, seconds, kind, severity: seconds * DEVIATION_SEVERITY[kind] });
        }
      }
      run = [];
    };
    for (const row of sorted) {
      if (deviationKinds(row).includes(kind)) run.push(row);
      else flushRun();
    }
    flushRun();
  }

  return candidates
    .sort((a, b) => b.severity - a.severity)
    .slice(0, maxSegments)
    .sort((a, b) => a.startMs - b.startMs)
    .map((c, i) => ({
      id: `ev_visual_${String(i + 1).padStart(3, '0')}`,
      modality: 'visual' as const,
      timestamp_ms: c.startMs,
      content: `${formatTimestamp(c.startMs)} 起${deviationText(c.kind, c.seconds)}`,
      dimension_hint: 'visual' as const,
    }));
}
