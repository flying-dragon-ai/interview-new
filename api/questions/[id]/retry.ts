import type { VercelRequest, VercelResponse } from '@vercel/node';
import { QUESTION_BANK } from '../../../data/questionBank.js';

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  const question = QUESTION_BANK.find((item) => item.id === String(request.query.id));
  if (!question) return response.status(404).json({ error: 'QUESTION_NOT_FOUND' });
  return response.status(200).json({ question_id: question.id, mode: 'retry', source_type: 'curated_bank' });
}
