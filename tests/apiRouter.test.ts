import test from 'node:test';
import assert from 'node:assert/strict';
import router, { resolveApiRoute } from '../api/router.ts';

test('unified API router maps every static endpoint to a handler', () => {
  for (const path of [
    'llm', 'session', 'message', 'feedback', 'events', 'avatars', 'avatars/presets',
    'tts', 'asr', 'tts-token', 'asr-token', 'practice-history', 'questions',
    'questions/random', 'questions/stats',
  ]) {
    assert.ok(resolveApiRoute(path), `missing route: ${path}`);
  }
});

test('unified API router resolves dynamic endpoints and IDs', () => {
  assert.equal(resolveApiRoute('questions/q-123')?.id, 'q-123');
  assert.equal(resolveApiRoute('questions/q-123/favorite')?.id, 'q-123');
  assert.equal(resolveApiRoute('questions/q-123/retry')?.id, 'q-123');
  assert.equal(resolveApiRoute('practice/42/review')?.id, '42');
  assert.equal(resolveApiRoute('sessions/42')?.id, '42');
  assert.equal(resolveApiRoute('sessions/42/analyze')?.id, '42');
  assert.equal(resolveApiRoute('sessions/42/report')?.id, '42');
  assert.equal(resolveApiRoute('/api/questions/q%2F123')?.id, 'q/123');
  assert.equal(resolveApiRoute('does-not-exist'), null);
});

test('unified API router invokes the selected handler and removes its routing parameter', async () => {
  const request = { method: 'GET', query: { path: 'questions/stats', sample: 'kept' }, headers: {}, url: '/api/router?path=questions/stats' } as any;
  let statusCode = 200;
  let payload: unknown;
  const response = {
    status(code: number) { statusCode = code; return this; },
    json(body: unknown) { payload = body; return this; },
  } as any;

  await router(request, response);
  assert.equal(statusCode, 200);
  assert.equal((payload as { total: number }).total, 12);
  assert.deepEqual(request.query, { sample: 'kept' });
});
