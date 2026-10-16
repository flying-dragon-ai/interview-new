import type { VercelRequest, VercelResponse } from '@vercel/node';
import { AVATAR_PRESETS } from '../data/avatars.ts';

/**
 * GET /api/avatars/presets —— 预设形象列表（PRD E.2 / 4.1.8）
 * DELETE /api/avatars?id= —— 删除已上传形象（不可恢复，C10；预设不可删）
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method === 'GET') {
    return response.status(200).json({
      presets: AVATAR_PRESETS,
      count: AVATAR_PRESETS.length,
      industries: [...new Set(AVATAR_PRESETS.map((a) => a.industry))],
    });
  }

  if (request.method === 'DELETE') {
    const id = String(request.query.id ?? '');
    if (!id) return response.status(400).json({ error: '缺少 id' });
    // 预设形象不可删除（P1 上传形象走 avatars 表，删除后不可恢复）
    if (AVATAR_PRESETS.some((a) => a.id === id)) {
      return response.status(403).json({ error: '预设形象不可删除' });
    }
    // 数据库删除（P1 上传形象）：未配置数据库时仅返回成功语义
    try {
      const { getPool, isDatabaseConfigured } = await import('./_lib/db');
      if (isDatabaseConfigured()) {
        await getPool().query('DELETE FROM avatars WHERE id = $1', [id]);
      }
    } catch (err) {
      console.error('/api/avatars delete error:', err);
    }
    return response.status(200).json({ deleted: id });
  }

  return response.status(405).json({ error: 'Method not allowed' });
}
