import type { VercelRequest, VercelResponse } from '@vercel/node';
import asrToken from './asr-token.js';
import asr from './asr.js';
import avatars from './avatars.js';
import events from './events.js';
import feedback from './feedback.js';
import llm from './llm.js';
import message from './message.js';
import practiceHistory from './practice-history.js';
import practiceReview from './practice/[id]/review.js';
import question from './questions/[id].js';
import questionFavorite from './questions/[id]/favorite.js';
import questionRetry from './questions/[id]/retry.js';
import questions from './questions.js';
import randomQuestion from './questions/random.js';
import questionStats from './questions/stats.js';
import session from './session.js';
import sessionAnalyze from './sessions/[id]/analyze.js';
import sessionById from './sessions/[id]/index.js';
import sessionReport from './sessions/[id]/report.js';
import ttsToken from './tts-token.js';
import tts from './tts.js';

type Handler = (request: VercelRequest, response: VercelResponse) => unknown;
type Route = { handler: Handler; id?: string };

/** Resolve public API paths to existing route handlers. This keeps one Vercel
 * Function entrypoint while preserving the existing handler implementations. */
export function resolveApiRoute(path: string): Route | null {
  const normalized = `/${path.replace(/^\/+/, '').replace(/^api\//, '')}`.replace(/\/$/, '') || '/';
  const staticHandlers: Record<string, Route> = {
    '/llm': { handler: llm },
    '/session': { handler: session },
    '/message': { handler: message },
    '/feedback': { handler: feedback },
    '/events': { handler: events },
    '/avatars': { handler: avatars },
    '/avatars/presets': { handler: avatars },
    '/tts': { handler: tts },
    '/asr': { handler: asr },
    '/tts-token': { handler: ttsToken },
    '/asr-token': { handler: asrToken },
    '/practice-history': { handler: practiceHistory },
    '/questions': { handler: questions },
    '/questions/random': { handler: randomQuestion },
    '/questions/stats': { handler: questionStats },
  };
  const exact = staticHandlers[normalized];
  if (exact) return exact;

  let match = normalized.match(/^\/questions\/([^/]+)\/(favorite|retry)$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const action = match[2];
    return { id, handler: action === 'favorite' ? questionFavorite : questionRetry };
  }
  match = normalized.match(/^\/questions\/([^/]+)$/);
  if (match) return { id: decodeURIComponent(match[1]), handler: question };
  match = normalized.match(/^\/practice\/([^/]+)\/review$/);
  if (match) return { id: decodeURIComponent(match[1]), handler: practiceReview };
  match = normalized.match(/^\/sessions\/([^/]+)(?:\/(analyze|report))?$/);
  if (match) {
    const id = decodeURIComponent(match[1]);
    const subroute = match[2];
    const handler = subroute === 'analyze'
      ? sessionAnalyze
      : subroute === 'report'
        ? sessionReport
        : sessionById;
    return { id, handler };
  }
  return null;
}

export default async function handler(request: VercelRequest, response: VercelResponse) {
  const forwardedPath = request.query.path;
  const path = Array.isArray(forwardedPath) ? forwardedPath.join('/') : forwardedPath;
  const route = resolveApiRoute(path || request.url?.split('?')[0] || '');
  if (!route) return response.status(404).json({ error: 'API_ROUTE_NOT_FOUND' });

  const query = { ...request.query };
  delete query.path;
  if (route.id !== undefined) query.id = route.id;
  request.query = query;

  try {
    return await route.handler(request, response);
  } catch (error) {
    console.error('[api-router] handler failed:', error);
    return response.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
  }
}
