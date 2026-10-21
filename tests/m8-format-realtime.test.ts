import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RealtimeClient,
  type RealtimeEvents,
  type WsLike,
} from '../services/realtimeClient.ts';
import { RealtimePlayback } from '../services/realtimePlayback.ts';
import { validatePanelSelection, validateSelection } from '../engine/roleSelector.ts';
import { buildHostPrompt, buildPanelInterviewerPrompt } from '../api/_lib/prompts.ts';
import { ROLE_CARDS } from '../data/roleCards.ts';
import { HOST_CARD } from '../data/interviewerCards.ts';
import type { RoleCard } from '../types.ts';

/**
 * M8：全面切换实时对话 + 群面双阵型测试
 * - RealtimeClient.speak → conversation.item.create（台词指令）+ response.create
 * - response.audio.delta → 入队播放（RealtimePlayback mock）；audio_transcript → 字幕回调
 * - VAD speech_started → 停 AI 播放 + response.cancel（barge-in）
 * - validatePanelSelection：3 面试官音色/形象去重，无性格互补约束
 * - buildHostPrompt / buildPanelInterviewerPrompt：身份与输出格式
 */

class MockWs implements WsLike {
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev?: { code?: number }) => void) | null = null;
  onerror: ((ev?: unknown) => void) | null = null;
  send(data: string): void {
    this.sent.push(data);
  }
  close(): void {
    this.readyState = 3;
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.();
  }
  emit(obj: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  sentJson(): Record<string, unknown>[] {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>);
  }
}

class FakePlayback {
  enqueueCalls: string[] = [];
  stopped = 0;
  playing = false;
  enqueue(b64: string): void {
    this.enqueueCalls.push(b64);
    this.playing = true;
  }
  stop(): void {
    this.stopped += 1;
    this.playing = false;
  }
  getPlaybackAnalyser(): null {
    return null;
  }
}

async function makeClient() {
  const log: string[] = [];
  const playback = new FakePlayback();
  const events: RealtimeEvents = {
    onVadStart: () => log.push('vadStart'),
    onVadStop: () => log.push('vadStop'),
    onUserTranscript: () => log.push('transcript'),
    onError: () => log.push('error'),
    onClose: () => log.push('close'),
    onAssistantTextDelta: (t) => log.push(`delta:${t}`),
    onAssistantTextDone: (t) => log.push(`done:${t}`),
    onPlaybackChange: (speaking) => log.push(`playback:${speaking}`),
  };
  const sockets: MockWs[] = [];
  const fetchFn = (async () =>
    new Response(JSON.stringify({ token: 't.sig', model: 'stepaudio-3-realtime-preview' }), { status: 200 })) as typeof fetch;
  const client = await RealtimeClient.create({
    events,
    fetchFn,
    playbackFactory: () => playback as unknown as RealtimePlayback,
    wsFactory: () => {
      const ws = new MockWs();
      sockets.push(ws);
      return ws;
    },
    micFactory: async () => ({ stop: () => undefined }),
    confirmWindowMs: 10,
    cooldownMs: 10,
    reconnectDelaysMs: [5],
  });
  client.start();
  sockets[0].open();
  return { client, sockets, playback, log };
}

test('speak：台词注入 = conversation.item.create(user 文本) + response.create', async () => {
  const h = await makeClient();
  h.client.speak('请谈谈你的项目经历');
  const msgs = h.sockets[0].sentJson();
  const create = msgs.find((m) => m.type === 'conversation.item.create') as {
    item: { role: string; content: { type: string; text: string }[] };
  };
  assert.ok(create, '未发送 conversation.item.create');
  assert.equal(create.item.role, 'user');
  assert.ok(create.item.content[0].text.includes('台词播报'), '台词指令缺失');
  assert.ok(create.item.content[0].text.includes('项目经历'), '台词正文缺失');
  const resp = msgs.find((m) => m.type === 'response.create');
  assert.ok(resp, '未触发 response.create');
  // 空台词不发送
  const before = h.sockets[0].sent.length;
  h.client.speak('   ');
  assert.equal(h.sockets[0].sent.length, before);
});

