import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from './_lib/db.js';
import type { ReportV15 } from '../types';

/**
 * 报告落库（PRD D.2：feedback_reports → reports）
 * 新增 JSONB：dimension_scores / evidence_pool / suggestions；旧 4 字段保留冗余展示。
 */

interface FeedbackBody {
  action?: 'record_onchain_assessment';
  session_id?: number | null;
  overall_score?: number;
  performance_rank?: string;
  simulated_rank?: string;
  performance_level?: string;
  dimension_scores?: unknown;
  evidence_pool?: unknown;
  suggestions?: unknown;
  // 旧 4 字段（冗余展示）
  timing?: string;
  voice_share?: number;
  structural_contribution?: string;
  interruption_handling?: string;
  wallet_address?: string;
  session_hash?: string;
  score_hash?: string;
  skill_hashes?: unknown;
  chain_id?: number;
  contract_address?: string;
  tx_hash?: string;
  token_id?: string | null;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!isDatabaseConfigured()) {
    return response.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: '服务端未配置 DATABASE_URL' });
  }
  const pool = getPool();

  try {
    if (request.method === 'POST') {
      const body = (request.body ?? {}) as FeedbackBody;
      if (body.action === 'record_onchain_assessment') {
        const isAddress = (value?: string) => typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value);
        const isHash = (value?: string) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value);
        const skills = body.skill_hashes;
        const tokenId = body.token_id ?? null;
        const sessionId = body.session_id ?? null;
        if (
          (sessionId !== null && (!Number.isInteger(sessionId) || sessionId <= 0))
          || !isAddress(body.wallet_address)
          || !isHash(body.session_hash)
          || !isHash(body.score_hash)
          || !isHash(body.tx_hash)
          || !isAddress(body.contract_address)
          || !Number.isInteger(body.overall_score) || (body.overall_score ?? -1) < 0 || (body.overall_score ?? 101) > 100
          || body.chain_id !== 10143
          || !Array.isArray(skills) || skills.length < 1 || skills.length > 12 || !skills.every((value) => isHash(String(value)))
          || (tokenId !== null && !/^\d{1,78}$/.test(tokenId))
        ) {
          return response.status(400).json({ error: '链上评估记录字段无效' });
        }
        const result = await pool.query(
          `INSERT INTO onchain_assessments (session_id, wallet_address, session_hash, score_hash, overall_score, skill_hashes, chain_id, contract_address, tx_hash, token_id, status)
           VALUES ($1, LOWER($2), LOWER($3), LOWER($4), $5, $6::jsonb, $7, LOWER($8), LOWER($9), $10, 'CONFIRMED')
           ON CONFLICT (chain_id, contract_address, tx_hash) DO UPDATE SET token_id = COALESCE(EXCLUDED.token_id, onchain_assessments.token_id)
           RETURNING id, status`,
          [sessionId, body.wallet_address, body.session_hash, body.score_hash, body.overall_score, JSON.stringify(skills), body.chain_id, body.contract_address, body.tx_hash, tokenId]
        );
        return response.status(200).json({ persisted: true, record: result.rows[0] ?? null });
      }
      if (!body.session_id) {
        return response.status(400).json({ error: 'session_id 必填' });
      }
      const suggestionsJson = JSON.stringify(body.suggestions ?? []);
      let row: any;
      try {
        const result = await pool.query(
          `INSERT INTO reports (session_id, overall_score, performance_rank, simulated_rank, performance_level, dimension_scores, evidence_pool, suggestions, timing, voice_share, structural_contribution, interruption_handling)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12) RETURNING *`,
          [
            Number(body.session_id),
            body.overall_score ?? null,
            body.performance_rank ?? null,
            body.simulated_rank ?? null,
            body.performance_level ?? null,
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
