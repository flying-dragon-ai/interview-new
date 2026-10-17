import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from '../../_lib/db.js';

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!isDatabaseConfigured()) return response.status(200).json({ session: null, messages: [], events: [], report: null });
  const id = Number(request.query.id);
  if (!id) return response.status(400).json({ error: 'practice_id_required' });
  try {
    const pool = getPool();
    const session = await pool.query('SELECT * FROM sessions WHERE id = $1', [id]);
    const messages = await pool.query('SELECT * FROM transcripts WHERE session_id = $1 ORDER BY created_at ASC', [id]).catch(() => ({ rows: [] }));
    const events = await pool.query('SELECT * FROM events WHERE session_id = $1 ORDER BY timestamp_ms ASC', [id]).catch(() => ({ rows: [] }));
    const report = await pool.query('SELECT * FROM reports WHERE session_id = $1 ORDER BY created_at DESC LIMIT 1', [id]).catch(() => ({ rows: [] }));
    return response.status(200).json({ session: session.rows[0] ?? null, messages: messages.rows, events: events.rows, report: report.rows[0] ?? null });
  } catch (error: any) {
    return response.status(500).json({ error: error.message });
  }
}
