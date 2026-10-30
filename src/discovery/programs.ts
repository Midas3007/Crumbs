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
 * deploy; one getProgramAccounts call reads just those slots (~6 MB for ~24k programs), we take the
 * newest, then map each ProgramData address back to its program (tag 2 accounts point at it).
 * Helius rejects history lookups on the loader address, so this uses `listingConn` (the public RPC by default).
 */
export async function recentlyDeployedPrograms(listingConn: Connection, newest = 40): Promise<string[]> {
  const tag = (n: number) => Buffer.from([n, 0, 0, 0]).toString('base64');
  try {
    const programData = await listingConn.getProgramAccounts(BPF_UPGRADEABLE_LOADER, {
      filters: [{ memcmp: { offset: 0, bytes: tag(3), encoding: 'base64' } }],
      dataSlice: { offset: 4, length: 8 },
    });
    const latest = programData
      .filter(a => a.account.data.length === 8)
      .map(a => ({ address: a.pubkey.toBase58(), slot: a.account.data.readBigUInt64LE(0) }))
      .sort((a, b) => (b.slot > a.slot ? 1 : b.slot < a.slot ? -1 : 0))
      .slice(0, newest);
    const wanted = new Set(latest.map(l => l.address));
    // Program accounts: tag 2 followed by their ProgramData address (36 bytes in total).
    const programs = await listingConn.getProgramAccounts(BPF_UPGRADEABLE_LOADER, {
      filters: [{ dataSize: 36 }, { memcmp: { offset: 0, bytes: tag(2), encoding: 'base64' } }],
      dataSlice: { offset: 4, length: 32 },
    });
    const byProgramData = new Map(programs.map(p => [new PublicKey(p.account.data).toBase58(), p.pubkey.toBase58()]));
    return latest.map(l => byProgramData.get(l.address)).filter((p): p is string => Boolean(p && wanted));
  } catch (e) {
    log.warn('could not list recent deploys', { error: String(e) });
    return [];
  }
}
