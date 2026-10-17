import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from './_lib/db.ts';
import { resolveRoleCards } from '../engine/roleSelector.ts';
import { WALLET_ADDRESS_RE, normalizeWalletAddress } from './_lib/wallet.ts';

/**
 * 会话管理（PRD E.1 保留 + D.2 迁移）
 * POST /api/session   创建会话（roles JSONB / topic_type / voice|camera / started_at）
 * GET  /api/session   列表（可按 user_id 过滤，免登录期可空）
 * GET  /api/session?session_id=  详情
 * PUT  /api/session   更新状态（FINISHED 记 ended_at）
 * DELETE /api/session 删除会话及全部记录（隐私要求，TC-11）
 */

interface SessionBody {
  session_id?: number;
  company?: string;
  job_title?: string;
  topic?: string;
  topic_type?: string;
  roles?: string[];
  voice_enabled?: boolean;
  camera_enabled?: boolean;
  user_id?: number | null;
  /** Q-N1：Para 钱包地址（0x…42 字符），免登录用户标识 */
  wallet_address?: string | null;
  status?: string;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!isDatabaseConfigured()) {
    return response.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: '服务端未配置 DATABASE_URL' });
  }
  const pool = getPool();

  try {
    // ---- 列表 ----
    if (request.method === 'GET' && !request.query.session_id) {
      let query = 'SELECT * FROM sessions';
      const params: any[] = [];
      if (request.query.wallet_address) {
        const addr = String(request.query.wallet_address).toLowerCase();
        if (!WALLET_ADDRESS_RE.test(addr)) {
          return response.status(400).json({ error: 'wallet_address 格式非法（应为 0x + 40 位十六进制）' });
        }
        query += ' WHERE wallet_address = $1';
        params.push(addr);
      } else if (request.query.user_id) {
        query += ' WHERE user_id = $1';
        params.push(Number(request.query.user_id));
      }
      query += ' ORDER BY created_at DESC';
      const result = await pool.query(query, params);
      return response.status(200).json(result.rows);
    }
    // ---- 创建 ----
    if (request.method === 'POST') {
      const body = (request.body ?? {}) as SessionBody;
      const { company, job_title, topic } = body;
      if (!company || !job_title || !topic) {
        return response.status(400).json({ error: 'company / job_title / topic 必填' });
      }
      // Q-N1：钱包地址校验（非法格式直接 400，不入库）
      let walletAddress: string | null = null;
      if (body.wallet_address != null && body.wallet_address !== '') {
        walletAddress = normalizeWalletAddress(body.wallet_address);
        if (!walletAddress) {
          return response.status(400).json({ error: 'wallet_address 格式非法（应为 0x + 40 位十六进制）' });
        }
      }

      const roles = resolveRoleCards(Array.isArray(body.roles) ? body.roles : []);
      const topicType = body.topic_type || 'business_case';
      const voiceEnabled = Boolean(body.voice_enabled);
      const cameraEnabled = Boolean(body.camera_enabled);
      const userId = body.user_id ? Number(body.user_id) : null;

      const isSchemaMiss = (e: any) => /sessions|column|relation/i.test(String(e?.message ?? ''));
      const insertV071 = (withWallet: boolean) =>
        withWallet
          ? pool.query(
              `INSERT INTO sessions (company, job_title, topic, topic_type, roles, voice_enabled, camera_enabled, status, user_id, wallet_address, started_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'DISCUSSING', $8, $9, NOW()) RETURNING *`,
              [company, job_title, topic, topicType, JSON.stringify(roles), voiceEnabled, cameraEnabled, userId, walletAddress]
            )
          : pool.query(
              `INSERT INTO sessions (company, job_title, topic, topic_type, roles, voice_enabled, camera_enabled, status, user_id, started_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, 'DISCUSSING', $8, NOW()) RETURNING *`,
              [company, job_title, topic, topicType, JSON.stringify(roles), voiceEnabled, cameraEnabled, userId]
            );

      const insertLegacy = async () => {
        // 兼容：迁移尚未执行时退回旧 schema（simulation_sessions + ai_personas）
        const legacy = await pool.query(
          `INSERT INTO simulation_sessions (company, job_title, topic, status, user_id) VALUES ($1, $2, $3, 'DISCUSSING', $4) RETURNING *`,
          [company, job_title, topic, userId]
        );
        const row = legacy.rows[0];
        for (const card of roles) {
          await pool.query(
            `INSERT INTO ai_personas (session_id, character_id, name, role, personality, color) VALUES ($1, $2, $3, $4, $5, $6)`,
            [row.id, card.id, card.name, card.persona.conflict_level, card.persona.legacy_personality ?? card.persona.speaking_style, 'bg-slate-500']
          ).catch(() => undefined);
        }
        return row;
      };

      let session: any;
      try {
        // v0.7.1 schema（含 wallet_address，db/migration-v0.7.1-wallet.sql）
        session = (await insertV071(true)).rows[0];
      } catch (err1: any) {
        if (!isSchemaMiss(err1)) throw err1;
        if (!/wallet_address/i.test(String(err1?.message ?? ''))) {
          // 缺的是其他新列 → v0.7 之前的旧库，直接回退旧表
          session = await insertLegacy();
        } else {
          try {
            // 仅缺 wallet_address → v0.7 库未跑 v0.7.1 迁移，去掉钱包列重试
            session = (await insertV071(false)).rows[0];
          } catch (err2: any) {
            if (!isSchemaMiss(err2)) throw err2;
            session = await insertLegacy();
          }
        }
      }
      return response.status(200).json(session);
    }

    // ---- 更新状态 ----
    if (request.method === 'PUT') {
      const body = (request.body ?? {}) as SessionBody;
      if (!body.session_id || !body.status) {
        return response.status(400).json({ error: 'session_id 与 status 必填' });
      }
      const result = await pool.query(
        `UPDATE sessions SET status = $1, ended_at = CASE WHEN $1 = 'FINISHED' THEN NOW() ELSE ended_at END WHERE id = $2 RETURNING *`,
        [body.status, Number(body.session_id)]
      );
      return response.status(200).json(result.rows[0] ?? null);
    }

    // ---- 删除（隐私：会话及全部记录不可恢复，TC-11）----
    if (request.method === 'DELETE') {
      const body = (request.body ?? {}) as SessionBody;
      const sessionId = Number(body.session_id ?? request.query.session_id);
      if (!sessionId) {
        return response.status(400).json({ error: 'session_id 必填' });
      }
      await pool.query('DELETE FROM events WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await pool.query('DELETE FROM reports WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await pool.query('DELETE FROM visual_features WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await pool.query('DELETE FROM transcripts WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await pool.query('DELETE FROM conversation_records WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await pool.query('DELETE FROM ai_personas WHERE session_id = $1', [sessionId]).catch(() => undefined);
      await pool.query('DELETE FROM feedback_reports WHERE session_id = $1', [sessionId]).catch(() => undefined);
      const result = await pool.query('DELETE FROM sessions WHERE id = $1 RETURNING id', [sessionId]).catch(() => ({ rows: [] }));
      return response.status(200).json({ deleted: result.rows?.[0]?.id ?? sessionId });
    }

    // ---- 详情 ----
    if (request.method === 'GET' && request.query.session_id) {
      const result = await pool.query('SELECT * FROM sessions WHERE id = $1', [Number(request.query.session_id)]);
      return response.status(200).json(result.rows[0] ?? null);
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('/api/session error:', error);
    return response.status(500).json({ error: error.message });
  }
}
