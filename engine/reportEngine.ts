import type { Evidence, GameEvent, Message, ReportV15 } from '../types';

/**
 * 面后报告 v1.5 规则引擎（PRD 4.1.7 / 7.4 / 附录 C）
 * - 规则引擎实算：话语权占比、发言时长分布、被打断次数、回应次数、恢复速度
 * - LLM 处理语义维度（结构贡献、冲突处理、团队协调）——由 /api/analyze 注入
 * - M3 过渡权重（视觉 M6 前不参与）：内容 40 / 语音 25 / 抗压 20 / 协作 15
 */

export const TRANSITION_WEIGHTS = { content: 40, voice: 25, stress: 20, teamwork: 15 } as const;

const FILLER_WORDS = ['嗯', '啊', '呃', '那个', '就是', '然后', '这个', '怎么说'];
const RESPONSE_MARKERS = ['同意', '赞同', '补充', '质疑', '回应', '反对', '认可', '支持'];
const PUSH_MARKERS = ['首先', '第一', '第二', '第三', '框架', '建议', '总结', '应该', '接下来', '角度'];
const STRUCTURE_MARKERS = ['首先', '其次', '最后', '第一', '第二', '第三', '综上', '方面', '要点'];

export interface ReportInput {
  transcripts: Message[];
  events: GameEvent[];
  sessionStartAt: number;
  durationMs: number;
}

export interface RuleMetrics {
  /** 用户发言条数占比 0-100 */
  voiceShareByCount: number;
  /** 用户发言时长占比 0-100（无时间戳时退化为条数占比） */
  voiceShareByTime: number;
  userSpeakMs: number;
  totalSpeakMs: number;
  userMessageCount: number;
  totalMessageCount: number;
  /** 填充词次数与占比 */
  fillerCount: number;
  fillerRatio: number;
  /** 语速（字/分钟，按带时间戳的用户发言估算） */
  speakingRateWpm: number;
  /** 用户被打断次数 */
  interruptedCount: number;
  /** 被打断后恢复时长（ms，取平均；未被打断为 null） */
  interruptRecoveryMs: number | null;
  /** 回应他人次数 */
  responseCount: number;
  /** 推动讨论次数（新角度/总结） */
  pushDiscussionCount: number;
  /** 结构标记出现次数（清晰度规则近似） */
  structureMarkerCount: number;
  /** 发言时长分布（每 5 分钟一段的用户发言字数） */
  timeDistribution: { bucketStartMs: number; userChars: number }[];
}

/** 发言时长估算：优先 endMs-startMs，否则按 2.8 字/秒 */
export function estimateSpeakMs(msg: Message): number {
  if (typeof msg.startMs === 'number' && typeof msg.endMs === 'number' && msg.endMs > msg.startMs) {
    return msg.endMs - msg.startMs;
  }
  return (msg.content.length / 2.8) * 1000;
}

function msgStartMs(msg: Message, sessionStartAt: number): number {
  if (typeof msg.startMs === 'number') return msg.startMs;
  return Math.max(0, msg.timestamp - sessionStartAt);
}

