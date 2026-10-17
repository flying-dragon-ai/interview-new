import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from '../../_lib/db.js';

/**
 * GET /api/sessions/{id}/report —— 获取报告（v1.5，PRD E.2 / E.5）
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  if (!isDatabaseConfigured()) {
    return response.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: '服务端未配置 DATABASE_URL' });
  }
  const sessionId = Number(request.query.id);
  if (!sessionId) {
    return response.status(400).json({ error: '缺少会话 id' });
  }
  try {
    const result = await getPool()
      .query('SELECT * FROM reports WHERE session_id = $1', [sessionId])
      .catch(() => getPool().query('SELECT * FROM feedback_reports WHERE session_id = $1', [sessionId]));
    return response.status(200).json(result.rows[0] ?? null);
  } catch (error: any) {
    console.error('/api/sessions/[id]/report error:', error);
    return response.status(500).json({ error: error.message });
  }
}
