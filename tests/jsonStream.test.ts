import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractJsonStringField, safeJsonParse } from '../api/_lib/jsonStream.ts';

test('JSON 流式提取：完整字段', () => {
  const buf = '{"content": "大家好，我认为应该先做调研", "emotion": "neutral"}';
  assert.equal(extractJsonStringField(buf, 'content'), '大家好，我认为应该先做调研');
});

test('JSON 流式提取：不完整缓冲区返回已解析部分', () => {
  const partial = '{"content": "大家';
  assert.equal(extractJsonStringField(partial, 'content'), '大家');
  const escaped = '{"content": "他说\\"你好\\"';
  assert.equal(extractJsonStringField(escaped, 'content'), '他说"你好"');
});

test('JSON 流式提取：字段未出现返回 null', () => {
  assert.equal(extractJsonStringField('{"emotion": "neutral"', 'content'), null);
  assert.equal(extractJsonStringField('', 'content'), null);
});

test('safeJsonParse：容错解析（带前后缀噪音）', () => {
  assert.deepEqual(safeJsonParse('前言 {"a": 1} 后记'), { a: 1 });
  assert.equal(safeJsonParse('完全不是 JSON'), null);
  assert.deepEqual(safeJsonParse('[1,2]'), [1, 2]);
});
