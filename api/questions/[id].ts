import type { VercelRequest, VercelResponse } from '@vercel/node';
import { QUESTION_BANK } from '../../data/questionBank.js';

export default function handler(request: VercelRequest, response: VercelResponse) {
  const id = String(request.query.id || '');
  const question = QUESTION_BANK.find((q) => q.id === id);
  if (!question) return response.status(404).json({ error: 'QUESTION_NOT_FOUND' });
  if (request.method === 'GET') return response.status(200).json({ ...question, source_type: 'curated_bank', difficulty: 'standard', estimated_duration: 35 });
  if (request.method === 'POST') return response.status(200).json({ question_id: question.id, status: 'started' });
  return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
}
