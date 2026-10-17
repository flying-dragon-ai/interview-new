import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RealtimeClient,
  RealtimeUnavailableError,
  type RealtimeEvents,
  type WsLike,
} from '../services/realtimeClient.ts';

/**
 * M7 P2：RealtimeClient 适配层测试（mock WS / mock mic / mock fetch）
 * - VAD start → 400ms 确认窗 → onVadStart；response.cancel 立即发出
 * - 确认窗内 speech_stopped = 咳嗽/键盘误触，不上报
 * - 800ms 冷却期内第二次 VAD 被忽略
 * - 转写 completed → onUserTranscript(isFinal)
 * - response.* 事件全部忽略（本项目把 Realtime 当流式 ASR+VAD 用）
 * - 断线指数退避重连，耗尽 → REALTIME_RECONNECT_FAILED + onClose（503 降级在 create 层）
 */

class MockWs implements WsLike {
  static OPEN = 1;
  readyState = 0;
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;

  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.closed = true;
    this.readyState = 3;
  }
  // 测试驱动
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(obj: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(): void {
    this.readyState = 3;
    this.onclose?.();
  }
  sentJson(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  events: RealtimeEvents & { log: string[] };
  sockets: MockWs[];
  frames: string[];
  client: RealtimeClient;
}

async function makeClient(overrides: Record<string, unknown> = {}): Promise<Harness> {
  const log: string[] = [];
  const events = {
    log,
    onVadStart: () => log.push('vadStart'),
    onVadStop: () => log.push('vadStop'),
    onUserTranscript: (p: { text: string; isFinal: boolean }) => log.push(`transcript:${p.text}:${p.isFinal}`),
    onError: (e: { code: string; message: string }) => log.push(`error:${e.code}`),
    onClose: () => log.push('close'),
  };
  const sockets: MockWs[] = [];
  const frames: string[] = [];
  const fetchFn = (async () =>
    new Response(JSON.stringify({ token: 't.token.sig', model: 'stepaudio-3-realtime-preview' }), { status: 200 })) as typeof fetch;
  const client = await RealtimeClient.create({
    events,
    fetchFn,
    wsFactory: () => {
      const ws = new MockWs();
      sockets.push(ws);
      return ws;
    },
    micFactory: async (onFrame: (b64: string) => void) => {
      frames.push('__mic_started__');
      (makeClient as unknown as { lastOnFrame: (b64: string) => void }).lastOnFrame = onFrame;
      return { stop: () => frames.push('__mic_stopped__') };
    },
    confirmWindowMs: 20,
    cooldownMs: 40,
    reconnectDelaysMs: [10, 20, 30],
    ...overrides,
  });
  return { events, sockets, frames, client };
}

function emitFrame(h: Harness, b64: string): void {
  (makeClient as unknown as { lastOnFrame: (b64: string) => void }).lastOnFrame?.(b64);
}

test('create：凭证 503 → RealtimeUnavailableError(fallback=push-to-talk)', async () => {
  const fetchFn = (async () => new Response(JSON.stringify({ fallback: 'push-to-talk' }), { status: 503 })) as typeof fetch;
  await assert.rejects(
    RealtimeClient.create({
      events: { onVadStart() {}, onVadStop() {}, onUserTranscript() {}, onError() {}, onClose() {} },
      fetchFn,
    }),
    (err: unknown) => err instanceof RealtimeUnavailableError && err.fallback === 'push-to-talk'
  );
});

test('start：open 即发 session.update(server_vad)，麦克风流 → append 帧', async () => {
  const h = await makeClient();
  h.client.start();
  assert.equal(h.client.state, 'connecting');
  h.sockets[0].open();
  await sleep(5);
  assert.equal(h.client.state, 'open');
  const sessionUpdate = h.sockets[0].sentJson().find((m) => m.type === 'session.update') as {
    session: { turn_detection: { type: string }; input_audio_format: string };
  };
  assert.ok(sessionUpdate, '未发送 session.update');
  assert.equal(sessionUpdate.session.turn_detection.type, 'server_vad');
  assert.equal(sessionUpdate.session.input_audio_format, 'pcm16');
  // 麦克风帧 → input_audio_buffer.append
  emitFrame(h, 'QUJD');
  const append = h.sockets[0].sentJson().find((m) => m.type === 'input_audio_buffer.append');
  assert.ok(append, '未发送音频 append');
  assert.equal((append as { audio: string }).audio, 'QUJD');
  // 静音后不再上行
  h.client.setMuted(true);
  const before = h.sockets[0].sentJson().length;
  emitFrame(h, 'REVG');
  assert.equal(h.sockets[0].sentJson().length, before);
  h.client.dispose();
});

test('VAD start：立即 response.cancel；400ms 确认窗后 onVadStart；speech_stopped → onVadStop', async () => {
  const h = await makeClient();
  h.client.start();
  h.sockets[0].open();
  await sleep(5);
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_started', item_id: 'm1' });
  // 同步：response.cancel 已发出，onVadStart 尚未触发（确认窗）
  assert.ok(h.sockets[0].sentJson().some((m) => m.type === 'response.cancel'));
  assert.deepEqual(h.events.log, []);
  await sleep(40); // 过 20ms 确认窗
  assert.deepEqual(h.events.log, ['vadStart']);
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'm1' });
  assert.deepEqual(h.events.log, ['vadStart', 'vadStop']);
  h.client.dispose();
});

