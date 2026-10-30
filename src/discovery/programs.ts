import { existsSync, readFileSync } from 'node:fs';
import { type Connection, PublicKey } from '@solana/web3.js';
import { log } from '../core/logger.js';

const BPF_UPGRADEABLE_LOADER = new PublicKey('BPFLoaderUpgradeab1e11111111111111111111111');

/** Programs to scan: your manual list (discovery/programs.json or DISCOVERY_PROGRAMS) plus recently deployed ones. */
export function manualPrograms(file = 'discovery/programs.json', env = process.env.DISCOVERY_PROGRAMS): string[] {
  const fromFile = existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as { programs: { id: string }[] }).programs.map(p => p.id) : [];
  const fromEnv = (env ?? '').split(',').map(s => s.trim()).filter(Boolean);
  return [...new Set([...fromFile, ...fromEnv])];
}

/**
 * Programs deployed or upgraded most recently.
 * Every upgradeable program has a ProgramData account (loader tag 3) holding the slot of its last
 * deploy. One getProgramAccounts call reads just those slots (~23.5k accounts, ~6 MB), parsed by hand
 * to keep memory low; then each of the newest is mapped to its program with a tiny exact-match lookup.
 * (Listing all ~80k program accounts instead ran a 512 MB server out of memory.)
 * Helius rejects history lookups on the loader address, so this uses `listingConn` (the public RPC by default).
 */
export async function recentlyDeployedPrograms(listingConn: Connection, newest = 40): Promise<string[]> {
  try {
    const res = await fetch(listingConn.rpcEndpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1, method: 'getProgramAccounts',
        params: [BPF_UPGRADEABLE_LOADER.toBase58(), {
          encoding: 'base64',
          dataSlice: { offset: 4, length: 8 },
          filters: [{ memcmp: { offset: 0, bytes: Buffer.from([3, 0, 0, 0]).toString('base64'), encoding: 'base64' } }],
        }],
      }),
      signal: AbortSignal.timeout(120_000),
    });
    const body = await res.json() as { result?: { pubkey: string; account: { data: [string, string] } }[]; error?: { message: string } };
    if (!body.result) throw new Error(body.error?.message ?? `HTTP ${res.status}`);
    // Keep the newest `newest` by slot without building objects for all ~23k.
    const latest: { address: string; slot: bigint }[] = [];
    for (const a of body.result) {
      const raw = Buffer.from(a.account.data[0], 'base64');
      if (raw.length !== 8) continue;
      const slot = raw.readBigUInt64LE(0);
      if (latest.length < newest || slot > latest[latest.length - 1].slot) {
        latest.push({ address: a.pubkey, slot });
        latest.sort((x, y) => (y.slot > x.slot ? 1 : y.slot < x.slot ? -1 : 0));
        if (latest.length > newest) latest.pop();
      }
    }
    body.result = undefined;

    const out: string[] = [];
    for (const { address } of latest) {
      // The program account is 36 bytes: tag 2, then its ProgramData address.
      const programs = await listingConn.getProgramAccounts(BPF_UPGRADEABLE_LOADER, {
        filters: [{ dataSize: 36 }, { memcmp: { offset: 4, bytes: address } }],
        dataSlice: { offset: 0, length: 0 },
      });
      if (programs[0]) out.push(programs[0].pubkey.toBase58());
    }
    return out;
  } catch (e) {
    log.warn('could not list recent deploys', { error: String(e) });
    return [];
  }
}
