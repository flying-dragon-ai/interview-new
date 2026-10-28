import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from '../../_lib/db.ts';
import { deleteSessionCascade } from '../../_lib/schema.ts';

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
      // 资源不存在 → 404（200 + null 无法区分「不存在」与「存在但字段为空」）
      if (!result.rows[0]) return response.status(404).json({ error: '会话不存在' });
      return response.status(200).json(result.rows[0]);
    }

    if (request.method === 'DELETE') {
      // 事务化级联删除（隐私 TC-11：不可恢复、不留半删状态）
      await deleteSessionCascade(pool, sessionId);
      return response.status(200).json({ deleted: sessionId });
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('/api/sessions/[id] error:', error);
    return response.status(500).json({ error: error.message });
  }
}
