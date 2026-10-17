import type { GameEvent, Message, ReportV15 } from '../types';

export const LOCAL_PRACTICE_STORAGE_KEY = 'lgd-local-practice-v1';
const MAX_LOCAL_PRACTICE_RECORDS = 10;

export interface LocalPracticeRecord {
  id: string;
  company: string;
  jobTitle: string;
  topic: string;
  topicType: string;
  status: 'in_progress' | 'finished' | 'interrupted';
  startedAt: number;
  finishedAt?: number;
  score?: number;
  messages?: Message[];
  events?: GameEvent[];
  report?: ReportV15;
}

export function loadLocalPracticeRecords(): LocalPracticeRecord[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LOCAL_PRACTICE_STORAGE_KEY) || '[]');
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is LocalPracticeRecord =>
      !!item && typeof item === 'object' && typeof item.id === 'string' &&
      typeof item.topic === 'string' && typeof item.jobTitle === 'string'
    );
  } catch {
    return [];
  }
}

export function getLocalPracticeRecord(id: string): LocalPracticeRecord | null {
  return loadLocalPracticeRecords().find((record) => record.id === id) ?? null;
}

export function listLocalPracticeRecords(): LocalPracticeRecord[] {
  return loadLocalPracticeRecords().sort((a, b) => b.startedAt - a.startedAt);
}

export function saveLocalPracticeRecord(record: LocalPracticeRecord): boolean {
  const records = loadLocalPracticeRecords().filter((item) => item.id !== record.id);
  records.unshift(record);
  try {
    localStorage.setItem(LOCAL_PRACTICE_STORAGE_KEY, JSON.stringify(records.slice(0, MAX_LOCAL_PRACTICE_RECORDS)));
    return true;
  } catch {
    return false;
  }
}

export function deleteLocalPracticeRecord(id: string): boolean {
  const records = loadLocalPracticeRecords();
  try {
    localStorage.setItem(LOCAL_PRACTICE_STORAGE_KEY, JSON.stringify(records.filter((item) => item.id !== id)));
    return true;
  } catch {
    return false;
  }
}

export function createLocalPracticeId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `local-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