test('咳嗽/键盘：确认窗内 speech_stopped → 不上报任何 VAD 事件（E2E-3）', async () => {
  const h = await makeClient();
  h.client.start();
  h.sockets[0].open();
  await sleep(5);
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_started', item_id: 'm1' });
  await sleep(5); // 窗内
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'm1' });
  await sleep(40);
  assert.deepEqual(h.events.log, []);
  h.client.dispose();
});

test('冷却期：onVadStart 后 cooldownMs 内第二次 speech_started 被忽略', async () => {
  const h = await makeClient();
  h.client.start();
  h.sockets[0].open();
  await sleep(5);
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_started', item_id: 'm1' });
  await sleep(30); // 确认窗过 → vadStart
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_stopped', item_id: 'm1' });
  // 冷却 40ms 内再次开口 → 忽略
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_started', item_id: 'm2' });
  await sleep(30);
  assert.deepEqual(h.events.log, ['vadStart', 'vadStop']);
  h.client.dispose();
});

test('转写：completed → onUserTranscript(isFinal=true)；response.* 全部忽略', async () => {
  const h = await makeClient();
  h.client.start();
  h.sockets[0].open();
  await sleep(5);
  h.sockets[0].emit({ type: 'response.audio.delta', delta: 'xxx' });
  h.sockets[0].emit({ type: 'response.text.delta', delta: '你好' });
  h.sockets[0].emit({ type: 'response.audio_transcript.done', transcript: '模型回复' });
  h.sockets[0].emit({ type: 'session.created', session: {} });
  assert.deepEqual(h.events.log, []);
  h.sockets[0].emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: '我认为应该先做调研' });
  assert.deepEqual(h.events.log, ['transcript:我认为应该先做调研:true']);
  h.client.dispose();
});

test('断线重连：非主动断线 → 退避重连成功；连续失败耗尽 → REALTIME_RECONNECT_FAILED + onClose', async () => {
  // 成功路径：断开后按退避重连，open 后计数复位
  const h = await makeClient();
  h.client.start();
  h.sockets[0].open();
  await sleep(5);
  h.sockets[0].drop();
  await sleep(25); // 第一次退避 10ms
  assert.equal(h.sockets.length, 2, '应发起第一次重连');
  h.sockets[1].open();
  await sleep(5);
  assert.equal(h.client.state, 'open');
  h.client.dispose();

  // 耗尽路径：持续未 open 的掉线 → 3 次退避后 error + close
  const h2 = await makeClient();
  h2.client.start();
  h2.sockets[0].open();
  await sleep(5);
  h2.sockets[0].drop();
  await sleep(25); // → sockets[1]
  assert.equal(h2.sockets.length, 2);
  h2.sockets[1].drop();
  await sleep(35); // → sockets[2]
  assert.equal(h2.sockets.length, 3);
  h2.sockets[2].drop();
  await sleep(45); // → sockets[3]
  assert.equal(h2.sockets.length, 4);
  h2.sockets[3].drop();
  await sleep(10);
  assert.equal(h2.client.state, 'error');
  assert.ok(h2.events.log.includes('error:REALTIME_RECONNECT_FAILED'));
  assert.ok(h2.events.log.includes('close'));
  h2.client.dispose();
});

test('上游 error 事件：response.cancel 噪音吞掉；server_error 上抛 onError', async () => {
  const h = await makeClient();
  h.client.start();
  h.sockets[0].open();
  await sleep(5);
  h.sockets[0].emit({ type: 'error', error: { type: 'invalid_request_error', message: 'response.cancel: no active response' } });
  h.sockets[0].emit({ type: 'error', error: { type: 'server_error', message: 'upstream boom' } });
  assert.deepEqual(h.events.log, ['error:server_error']);
  h.client.dispose();
});