export function computeRuleMetrics(input: ReportInput): RuleMetrics {
  const { transcripts, events, sessionStartAt, durationMs } = input;
  const userMsgs = transcripts.filter((m) => m.senderId === 'user' && m.type === 'message');
  const allMsgs = transcripts.filter((m) => m.type === 'message');

  const userSpeakMs = userMsgs.reduce((sum, m) => sum + estimateSpeakMs(m), 0);
  const totalSpeakMs = allMsgs.reduce((sum, m) => sum + estimateSpeakMs(m), 0);

  const fillerCount = userMsgs.reduce((sum, m) => {
    return sum + FILLER_WORDS.reduce((s, w) => s + (m.content.split(w).length - 1), 0);
  }, 0);
  const userChars = userMsgs.reduce((sum, m) => sum + m.content.length, 0);

  // 语速：仅在用户发言带时间戳时可估算
  const timedUserMsgs = userMsgs.filter((m) => typeof m.startMs === 'number' && typeof m.endMs === 'number');
  const timedMs = timedUserMsgs.reduce((sum, m) => sum + (m.endMs! - m.startMs!), 0);
  const timedChars = timedUserMsgs.reduce((sum, m) => sum + m.content.length, 0);
  const speakingRateWpm = timedMs > 60_000 ? Math.round((timedChars / (timedMs / 60_000)) * 10) / 10 : 0;

  // 被打断次数（events: interrupt, target=user）
  const userInterrupts = events.filter((e) => e.event_type === 'interrupt' && e.target === 'user');
  const interruptedCount = userInterrupts.length;

  // 打断后恢复：从打断事件到用户下一条发言的时长
  const recoveries: number[] = [];
  for (const ev of userInterrupts) {
    const evAbs = sessionStartAt + ev.timestamp_ms;
    const nextUser = userMsgs.find((m) => m.timestamp >= evAbs && msgStartMs(m, sessionStartAt) >= ev.timestamp_ms);
    if (nextUser) recoveries.push(Math.max(0, nextUser.timestamp - evAbs));
  }
  const interruptRecoveryMs = recoveries.length > 0 ? Math.round(recoveries.reduce((a, b) => a + b, 0) / recoveries.length) : null;

  const responseCount = userMsgs.filter((m) => RESPONSE_MARKERS.some((k) => m.content.includes(k))).length;
  const pushDiscussionCount = userMsgs.filter((m) => PUSH_MARKERS.some((k) => m.content.includes(k))).length;
  const structureMarkerCount = userMsgs.reduce(
    (sum, m) => sum + STRUCTURE_MARKERS.filter((k) => m.content.includes(k)).length,
    0
  );

  // 发言时长分布（5 分钟一桶）
  const bucketMs = 5 * 60 * 1000;
  const buckets = new Map<number, number>();
  for (const m of userMsgs) {
    const b = Math.floor(msgStartMs(m, sessionStartAt) / bucketMs) * bucketMs;
    buckets.set(b, (buckets.get(b) ?? 0) + m.content.length);
  }
  const timeDistribution = [...buckets.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([bucketStartMs, userChars]) => ({ bucketStartMs, userChars }));

  return {
    voiceShareByCount: allMsgs.length > 0 ? Math.round((userMsgs.length / allMsgs.length) * 100) : 0,
    voiceShareByTime: totalSpeakMs > 0 ? Math.round((userSpeakMs / totalSpeakMs) * 100) : 0,
    userSpeakMs: Math.round(userSpeakMs),
    totalSpeakMs: Math.round(totalSpeakMs),
    userMessageCount: userMsgs.length,
    totalMessageCount: allMsgs.length,
    fillerCount,
    fillerRatio: userChars > 0 ? Math.round((fillerCount / userChars) * 1000) / 10 : 0,
    speakingRateWpm,
    interruptedCount,
    interruptRecoveryMs,
    responseCount,
    pushDiscussionCount,
    structureMarkerCount,
    timeDistribution,
  };
}

/** 证据池（PRD 7.3）：用户发言 → text 证据；打断事件 → event 证据 */
export function buildEvidencePool(input: ReportInput): Evidence[] {
  const { transcripts, events, sessionStartAt } = input;
  const pool: Evidence[] = [];
  let idx = 0;
  transcripts
    .filter((m) => m.senderId === 'user' && m.type === 'message')
    .forEach((m, i) => {
      idx += 1;
      const startMs = msgStartMs(m, sessionStartAt);
      const hint: Evidence['dimension_hint'] = PUSH_MARKERS.some((k) => m.content.includes(k))
        ? 'content'
        : RESPONSE_MARKERS.some((k) => m.content.includes(k))
          ? 'teamwork'
          : 'content';
      pool.push({
        id: `ev_${String(idx).padStart(3, '0')}`,
        modality: 'text',
        timestamp_ms: startMs,
        content: m.content,
        dimension_hint: hint,
        message_index: i,
      });
    });
  for (const ev of events) {
    if (ev.event_type === 'interrupt' && ev.target === 'user') {
      idx += 1;
      pool.push({
        id: `ev_${String(idx).padStart(3, '0')}`,
        modality: 'event',
        timestamp_ms: ev.timestamp_ms,
        content: `被 ${ev.actor} 打断（规则：${(ev.metadata as { rule?: string })?.rule ?? 'unknown'}）`,
        dimension_hint: 'stress',
      });
    }
  }
  return pool;
}

