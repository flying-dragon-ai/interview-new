import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveSpeaker, deriveSpeaker } from '../src/session/speakerTracker.ts';
import { SessionController, type SessionDeps } from '../src/session/sessionController.ts';
import { ROLE_CARDS } from '../data/roleCards.ts';
import type { SimulationState } from '../types.ts';
import type { ReplyResult } from '../services/geminiService.ts';

/**
 * M7 P2-3：说话人归属（speakerTracker 纯函数 + 控制器级三通道交错）
 * - Realtime 通道 → user/realtime；LLM+TTS 通道 → ai:<cardId>/llm；手动输入 → user/text；系统提示 → system
 * - 交错注入无错位、无串话
 */

test('resolveSpeaker：三通道 + 系统提示归属矩阵', () => {
  assert.deepEqual(resolveSpeaker({ via: 'realtime' }), { speaker: 'user', source: 'realtime' });
  assert.deepEqual(resolveSpeaker({ via: 'llm', cardId: 'ib_analyst' }), { speaker: 'ai:ib_analyst', source: 'llm' });
  assert.deepEqual(resolveSpeaker({ via: 'text' }), { speaker: 'user', source: 'text' });
  assert.deepEqual(resolveSpeaker({ via: 'system' }), { speaker: 'system' });
});

test('deriveSpeaker：旧数据缺省时由 senderId 派生（向后兼容）', () => {
  assert.equal(deriveSpeaker('user'), 'user');
  assert.equal(deriveSpeaker('system'), 'system');
  assert.equal(deriveSpeaker('ib_analyst'), 'ai:ib_analyst');
});

const cards = [
  ROLE_CARDS.find((c) => c.id === 'ib_analyst')!,
  ROLE_CARDS.find((c) => c.id === 'strategy_consultant')!,
  ROLE_CARDS.find((c) => c.id === 'ops_director')!,
];

const simState: SimulationState = {
  topic: '是否应在全行业推行远程办公？请讨论效率、协作与成本三个要点。',
  jobTitle: '产品经理',
  company: '测试公司',
  messages: [],
  status: 'DISCUSSING',
  activeCharacterId: null,
  round: 0,
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('控制器级交错：文字 → AI → Realtime 转写 → 系统消息，speaker/source 无错位', async () => {
  const fakeReply = async (_p: unknown, onChunk: (c: string) => void): Promise<ReplyResult> => {
    onChunk('补充');
    return { content: '我补充一个落地视角。', emotion: 'neutral', target: null, stepfun_tts_instruction: null };
  };
  const deps: SessionDeps = {
    state: simState,
    roles: cards,
    sessionId: null,
    consentSaveTranscript: false,
    cameraEnabled: false,
    facingMode: 'user',
    onFinish: () => undefined,
    generateReply: fakeReply as SessionDeps['generateReply'],
  };
  const c = new SessionController(deps);
  c.forcePhaseForTest({ phaseIndex: 2, phaseStartedAt: Date.now(), openingIndex: 4, openingStartedAt: Date.now(), finished: false });

  // 1) AI 发言（调度触发，注入 LLM；先 AI 避免用户发言后的 12s 优先等待窗）
  c.scheduleNextTurn(5);
  await sleep(150);
  // 2) 手动输入
  c.sendTextMessage('先做用户调研。');
  // 3) Realtime 最终转写
  c.sendUserSpeech('我同意，补充成本视角。', 0.93);
  // 4) 系统提示（直接 addMessage，走 deriveSpeaker 兼容路径的旧格式）
  c.addMessage({
    id: 'sys-1',
    senderId: 'system',
    senderName: '系统',
    content: '自由讨论开始',
    timestamp: Date.now(),
    type: 'system',
    speaker: 'system',
  });

  const msgs = c.store.getSnapshot().messages;
  assert.equal(msgs.length, 4);
  // 无错位：逐条核对说话人与来源
  assert.deepEqual(
    msgs.map((m) => [m.speaker, m.source]),
    [
      [msgs[0].speaker, 'llm'],
      ['user', 'text'],
      ['user', 'realtime'],
      ['system', undefined],
    ]
  );
  // AI 条的 speaker 必须是 ai:<senderId> 且与其他条不串
  assert.equal(msgs[0].speaker, `ai:${msgs[0].senderId}`);
  assert.ok(cards.some((k) => `ai:${k.id}` === msgs[0].speaker));
  // Realtime 条的置信度保留
  assert.equal(msgs[2].confidence, 0.93);
  c.dispose();
});
