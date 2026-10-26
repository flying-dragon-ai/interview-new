import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PANEL_SIZE } from '../types.ts';
import { autoSelectPanel, autoSelectRoles, validatePanelSelection, validateSelection } from '../engine/roleSelector.ts';
import { buildTopicPrompt } from '../api/_lib/prompts.ts';
import { generateTopicStream } from '../services/geminiService.ts';

test('default panel has two valid interviewers; LGD continues to allocate three AI candidates', () => {
  assert.equal(DEFAULT_PANEL_SIZE, 2);
  for (const industry of ['tech', 'finance', 'consulting', 'hr']) {
    for (let seed = 1; seed <= 50; seed++) {
      const panel = autoSelectPanel(industry, seed);
      assert.equal(panel.length, 2);
      assert.deepEqual(validatePanelSelection(panel, 2), []);
      const lgd = autoSelectRoles(industry, seed);
      assert.equal(lgd.length, 3);
      assert.deepEqual(validateSelection(lgd), []);
    }
  }
  assert.equal(autoSelectPanel('tech', 42, 3).length, 3);
});

test('panel preparation generates an individual interview outline regardless of LGD topic type', () => {
  const prompt = buildTopicPrompt('测试公司', '产品经理', { format: 'panel', topicType: 'open_debate' });
  assert.match(prompt, /结构化单面提纲/);
  assert.match(prompt, /候选人只有一位/);
  assert.match(prompt, /开场问题/);
  assert.doesNotMatch(prompt, /本次题型要求|三、时间分配|请你们在小组讨论/);
  assert.equal(prompt, buildTopicPrompt('测试公司', '产品经理', { format: 'panel' }));
});

test('each LGD topic selection reaches the question generation prompt', () => {
  for (const [topicType, label] of [
    ['business_case', '商业案例题'], ['open_debate', '开放辩论题'],
    ['resource_competition', '资源争夺题'], ['priority_ranking', '优先级排序题'],
  ]) {
    assert.ok(buildTopicPrompt('测试公司', '产品经理', { format: 'lgd', topicType }).includes('本次题型要求：' + label));
  }
});

test('topic client sends the selected mode and LGD question type to the API', async (t) => {
  const original = globalThis.fetch;
  t.after(() => { globalThis.fetch = original; });
  let payload: any;
  globalThis.fetch = (async (_url, init) => {
    payload = JSON.parse(String(init?.body)).payload;
    return new Response('event: done\ndata: {"content":"准备内容"}\n\n', {
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as typeof fetch;
  const content = await generateTopicStream('测试公司', '产品经理', () => {}, { format: 'lgd', topicType: 'priority_ranking' });
  assert.equal(content, '准备内容');
  assert.equal(payload.format, 'lgd');
  assert.equal(payload.topicType, 'priority_ranking');
  await generateTopicStream('测试公司', '产品经理', () => {}, { format: 'panel' });
  assert.equal(payload.format, 'panel');
  assert.equal(payload.topicType, undefined);
});
