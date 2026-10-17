import { keccak256, toBytes } from 'viem';
import type { ReportV15 } from '../../types';

export const SKILL_TAGS = [
  { key: 'content', label: '结构化表达' },
  { key: 'analysis', label: '问题分析' },
  { key: 'voice', label: '表达沟通' },
  { key: 'stress', label: '抗压处理' },
  { key: 'teamwork', label: '沟通协作' },
] as const;

export interface AssessmentProof {
  schema: 'interview-credential-proof/v1';
  sessionNonce: string;
  scoreSalt: string;
  scoreSummary: {
    overallScore: number;
    skills: Record<string, number>;
    reportVersion: string;
  };
  sessionHash: `0x${string}`;
  scoreHash: `0x${string}`;
  skillHashes: `0x${string}`[];
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function randomHex(bytes = 32): string {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  return `0x${Array.from(value, (part) => part.toString(16).padStart(2, '0')).join('')}`;
}

export function createAssessmentProof(report: ReportV15): AssessmentProof {
  const sessionNonce = randomHex();
  const scoreSalt = randomHex();
  const skills = {
    content: report.dimensions.content.score,
    analysis: Math.round((report.dimensions.content.score / report.dimensions.content.max) * 100),
    voice: report.dimensions.voice.score,
    stress: report.dimensions.stress.score,
    teamwork: report.dimensions.teamwork.score,
  };
  const scoreSummary = {
    overallScore: report.overall_score,
    skills,
    reportVersion: '1.0',
  };
  const sessionHash = keccak256(toBytes(sessionNonce));
  const scoreHash = keccak256(toBytes(stableStringify({ scoreSummary, scoreSalt })));
  const skillHashes = SKILL_TAGS.map(({ key, label }) => keccak256(toBytes(`${key}:${label}`)));

  return { schema: 'interview-credential-proof/v1', sessionNonce, scoreSalt, scoreSummary, sessionHash, scoreHash, skillHashes };
}

export function verifyAssessmentProof(proof: AssessmentProof): boolean {
  if (proof.schema !== 'interview-credential-proof/v1') return false;
  if (keccak256(toBytes(proof.sessionNonce)) !== proof.sessionHash) return false;
  if (keccak256(toBytes(stableStringify({ scoreSummary: proof.scoreSummary, scoreSalt: proof.scoreSalt }))) !== proof.scoreHash) return false;
  const expectedSkillHashes = SKILL_TAGS.map(({ key, label }) => keccak256(toBytes(`${key}:${label}`)));
  return stableStringify(expectedSkillHashes) === stableStringify(proof.skillHashes);
}
