import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from './_lib/db.ts';
import { insertSessionAdaptive, deleteSessionCascade } from './_lib/schema.ts';
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
  /** v0.8：群面阵型 lgd | panel（缺列旧库自动降级不入库） */
  format?: string;
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
      } else {
        // 隐私门禁：拒绝无条件全表列举（匿名访客不可见他人会话）
        return response.status(400).json({ error: '必须提供 wallet_address 或 user_id 过滤条件' });
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

      // v0.8 → v0.7.1 → v0.7 → legacy 自适应插入（schema.ts 统一收口）
      const session = await insertSessionAdaptive(pool, {
        company,
        job_title,
        topic,
        topicType,
        roles,
        voiceEnabled,
        cameraEnabled,
        userId,
        walletAddress,
        format: body.format === 'panel' ? 'panel' : 'lgd',
      });
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
      // 事务化级联删除（隐私 TC-11：不可恢复、不留半删状态）
      await deleteSessionCascade(pool, sessionId);
      return response.status(200).json({ deleted: sessionId });
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
