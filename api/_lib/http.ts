import type { VercelRequest } from '@vercel/node';

/** 客户端 IP（限流用）：x-forwarded-for 首段 → socket 地址 */
export function getClientIp(req: VercelRequest): string | undefined {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string') return fwd.split(',')[0].trim();
  if (Array.isArray(fwd)) return fwd[0];
  return req.socket?.remoteAddress;
}
