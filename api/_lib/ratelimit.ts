/**
 * /api/llm 速率限制与防滥用（PRD 4.1.1 / Q-N2 / 第 9 章风险）
 * 免登录公开部署下的防护：
 *  1. 单 IP 令牌桶限流（窗口内请求数）
 *  2. 单会话（session_id）LLM 调用次数上限（单场时间盒天然约束，双保险）
 *  3. 全局限速（防单实例被打爆）
 * serverless 实例 ephemeral，内存态为 best-effort；生产建议外挂 Redis（文档已注明）。
 */

interface Bucket {
  count: number;
  resetAt: number;
}

const IP_WINDOW_MS = 60 * 1000; // 1 分钟窗口
const IP_MAX_REQUESTS = 60; // 单 IP 每分钟最多 60 次 /api/llm 调用
const GLOBAL_MAX_REQUESTS = 600; // 单实例每分钟总上限
const SESSION_MAX_LLM_CALLS = 400; // 单场 LLM 调用上限（25 分钟场双保险）

const ipBuckets = new Map<string, Bucket>();
let globalBucket: Bucket = { count: 0, resetAt: Date.now() + IP_WINDOW_MS };
const sessionCounts = new Map<string, { count: number; resetAt: number }>();

function take(bucket: Bucket, max: number, now: number): boolean {
  if (now >= bucket.resetAt) {
    bucket.count = 0;
    bucket.resetAt = now + IP_WINDOW_MS;
  }
  if (bucket.count >= max) return false;
  bucket.count += 1;
  return true;
}

export interface RateLimitResult {
  allowed: boolean;
  reason?: string;
  retryAfterMs?: number;
}

export function checkRateLimit(ip: string | undefined, sessionId?: string | number | null, now: number = Date.now()): RateLimitResult {
  const key = ip || 'anonymous';

  let ipBucket = ipBuckets.get(key);
  if (!ipBucket) {
    ipBucket = { count: 0, resetAt: now + IP_WINDOW_MS };
    ipBuckets.set(key, ipBucket);
  }
  if (!take(ipBucket, IP_MAX_REQUESTS, now)) {
    return { allowed: false, reason: 'ip_rate_limited', retryAfterMs: ipBucket.resetAt - now };
  }

  if (!take(globalBucket, GLOBAL_MAX_REQUESTS, now)) {
    return { allowed: false, reason: 'global_rate_limited', retryAfterMs: globalBucket.resetAt - now };
  }

  if (sessionId !== undefined && sessionId !== null) {
    const skey = String(sessionId);
    let s = sessionCounts.get(skey);
    if (!s) {
      s = { count: 0, resetAt: now + 30 * 60 * 1000 };
      sessionCounts.set(skey, s);
    }
    if (now >= s.resetAt) {
      s.count = 0;
      s.resetAt = now + 30 * 60 * 1000;
    }
    if (s.count >= SESSION_MAX_LLM_CALLS) {
      return { allowed: false, reason: 'session_limit', retryAfterMs: s.resetAt - now };
    }
    s.count += 1;
  }

  // 定向淘汰过期桶（不做全量 clear——那会重置所有攻击者的窗口，反而利好攻击）
  evictExpired(ipBuckets, now, 5000);
  evictExpired(sessionCounts, now, 5000);
  return { allowed: true };
}

/** 超过 max 时淘汰已过期条目；仍超额则按 resetAt 淘汰最旧的（防内存膨胀） */
function evictExpired(map: Map<string, { count: number; resetAt: number }>, now: number, max: number): void {
  if (map.size <= max) return;
  for (const [k, v] of map) {
    if (v.resetAt <= now) map.delete(k);
  }
  if (map.size <= max) return;
  const entries = [...map.entries()].sort((a, b) => a[1].resetAt - b[1].resetAt);
  for (let i = 0; i < map.size - max; i++) map.delete(entries[i][0]);
}

export function getRateLimitConfig() {
  return { IP_WINDOW_MS, IP_MAX_REQUESTS, GLOBAL_MAX_REQUESTS, SESSION_MAX_LLM_CALLS };
}
