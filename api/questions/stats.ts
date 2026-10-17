import type { VercelRequest, VercelResponse } from '@vercel/node';
import { QUESTION_BANK } from '../../data/questionBank.js';

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  return response.status(200).json({ total: QUESTION_BANK.length, byIndustry: QUESTION_BANK.reduce<Record<string, number>>((a, q) => ({ ...a, [q.industry]: (a[q.industry] || 0) + 1 }), {}), byType: QUESTION_BANK.reduce<Record<string, number>>((a, q) => ({ ...a, [q.topicType]: (a[q.topicType] || 0) + 1 }), {}) });
}
