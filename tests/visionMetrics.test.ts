import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SecondAggregator,
  VISUAL_MIN_ROWS,
  aggregateSecond,
  classifyEmotion,
  eulerFromMatrix,
  extractVisualEvidence,
  irisOffset,
  isEyeContact,
  isVisualDataSufficient,
  judgeFrame,
  normalizeRow,
  scoreVisual,
  summarizeVisual,
  visualMetrics,
  type FrameJudgment,
} from '../engine/visionMetrics.ts';
import type { VisualFeatureRow } from '../types.ts';

/**
 * M6 视觉维度单测（PRD 4.3 / 4.4 / C.2）
 * 阈值边界、1Hz 聚合、评分换算、偏离段证据、数据不足兜底。
 */

/** 4x4 列主序旋转矩阵（yaw 绕 Y / pitch 绕 X，单位度） */
function rotationMatrix(pitchDeg: number, yawDeg: number): number[] {
  const rad = (d: number) => (d * Math.PI) / 180;
  const ca = Math.cos(rad(pitchDeg));
  const sa = Math.sin(rad(pitchDeg));
  const cb = Math.cos(rad(yawDeg));
  const sb = Math.sin(rad(yawDeg));
  // R = Rz(0)·Ry(yaw)·Rx(pitch)
  const m = [
    [cb, 0, sb],
    [sa * sb, ca, -sa * cb],
    [-ca * sb, sa, ca * cb],
  ];
  return [
    m[0][0], m[1][0], m[2][0], 0,
    m[0][1], m[1][1], m[2][1], 0,
    m[0][2], m[1][2], m[2][2], 0,
    0, 0, 0, 1,
  ];
}

/** 造 478 点 landmarks：虹膜相对眼眶中心的水平偏移比 */
function landmarksWithIris(offsetRatio: number) {
  const lm = Array.from({ length: 478 }, () => ({ x: 0.5, y: 0.5, z: 0 }));
  // 左眼：外 33 / 内 133 / 虹膜 468；右眼：外 263 / 内 362 / 虹膜 473
  lm[33] = { x: 0.4, y: 0.5, z: 0 };
  lm[133] = { x: 0.5, y: 0.5, z: 0 };
  lm[468] = { x: 0.45 + 0.01 * offsetRatio, y: 0.5, z: 0 };
  lm[263] = { x: 0.5, y: 0.5, z: 0 };
  lm[362] = { x: 0.6, y: 0.5, z: 0 };
  lm[473] = { x: 0.55 + 0.01 * offsetRatio, y: 0.5, z: 0 };
  return lm;
}

function frame(partial: Partial<FrameJudgment>): FrameJudgment {
  return {
    timestampMs: 0,
    faceCount: 1,
    eyeContact: true,
    emotion: 'neutral',
    emotionIntensity: 0,
    nervousScore: 0,
    headPose: { pitch: 0, yaw: 0, roll: 0 },
    ...partial,
  };
}

// ---------- 4.3 帧级判定 ----------

test('头部姿态：列主序矩阵 → 欧拉角（低头 pitch 为负、偏头 yaw 绝对值）', () => {
  const straight = eulerFromMatrix(rotationMatrix(0, 0));
  assert.ok(Math.abs(straight.pitch) < 0.01 && Math.abs(straight.yaw) < 0.01);

  const down = eulerFromMatrix(rotationMatrix(-20, 0));
  assert.ok(Math.abs(down.pitch + 20) < 0.5, `低头 pitch 应为 -20°，实际 ${down.pitch}`);
  assert.ok(Math.abs(down.yaw) < 0.5);

  const turned = eulerFromMatrix(rotationMatrix(0, 25));
  assert.ok(Math.abs(turned.yaw - 25) < 0.5, `偏头 yaw 应为 25°，实际 ${turned.yaw}`);

  // 缺矩阵 / 长度不足 → 零姿态（不崩）
  assert.deepEqual(eulerFromMatrix(null), { pitch: 0, yaw: 0, roll: 0 });
  assert.deepEqual(eulerFromMatrix([1, 2, 3]), { pitch: 0, yaw: 0, roll: 0 });
});