export interface LlmSemanticScores {
  /** 结构清晰度 0-100 */
  structureScore?: number;
  /** 回应质量 0-100 */
  responseQuality?: number;
  /** 被质疑后回应质量 0-100 */
  stressResponseQuality?: number;
  /** 冲突处理方式 0-100 */
  conflictHandling?: number;
  /** 支持/补充他人 0-100 */
  supportOthers?: number;
  /** 协调分歧 0-100 */
  coordinateOthers?: number;
  /** LLM 补充证据（原话 + 时间戳） */
  extraEvidence?: Evidence[];
}

function clamp(x: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, x));
}

/** 线性阈值映射：value >= full 满分，<= empty 0 分 */
function thresholdScore(value: number, full: number, empty: number): number {
  if (value >= full) return 100;
  if (value <= empty) return 0;
  return Math.round(((value - empty) / (full - empty)) * 100);
}

/**
 * 组装报告 v1.5。
 * 规则引擎实算指标 + LLM 语义分（可选，缺失时用规则近似并标注）。
 */
export function buildRuleReport(input: ReportInput, llm?: LlmSemanticScores): ReportV15 {
  const m = computeRuleMetrics(input);
  const evidence = buildEvidencePool(input);
  const contentEvidence = evidence.filter((e) => e.dimension_hint === 'content').slice(0, 5);
  const stressEvidence = evidence.filter((e) => e.dimension_hint === 'stress').slice(0, 3);
  const teamworkEvidence = evidence.filter((e) => e.dimension_hint === 'teamwork').slice(0, 3);
  const voiceEvidence = evidence.slice(0, 3);

  // ---- 内容贡献（max 40）：观点数量 25% / 结构清晰度 25% / 推动讨论 25% / 回应质量 25%
  const opinionsScore = thresholdScore(m.userMessageCount, 5, 1);
  const structureRule = thresholdScore(m.structureMarkerCount, 3, 0);
  const structureScore = llm?.structureScore ?? structureRule;
  const pushScore = thresholdScore(m.pushDiscussionCount, 3, 0);
  const responseQuality = llm?.responseQuality ?? thresholdScore(m.responseCount, 3, 0);
  const contentRaw = opinionsScore * 0.25 + structureScore * 0.25 + pushScore * 0.25 + responseQuality * 0.25;
  const content = Math.round((contentRaw / 100) * 40);

  // ---- 语音表现（max 25）：语速 20% / 填充词 20% / 停顿合理性 20% / 打断后恢复 20% / 音量稳定性 20%（P1）
  const rateScore = m.speakingRateWpm > 0 ? thresholdScore(m.speakingRateWpm, 140, 100) : 60; // 100-140 WPM 满分
  const fillerScore = thresholdScore(5 - m.fillerRatio, 5, 0); // <5% 满分
  const pauseScore = m.userMessageCount >= 3 ? 70 : 50; // 文字版无停顿数据，规则近似
  const recoveryScore = m.interruptRecoveryMs === null ? 70 : thresholdScore(3000 - m.interruptRecoveryMs, 3000, 0); // <3s 满分
  const volumeScore = 60; // P1（音量稳定性）
  const voiceRaw = rateScore * 0.2 + fillerScore * 0.2 + pauseScore * 0.2 + recoveryScore * 0.2 + volumeScore * 0.2;
  const voice = Math.round((voiceRaw / 100) * 25);

  // ---- 抗压/冲突（max 20）：被质疑后回应质量 50% / 打断后恢复速度 30% / 冲突处理方式 20%
  const stressQuality = llm?.stressResponseQuality ?? (stressEvidence.length > 0 ? 60 : 55);
  const conflictHandling = llm?.conflictHandling ?? 60;
  const stressRaw = stressQuality * 0.5 + recoveryScore * 0.3 + conflictHandling * 0.2;
  const stress = Math.round((stressRaw / 100) * 20);

  // ---- 团队协作（max 15，M3 过渡权重 TRANSITION_WEIGHTS）：回应他人次数 40% / 支持补充他人 30% / 协调分歧 30%
  const respondScore = thresholdScore(m.responseCount, 3, 0);
  const supportScore = llm?.supportOthers ?? respondScore;
  const coordinateScore = llm?.coordinateOthers ?? 55;
  const teamworkRaw = respondScore * 0.4 + supportScore * 0.3 + coordinateScore * 0.3;
  const teamwork = Math.round((teamworkRaw / 100) * TRANSITION_WEIGHTS.teamwork);

  // ---- 视觉（M6 前不参与总分）
  const visual = { score: 0, max: 20, status: 'not_enabled' as const, evidence: [] as Evidence[], note: '视觉维度 M6 启用（摄像头分析未开启）' };

  const overall = clamp(content + voice + stress + teamwork, 0, 100);
  const performanceLevel: ReportV15['performance_level'] = overall >= 80 ? '领先' : overall >= 60 ? '良好' : '待提升';
  const performanceRank = overall >= 85 ? '前 20%' : overall >= 70 ? '前 40%' : overall >= 55 ? '中段' : '后 40%';
  const simulatedRank = overall >= 85 ? '模拟第1梯队' : overall >= 70 ? '模拟第2梯队' : overall >= 55 ? '模拟第3梯队' : '模拟待提升';

  const suggestions = buildSuggestions({ m, content, voice, stress, teamwork });

  return {
    session_id: null,
    overall_score: overall,
    performance_rank: performanceRank,
    simulated_rank: simulatedRank,
    performance_level: performanceLevel,
    dimensions: {
      content: {
        score: content,
        max: 40,
        evidence: [...contentEvidence, ...(llm?.extraEvidence ?? []).filter((e) => e.dimension_hint === 'content')].slice(0, 6),
        metrics: {
          观点数量: m.userMessageCount,
          结构标记次数: m.structureMarkerCount,
          推动讨论次数: m.pushDiscussionCount,
          回应次数: m.responseCount,
        },
      },
      voice: {
        score: voice,
        max: 25,
        evidence: voiceEvidence,
        metrics: {
          话语权占比: m.voiceShareByTime,
          填充词占比: m.fillerRatio,
          语速WPM: m.speakingRateWpm || 'N/A（文字版无 ASR 时间戳）',
          被打断次数: m.interruptedCount,
          平均恢复时长ms: m.interruptRecoveryMs ?? 'N/A',
          发言时段分布:
            m.timeDistribution.length > 0
              ? m.timeDistribution
                  .slice(0, 5)
                  .map((b) => `${Math.round(b.bucketStartMs / 60000)}min/${b.userChars}字`)
                  .join(' ')
              : 'N/A',
        },
        note: '语音副语言特征需 ASR 时间戳（M2），当前为文字版规则近似',
      },
      visual,
      stress: {
        score: stress,
        max: 20,
        evidence: stressEvidence,
        metrics: {
          被打断次数: m.interruptedCount,
          平均恢复时长ms: m.interruptRecoveryMs ?? 'N/A',
        },
      },
      teamwork: {
        score: teamwork,
        max: TRANSITION_WEIGHTS.teamwork,
        evidence: teamworkEvidence,
        metrics: {
          回应他人次数: m.responseCount,
        },
      },
    },
    suggestions,
  };
}

