import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/sessions.ts';
import { setPoolForTesting } from '../api/_lib/db.ts';

const envNames = ['DATABASE_URL', 'POSTGRES_URL', 'DEEPSEEK_API_KEY'] as const;
const originalEnv = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
let queries: { sql: string; params: unknown[] }[];

beforeEach(() => {
  process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';
  delete process.env.DEEPSEEK_API_KEY;
  queries = [];
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (/SELECT \* FROM sessions/.test(sql)) {
      return { rows: [{ id: 42, topic: 'Test topic', started_at: new Date(0), ended_at: new Date(60_000) }] };
    }
    if (/SELECT \* FROM reports/.test(sql)) return { rows: [{ session_id: 42, overall_score: 72 }] };
    return { rows: [] };
  };
  setPoolForTesting({ query, connect: async () => ({ query, release() {} }) } as any);
});

afterEach(() => {
  setPoolForTesting(null);
  for (const name of envNames) {
    if (originalEnv[name] === undefined) delete process.env[name];
    else process.env[name] = originalEnv[name];
  }
});

function response() {
  return {
    statusCode: 0,
    body: undefined as any,
    status(code: number) { this.statusCode = code; return this; },
    json(body: unknown) { this.body = body; return this; },
  };
}

const routes = [
  { suffix: '', method: 'GET', sql: /SELECT \* FROM sessions/, result: (body: any) => assert.equal(body.id, 42) },
  { suffix: '', method: 'DELETE', sql: /DELETE FROM sessions/, result: (body: any) => assert.equal(body.deleted, 42) },
  { suffix: '/report', method: 'GET', sql: /SELECT \* FROM reports/, result: (body: any) => assert.equal(body.overall_score, 72) },
  { suffix: '/analyze', method: 'POST', sql: /INSERT INTO reports/, result: (body: any) => assert.equal(body.session_id, 42) },
  { suffix: '/visual', method: 'GET', sql: /FROM visual_features/, result: (body: any) => assert.deepEqual(body, []) },
  { suffix: '/visual', method: 'POST', sql: /INSERT INTO visual_features/, result: (body: any) => assert.equal(body.inserted, 1) },
];

for (const mode of ['original URL', 'Vercel rewrite'] as const) {
  for (const route of routes) {
    test(`${mode}: ${route.method} /api/sessions/42${route.suffix}`, async () => {
      const request: any = {
        method: route.method,
        url: mode === 'original URL' ? `/api/sessions/42${route.suffix}?id=999` : '/api/sessions',
        query: { id: '999', extra: 'preserved', __sessionRoute: mode === 'Vercel rewrite' ? `42${route.suffix}` : '999/report' },
        body: { rows: [{ timestamp_ms: 1000, eye_contact: 0.8, emotion: 'neutral', head_pose: {}, engagement: 1 }] },
      };
      const res = response();
      await handler(request, res as any);
      assert.equal(res.statusCode, 200);
      route.result(res.body);
      assert.equal(request.query.id, '42', 'path ID must override a query ID');
      assert.equal(request.query.extra, 'preserved');
      const query = queries.find(({ sql }) => route.sql.test(sql));
      assert.ok(query, 'expected handler was not called');
      assert.ok(query.params.includes(42), 'handler must receive the path ID');
    });
  }
}

test('unknown or ambiguous routes return 404 without querying the database', async () => {
  for (const route of ['42/unknown', '42/report/extra', '../42', '', ['42', 'report']]) {
    const res = response();
    await handler({ url: '/api/sessions', query: { __sessionRoute: route }, method: 'GET' } as any, res as any);
    assert.equal(res.statusCode, 404);
  }
  assert.equal(queries.length, 0);
});

test('unsupported methods retain the original 405 response', async () => {
  const res = response();
  await handler({ url: '/api/sessions/42/analyze', query: {}, method: 'GET' } as any, res as any);
  assert.equal(res.statusCode, 405);
  assert.deepEqual(res.body, { error: 'Method not allowed' });
  assert.equal(queries.length, 0);
});

test('missing database configuration retains the original 503 response', async () => {
  delete process.env.DATABASE_URL;
  delete process.env.POSTGRES_URL;
  const res = response();
  await handler({ url: '/api/sessions/42/report', query: {}, method: 'GET' } as any, res as any);
  assert.equal(res.statusCode, 503);
  assert.equal(res.body.error, 'DATABASE_NOT_CONFIGURED');
});
