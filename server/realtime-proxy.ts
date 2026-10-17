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

const wss = new WebSocketServer({ noServer: true });

export function handleRealtimeUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
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

  const upstream = new UpstreamWebSocket(STEPFUN_CONFIG.realtime.endpoint + `?model=${STEPFUN_CONFIG.realtime.model}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  wss.handleUpgrade(req, socket, head, (client) => {
    // 上游 → 客户端
    upstream.on('message', (data, isBinary) => {
      if (client.readyState === client.OPEN) client.send(data, { binary: isBinary });
    });
    upstream.on('close', (code, reason) => client.close(code, reason));
    upstream.on('error', () => client.close(1011, 'upstream error'));

    // 客户端 → 上游（缓冲到上游 open，避免建连竞态丢帧）
    const pending: (string | Buffer)[] = [];
    upstream.on('open', () => {
      while (pending.length > 0) upstream.send(pending.shift()!);
    });
    client.on('message', (data: Buffer | string) => {
      if (upstream.readyState === UpstreamWebSocket.OPEN) upstream.send(data);
      else pending.push(data);
    });
    client.on('close', () => upstream.close());
    client.on('error', () => upstream.close());
  });
}

/** 判断 upgrade 请求是否指向 realtime 代理路径 */
export function isRealtimeUpgradePath(url: string | undefined): boolean {
  if (!url) return false;
  return new URL(url, 'http://localhost').pathname === '/api/realtime';
}
