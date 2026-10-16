import type { Pool } from 'pg';
import type { GameEvent, Message, ReportV15 } from '../../types';
import { buildRuleReport, type LlmSemanticScores, type ReportInput } from '../../engine/reportEngine.ts';
import { callDeepSeek } from './llm';
import { buildAnalysisPrompt } from './prompts';
import { safeJsonParse } from './jsonStream';

/**
 * 面后分析流水线（PRD 7.6 / E.2：/api/sessions/{id}/analyze）
 * 读取 transcripts + events → 规则引擎 + LLM 语义分 → reports 落库。
 * 同一份日志可多次分析（幂等：重复触发覆盖同一 session 的报告）。
 * 目标 ≤30s（C8）：规则引擎毫秒级 + 单次 DeepSeek 调用秒级。
 */

export interface AnalyzeResult {
  report: ReportV15;
  persisted: boolean;
}

export async function analyzeSession(
  pool: Pool,
  sessionId: number,
  opts: { persist?: boolean } = {}
): Promise<AnalyzeResult> {
  const sessionRes = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]).catch(() => ({ rows: [] as any[] }));
  const session = sessionRes.rows[0];
  const topic = session?.topic ?? '';

  let transcriptRows: any[] = [];
  try {
    const res = await pool.query('SELECT * FROM transcripts WHERE session_id = $1 ORDER BY created_at ASC', [sessionId]);
    transcriptRows = res.rows;
  } catch {
    const res = await pool.query('SELECT * FROM conversation_records WHERE session_id = $1 ORDER BY created_at ASC', [sessionId]);
    transcriptRows = res.rows;
  }
  let eventRows: any[] = [];
  try {
    const res = await pool.query('SELECT * FROM events WHERE session_id = $1 ORDER BY timestamp_ms ASC', [sessionId]);
    eventRows = res.rows;
  } catch {
    eventRows = [];
  }

  const sessionStartAt = session?.started_at ? new Date(session.started_at).getTime() : Date.now();
  const endedAt = session?.ended_at ? new Date(session.ended_at).getTime() : Date.now();
  const durationMs = Math.max(60_000, endedAt - sessionStartAt);

  const transcripts: Message[] = transcriptRows.map((r, i) => {
    const isUser = r.speaker === 'user' || r.speaker_type === 'user';
    return {
      id: String(r.id ?? i),
      senderId: isUser ? 'user' : String(r.speaker_id ?? r.speaker ?? 'ai'),
      senderName: r.speaker_name ?? (isUser ? '陈明' : 'AI'),
      content: r.message ?? '',
      timestamp: r.created_at ? new Date(r.created_at).getTime() : sessionStartAt,
      type: 'message' as const,
      startMs: r.start_ms ?? undefined,
      endMs: r.end_ms ?? undefined,
      confidence: r.confidence ?? undefined,
      stepfunSegmentId: r.stepfun_segment_id ?? undefined,
    };
  });
  const events: GameEvent[] = eventRows.map((r) => ({
    event_type: r.event_type,
    actor: r.actor,
    target: r.target,
    timestamp_ms: r.timestamp_ms,
    metadata: r.metadata ?? {},
  }));

  const input: ReportInput = { transcripts, events, sessionStartAt, durationMs };

  const userTranscripts = transcripts
    .filter((m) => m.senderId === 'user')
    .map((m) => ({ content: m.content, timestampMs: Math.max(0, m.timestamp - sessionStartAt) }));

  let llm: LlmSemanticScores | undefined;
  if (userTranscripts.length > 0) {
    try {
      const full = await callDeepSeek(buildAnalysisPrompt(topic, userTranscripts), 0.3);
      const parsed = safeJsonParse<LlmSemanticScores & { evidence?: { content: string; timestamp_ms: number }[] }>(full);
      if (parsed) {
        llm = {
          structureScore: parsed.structureScore,
          responseQuality: parsed.responseQuality,
          stressResponseQuality: parsed.stressResponseQuality,
          conflictHandling: parsed.conflictHandling,
          supportOthers: parsed.supportOthers,
          coordinateOthers: parsed.coordinateOthers,
          extraEvidence: (parsed.evidence ?? []).map((e, i) => ({
            id: `ev_llm_${i + 1}`,
            modality: 'text' as const,
            timestamp_ms: e.timestamp_ms,
            content: e.content,
            dimension_hint: 'content' as const,
          })),
        };
      }
    } catch (err) {
      console.error('analyzeSession LLM 失败，退回规则引擎:', err);
    }
  }

  const report = buildRuleReport(input, llm);
  report.session_id = sessionId;

  let persisted = false;
  if (opts.persist !== false) {
    try {
      await pool.query(
        `INSERT INTO reports (session_id, overall_score, dimension_scores, evidence_pool, suggestions)
         VALUES ($1, $2, $3, $4, $5::jsonb)`,
        [
          sessionId,
          report.overall_score,
          JSON.stringify(report.dimensions),
          JSON.stringify([
            ...report.dimensions.content.evidence,
            ...report.dimensions.stress.evidence,
            ...report.dimensions.teamwork.evidence,
          ]),
          JSON.stringify(report.suggestions),
        ]
      );
      persisted = true;
    } catch (err) {
      console.error('reports 落库失败:', err);
    }
  }

  return { report, persisted };
}
