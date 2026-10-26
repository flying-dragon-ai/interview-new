import type { VercelRequest, VercelResponse } from '@vercel/node';
import session from './_sessions/[id]/index.ts';
import analyze from './_sessions/[id]/analyze.ts';
import report from './_sessions/[id]/report.ts';
import visual from './_sessions/[id]/visual.ts';

const handlers = { session, analyze, report, visual };

/**
 * One deployed function for the existing /api/sessions/:id[/action] endpoints.
 * Vercel rewrites supply __sessionRoute; Vite passes the original URL.
 * Keep implementations under an underscore directory so Vercel does not deploy
 * them as additional functions.
 */
export default async function handler(request: VercelRequest, response: VercelResponse) {
  const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
  const originalRoute = pathname.startsWith('/api/sessions/')
    ? pathname.slice('/api/sessions/'.length)
    : undefined;
  const route = originalRoute ?? request.query.__sessionRoute;
  const match = typeof route === 'string'
    ? /^(\d+)(?:\/(analyze|report|visual))?\/?$/.exec(route)
    : null;
  if (!match) {
    return response.status(404).json({ error: 'Not found' });
  }

  // The path ID takes precedence over a caller-supplied ?id= query parameter.
  request.query = { ...request.query, id: match[1] };
  const action = (match[2] ?? 'session') as keyof typeof handlers;
  return handlers[action](request, response);
}
