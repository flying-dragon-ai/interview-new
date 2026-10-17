import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer, WebSocket } from 'ws';
import { sanitizeCloseFrame } from '../server/realtime-proxy.ts';

/**
 * fix bug 回归：realtime-proxy 上游异常断开（close code=1006 保留值）导致
 * dev server 崩溃（ws Sender.close TypeError 在事件回调里无人捕获）。
 * 1) 用真实 ws 复现崩溃场景；2) 验证 sanitizeCloseFrame 消毒；3) 静态接线护栏。
 */

const ROOT = process.cwd();
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

// ---------- 1) 真实复现：1006 是 ws 拒绝发送的保留码 ----------

test('复现崩溃根因：ws client.close(1006) 抛 TypeError（保留码不可发送）', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.once('listening', r));
  const port = (wss.address() as { port: number }).port;

  const closed = new Promise<number>((resolve) => {
    wss.on('connection', (ws) => ws.on('close', (code) => resolve(code)));
  });

  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise((r) => client.once('open', r));

  assert.throws(
    () => client.close(1006),
    /First argument must be a valid error code number/,
    'ws 应拒绝 1006（复现失败则说明根因判断有误）'
  );

  // 消毒后同场景不再抛，且服务端收到的是合法码
  const frame = sanitizeCloseFrame(1006, Buffer.from('abnormal'));
  assert.equal(frame.code, 1011);
  client.close(frame.code, frame.reason);
  const seen = await closed;
  assert.equal(seen, 1011);
  client.terminate();
  wss.close();
});

// ---------- 2) sanitizeCloseFrame 单元 ----------

test('sanitizeCloseFrame：合法码透传，非法/保留码映射 1011', () => {
  assert.equal(sanitizeCloseFrame(1000, undefined).code, 1000);
  assert.equal(sanitizeCloseFrame(1001, undefined).code, 1001);
  assert.equal(sanitizeCloseFrame(3000, undefined).code, 3000);
  assert.equal(sanitizeCloseFrame(4999, undefined).code, 4999);

  assert.equal(sanitizeCloseFrame(1006, undefined).code, 1011); // TLS 异常断开的实际值
  assert.equal(sanitizeCloseFrame(1005, undefined).code, 1011);
  assert.equal(sanitizeCloseFrame(1004, undefined).code, 1011);
  assert.equal(sanitizeCloseFrame(undefined, undefined).code, 1011);
  assert.equal(sanitizeCloseFrame(5000, undefined).code, 1011);
  assert.equal(sanitizeCloseFrame(999, undefined).code, 1011);
  assert.equal(sanitizeCloseFrame('1000' as unknown, undefined).code, 1011); // 字符串码
  assert.equal(sanitizeCloseFrame(1000.5, undefined).code, 1011); // 非整数
});

test('sanitizeCloseFrame：reason 仅接受 string/Buffer 且 ≤123 字节', () => {
  assert.equal(sanitizeCloseFrame(1000, 'bye').reason, 'bye');
  assert.ok(Buffer.isBuffer(sanitizeCloseFrame(1000, Buffer.from('x')).reason));
  assert.equal(sanitizeCloseFrame(1000, undefined).reason, undefined);
  assert.equal(sanitizeCloseFrame(1000, 42 as unknown).reason, undefined); // 非法类型
  assert.equal(sanitizeCloseFrame(1000, null as unknown).reason, undefined);
  assert.equal(sanitizeCloseFrame(1000, 'x'.repeat(124)).reason, undefined); // 超长
  assert.equal(sanitizeCloseFrame(1000, Buffer.alloc(124)).reason, undefined);
});

// ---------- 3) 静态接线护栏：不再裸转发 + 处理器全包裹 ----------

test('接线护栏：上游 close 经 sanitizeCloseFrame，handler 经 safeHandler', () => {
  const src = read('server/realtime-proxy.ts');
  // 旧 bug 形态：upstream.on('close', (code, reason) => client.close(code, reason));
  assert.ok(
    !/upstream\.on\(\s*'close',\s*\(code,\s*reason\)\s*=>\s*client\.close\(code,\s*reason\)/.test(src),
    '仍存在裸转发 close 帧的旧代码'
  );
  assert.ok(/sanitizeCloseFrame\(code,\s*reason\)/.test(src), 'close 未走消毒函数');
  // 所有事件注册都用 safeHandler 包裹（防爆：回调抛异常不再杀死进程）
  const registrations = [...src.matchAll(/(upstream|client)\.on\(/g)];
  const unwrapped = registrations.filter((m) => !src.slice(m.index!, m.index! + 120).includes('safeHandler('));
  assert.equal(
    unwrapped.length,
    0,
    `有 ${unwrapped.length} 个事件注册未用 safeHandler 包裹：${unwrapped.map((m) => src.slice(m.index, m.index! + 60)).join(' | ')}`
  );
  // 关键 close 分支带 readyState 守卫
  assert.ok(/client\.readyState !== client\.OPEN && client\.readyState !== client\.CLOSING/.test(src), 'close 转发缺 readyState 守卫');
});
