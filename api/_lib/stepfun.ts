import crypto from 'crypto';

/**
 * StepFun 凭证签发（PRD 4.1.5 / G.4 / C9）
 * 所有 StepFun 连接凭证经服务端签发，前端永不持 key。
 *
 * 实现说明：
 * - 服务端持有 STEPFUN_API_KEY（env），按请求签发短时效 bearer token（HMAC 签名 + 过期时间）。
 * - 若 StepFun 官方要求直接使用 API Key 建连，可将本模块替换为「服务端代理转发」，
 *   前端接口不变（仍只拿短时凭证），C9（前端 0 key）不受影响。
 */

const TOKEN_TTL_SECONDS = 15 * 60; // 15 分钟短时凭证

export function isStepFunConfigured(): boolean {
  return Boolean(process.env.STEPFUN_API_KEY && process.env.STEPFUN_API_KEY.trim());
}

function sign(payload: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

export interface IssuedToken {
  token: string;
  expires_in: number;
  expires_at: number;
}

/** 签发短时凭证 */
export function issueToken(scope: string, extra: Record<string, string> = {}): IssuedToken {
  const secret = (process.env.STEPFUN_API_KEY || '').trim();
  if (!secret) throw new Error('STEPFUN_API_KEY 未配置（服务端环境变量）');
  const now = Math.floor(Date.now() / 1000);
  const body = Buffer.from(
    JSON.stringify({ scope, iat: now, exp: now + TOKEN_TTL_SECONDS, ...extra })
  ).toString('base64url');
  return {
    token: `${body}.${sign(body, secret)}`,
    expires_in: TOKEN_TTL_SECONDS,
    expires_at: now + TOKEN_TTL_SECONDS,
  };
}

/** 校验凭证（服务端代理场景使用） */
export function verifyToken(token: string): { valid: boolean; payload?: Record<string, unknown> } {
  const secret = (process.env.STEPFUN_API_KEY || '').trim();
  if (!secret || !token) return { valid: false };
  const [body, sig] = token.split('.');
  if (!body || !sig) return { valid: false };
  if (sign(body, secret) !== sig) return { valid: false };
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    if (typeof payload.exp === 'number' && payload.exp < Math.floor(Date.now() / 1000)) {
      return { valid: false };
    }
    return { valid: true, payload };
  } catch {
    return { valid: false };
  }
}

/** StepFun 接入规格（附录 G） */
export const STEPFUN_CONFIG = {
  tts: {
    endpoint: 'wss://api.stepfun.com/v1/realtime/audio',
    model: 'stepaudio-3-tts',
    /** 备选：step-tts-mini（首包 <200ms）、step-audio-2（首包 120ms） */
    fallbackModels: ['step-tts-mini', 'step-audio-2'],
  },
  asr: {
    endpoint: 'https://api.stepfun.com/v1/audio/asr/sse',
    model: 'stepaudio-3-asr-max',
  },
  realtime: {
    endpoint: 'wss://api.stepfun.com/v1/realtime',
    model: 'stepaudio-3-realtime-preview',
  },
} as const;
