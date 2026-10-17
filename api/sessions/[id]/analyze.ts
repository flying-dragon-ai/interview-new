import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from '../../_lib/db.js';
import { analyzeSession } from '../../_lib/analyze.js';

/**
 * POST /api/sessions/{id}/analyze —— 触发面后分析（PRD E.2 / 7.6）
 * 幂等：重复触发重新分析并覆盖报告。
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
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
    const { report, persisted } = await analyzeSession(getPool(), sessionId);
    return response.status(200).json({ ...report, persisted });
  } catch (error: any) {
    console.error('/api/sessions/[id]/analyze error:', error);
    return response.status(500).json({ error: error.message });
  }
}
