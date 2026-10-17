#!/usr/bin/env node
/**
 * 项目功能接口整体性 E2E（打真实 dev server，非 mock）
 * 用法：node scripts/e2e-api.mjs [baseUrl]   默认 http://localhost:3000
 * 覆盖：
 *  1. 静态入口（/ 与 /app.html）
 *  2. GET /api/avatars/presets（≥8 预设、≥4 行业）
 *  3. POST /api/tts-token / /api/asr-token / /api/realtime-token（配置探针）
 *  4. 持久层降级契约（无 DATABASE_URL → 503 DATABASE_NOT_CONFIGURED）
 *  5. 全场模拟群面：topic(流式) → 3 角色 reply（含流式/非流式/voiceMode/用户回应）→ analyze(v1.5) → feedback(旧版)
 *  6. TTS 三音色出声 + ASR 语音回环（TTS 产物喂回 ASR，转写须命中原文）
 */

const BASE = process.argv[2] ?? 'http://localhost:3000';

let passed = 0;
let failed = 0;
const results = [];

function record(name, ok, detail = '', ms = 0) {
  results.push({ name, ok, detail, ms });
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}${ms ? ` (${ms}ms)` : ''}`);
}

async function timed(fn) {
  const t0 = Date.now();
  const r = await fn();
  return { r, ms: Date.now() - t0 };
}

async function postJson(path, body, opts = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined,
  });
  return res;
}

async function readSse(res, onEvent) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const blocks = buffer.split('\n\n');
    buffer = blocks.pop() ?? '';
    for (const block of blocks) {
      const event = block.match(/^event: (.+)$/m)?.[1] ?? 'message';
      const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
      if (!dataLine) continue;
      try { onEvent(event, JSON.parse(dataLine.slice(6))); } catch { /* ignore */ }
    }
  }
}

const TOPIC_COMPANY = '字节跳动';
const TOPIC_JOB = '产品经理';
const CARDS = ['tech_visionary', 'strategy_consultant', 'hr_manager'];
const CARD_VOICES = ['zhengpaiqingnian', 'zhixingjiejie', 'ganliannvsheng'];

console.log(`\n=== LGD 群面模拟器 · 接口整体性测试 @ ${BASE} ===\n`);

// ---------- 1. 静态入口 ----------
for (const [path, label] of [['/', '首页 index.html'], ['/app.html', '模拟器 app.html']]) {
  try {
    const { r: res, ms } = await timed(() => fetch(`${BASE}${path}`));
    const text = await res.text();
    record(`静态 ${label}`, res.status === 200 && text.length > 500, `HTTP ${res.status}, ${text.length}B`, ms);
  } catch (e) {
    record(`静态 ${label}`, false, String(e));
  }
}

// ---------- 2. avatars ----------
try {
  const { r: res, ms } = await timed(() => fetch(`${BASE}/api/avatars/presets`));
  const data = await res.json();
  const ok = res.status === 200 && data.count >= 8 && data.industries.length >= 4;
  record('GET /api/avatars/presets', ok, `预设 ${data.count} 个 / 行业 ${data.industries.length} 个`, ms);
} catch (e) {
  record('GET /api/avatars/presets', false, String(e));
}

// ---------- 3. 凭证探针 ----------
for (const ep of ['tts-token', 'asr-token', 'realtime-token']) {
  try {
    const { r: res, ms } = await timed(() => postJson(`/api/${ep}`, {}));
    const data = await res.json();
    record(`POST /api/${ep}（配置探针）`, res.status === 200 && typeof data.token === 'string', `HTTP ${res.status}`, ms);
  } catch (e) {
    record(`POST /api/${ep}（配置探针）`, false, String(e));
  }
}

// ---------- 4. 持久层降级契约 ----------
const dbChecks = [
  ['POST', '/api/session', { company: 'x', job_title: 'y', topic: 'z' }],
  ['GET', '/api/message?session_id=1', null],
  ['GET', '/api/feedback?session_id=1', null],
  ['GET', '/api/events', null],
  ['GET', '/api/sessions/1', null],
];
for (const [method, path, body] of dbChecks) {
  try {
    const { r: res, ms } = await timed(() =>
      body ? postJson(path, body) : fetch(`${BASE}${path}`)
    );
    const data = await res.json();
    const ok = res.status === 503 && String(data.error).includes('DATABASE_NOT_CONFIGURED');
    record(`降级契约 ${method} ${path}`, ok, `HTTP ${res.status} ${data.error ?? ''}`, ms);
  } catch (e) {
    record(`降级契约 ${method} ${path}`, false, String(e));
  }
}

// ---------- 5. 全场模拟群面 ----------
let topic = '';
const history = [];

// 5.1 出题（流式）
try {
  const { ms } = await timed(async () => {
    const res = await postJson('/api/llm', { action: 'topic', payload: { company: TOPIC_COMPANY, jobTitle: TOPIC_JOB }, stream: true }, { timeoutMs: 120_000 });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    let deltas = 0;
    await readSse(res, (event, data) => {
      if (event === 'delta') deltas++;
      if (event === 'done') topic = data.content ?? '';
      if (event === 'error') throw new Error(data.message);
    });
    if (deltas === 0) throw new Error('无渐进 delta');
  });
  const ok = topic.includes('一、背景') && topic.includes('二、问题') && topic.includes('三、时间分配');
  record('群面① topic 流式出题', ok, `${topic.length} 字, 三段式${ok ? '齐全' : '缺失'}`, ms);
} catch (e) {
  record('群面① topic 流式出题', false, String(e));
}

// 5.2 三角色发言（首回合非流式 voice JSON；次回合流式；第三回合回应用户）
const userMsg1 = { senderId: 'user', senderName: '陈明', content: '我建议先按题目要点的顺序推进，先分析创作者流失的根因，再定激励方案。' };
try {
  // 回合 1：tech_visionary 非流式 + voiceMode（emotion/instruction 元数据）
  const { ms: ms1 } = await timed(async () => {
    const res = await postJson('/api/llm', {
      action: 'reply',
      payload: { card: { id: CARDS[0] }, topic, jobTitle: TOPIC_JOB, history, phase: '开局框架阶段', voiceMode: true },
      stream: false,
    }, { timeoutMs: 90_000 });
    const data = await res.json();
    if (!res.ok || !data.content) throw new Error(data.message ?? `HTTP ${res.status}`);
    history.push({ senderId: CARDS[0], senderName: '科技远见者', content: data.content });
    if (!data.emotion) throw new Error('缺 emotion');
  });
  record('群面② reply 非流式 voice JSON', true, `"${history[0].content.slice(0, 30)}…"`, ms1);

  // 回合 2：strategy_consultant 流式
  const { ms: ms2 } = await timed(async () => {
    const res = await postJson('/api/llm', {
      action: 'reply',
      payload: { card: { id: CARDS[1] }, topic, jobTitle: TOPIC_JOB, history, phase: '开局框架阶段', voiceMode: true },
      stream: true,
    }, { timeoutMs: 90_000 });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    let text = '';
    let deltas = 0;
    await readSse(res, (event, data) => {
      if (event === 'delta') { text += data.delta ?? ''; deltas++; }
      if (event === 'error') throw new Error(data.message);
    });
    if (!text || deltas === 0) throw new Error('无流式增量');
    history.push({ senderId: CARDS[1], senderName: '战略顾问', content: text });
  });
  record('群面③ reply 流式渐进', true, `"${history[1].content.slice(0, 30)}…"`, ms2);

  // 用户插入一条
  history.push(userMsg1);

  // 回合 3：hr_manager 必须回应用户
  const { ms: ms3 } = await timed(async () => {
    const res = await postJson('/api/llm', {
      action: 'reply',
      payload: { card: { id: CARDS[2] }, topic, jobTitle: TOPIC_JOB, history, phase: '深入讨论与方案贡献', voiceMode: false },
      stream: false,
    }, { timeoutMs: 90_000 });
    const data = await res.json();
    if (!res.ok || !data.content) throw new Error(data.message ?? `HTTP ${res.status}`);
    history.push({ senderId: CARDS[2], senderName: '招聘经理', content: data.content });
  });
  record('群面④ reply 回应用户发言', true, `"${history[2].content.slice(0, 30)}…"`, ms3);
} catch (e) {
  record('群面②-④ reply 链路', false, String(e));
}

// 5.3 analyze（报告 v1.5）
const sessionStartAt = Date.now() - 8 * 60 * 1000;
const analyzeMessages = [
  ...history.map((m, i) => ({
    id: String(i + 1), senderId: m.senderId, senderName: m.senderName,
    content: m.content, timestamp: sessionStartAt + (i + 1) * 60_000, type: 'message',
  })),
  { id: 'u2', senderId: 'user', senderName: '陈明', content: '我补充一点：激励方案要控制成本，先抓头部种子创作者试点。', timestamp: sessionStartAt + 6 * 60_000, type: 'message' },
];
let report = null;
try {
  const { ms } = await timed(async () => {
    const res = await postJson('/api/llm', {
      action: 'analyze',
      payload: {
        topic, jobTitle: TOPIC_JOB,
        messages: analyzeMessages,
        events: [{ event_type: 'interrupt', actor: CARDS[0], target: 'user', timestamp_ms: 200_000, metadata: { rule: 'user_over_30s' } }],
        sessionStartAt, durationMs: 8 * 60 * 1000, session_id: null,
      },
    }, { timeoutMs: 120_000 });
    report = await res.json();
    if (!res.ok) throw new Error(report.message ?? `HTTP ${res.status}`);
  });
  const d = report.dimensions;
  const ok =
    typeof report.overall_score === 'number' && report.overall_score >= 0 && report.overall_score <= 100 &&
    d?.content?.max === 40 && d?.voice?.max === 25 && d?.stress?.max === 20 && d?.teamwork?.max === 15 &&
    d?.visual?.status === 'not_enabled' &&
    Array.isArray(report.suggestions) && report.suggestions.length >= 3;
  record('群面⑤ analyze 报告 v1.5', ok, `总分 ${report.overall_score}, 维度 max 40/25/20/15, 建议 ${report.suggestions?.length} 条`, ms);
} catch (e) {
  record('群面⑤ analyze 报告 v1.5', false, String(e));
}

// 5.4 feedback（旧 4 字段）
try {
  let fb = null;
  const { ms } = await timed(async () => {
    const res = await postJson('/api/llm', {
      action: 'feedback',
      payload: { topic, jobTitle: TOPIC_JOB, history: analyzeMessages },
    }, { timeoutMs: 120_000 });
    fb = await res.json();
    if (!res.ok) throw new Error(fb.message ?? `HTTP ${res.status}`);
  });
  const ok =
    typeof fb.timing === 'string' && typeof fb.structuralContribution === 'string' &&
    typeof fb.interruptionHandling === 'string' && typeof fb.overallScore === 'number' &&
    Array.isArray(fb.suggestions) && fb.suggestions.length >= 3 &&
    typeof fb.voiceShare === 'number' && fb.voiceShare > 0;
  record('群面⑥ feedback 旧版报告', ok, ok ? `score ${fb.overallScore}, voiceShare ${fb.voiceShare}%` : '字段不完整', ms);
} catch (e) {
  record('群面⑥ feedback 旧版报告', false, String(e));
}

// ---------- 6. 语音：TTS 三音色 + ASR 回环 ----------
let roundtripPcm = null;
const roundtripText = '我建议先做用户调研，再确定激励方案。';
for (let i = 0; i < CARDS.length; i++) {
  try {
    const { r: pcm, ms } = await timed(async () => {
      const res = await postJson('/api/tts', { text: roundtripText, voice_id: CARD_VOICES[i] }, { timeoutMs: 60_000 });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const chunks = [];
      await readSse(res, (event, data) => {
        if (event === 'delta' && data.audio) chunks.push(data.audio);
        if (event === 'error') throw new Error(data.message);
      });
      if (chunks.length === 0) throw new Error('无音频分片');
      return Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64')));
    });
    if (i === 0) roundtripPcm = pcm;
    record(`语音① TTS[${CARD_VOICES[i]}]`, pcm.length > 10_000, `${(pcm.length / 2 / 24000).toFixed(1)}s 音频`, ms);
  } catch (e) {
    record(`语音① TTS[${CARD_VOICES[i]}]`, false, String(e));
  }
}

if (roundtripPcm) {
  try {
    const { r: text, ms } = await timed(async () => {
      // PCM → WAV
      const header = Buffer.alloc(44);
      const dataSize = roundtripPcm.length;
      header.write('RIFF', 0); header.writeUInt32LE(36 + dataSize, 4); header.write('WAVEfmt ', 8);
      header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
      header.writeUInt32LE(24000, 24); header.writeUInt32LE(48000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
      header.write('data', 36); header.writeUInt32LE(dataSize, 40);
      const wav = Buffer.concat([header, roundtripPcm]);
      const res = await postJson('/api/asr', { audio: wav.toString('base64'), format: { type: 'wav' } }, { timeoutMs: 60_000 });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      let final = '';
      let deltas = 0;
      await readSse(res, (event, data) => {
        if (event === 'delta') deltas++;
        if (event === 'done') final = data.text ?? '';
        if (event === 'error') throw new Error(data.message);
      });
      if (deltas === 0) throw new Error('无增量转写');
      return final;
    });
    const hit = ['用户调研', '激励'].filter((w) => text.includes(w)).length;
    record('语音② ASR 回环（TTS→ASR）', hit >= 1, `转写："${text}"`, ms);
  } catch (e) {
    record('语音② ASR 回环（TTS→ASR）', false, String(e));
  }
}

// ---------- 汇总 ----------
console.log(`\n=== 汇总：${passed} 通过 / ${failed} 失败 / 共 ${passed + failed} 项 ===\n`);
process.exit(failed > 0 ? 1 : 0);
