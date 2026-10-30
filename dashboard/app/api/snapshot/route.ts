import { timingSafeEqual } from 'node:crypto';
import { loadSnapshot, saveSnapshot } from '@/lib/store';
import { isSnapshot } from '@/lib/types';

export const dynamic = 'force-dynamic';

function authorized(req: Request): boolean {
  const secret = process.env.CRUMBS_PUSH_SECRET;
  const given = req.headers.get('authorization')?.replace(/^Bearer /, '') ?? '';
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

/** The agent pushes its latest snapshot here every minute. */
export async function POST(req: Request) {
  if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const text = await req.text();
  if (text.length > 1_000_000) return Response.json({ error: 'snapshot too large' }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 });
  }
  if (!isSnapshot(body)) return Response.json({ error: 'not a Crumbs snapshot (version 1)' }, { status: 400 });
  await saveSnapshot(body);
  return Response.json({ ok: true, generatedAt: body.generatedAt });
}

/** Public, read-only: the same data the page shows, for anyone who wants to verify or build on it. */
export async function GET() {
  const s = await loadSnapshot();
  return s ? Response.json(s, { headers: { 'cache-control': 'no-store' } }) : Response.json({ error: 'no data yet' }, { status: 404 });
}