test('眼神接触：阈值边界（yaw 15° / pitch 12° / 虹膜偏移 0.18）', () => {
  assert.equal(isEyeContact({ irisOffset: 0, yaw: 0, pitch: 0 }), true);
  // 刚好在边界内（严格小于）
  assert.equal(isEyeContact({ irisOffset: 0.17, yaw: 14.9, pitch: 11.9 }), true);
  // 越界：任一条不满足即不看镜头
  assert.equal(isEyeContact({ irisOffset: 0, yaw: 15, pitch: 0 }), false);
  assert.equal(isEyeContact({ irisOffset: 0, yaw: -15, pitch: 0 }), false);
  assert.equal(isEyeContact({ irisOffset: 0, yaw: 0, pitch: 12 }), false);
  assert.equal(isEyeContact({ irisOffset: 0.18, yaw: 0, pitch: 0 }), false);
  // 头部姿态补偿：转头接近上限时，同样的虹膜偏移应更容易判为看镜头
  assert.equal(isEyeContact({ irisOffset: 0.24, yaw: 14.9, pitch: 0 }), true);
  assert.equal(isEyeContact({ irisOffset: 0.24, yaw: 0, pitch: 0 }), false);
  // 头部超出 15°/12° 门限：即使虹膜居中也不算看镜头
  assert.equal(isEyeContact({ irisOffset: 0, yaw: 30, pitch: 0 }), false);
});

test('虹膜偏移：居中 0、偏移按眼眶宽度归一化', () => {
  assert.ok(irisOffset(landmarksWithIris(0)) < 0.01);
  assert.ok(Math.abs(irisOffset(landmarksWithIris(1)) - 0.1) < 0.01);
  // landmarks 不足 478 点（无虹膜）→ 0，不崩
  assert.equal(irisOffset([{ x: 0.5, y: 0.5 }]), 0);
});

test('情绪：blendshapes 规则映射四类 + 优先级', () => {
  assert.equal(classifyEmotion({}).emotion, 'neutral');
  assert.equal(classifyEmotion({ mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }).emotion, 'happy');
  assert.equal(classifyEmotion({ browInnerUp: 0.8, mouthFrownLeft: 0.1, mouthFrownRight: 0.1 }).emotion, 'nervous');
  assert.equal(classifyEmotion({ browDownLeft: 0.5, browDownRight: 0.5 }).emotion, 'serious');
  // happy 优先于 nervous/serious
  assert.equal(
    classifyEmotion({ mouthSmileLeft: 0.6, mouthSmileRight: 0.6, browInnerUp: 0.9, browDownLeft: 0.9, browDownRight: 0.9 }).emotion,
    'happy'
  );
  // 紧张度原始值保留
  assert.ok(classifyEmotion({ browInnerUp: 0.9 }).nervousScore > 0.5);
  // 刚好不到阈值 → 不进对应类
  assert.equal(classifyEmotion({ mouthSmileLeft: 0.4, mouthSmileRight: 0.4 }).emotion, 'neutral');
});

test('帧级判定：无脸/多脸 → 参与度 0、中性字段，不崩', () => {
  const noFace = judgeFrame({ landmarks: [] }, 0, 1000);
  assert.equal(noFace.faceCount, 0);
  assert.equal(noFace.eyeContact, false);
  assert.equal(noFace.emotion, 'neutral');
  assert.deepEqual(noFace.headPose, { pitch: 0, yaw: 0, roll: 0 });

  const twoFaces = judgeFrame({ landmarks: landmarksWithIris(0) }, 2, 1000);
  assert.equal(twoFaces.eyeContact, false);
  assert.equal(twoFaces.faceCount, 2);

  const ok = judgeFrame(
    { landmarks: landmarksWithIris(0), blendshapes: { mouthSmileLeft: 0.5, mouthSmileRight: 0.5 }, matrix: rotationMatrix(0, 0) },
    1,
    1000
  );
  assert.equal(ok.eyeContact, true);
  assert.equal(ok.emotion, 'happy');
});

// ---------- 4.2 秒级聚合 ----------

