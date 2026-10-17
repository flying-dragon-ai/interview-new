import type { Plugin, ViteDevServer } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadEnv } from 'vite';

/**
 * 本地开发 API 中间件（修复：vite dev 下 /api/* 404 → 前端"题目生成失败"）
 * 生产由 Vercel 承载 serverless；本地 dev 用 ssrLoadModule 直接加载 api/*.ts handler，
 * 以最小 shim 适配 VercelRequest / VercelResponse，行为与生产一致（含 SSE 流式）。
 */

const STATIC_ROUTES: Record<string, string> = {
  '/api/llm': '/api/llm.ts',
  '/api/session': '/api/session.ts',
  '/api/message': '/api/message.ts',
  '/api/feedback': '/api/feedback.ts',
  '/api/events': '/api/events.ts',
  '/api/avatars': '/api/avatars.ts',
  '/api/avatars/presets': '/api/avatars.ts',
  '/api/tts': '/api/tts.ts',
  '/api/asr': '/api/asr.ts',
  '/api/tts-token': '/api/tts-token.ts',
  '/api/asr-token': '/api/asr-token.ts',
  '/api/practice-history': '/api/practice-history.ts',
  '/api/questions': '/api/questions.ts',
  '/api/questions/random': '/api/questions/random.ts',
  '/api/questions/stats': '/api/questions/stats.ts',
};

/** Vercel 文件系统路由：[id] 动态段 → query.id */
const DYNAMIC_ROUTES: { re: RegExp; file: string }[] = [
  { re: /^\/api\/sessions\/(\d+)\/analyze$/, file: '/api/sessions/[id]/analyze.ts' },
  { re: /^\/api\/sessions\/(\d+)\/report$/, file: '/api/sessions/[id]/report.ts' },
  { re: /^\/api\/sessions\/(\d+)$/, file: '/api/sessions/[id]/index.ts' },
  { re: /^\/api\/practice\/([^/]+)\/review$/, file: '/api/practice/[id]/review.ts' },
  { re: /^\/api\/questions\/([^/]+)\/favorite$/, file: '/api/questions/[id]/favorite.ts' },
  { re: /^\/api\/questions\/([^/]+)\/retry$/, file: '/api/questions/[id]/retry.ts' },
  { re: /^\/api\/questions\/([^/]+)$/, file: '/api/questions/[id].ts' },
];

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text.trim()) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

interface VercelShim extends ServerResponse {
  status: (code: number) => VercelShim;
  json: (data: unknown) => VercelShim;
  send: (data: unknown) => VercelShim;
}

export function localApiPlugin(mode: string): Plugin {
  return {
    name: 'local-api',
    apply: 'serve',
    configureServer(server: ViteDevServer) {
      // 把 .env.local 等加载进 process.env（服务端 handler 读取 DEEPSEEK_API_KEY / STEPFUN_API_KEY / DATABASE_URL）
      const env = loadEnv(mode, process.cwd(), '');
      for (const [k, v] of Object.entries(env)) {
        if (process.env[k] === undefined) process.env[k] = v;
      }

      server.middlewares.use('/api', (req, res, next) => {
        void (async () => {
          const rawUrl = '/api' + (req.url ?? '/');
          const url = new URL(rawUrl, 'http://localhost');
          const pathname = url.pathname;

          let file = STATIC_ROUTES[pathname];
          let id: string | null = null;
          if (!file) {
            for (const route of DYNAMIC_ROUTES) {
              const m = pathname.match(route.re);
              if (m) {
                file = route.file;
                id = m[1];
                break;
              }
            }
          }
          if (!file) return next();

          const query: Record<string, string> = {};
          for (const [k, v] of url.searchParams) query[k] = v;
          if (id !== null) query.id = id;

          const body = req.method !== 'GET' && req.method !== 'HEAD' ? await readJsonBody(req) : undefined;

          const vres = res as VercelShim;
          vres.status = (code: number) => {
            res.statusCode = code;
            return vres;
          };
          vres.json = (data: unknown) => {
            if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
            res.end(JSON.stringify(data));
            return vres;
          };
          vres.send = (data: unknown) => {
            if (data !== null && typeof data === 'object') return vres.json(data);
            if (!res.headersSent) res.setHeader('Content-Type', 'text/plain; charset=utf-8');
            res.end(data === undefined ? '' : String(data));
            return vres;
          };

          const vreq = Object.assign(req, { body, query });
          try {
            const mod = await server.ssrLoadModule(file);
            await mod.default(vreq, vres);
          } catch (err) {
            console.error('[local-api] %s %s error:', req.method, pathname, err);
            if (!res.headersSent) {
              res.statusCode = 500;
              res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
            if (!res.writableEnded) {
              res.end(JSON.stringify({ error: 'LOCAL_API_ERROR', message: err instanceof Error ? err.message : String(err) }));
            }
          }
        })().catch(next);
      });
    },
  };
}
