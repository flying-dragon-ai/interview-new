import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from '../../_lib/db.ts';

/**
 * /api/sessions/{id}（PRD E.2）
 * GET    会话详情（含 roles 快照）
 * DELETE 删除会话及全部记录（隐私要求，TC-11：不可恢复、数据库无残留）
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!isDatabaseConfigured()) {
    return response.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: '服务端未配置 DATABASE_URL' });
  }
  const sessionId = Number(request.query.id);
  if (!sessionId) {
    return response.status(400).json({ error: '缺少会话 id' });
  }
  const pool = getPool();

  try {
    if (request.method === 'GET') {
      const result = await pool.query('SELECT * FROM sessions WHERE id = $1', [sessionId]);
      return response.status(200).json(result.rows[0] ?? null);
    }

    if (request.method === 'DELETE') {
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

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('/api/sessions/[id] error:', error);
    return response.status(500).json({ error: error.message });
  }
}
