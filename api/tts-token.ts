import type { VercelRequest, VercelResponse } from '@vercel/node';
import { issueToken, isStepFunConfigured, STEPFUN_CONFIG } from './_lib/stepfun.js';

/**
 * POST /api/tts-token —— 签发 StepFun TTS 连接凭证（PRD E.2 / G.4）
 * 前端不持 key（C9）；凭证 15 分钟短效。
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') {
    return response.status(405).json({ error: 'Method not allowed' });
  }
  if (!isStepFunConfigured()) {
    // 未配置时不阻断：前端据此降级到 Web Speech / 文字播报
    return response.status(503).json({
      error: 'STEPFUN_NOT_CONFIGURED',
      message: '服务端未配置 STEPFUN_API_KEY，语音合成不可用，将降级为文字/浏览器语音',
      fallback: 'webspeech',
    });
  }
  const voiceId = typeof request.body?.voice_id === 'string' ? request.body.voice_id : undefined;
  const issued = issueToken('tts', voiceId ? { voice_id: voiceId } : {});
  return response.status(200).json({
    ...issued,
    endpoint: STEPFUN_CONFIG.tts.endpoint,
    model: STEPFUN_CONFIG.tts.model,
    fallback_models: [...STEPFUN_CONFIG.tts.fallbackModels],
    voice_id: voiceId ?? null,
  });
}
