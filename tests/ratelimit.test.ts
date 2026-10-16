import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkRateLimit, getRateLimitConfig } from '../api/_lib/ratelimit.ts';

test('Q-N2: 限流配置存在（IP 窗口 / 全局限 / 单场限）', () => {
  const cfg = getRateLimitConfig();
  assert.ok(cfg.IP_MAX_REQUESTS > 0);
  assert.ok(cfg.GLOBAL_MAX_REQUESTS >= cfg.IP_MAX_REQUESTS);
  assert.ok(cfg.SESSION_MAX_LLM_CALLS > 0);
});

test('Q-N2: 单 IP 超频被限流', () => {
  const cfg = getRateLimitConfig();
  const now = 1_000_000;
  let last: ReturnType<typeof checkRateLimit> = { allowed: true };
  for (let i = 0; i < cfg.IP_MAX_REQUESTS; i++) {
    last = checkRateLimit('1.2.3.4', null, now);
  }
  assert.equal(last.allowed, true);
  const over = checkRateLimit('1.2.3.4', null, now);
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'ip_rate_limited');
  assert.ok((over.retryAfterMs ?? 0) > 0);
});

test('Q-N2: 窗口过后恢复', () => {
  const cfg = getRateLimitConfig();
  const now = 2_000_000;
  for (let i = 0; i < cfg.IP_MAX_REQUESTS; i++) checkRateLimit('5.6.7.8', null, now);
  assert.equal(checkRateLimit('5.6.7.8', null, now).allowed, false);
  assert.equal(checkRateLimit('5.6.7.8', null, now + cfg.IP_WINDOW_MS + 1).allowed, true);
});

test('Q-N2: 单会话 LLM 调用上限', () => {
  const cfg = getRateLimitConfig();
  const now = 3_000_000;
  let last: ReturnType<typeof checkRateLimit> = { allowed: true };
  for (let i = 0; i < cfg.SESSION_MAX_LLM_CALLS; i++) {
    last = checkRateLimit(`9.9.9.${i % 250}`, 777, now); // 不同 IP，仅压会话上限
  }
  assert.equal(last.allowed, true);
  const over = checkRateLimit('9.9.9.1', 777, now);
  assert.equal(over.allowed, false);
  assert.equal(over.reason, 'session_limit');
});

test('Q-N2: 无 IP 时按 anonymous 限流', () => {
  const cfg = getRateLimitConfig();
  const now = 4_000_000;
  for (let i = 0; i < cfg.IP_MAX_REQUESTS; i++) checkRateLimit(undefined, null, now);
  assert.equal(checkRateLimit(undefined, null, now).allowed, false);
});
