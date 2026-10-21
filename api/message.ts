import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPool, isDatabaseConfigured } from './_lib/db.ts';
import { insertWithFallback, selectAdaptive } from './_lib/schema.ts';

/**
 * 消息落库（PRD D.2：conversation_records → transcripts）
 * 新增字段：speaker（'user' 或角色卡 id）、start_ms、end_ms、confidence、stepfun_segment_id
 */

interface MessageBody {
  session_id: number;
  speaker?: string;
  speaker_type?: 'user' | 'ai';
  speaker_id?: string;
  speaker_name: string;
  message: string;
  round?: number;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
  stepfun_segment_id?: string | null;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (!isDatabaseConfigured()) {
    return response.status(503).json({ error: 'DATABASE_NOT_CONFIGURED', message: '服务端未配置 DATABASE_URL' });
  }
  const pool = getPool();

  try {
    if (request.method === 'POST') {
      const body = (request.body ?? {}) as MessageBody;
      if (!body.session_id || !body.message) {
        return response.status(400).json({ error: 'session_id 与 message 必填' });
      }
      const speakerType = body.speaker_type ?? (body.speaker === 'user' ? 'user' : 'ai');
      const speaker = body.speaker ?? (speakerType === 'user' ? 'user' : body.speaker_id ?? '');

      const row = await insertWithFallback(
        async () =>
          (
            await pool.query(
              `INSERT INTO transcripts (session_id, speaker, speaker_type, speaker_id, speaker_name, message, round, start_ms, end_ms, confidence, stepfun_segment_id)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
              [
                Number(body.session_id),
                speaker,
                speakerType,
                body.speaker_id ?? (speakerType === 'user' ? 'user' : speaker),
                body.speaker_name,
                body.message,
                body.round || 1,
                typeof body.start_ms === 'number' ? body.start_ms : null,
                typeof body.end_ms === 'number' ? body.end_ms : null,
                typeof body.confidence === 'number' ? body.confidence : null,
                body.stepfun_segment_id ?? null,
              ]
            )
          ).rows[0],
        async () =>
          (
            await pool.query(
              `INSERT INTO conversation_records (session_id, speaker_type, speaker_id, speaker_name, message, round) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
              [Number(body.session_id), speakerType, body.speaker_id ?? speaker, body.speaker_name, body.message, body.round || 1]
            )
          ).rows[0],
        ['transcripts']
      );
      return response.status(200).json(row);
    }

    if (request.method === 'GET' && request.query.session_id) {
      return response.status(
        200
      ).json(
        await selectAdaptive(pool, ['transcripts', 'conversation_records'], (table) => ({
          text: `SELECT * FROM ${table} WHERE session_id = $1 ORDER BY created_at ASC`,
          values: [Number(request.query.session_id)],
        }))
      );
    }

    // 隐私门禁：拒绝无条件全表 dump（转写属用户数据）
    if (request.method === 'GET') {
      return response.status(400).json({ error: '必须提供 session_id' });
    }
    return response.status(405).json({ error: 'Method not allowed' });
  } catch (error: any) {
    console.error('/api/message error:', error);
    return response.status(500).json({ error: error.message });
  }
}