test('response.audio.delta → 播放入队；audio_transcript → 字幕回调；speech_started → 停播 + cancel', async () => {
  const h = await makeClient();
  h.sockets[0].emit({ type: 'response.audio.delta', delta: 'QUJD' });
  h.sockets[0].emit({ type: 'response.audio_transcript.delta', delta: '你' });
  h.sockets[0].emit({ type: 'response.audio_transcript.done', text: '你好' });
  h.sockets[0].emit({ type: 'response.done' });
  assert.deepEqual(h.playback.enqueueCalls, ['QUJD']);
  assert.ok(h.log.includes('delta:你'), '字幕增量未回调');
  assert.ok(h.log.includes('done:你好'), '字幕完结未回调');
  assert.ok(h.log.includes('playback:true'), '播放态未上报');

  // barge-in：VAD 起点立即停播放 + response.cancel
  h.sockets[0].emit({ type: 'input_audio_buffer.speech_started' });
  assert.ok(h.playback.stopped >= 1, 'VAD 未停止 AI 播放');
  assert.ok(h.log.includes('playback:false'), '停止后播放态未收敛');
  const cancel = h.sockets[0].sentJson().filter((m) => m.type === 'response.cancel');
  assert.ok(cancel.length >= 1, '未发送 response.cancel');
});

test('stopAISpeech：手动打断 → response.cancel + 播放停止', async () => {
  const h = await makeClient();
  h.sockets[0].emit({ type: 'response.audio.delta', delta: 'QUJD' });
  h.client.stopAISpeech();
  assert.ok(h.playback.stopped >= 1);
  assert.ok(h.sockets[0].sentJson().some((m) => m.type === 'response.cancel'));
  assert.ok(h.log.includes('playback:false'));
});

test('session.update 携带默认逐字播报 instructions', async () => {
  const h = await makeClient();
  const update = h.sockets[0].sentJson().find((m) => m.type === 'session.update') as {
    session: { instructions?: string; turn_detection?: { type: string } };
  };
  assert.ok(update.session.instructions?.includes('台词播报'), '缺省播报指令缺失');
  assert.equal(update.session.turn_detection.type, 'server_vad');
});

// ==================== 阵型 ====================

const pick = (ids: string[]): RoleCard[] => ids.map((id) => ROLE_CARDS.find((c) => c.id === id)!).filter(Boolean);

test('validatePanelSelection：3 面试官音色/形象去重，无性格互补约束', () => {
  // 音色/形象/策略均不重复的合法组合
  const ok = pick(['tech_visionary', 'product_legend', 'supply_chain_master']);
  assert.deepEqual(validatePanelSelection(ok), []);
  // 同一组合若用于候选人（lgd）同样合法（兼容）
  assert.deepEqual(validateSelection(ok), []);
  // 音色重复 → panel 违规
  const dupVoice = pick(['tech_visionary', 'crypto_pioneer', 'product_legend']); // tech_visionary 与 crypto_pioneer 同 voice_01
  assert.ok(validatePanelSelection(dupVoice).some((v) => v.rule === 'voice_unique'));
  // 数量不足
  assert.ok(validatePanelSelection(ok.slice(0, 2)).some((v) => v.rule === 'count'));
});

test('buildHostPrompt：主持台词指令，不发表业务观点', () => {
  const card = ROLE_CARDS[0];
  const prompt = buildHostPrompt({
    card,
    topic: '共享单车乱停问题',
    jobTitle: '产品经理',
    history: [],
    phase: '深入讨论与方案贡献',
    voiceMode: true,
    speakerKind: 'host',
  });
  assert.ok(prompt.includes('主持面试官'), 'host 身份缺失');
  assert.ok(prompt.includes('自由讨论'), '阶段任务缺失');
  assert.ok(prompt.includes('"content"'), 'JSON 输出格式缺失');
});

test('buildPanelInterviewerPrompt：单面提问指令，每次只问一个问题', () => {
  const card = ROLE_CARDS[0];
  const prompt = buildPanelInterviewerPrompt({
    card,
    topic: '字节跳动产品岗背景题',
    jobTitle: '产品经理',
    history: [{ senderId: 'user', senderName: '用户', content: '我做过一个增长项目' }],
    phase: '深入讨论与方案贡献',
    voiceMode: true,
    speakerKind: 'interviewer',
  });
  assert.ok(prompt.includes('面试官'), 'interviewer 身份缺失');
  assert.ok(prompt.includes('唯一候选人') || prompt.includes('候选人只有一位'), '候选人约束缺失');
  assert.ok(prompt.includes('每次发言只包含一个问题'), '单问约束缺失');
  assert.ok(prompt.includes('增长项目'), '候选人上下文未注入');
});
