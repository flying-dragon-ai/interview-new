import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from './_lib/db.js';

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  if (!isDatabaseConfigured()) return response.status(200).json([]);
  try {
    const pool = getPool();
    const result = await pool.query('SELECT id, company, job_title, topic, topic_type, status, created_at, started_at, ended_at FROM sessions ORDER BY created_at DESC LIMIT 50');
    return response.status(200).json(result.rows);
  } catch (error: any) {
    return response.status(500).json({ error: error.message });
  }
}
