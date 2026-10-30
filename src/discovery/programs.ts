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
 * Programs deployed or upgraded recently, read from the upgradeable loader's own transactions.
 * Loader instruction 2 = DeployWithMaxDataLen (program is account #2), 3 = Upgrade (program is account #1).
 */
export async function recentlyDeployedPrograms(conn: Connection, scan = 40): Promise<string[]> {
  const out = new Set<string>();
  try {
    const sigs = await conn.getSignaturesForAddress(BPF_UPGRADEABLE_LOADER, { limit: scan });
    for (const s of sigs) {
      if (s.err) continue;
      const tx = await conn.getTransaction(s.signature, { maxSupportedTransactionVersion: 0 });
      if (!tx?.meta) continue;
      const msg = tx.transaction.message;
      const keys = msg.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
      for (const ix of msg.compiledInstructions) {
        if (!keys.get(ix.programIdIndex)?.equals(BPF_UPGRADEABLE_LOADER) || ix.data.length < 4) continue;
        const kind = Buffer.from(ix.data).readUInt32LE(0);
        const programIdx = kind === 2 ? ix.accountKeyIndexes[2] : kind === 3 ? ix.accountKeyIndexes[1] : undefined;
        const program = programIdx !== undefined ? keys.get(programIdx) : undefined;
        if (program) out.add(program.toBase58());
      }
    }
  } catch (e) {
    log.warn('could not list recent deploys', { error: String(e) });
  }
  return [...out];
}
