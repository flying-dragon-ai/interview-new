import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { VisualFeatureRow } from '../../../types';
import { getPool, isDatabaseConfigured } from '../../_lib/db.ts';

/**
 * visual_features 表读写（PRD D.4：M6 视觉聚合特征，每秒一条）
 * POST /api/sessions/{id}/visual  { rows: VisualFeatureRow[] }  批量入库（单批 ≤ 60 行）
 *
 * 隐私（C3/C4）：payload 只含数值与情绪枚举，无任何图像数据；原始视频 0 字节上传。
 */

const EMOTIONS = new Set(['neutral', 'happy', 'nervous', 'serious']);
const MAX_ROWS = 60;

function clamp01(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function pose(value: unknown): { pitch: number; yaw: number; roll: number } {
  const p = (value ?? {}) as Record<string, unknown>;
  return { pitch: num(p.pitch), yaw: num(p.yaw), roll: num(p.roll) };
}

function toRow(sessionId: number, row: VisualFeatureRow): [number, number, number, string, string, number] {
  const emotion = EMOTIONS.has(row.emotion) ? row.emotion : 'neutral';
  return [
    sessionId,
    num(row.timestamp_ms),
    clamp01(row.eye_contact),
    emotion,
    JSON.stringify(pose(row.head_pose)),
    clamp01(row.engagement),
  ];
}

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
    if (request.method === 'POST') {
      const { rows } = (request.body ?? {}) as { rows?: VisualFeatureRow[] };
      if (!Array.isArray(rows) || rows.length === 0) {
        return response.status(400).json({ error: 'rows[] 必填' });
      }
      const batch = rows.slice(0, MAX_ROWS);
      const values = batch
        .map((_, i) => `($${i * 6 + 1}, $${i * 6 + 2}, $${i * 6 + 3}, $${i * 6 + 4}, $${i * 6 + 5}, $${i * 6 + 6})`)
        .join(', ');
      await pool.query(
        `INSERT INTO visual_features (session_id, timestamp_ms, eye_contact, emotion, head_pose, engagement) VALUES ${values}`,
        batch.flatMap((row) => toRow(sessionId, row))
      );
      return response.status(200).json({ inserted: batch.length });
    }

    if (request.method === 'GET') {
      const result = await pool.query(
        'SELECT timestamp_ms, eye_contact, emotion, head_pose, engagement FROM visual_features WHERE session_id = $1 ORDER BY timestamp_ms ASC',
        [sessionId]
      );
      return response.status(200).json(result.rows);
    }

    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('/api/sessions/[id]/visual error:', error);
    return response.status(500).json({ error: error.message });
  }
}
