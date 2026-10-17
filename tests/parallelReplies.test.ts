import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAIRepliesInParallel, type ReplyParams } from '../services/geminiService.ts';

test('demo candidate replies start concurrently and retain input order', async () => {
  let active = 0;
  let maximumActive = 0;
  const params = [{ card: { id: 'a' } }, { card: { id: 'b' } }, { card: { id: 'c' } }] as ReplyParams[];
  const replies = await generateAIRepliesInParallel(params, async ({ card }) => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    return { content: card.id, emotion: 'neutral', target: null, stepfun_tts_instruction: null };
  });

  assert.equal(maximumActive, 3);
  assert.deepEqual(replies.map((reply) => reply.content), ['a', 'b', 'c']);
});
