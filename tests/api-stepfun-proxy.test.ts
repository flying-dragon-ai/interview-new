import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import ttsHandler from '../api/tts.ts';
import asrHandler from '../api/asr.ts';

/**
 * /api/tts · /api/asr 代理集成测试（mock StepFun 上游 fetch，验证 C9 代理 + SSE 透传 + 参数映射）
 */

const originalFetch = globalThis.fetch;
const originalKey = process.env.STEPFUN_API_KEY;

function mockReq(body: unknown, ip = '10.0.0.2') {
  return {
    method: 'POST',
    body,
    headers: { 'x-forwarded-for': ip },
    socket: { remoteAddress: ip },
  } as any;
}

function mockRes() {
  const res: any = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(status: number, headers: Record<string, string>) {
      res.statusCode = status;
      res.headers = headers;
    },
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(data: unknown) {
      res.body = JSON.stringify(data);
      res.ended = true;
      return res;
    },
    write(chunk: string) {
      res.body += chunk;
      return true;
    },
    end() {
      res.ended = true;
    },
    on() {},
  };
  return res;
}

function sseUpstream(lines: string[]) {
  const stream = new ReadableStream({
    start(controller) {
      const enc = new TextEncoder();
      for (const l of lines) controller.enqueue(enc.encode(l));
      controller.close();
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function parseSse(body: string): { event: string; data: any }[] {
  return body
    .split('\n\n')
    .filter((b) => b.trim())
    .map((block) => ({
      event: block.match(/event: (.+)/)?.[1] ?? 'message',
      data: JSON.parse(block.match(/data: (.+)/)?.[1] ?? '{}'),
    }));
}

beforeEach(() => {
  process.env.STEPFUN_API_KEY = 'test-stepfun-key';
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalKey === undefined) delete process.env.STEPFUN_API_KEY;
  else process.env.STEPFUN_API_KEY = originalKey;
});

test('/api/tts：voice/rate/instruction 转发上游，audio.delta 透传为 SSE', async () => {
  let upstreamBody: any = null;
  let upstreamAuth = '';
  globalThis.fetch = (async (_url: string, init?: any) => {
    upstreamBody = JSON.parse(init?.body ?? '{}');
    upstreamAuth = init?.headers?.Authorization ?? '';
    return sseUpstream([
      'data: {"type":"speech.audio.delta","audio":"QUJD"}\n\n',
      'data: {"type":"speech.audio.delta","audio":"REVG"}\n\n',
      'data: {"type":"speech.audio.done","audio":""}\n\n',
      'data: [DONE]\n\n',
    ]);
  }) as any;

  const res = mockRes();
  await ttsHandler(mockReq({ text: '我认为先调研', voice_id: 'zhengpaiqingnian', rate: 1.25, instruction: '语速稍快' }), res);

  assert.equal(res.statusCode, 200);
  assert.match(res.headers['Content-Type'], /text\/event-stream/);
  // 上游参数：key 注入（C9）、模型、音色、语速、instruction、PCM/SSE
  assert.equal(upstreamAuth, 'Bearer test-stepfun-key');
  assert.equal(upstreamBody.model, 'stepaudio-3-tts');
  assert.equal(upstreamBody.input, '我认为先调研');
  assert.equal(upstreamBody.voice, 'zhengpaiqingnian');
  assert.equal(upstreamBody.speed, 1.25);
  assert.equal(upstreamBody.instruction, '语速稍快');
  assert.equal(upstreamBody.response_format, 'pcm');
  assert.equal(upstreamBody.stream_format, 'sse');
  // 透传事件
  const events = parseSse(res.body);
  const audios = events.filter((e) => e.event === 'delta').map((e) => e.data.audio);
  assert.deepEqual(audios, ['QUJD', 'REVG']);
  assert.ok(events.some((e) => e.event === 'done'));
});

test('/api/tts：未配置 key → 503 fallback webspeech-tts', async () => {
  delete process.env.STEPFUN_API_KEY;
  const res = mockRes();
  await ttsHandler(mockReq({ text: 't', voice_id: 'v' }), res);
  assert.equal(res.statusCode, 503);
  assert.match(res.body, /STEPFUN_NOT_CONFIGURED/);
  assert.match(res.body, /webspeech-tts/);
});

test('/api/tts：上游失败 → 502', async () => {
  globalThis.fetch = (async () => new Response('blocked', { status: 451 })) as any;
  const res = mockRes();
  await ttsHandler(mockReq({ text: 't', voice_id: 'v' }), res);
  assert.equal(res.statusCode, 502);
  assert.match(res.body, /TTS_UPSTREAM_FAILED/);
});

test('/api/tts：缺参数 → 400；超长 → 400', async () => {
  const res1 = mockRes();
  await ttsHandler(mockReq({ text: '', voice_id: 'v' }), res1);
  assert.equal(res1.statusCode, 400);
  const res2 = mockRes();
  await ttsHandler(mockReq({ text: 'x'.repeat(1001), voice_id: 'v' }), res2);
  assert.equal(res2.statusCode, 400);
});

test('/api/asr：audio/format 转发上游，transcript delta/done 透传', async () => {
  let upstreamBody: any = null;
  globalThis.fetch = (async (_url: string, init?: any) => {
    upstreamBody = JSON.parse(init?.body ?? '{}');
    return sseUpstream([
      'data: {"type":"transcript.text.delta","delta":"我认为","start_time":0,"end_time":500}\n\n',
      'data: {"type":"transcript.text.delta","delta":"先调研","start_time":500,"end_time":900}\n\n',
      'data: {"type":"transcript.text.done","text":"我认为先调研"}\n\n',
    ]);
  }) as any;

  const res = mockRes();
  await asrHandler(mockReq({ audio: 'QUJD', format: { type: 'ogg' } }), res);

  assert.equal(res.statusCode, 200);
  assert.equal(upstreamBody.audio.data, 'QUJD');
  assert.equal(upstreamBody.audio.input.transcription.model, 'stepaudio-3-asr-max');
  assert.equal(upstreamBody.audio.input.transcription.language, 'zh');
  assert.equal(upstreamBody.audio.input.format.type, 'ogg');

  const events = parseSse(res.body);
  const deltas = events.filter((e) => e.event === 'delta').map((e) => e.data.delta);
  assert.deepEqual(deltas, ['我认为', '先调研']);
  const done = events.find((e) => e.event === 'done');
  assert.equal(done?.data.text, '我认为先调研');
});

test('/api/asr：未配置 key → 503；缺 audio → 400', async () => {
  delete process.env.STEPFUN_API_KEY;
  const res = mockRes();
  await asrHandler(mockReq({ audio: 'QUJD' }), res);
  assert.equal(res.statusCode, 503);

  process.env.STEPFUN_API_KEY = 'test-stepfun-key';
  const res2 = mockRes();
  await asrHandler(mockReq({}), res2);
  assert.equal(res2.statusCode, 400);
});
