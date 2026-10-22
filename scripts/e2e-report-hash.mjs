/**
 * E2E：用前端同款 reportHash 模块计算报告哈希（与 CertificateSection 铸证时完全一致）。
 * 用法：node tmp/e2e-report-hash.mjs <minter-address>
 * 输出：CANONICAL=<规范化 JSON> / HASH=<keccak256>
 */
import {
  buildReportHash,
  canonicalize,
  CERT_APP_ID,
  CERT_PAYLOAD_VERSION,
} from '../src/onchain/reportHash.ts';

const minter = (process.argv[2] ?? '0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc').toLowerCase();

// 与 types.ts ReportV15 / Evidence 对齐的样例报告（一场开启语音、未开摄像头的练习）
const report = {
  session_id: 42,
  overall_score: 85,
  dimensions: {
    content: {
      score: 80,
      max: 100,
      evidence: [
        {
          id: 'ev-1',
          modality: 'voice',
          timestamp_ms: 128000,
          content: '我认为应该先明确目标用户再谈增长',
          dimension_hint: 'content',
          message_index: 3,
        },
      ],
      metrics: { 发言次数: 5, 关键词命中: 4 },
    },
    voice: { score: 82, max: 100, evidence: [], metrics: { 话语权占比: 34 } },
    visual: {
      score: 0,
      max: 100,
      status: 'not_enabled',
      evidence: [],
      note: '本场未开启',
    },
    stress: {
      score: 78,
      max: 100,
      evidence: [
        {
          id: 'ev-2',
          modality: 'event',
          timestamp_ms: 156000,
          content: '被打断后 2 秒内夺回发言权',
          dimension_hint: 'stress',
          message_index: 9,
        },
      ],
      metrics: { 被打断次数: 2 },
    },
    teamwork: { score: 88, max: 100, evidence: [], metrics: { 协作发言: 3 } },
  },
  suggestions: ['多总结他人观点再引申', '控制单次发言时长在 40 秒内'],
  created_at: '2026-10-17T03:00:00.000Z',
};

const payload = { v: CERT_PAYLOAD_VERSION, app: CERT_APP_ID, minter, report };
console.log('CANONICAL=' + canonicalize(payload));
console.log('HASH=' + buildReportHash(payload));