test('1Hz 聚合：眼神占比 / 主导情绪 / 姿态均值 / 参与度', () => {
  const row = aggregateSecond(
    [
      frame({ timestampMs: 100, eyeContact: true, emotion: 'happy', emotionIntensity: 0.6 }),
      frame({ timestampMs: 250, eyeContact: false, emotion: 'nervous', nervousScore: 0.5, emotionIntensity: 0.5 }),
      frame({ timestampMs: 400, faceCount: 0 }),
      frame({ timestampMs: 600, eyeContact: false, emotion: 'nervous', nervousScore: 0.6, emotionIntensity: 0.6 }),
    ],
    0
  );
  assert.equal(row.timestamp_ms, 0);
  // 有脸帧 3 帧，其中 1 帧看镜头
  assert.ok(Math.abs(row.eye_contact - 1 / 3) < 0.01);
  // 4 帧中 3 帧有脸
  assert.ok(Math.abs(row.engagement - 0.75) < 0.01);
  // nervous 出现 2 次 > happy 1 次 → 主导情绪 nervous
  assert.equal(row.emotion, 'nervous');
  assert.deepEqual(row.head_pose, { pitch: 0, yaw: 0, roll: 0 });
});

test('SecondAggregator：跨秒返回上一秒行，暂停段不产生行', () => {
  const agg = new SecondAggregator();
  assert.equal(agg.push(frame({ timestampMs: 100 })), null);
  assert.equal(agg.push(frame({ timestampMs: 900 })), null);
  const first = agg.push(frame({ timestampMs: 1100 }));
  assert.ok(first);
  assert.equal(first!.timestamp_ms, 0);
  // 直接跳到第 5 秒：中间 2-4 秒无帧 → 不补行，只产出第 1 秒的行
  const second = agg.push(frame({ timestampMs: 5100 }));
  assert.ok(second);
  assert.equal(second!.timestamp_ms, 1000);
  // 第 5 秒的行要等下一次跨秒或 flush
  assert.equal(agg.flush()!.timestamp_ms, 5000);
  assert.equal(agg.flush(), null);
});

// ---------- 4.4 统计 / 评分 / 证据 ----------

function rows(
  count: number,
  overrides: (i: number) => Partial<VisualFeatureRow> = () => ({})
): VisualFeatureRow[] {
  return Array.from({ length: count }, (_, i) => ({
    timestamp_ms: i * 1000,
    eye_contact: 0.8,
    emotion: 'neutral' as const,
    head_pose: { pitch: 0, yaw: 0, roll: 0 },
    engagement: 1,
    ...overrides(i),
  }));
}

test('scoreVisual：满分 / 零分 / 线性中值（PRD C.2 权重）', () => {
  const perfect = summarizeVisual(rows(40));
  assert.equal(perfect.rawScore, 100);
  assert.equal(perfect.validRows, 40);
  assert.equal(perfect.eyeContactRatio, 0.8);

  const worst = summarizeVisual(
    rows(40, () => ({ eye_contact: 0, emotion: 'nervous', head_pose: { pitch: -30, yaw: 40, roll: 0 }, engagement: 0 }))
  );
  assert.equal(worst.rawScore, 0);
  assert.equal(worst.nervousRatio, 1);
  assert.equal(worst.headPoseRatio, 1);

  // 眼神 50%（满分线 70%）→ 眼神项 round(50/70*100)=71；其余三项满分 → 71×0.4 + 60 = 88.4 → 88
  const half = scoreVisual({
    validRows: 40,
    eyeContactRatio: 0.5,
    nervousRatio: 0,
    headDownRatio: 0,
    headTurnRatio: 0,
    headPoseRatio: 0,
    engagementRatio: 1,
  });
  assert.equal(half, 88);
});

test('metrics 徽章：百分比 + 有效采样秒数', () => {
  const stats = summarizeVisual(rows(35, () => ({ eye_contact: 0.7, engagement: 0.95 })));
  const m = visualMetrics(stats);
  assert.equal(m['眼神接触'], '70%');
  assert.equal(m['面部检测率'], '95%');
  assert.equal(m['低头偏头占比'], '0%');
  assert.equal(m['有效采样秒数'], 35);
});

test('数据不足兜底：29 行不参与评分，30 行起参与', () => {
  assert.equal(isVisualDataSufficient(29), false);
  assert.equal(isVisualDataSufficient(30), true);
  assert.equal(isVisualDataSufficient(VISUAL_MIN_ROWS), true);
  assert.equal(summarizeVisual(rows(10)).validRows, 10);
});

