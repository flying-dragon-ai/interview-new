import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, WebSocket as UpstreamWebSocket } from 'ws';
import { verifyToken, STEPFUN_CONFIG } from '../api/_lib/stepfun.ts';

/**
 * StepFun Realtime 服务端 WS 代理（M7 P2-2 / docs/stepfun-realtime-notes.md §1）
 * - 浏览器 WebSocket 无法设置 Authorization 头，上游又要求原始 key → 必须服务端代理
 * - 前端连同源 /api/realtime?token=<短时凭证>；本代理验证凭证后持 key 连上游并双向透传帧
 * - 纯传输层：不解析、不修改任何事件（StepFun 专有事件名只允许出现在 services/realtimeClient.ts）
 * - 挂载方：vite dev（server/local-api.ts）；CN 独立 node 部署可复用本模块
 */

/** ws 合法可发送的关闭码（1005/1006 是协议保留值，发送即 TypeError，见 ws/lib/sender.js） */
function isValidCloseCode(code: unknown): code is number {
  return (
    typeof code === 'number' &&
    Number.isInteger(code) &&
    ((code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) ||
      (code >= 3000 && code <= 4999))
  );
}

/**
 * 消毒上游 close 帧再转发给客户端。
 * 背景（fix bug）：上游 TLS 异常断开时 ws 的 'close' 事件 code=1006（保留值），
 * 原样 client.close(1006) 触发 ws TypeError 且无人捕获 → 整个 dev server 退出。
 * 非法 code 一律映射 1011（上游异常）；reason 非 Buffer/字符串或超 123 字节则丢弃。
 */
export function sanitizeCloseFrame(
  code: unknown,
  reason: unknown
): { code: number | undefined; reason: Buffer | string | undefined } {
  const safeCode = isValidCloseCode(code) ? code : 1011;
  if (typeof reason === 'string') {
    return { code: safeCode, reason: Buffer.byteLength(reason) <= 123 ? reason : undefined };
  }
  if (Buffer.isBuffer(reason)) {
    return { code: safeCode, reason: reason.length <= 123 ? reason : undefined };
  }
  return { code: safeCode, reason: undefined };
}

/** 事件处理器防爆：WS 回调里抛异常会无人捕获直接杀死进程（fix bug 回归护栏） */
function safeHandler(fn: (...args: any[]) => void): (...args: any[]) => void {
  return (...args: any[]) => {
    try {
      fn(...args);
    } catch (err) {
      console.error('[realtime-proxy] handler error:', err);
    }
  };
}

const wss = new WebSocketServer({ noServer: true });

type PendingFrame = { data: Buffer | ArrayBuffer | Buffer[] | string; binary: boolean };

/**
 * 浏览器文本帧到达 `ws` 时 data 往往已是 Buffer，但 isBinary=false。
 * 若按 Buffer 默认当二进制转发，上游会丢掉 JSON 事件（session.update 永远没有 session.updated）。
 * 必须带上原始帧类型；上游还没 open 时先排队，open 时按原类型冲刷。
 */
function forwardFrame(
  upstream: UpstreamWebSocket,
  pending: PendingFrame[],
  data: PendingFrame['data'],
  binary: boolean
): void {
  if (upstream.readyState === UpstreamWebSocket.OPEN) upstream.send(data, { binary });
  else pending.push({ data, binary });
}

function flushPending(upstream: UpstreamWebSocket, pending: PendingFrame[]): void {
  while (pending.length > 0) {
    const frame = pending.shift()!;
    upstream.send(frame.data, { binary: frame.binary });
  }
}

export function handleRealtimeUpgrade(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options?: { endpoint?: string }
): void {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const token = url.searchParams.get('token') ?? '';

  const apiKey = (process.env.STEPFUN_API_KEY || '').trim();
  if (!apiKey) {
    socket.write('HTTP/1.1 503 Service Unavailable\r\n\r\n');
    socket.destroy();
    return;
  }
  // 短时凭证校验（HMAC + 过期；与 /api/realtime-token 签发对应）
  const check = verifyToken(token);
  if (!check.valid) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    socket.destroy();
    return;
  }

  const endpoint =
    options?.endpoint ??
    STEPFUN_CONFIG.realtime.endpoint + `?model=${STEPFUN_CONFIG.realtime.model}`;
  const upstream = new UpstreamWebSocket(endpoint, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  let upgraded = false;
  const abortUpstream = () => {
    try {
      upstream.close();
    } catch {
      // 忽略
    }
  };
  // 客户端升级失败时 handleUpgrade 的回调不会执行 → 上游连接没人关闭。
  // 每漏一个就永久占用上游并发槽（StepFun 上限 5：1 耳 + 4 嘴），漏几次整场退回按键说话。
  socket.once('close', () => {
    if (!upgraded) abortUpstream();
  });
  wss.handleUpgrade(req, socket, head, (client) => {
    upgraded = true;
    const pending: PendingFrame[] = [];
    // 上游 → 客户端（保留文本/二进制）
    upstream.on(
      'message',
      safeHandler((data: Buffer | ArrayBuffer | Buffer[], isBinary: boolean) => {
        if (client.readyState === client.OPEN) client.send(data as any, { binary: isBinary });
      })
    );
    // fix bug：上游 close 的 code 可能是 1006 等保留值，原样转发会抛 TypeError 杀死进程；
    // 先经 sanitizeCloseFrame 消毒，且处理器包 safeHandler 防爆
    upstream.on(
      'close',
      safeHandler((code: unknown, reason: unknown) => {
        if (client.readyState !== client.OPEN && client.readyState !== client.CLOSING) return;
        const frame = sanitizeCloseFrame(code, reason);
        client.close(frame.code, frame.reason);
      })
    );
    // ws 在有 unexpected-response 监听器时不会再 emit error（见 ws/lib/websocket.js）。
    // 第 6 条并发被拒时上游直接回 HTTP 429，必须在这里关掉浏览器侧，否则连接会挂住。
    // 只写入状态码，不读 body，避免把密钥带出来。
    upstream.on(
      'unexpected-response',
      safeHandler((_req: IncomingMessage, res: IncomingMessage & { resume?: () => void }) => {
        const status = typeof res.statusCode === 'number' ? res.statusCode : undefined;
        if (status) console.warn(`[realtime-proxy] upstream handshake HTTP ${status}`);
        res.resume?.();
        try {
          upstream.terminate();
        } catch {
          // 忽略
        }
        if (client.readyState === client.OPEN) {
          client.close(1011, status ? `upstream http ${status}` : 'upstream error');
        }
      })
    );
    upstream.on(
      'error',
      safeHandler(() => {
        if (client.readyState === client.OPEN) client.close(1011, 'upstream error');
      })
    );

    // 客户端 → 上游（缓冲到上游 open，避免建连竞态丢帧；文本帧不能改成二进制）
    upstream.on(
      'open',
      safeHandler(() => {
        flushPending(upstream, pending);
      })
    );
    if (upstream.readyState === UpstreamWebSocket.OPEN) flushPending(upstream, pending);
    client.on(
      'message',
      safeHandler((data: Buffer | string, isBinary: boolean) => {
        forwardFrame(upstream, pending, data, isBinary);
      })
    );
    client.on(
      'close',
      safeHandler(() => upstream.close())
    );
    client.on(
      'error',
      safeHandler(() => upstream.close())
    );
  });
}

/** 判断 upgrade 请求是否指向 realtime 代理路径 */
export function isRealtimeUpgradePath(url: string | undefined): boolean {
  if (!url) return false;
  return new URL(url, 'http://localhost').pathname === '/api/realtime';
}
