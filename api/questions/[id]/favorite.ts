import type { VercelRequest, VercelResponse } from '@vercel/node';
import { QUESTION_BANK } from '../../../data/questionBank.js';

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'POST' && request.method !== 'DELETE') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  const id = String(request.query.id || '');
  if (!QUESTION_BANK.some((item) => item.id === id)) return response.status(404).json({ error: 'QUESTION_NOT_FOUND' });
  return response.status(200).json({ question_id: id, favorited: request.method === 'POST' });
}
