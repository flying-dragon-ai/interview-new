import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { GameEvent } from '../types';
import { getPool, isDatabaseConfigured } from './_lib/db.js';

/**
 * events 表读写（PRD 4.1.4：发言权调度事件日志入库，供面后分析）
 * POST /api/events  { session_id, events: GameEvent[] }  批量入库
 * GET  /api/events?session_id=                           查询
 */

const VALID_TYPES = new Set(['stage_change', 'stage_start', 'stage_end', 'speaker_start', 'speaker_end', 'interrupt', 'yield', 'speak_grant', 'interviewer_prompt', 'user_called', 'report_start', 'report_ready']);

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!isDatabaseConfigured()) {
    return response.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: '服务端未配置 DATABASE_URL' });
  }
  const pool = getPool();

  try {
    if (request.method === 'POST') {
      const { session_id, events } = request.body as { session_id?: number; events?: GameEvent[] };
      if (!session_id || !Array.isArray(events) || events.length === 0) {
        return response.status(400).json({ error: 'session_id 与 events[] 必填' });
      }
      const rows = events
        .filter((e) => VALID_TYPES.has(e.event_type))
        .map((e) => [
          Number(session_id),
          e.event_type,
          String(e.actor ?? ''),
          String(e.target ?? ''),
          Number(e.timestamp_ms) || 0,
          JSON.stringify(e.metadata ?? {}),
        ]);
      if (rows.length === 0) {
        return response.status(200).json({ inserted: 0 });
      }
      const values = rows.map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`).join(', ');
      await pool.query(
        `INSERT INTO events (session_id, event_type, actor, target, timestamp_ms, metadata) VALUES ${values}`,
        rows.flat()
      );
      return response.status(200).json({ inserted: rows.length });
    }

    if (request.method === 'GET' && request.query.session_id) {
      const result = await pool.query(
        'SELECT * FROM events WHERE session_id = $1 ORDER BY timestamp_ms ASC',
        [Number(request.query.session_id)]
      );
      return response.status(200).json(result.rows);
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('/api/events error:', error);
    return response.status(500).json({ error: error.message });
  }
}