/** 改进建议（PRD F.4）：规则生成，LLM 版由 /api/analyze 覆盖 */
export function buildSuggestions(scores: {
  m: RuleMetrics;
  content: number;
  voice: number;
  stress: number;
  teamwork: number;
}): string[] {
  const { m, content, voice, stress, teamwork } = scores;
  const tips: string[] = [];
  if (m.voiceShareByTime < 25) tips.push('下次练习争取更早发言，前 3 分钟至少贡献 1 个核心观点');
  if (m.userMessageCount < 4) tips.push('增加有效发言次数，目标每场至少 5 次有观点的发言');
  if (content < 24) tips.push('发言使用"首先/其次/最后"结构化表达，让观点更清晰');
  if (voice < 15 && m.fillerRatio >= 3) tips.push(`减少口头填充词（当前约 ${m.fillerRatio}% 的字数含"嗯/那个"等）`);
  if (stress < 12 && m.interruptedCount > 0) tips.push('被质疑或打断后，先确认对方观点再回应，争取 3 秒内恢复');
  if (teamwork < 9) tips.push('多回应他人观点（同意并推进/质疑后给方案），目标每场回应 ≥3 次');
  if (tips.length === 0) tips.push('表现均衡，尝试在总结阶段主动承担汇报，展示领导力');
  return tips.slice(0, 5);
}
