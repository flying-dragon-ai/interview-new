import type { VercelRequest, VercelResponse } from '@vercel/node';
import { issueToken, isStepFunConfigured, STEPFUN_CONFIG } from './_lib/stepfun.ts';

/**
 * POST /api/realtime-token —— 签发 StepFun Realtime 连接凭证（M7 P2-1）
 * 前端不持 key（C9）；凭证 15 分钟短效。
 * 未配置 STEPFUN_API_KEY 时返回 503 + fallback: 'push-to-talk'，前端退回按键说话链路（不许白屏）。
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  if (!isStepFunConfigured()) {
    // 未配置时不阻断：前端据此降级到按键说话 / 手动输入
    return response.status(503).json({
      error: 'STEPFUN_NOT_CONFIGURED',
      message: '服务端未配置 STEPFUN_API_KEY，实时语音不可用，将降级为按键说话/手动输入',
      fallback: 'push-to-talk',
    });
  }
  const issued = issueToken('realtime');
  return response.status(200).json({
    ...issued,
    endpoint: STEPFUN_CONFIG.realtime.endpoint,
    model: STEPFUN_CONFIG.realtime.model,
  });
}
