import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from './_lib/db.ts';
import type { ReportV15 } from '../types';

/**
 * 报告落库（PRD D.2：feedback_reports → reports）
 * 新增 JSONB：dimension_scores / evidence_pool / suggestions；旧 4 字段保留冗余展示。
 */

interface FeedbackBody {
  session_id: number;
  overall_score?: number;
  dimension_scores?: unknown;
  evidence_pool?: unknown;
  suggestions?: unknown;
  // 旧 4 字段（冗余展示）
  timing?: string;
  voice_share?: number;
  structural_contribution?: string;
  interruption_handling?: string;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!isDatabaseConfigured()) {
    return response.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: '服务端未配置 DATABASE_URL' });
  }
  const pool = getPool();

  try {
    if (request.method === 'POST') {
      const body = (request.body ?? {}) as FeedbackBody;
      if (!body.session_id) {
        return response.status(400).json({ error: 'session_id 必填' });
      }
      const suggestionsJson = JSON.stringify(body.suggestions ?? []);
      let row: any;
      try {
        const result = await pool.query(
          `INSERT INTO reports (session_id, overall_score, dimension_scores, evidence_pool, suggestions, timing, voice_share, structural_contribution, interruption_handling)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9) RETURNING *`,
          [
            Number(body.session_id),
            body.overall_score ?? null,
            JSON.stringify(body.dimension_scores ?? {}),
            JSON.stringify(body.evidence_pool ?? []),
            suggestionsJson,
            body.timing ?? null,
            body.voice_share ?? null,
            body.structural_contribution ?? null,
            body.interruption_handling ?? null,
          ]
        );
        row = result.rows[0];
      } catch (migrationErr: any) {
        if (!/reports|column|relation/i.test(String(migrationErr?.message ?? ''))) throw migrationErr;
        const legacy = await pool.query(
          `INSERT INTO feedback_reports (session_id, timing, voice_share, structural_contribution, interruption_handling, overall_score, suggestions)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
          [
            Number(body.session_id),
            body.timing ?? '',
            body.voice_share ?? 0,
            body.structural_contribution ?? '',
            body.interruption_handling ?? '',
            body.overall_score ?? 0,
            suggestionsJson,
          ]
        );
        row = legacy.rows[0];
      }
      return response.status(200).json(row);
    }

    if (request.method === 'GET' && request.query.session_id) {
      const result = await pool
        .query('SELECT * FROM reports WHERE session_id = $1', [Number(request.query.session_id)])
        .catch(() => pool.query('SELECT * FROM feedback_reports WHERE session_id = $1', [Number(request.query.session_id)]));
      return response.status(200).json(result.rows[0] ?? null);
    }

    if (request.method === 'GET') {
      const result = await pool.query('SELECT * FROM reports ORDER BY created_at DESC').catch(() =>
        pool.query('SELECT * FROM feedback_reports ORDER BY created_at DESC')
      );
      return response.status(200).json(result.rows);
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('/api/feedback error:', error);
    return response.status(500).json({ error: error.message });
  }
}
