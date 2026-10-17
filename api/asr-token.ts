import type { VercelRequest, VercelResponse } from '@vercel/node';
import { issueToken, isStepFunConfigured, STEPFUN_CONFIG } from './_lib/stepfun.js';

/**
 * POST /api/asr-token —— 签发 StepFun ASR 连接凭证（PRD E.2 / G.4）
 * 前端不持 key（C9）；凭证 15 分钟短效。
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  if (!isStepFunConfigured()) {
    // 未配置时不阻断：前端据此降级到 Web Speech / 手动输入
    return response.status(503).json({
      error: 'STEPFUN_NOT_CONFIGURED',
      message: '服务端未配置 STEPFUN_API_KEY，语音识别不可用，将降级为浏览器语音/手动输入',
      fallback: 'webspeech',
    });
  }
  const issued = issueToken('asr');
  return response.status(200).json({
    ...issued,
    endpoint: STEPFUN_CONFIG.asr.endpoint,
    model: STEPFUN_CONFIG.asr.model,
  });
}
