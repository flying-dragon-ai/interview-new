import { test } from 'node:test';
import assert from 'node:assert/strict';
import { issueToken, verifyToken, isStepFunConfigured, STEPFUN_CONFIG } from '../api/_lib/stepfun.ts';
import crypto from 'node:crypto';

test('G.4: 未配置 STEPFUN_API_KEY 时不签发', () => {
  const prev = process.env.STEPFUN_API_KEY;
  delete process.env.STEPFUN_API_KEY;
  assert.equal(isStepFunConfigured(), false);
  assert.throws(() => issueToken('tts'));
  if (prev !== undefined) process.env.STEPFUN_API_KEY = prev;
});

test('G.4: 签发与校验闭环（前端只拿短时凭证，不持 key）', () => {
  process.env.STEPFUN_API_KEY = 'test-secret-key';
  const issued = issueToken('tts', { voice_id: 'stepfun_voice_01' });
  assert.ok(issued.token.includes('.'));
  assert.equal(issued.expires_in, 15 * 60);

  const verified = verifyToken(issued.token);
  assert.equal(verified.valid, true);
  assert.equal(verified.payload?.scope, 'tts');
  assert.equal(verified.payload?.voice_id, 'stepfun_voice_01');

  // 篡改签名 → 无效
  const [body] = issued.token.split('.');
  assert.equal(verifyToken(`${body}.forged`).valid, false);
  // 过期 token → 无效
  const now = Math.floor(Date.now() / 1000);
  const expiredBody = Buffer.from(JSON.stringify({ scope: 'tts', iat: now - 1000, exp: now - 1 })).toString('base64url');
  const sig = crypto.createHmac('sha256', 'test-secret-key').update(expiredBody).digest('base64url');
  assert.equal(verifyToken(`${expiredBody}.${sig}`).valid, false);
});

test('附录 G: 端点与模型规格', () => {
  assert.equal(STEPFUN_CONFIG.tts.endpoint, 'wss://api.stepfun.com/v1/realtime/audio');
  assert.equal(STEPFUN_CONFIG.tts.model, 'stepaudio-3-tts');
  assert.equal(STEPFUN_CONFIG.asr.endpoint, 'https://api.stepfun.com/v1/audio/asr/sse');
  assert.equal(STEPFUN_CONFIG.asr.model, 'stepaudio-3-asr-max');
  assert.equal(STEPFUN_CONFIG.realtime.model, 'stepaudio-3-realtime-preview');
});
