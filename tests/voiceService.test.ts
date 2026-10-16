import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { VoiceService, detectCapabilities } from '../services/voiceService.ts';

/**
 * 语音服务测试（PRD 4.1.5 / 4.1.6 / 附录 G / TC-04 / TC-10 / TC-12 / TC-13）
 * mock WebSocket / AudioContext / MediaRecorder / fetch，不触真实 StepFun。
 */

const originalFetch = globalThis.fetch;

// ---------- mock 基础设施 ----------

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  sent: any[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  url: string;
  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
    setTimeout(() => this.onopen?.(), 0);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {
    this.closed = true;
    this.onclose?.();
  }
  /** 测试辅助：投递一帧 */
  deliver(obj: unknown) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
}

class MockAudioSource {
  buffer: any = null;
  startedAt: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connect() {
    return this;
  }
  start(t: number) {
    this.startedAt = t;
    // 模拟播放结束（真实 AudioBufferSource 播完触发 onended）
    setTimeout(() => this.onended?.(), 0);
  }
  stop() {
    this.stopped = true;
  }
}

class MockAudioContext {
  static sources: MockAudioSource[] = [];
  state = 'running';
  currentTime = 0;
  destination = {};
  async resume() {
    this.state = 'running';
  }
  createBuffer(_ch: number, len: number) {
    return { duration: len / 24000, getChannelData: () => new Float32Array(len) };
  }
  createBufferSource() {
    const s = new MockAudioSource();
    MockAudioContext.sources.push(s);
    return s;
  }
  async close() {}
}

class MockMediaRecorder {
  static instances: MockMediaRecorder[] = [];
  state = 'inactive';
  mimeType = 'audio/webm';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  stream: unknown;
  constructor(stream: unknown) {
    this.stream = stream;
    MockMediaRecorder.instances.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    this.state = 'inactive';
    this.ondataavailable?.({ data: new Blob(['audio-bytes']) });
    this.onstop?.();
  }
}

function installBrowserMocks() {
  (globalThis as any).WebSocket = MockWebSocket;
  (globalThis as any).AudioContext = MockAudioContext;
  (globalThis as any).MediaRecorder = MockMediaRecorder;
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: { getUserMedia: async () => ({ getTracks: () => [{ stop() {} }] }) },
  });
}

beforeEach(() => {
  MockWebSocket.instances = [];
  MockAudioContext.sources = [];
  MockMediaRecorder.instances = [];
  installBrowserMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ---------- 能力探测与降级 ----------
test('TC-14/2.3: 无 Web Speech 环境降级纯文字（iOS Safari 场景）', () => {
  const caps = detectCapabilities();
  // node 环境无 window.SpeechRecognition
  assert.equal(caps.hasWebSpeech, false);
  assert.equal(caps.isIOS, false);
});

test('TC-14/2.3: 无 mediaDevices（旧设备/受限浏览器）→ 纯文字输入 + 纯文字输出', () => {
  const prev = Object.getOwnPropertyDescriptor(globalThis.navigator, 'mediaDevices');
  Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: undefined });
  const caps = detectCapabilities();
  assert.equal(caps.hasMediaDevices, false);
  assert.equal(caps.inputMode, 'text');
  assert.equal(caps.outputMode, 'text-only');
  if (prev) Object.defineProperty(globalThis.navigator, 'mediaDevices', prev);
});

test('TC-10: StepFun 凭证不可用时 init() 降级（Web Speech / 文字）', async () => {
  globalThis.fetch = (async () => new Response(JSON.stringify({ error: 'STEPFUN_NOT_CONFIGURED' }), { status: 503 })) as any;
  const voice = new VoiceService({ inputMode: 'stepfun-asr', outputMode: 'stepfun-tts' });
  const caps = await voice.init();
  // 无 Web Speech → 直接纯文字
  assert.equal(caps.inputMode, 'text');
  assert.equal(caps.outputMode, 'text-only');
});

test('TC-10: 凭证可用时保持 StepFun 模式', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token: 't', endpoint: 'wss://api.stepfun.com/v1/realtime/audio', model: 'stepaudio-3-tts' }), { status: 200 })) as any;
  const voice = new VoiceService({ inputMode: 'stepfun-asr', outputMode: 'stepfun-tts' });
  const caps = await voice.init();
  assert.equal(caps.inputMode, 'stepfun-asr');
  assert.equal(caps.outputMode, 'stepfun-tts');
});

// ---------- TC-12：TTS 流式协议 ----------

