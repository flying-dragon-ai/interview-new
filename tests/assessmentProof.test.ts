import test from 'node:test';
import assert from 'node:assert/strict';
import { createAssessmentProof, verifyAssessmentProof } from '../src/onchain/assessmentProof.ts';
import type { Evidence, ReportV15 } from '../types';

const dimension = (score: number) => ({ score, max: 100, evidence: [] as Evidence[] });
const report: ReportV15 = {
  session_id: null,
  overall_score: 82,
  dimensions: {
    content: dimension(82),
    voice: dimension(76),
    visual: { ...dimension(0), status: 'not_enabled' },
    stress: dimension(73),
    teamwork: dimension(88),
  },
  suggestions: [],
};

test('assessment proof hashes are stable to verify and do not disclose report text', () => {
  const proof = createAssessmentProof(report);
  assert.equal(verifyAssessmentProof(proof), true);
  assert.equal(JSON.stringify(proof).includes('suggestions'), false);
  assert.equal(proof.skillHashes.length, 5);
});

test('assessment proof verification detects a changed score', () => {
  const proof = createAssessmentProof(report);
  proof.scoreSummary.overallScore = 99;
  assert.equal(verifyAssessmentProof(proof), false);
});
