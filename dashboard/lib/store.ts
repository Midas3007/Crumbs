import { readFile } from 'node:fs/promises';
import { get, put } from '@vercel/blob';
import { isSnapshot, type Snapshot } from './types';

const PATH = 'crumbs/snapshot.json';
// Older stores inject BLOB_READ_WRITE_TOKEN; newer ones inject BLOB_STORE_ID and sign in with Vercel OIDC (handled by the SDK).
const useBlob = () => Boolean(process.env.BLOB_READ_WRITE_TOKEN || process.env.BLOB_STORE_ID);

/** Latest snapshot pushed by the agent: Vercel Blob in production, a local file in development. */
export async function loadSnapshot(): Promise<Snapshot | null> {
  try {
    if (useBlob()) {
      const r = await get(PATH, { access: 'private', useCache: false });
      if (!r) return null;
      const json: unknown = await new Response(r.stream).json();
      return isSnapshot(json) ? json : null;
    }
    const json: unknown = JSON.parse(await readFile(/*turbopackIgnore: true*/ process.env.SNAPSHOT_FILE ?? '../data/snapshot.json', 'utf8'));
    return isSnapshot(json) ? json : null;
  } catch {
    return null;
  }
}

export async function saveSnapshot(s: Snapshot): Promise<void> {
  if (!useBlob()) throw new Error('No Blob store connected to this Vercel project (BLOB_STORE_ID / BLOB_READ_WRITE_TOKEN missing)');
  await put(PATH, JSON.stringify(s), { access: 'private', allowOverwrite: true, addRandomSuffix: false, contentType: 'application/json' });
}