test('TC-12/G.1: TTS WebSocket 协议（session.update + tts.text.delta + instruction + audio.delta 播放）', async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ token: 'tok', expires_in: 900, endpoint: 'wss://api.stepfun.com/v1/realtime/audio', model: 'stepaudio-3-tts', voice_id: 'stepfun_voice_04' }),
      { status: 200 }
    )) as any;

  const voice = new VoiceService({ outputMode: 'stepfun-tts' });
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03]).toString('base64');

  const speakPromise = voice.speak('我认为应该先做用户调研', {
    voiceId: 'stepfun_voice_04',
    rate: 1.25,
    emotion: 'serious',
    instruction: '语速稍快、坚定有力',
  });

  // 等待 WebSocket 建立
  await new Promise((r) => setTimeout(r, 5));
  const ws = MockWebSocket.instances[0];
  assert.ok(ws, '未建立 TTS WebSocket');
  assert.equal(ws.url, 'wss://api.stepfun.com/v1/realtime/audio');

  // 会话配置 + 文本增量（含 instruction）
  const sessionUpdate = ws.sent.find((s) => s.type === 'session.update');
  assert.ok(sessionUpdate);
  assert.equal(sessionUpdate.voice, 'stepfun_voice_04');
  assert.equal(sessionUpdate.rate, 1.25);
  const textDelta = ws.sent.find((s) => s.type === 'tts.text.delta');
  assert.equal(textDelta.text, '我认为应该先做用户调研');
  assert.equal(textDelta.instruction, '语速稍快、坚定有力');
  assert.ok(ws.sent.some((s) => s.type === 'tts.text.done'));

  // 音频增量 → 入队播放
  assert.equal(voice.isSpeaking(), true);
  ws.deliver({ type: 'tts.response.audio.delta', audio: pcm });
  ws.deliver({ type: 'tts.response.subtitle', words: [{ text: '我认为', start: 0, end: 200 }] });
  assert.equal(MockAudioContext.sources.length, 1, 'PCM 未入队播放');

  // 完成事件 → resolve
  ws.deliver({ type: 'tts.response.done' });
  await speakPromise;
});

test('TC-04: barge-in —— 用户抢话时同步停止播报（≤300ms）', async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ token: 'tok', endpoint: 'wss://api.stepfun.com/v1/realtime/audio', model: 'stepaudio-3-tts' }), { status: 200 })) as any;

  const voice = new VoiceService({ outputMode: 'stepfun-tts' });
  const speakPromise = voice.speak('我同意你的思路，补充一点样本量要足够。', { voiceId: 'stepfun_voice_02', emotion: 'neutral' });

  await new Promise((r) => setTimeout(r, 5));
  const ws = MockWebSocket.instances[0];
  ws.deliver({ type: 'tts.response.audio.delta', audio: Buffer.from([1, 2, 3, 4]).toString('base64') });
  const source = MockAudioContext.sources[0];
  assert.equal(source.stopped, false);

  // barge-in：同步生效
  const t0 = Date.now();
  voice.bargeIn();
  assert.equal(source.stopped, true, 'barge-in 未立即停止音频');
  assert.equal(voice.isSpeaking(), false);
  assert.equal(ws.closed, true, 'barge-in 未关闭 TTS 连接');
  assert.ok(Date.now() - t0 < 300, 'barge-in 超过 300ms');

  await speakPromise;
});

test('TC-12: TTS 失败自动降级文字播报（不阻断群面）', async () => {
  globalThis.fetch = (async () => new Response('{}', { status: 503 })) as any;
  const voice = new VoiceService({ outputMode: 'stepfun-tts' });
  await voice.speak('测试发言', { voiceId: 'stepfun_voice_01' });
  assert.equal(voice.getCapabilities().outputMode, 'text-only');
  // 降级后再次 speak 为 no-op 且不抛错
  await voice.speak('第二次发言', { voiceId: 'stepfun_voice_01' });
});

// ---------- TC-13：ASR SSE 流式 ----------

test('TC-13/G.2: ASR 录音提交 → SSE 增量 + 最终转写', async () => {
  const asrTokenRes = { token: 'asr-tok', endpoint: 'https://api.stepfun.com/v1/audio/asr/sse', model: 'stepaudio-3-asr-max' };
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes('/api/asr-token')) {
      return new Response(JSON.stringify(asrTokenRes), { status: 200 });
    }
    // ASR SSE 响应
    const stream = new ReadableStream({
      start(controller) {
        const enc = new TextEncoder();
        controller.enqueue(enc.encode('data: {"text": "我认为"}\n\n'));
        controller.enqueue(enc.encode('data: {"text": "我认为应该先做用户调研"}\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }) as any;

  const voice = new VoiceService({ inputMode: 'stepfun-asr' });
  const partials: string[] = [];
  let finalText = '';
  await voice.startAsr(
    (p) => partials.push(p),
    (f) => {
      finalText = f;
    }
  );
  assert.equal(MockMediaRecorder.instances.length, 1, '未开始录音');

  const result = await voice.stopAsr();
  assert.equal(result, '我认为应该先做用户调研');
  assert.equal(finalText, '我认为应该先做用户调研');
  assert.deepEqual(partials, ['我认为', '我认为应该先做用户调研']);
});

test('TC-13: ASR 请求失败返回空串（前端保持手动输入，不崩溃）', async () => {
  globalThis.fetch = (async () => new Response('{}', { status: 500 })) as any;
  const voice = new VoiceService({ inputMode: 'stepfun-asr' });
  await voice.startAsr(
    () => {},
    () => {}
  );
  const result = await voice.stopAsr();
  assert.equal(result, '');
});

test('4.1.6: 无麦克风权限时 ASR 降级', async () => {
  Object.defineProperty(globalThis.navigator, 'mediaDevices', {
    configurable: true,
    value: {
      getUserMedia: async () => {
        throw new Error('Permission denied');
      },
    },
  });
  const voice = new VoiceService({ inputMode: 'stepfun-asr' });
  await voice.startAsr(
    () => {},
    () => {}
  );
  // 无 Web Speech → 降级纯文字
  assert.equal(voice.getCapabilities().inputMode, 'text');
});

// ---------- dispose ----------

test('dispose 释放资源不抛错', async () => {
  const voice = new VoiceService({ inputMode: 'stepfun-asr', outputMode: 'stepfun-tts' });
  await voice.startAsr(
    () => {},
    () => {}
  );
  voice.dispose();
  assert.ok(true);
});
