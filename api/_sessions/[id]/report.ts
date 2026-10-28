import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from '../../_lib/db.ts';

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
      // 固定取最新一条（重跑分析会覆盖 reports 行，读取必须确定）
      .query('SELECT * FROM reports WHERE session_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1', [sessionId])
      .catch(() => getPool().query('SELECT * FROM feedback_reports WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [sessionId]));
    if (!result.rows[0]) return response.status(404).json({ error: '报告不存在' });
    return response.status(200).json(result.rows[0]);
  } catch (error: any) {
    console.error('/api/sessions/[id]/report error:', error);
    return response.status(500).json({ error: error.message });
  }
}