test('偏离段证据：连续 ≥5 秒才生成，≤3 段，按时间排序', () => {
  // 前 6 秒眼神偏离 + 第 20-24 秒紧张
  const evidence = extractVisualEvidence(
    rows(30, (i) =>
      i < 6
        ? { eye_contact: 0.1 }
        : i >= 20 && i < 25
          ? { emotion: 'nervous' as const }
          : {}
    )
  );
  assert.equal(evidence.length, 2);
  const gaze = evidence.find((e) => e.content.includes('视线偏离镜头'));
  assert.ok(gaze, '缺少视线偏离证据');
  assert.equal(gaze!.modality, 'visual');
  assert.equal(gaze!.dimension_hint, 'visual');
  assert.equal(gaze!.timestamp_ms, 0);
  assert.ok(gaze!.content.startsWith('00:00 起持续 6 秒'), gaze!.content);
  const nervous = evidence.find((e) => e.content.includes('表情紧张'));
  assert.ok(nervous);
  assert.equal(nervous!.timestamp_ms, 20_000);
  assert.ok(nervous!.content.includes('00:20 起持续 5 秒'), nervous!.content);

  // 只有 4 秒 → 不生成
  assert.equal(extractVisualEvidence(rows(30, (i) => (i < 4 ? { eye_contact: 0.1 } : {}))).length, 0);
  // 正常数据 → 无证据
  assert.equal(extractVisualEvidence(rows(40)).length, 0);
});

test('证据上限 ≤3：四类偏离都触发时只保留最严重的 3 段', () => {
  const evidence = extractVisualEvidence(
    rows(60, (i) => {
      if (i < 20) return { eye_contact: 0.1 };
      if (i < 40) return { emotion: 'nervous' as const };
      if (i < 60) return { head_pose: { pitch: -40, yaw: 0, roll: 0 } };
      return {};
    })
  );
  assert.ok(evidence.length <= 3, `证据应 ≤3 段，实际 ${evidence.length}`);
  // 段按时间升序、id 连续
  for (let i = 1; i < evidence.length; i += 1) {
    assert.ok(evidence[i].timestamp_ms >= evidence[i - 1].timestamp_ms);
  }
  assert.equal(evidence[0].id, 'ev_visual_001');
});

test('normalizeRow：容忍 DB null / 字符串数字 / 非法枚举', () => {
  const row = normalizeRow({ timestamp_ms: '12000', eye_contact: null, emotion: 'angry', head_pose: { pitch: '-8' }, engagement: 2 });
  assert.equal(row.timestamp_ms, 12_000);
  assert.equal(row.eye_contact, 0);
  assert.equal(row.emotion, 'neutral');
  assert.equal(row.head_pose.pitch, -8);
  assert.equal(row.engagement, 1);
  assert.deepEqual(normalizeRow(null), {
    timestamp_ms: 0,
    eye_contact: 0,
    emotion: 'neutral',
    head_pose: { pitch: 0, yaw: 0, roll: 0 },
    engagement: 0,
  });
});

test('summarizeVisual：低头/偏头分别统计，headPoseRatio 取并集', () => {
  const stats = summarizeVisual(
    rows(10, (i) => {
      if (i < 4) return { head_pose: { pitch: -20, yaw: 0, roll: 0 } };
      if (i < 6) return { head_pose: { pitch: 0, yaw: 30, roll: 0 } };
      return {};
    })
  );
  assert.equal(stats.headDownRatio, 0.4);
  assert.equal(stats.headTurnRatio, 0.2);
  assert.equal(stats.headPoseRatio, 0.6);
});

test('帧级判定：虹膜点缺失时仍算有效帧（退化为头部姿态判断）', () => {
  // 只有 468 点（无虹膜）但检测到一张脸：engagement 应计 1，眼神按头部姿态判断
  const noIris = judgeFrame({ landmarks: Array.from({ length: 468 }, () => ({ x: 0.5, y: 0.5 })) }, 1, 1000);
  assert.equal(noIris.faceCount, 1);
  assert.equal(noIris.eyeContact, true); // 头部姿态为 0 → 视为看镜头
  assert.equal(noIris.emotion, 'neutral');
});
