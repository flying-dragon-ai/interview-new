import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLocalPracticeId,
  deleteLocalPracticeRecord,
  getLocalPracticeRecord,
  listLocalPracticeRecords,
  LOCAL_PRACTICE_STORAGE_KEY,
  saveLocalPracticeRecord,
  type LocalPracticeRecord,
} from '../src/localPractice.js';

class MemoryStorage {
  private values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
}

function withStorage(run: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: new MemoryStorage() });
  try { run(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

function record(id: string, startedAt: number): LocalPracticeRecord {
  return { id, company: '本地演示', jobTitle: '产品岗', topic: '预设题目', topicType: 'product_innovation', status: 'finished', startedAt };
}

test('local-only practice records are stored, updated, sorted, and deletable', () => {
  withStorage(() => {
    assert.equal(saveLocalPracticeRecord(record('one', 1)), true);
    assert.equal(saveLocalPracticeRecord({ ...record('one', 1), score: 82 }), true);
    assert.equal(getLocalPracticeRecord('one')?.score, 82);
    assert.deepEqual(listLocalPracticeRecords().map((item) => item.id), ['one']);
    assert.equal(deleteLocalPracticeRecord('one'), true);
    assert.equal(getLocalPracticeRecord('one'), null);
  });
});

test('local-only practice history is capped at the ten most recent records', () => {
  withStorage(() => {
    for (let index = 0; index < 12; index += 1) {
      assert.equal(saveLocalPracticeRecord(record(String(index), index)), true);
    }
    const records = listLocalPracticeRecords();
    assert.equal(records.length, 10);
    assert.equal(records[0].id, '11');
    assert.equal(records.at(-1)?.id, '2');
    assert.equal(localStorage.getItem(LOCAL_PRACTICE_STORAGE_KEY) !== null, true);
  });
});

test('local-only practice IDs are unique strings', () => {
  const first = createLocalPracticeId();
  const second = createLocalPracticeId();
  assert.equal(typeof first, 'string');
  assert.notEqual(first, second);
});
