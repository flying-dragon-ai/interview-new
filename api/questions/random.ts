import type { VercelRequest, VercelResponse } from '@vercel/node';
import { QUESTION_BANK } from '../../data/questionBank.js';

export default function handler(request: VercelRequest, response: VercelResponse) {
  if (request.method !== 'GET') return response.status(405).json({ error: 'METHOD_NOT_ALLOWED' });
  const { industry, job, topic_type: topicType } = request.query;
  const rows = QUESTION_BANK.filter((q) => (!industry || q.industry === String(industry)) && (!topicType || q.topicType === String(topicType)) && (!job || q.jobKeys.includes(String(job))));
  const pool = rows.length ? rows : QUESTION_BANK;
  const question = pool[Math.floor(Math.random() * pool.length)];
  return response.status(200).json({ ...question, source_type: 'curated_bank', difficulty: 'standard', estimated_duration: 35 });
}
