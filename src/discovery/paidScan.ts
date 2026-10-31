import { base58Decode } from '../core/base58.js';
import type { Ledger } from '../core/ledger.js';
import { log } from '../core/logger.js';
import { COVERED } from './covered.js';

/**
 * Who gets paid to call what? Samples recent blocks and keeps every successful transaction whose signer
 * ended up with more SOL than before (after the fee), with none of its own tokens going down (so not a
 * sale, swap or withdrawal into SOL). Grouped by program and instruction, the leftovers are the chores
 * someone is being paid to do. This is how ORE's checkpoint bounty was found (Oct 31); it needs no Claude
 * and no IDL, so it sees programs discovery can't.
 *
 * It only *finds* candidates. New programs go to the discovery engine (Claude classification and the
 * deterministic replay with our wallet), and the owner gets a Telegram summary.
 */

/** Plumbing every transaction uses: ignored when deciding which program was called. */
const INFRA = new Set([
  'ComputeBudget111111111111111111111111111111', '11111111111111111111111111111111', 'Vote111111111111111111111111111111111111111',
  'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb', 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  'Ed25519SigVerify111111111111111111111111111', 'KeccakSecp256k11111111111111111111111111111', 'AddressLookupTab1e1111111111111111111111111',
  'Stake11111111111111111111111111111111111111',
]);

/** Trading, liquidity and launchpad programs: a "gain" there is the user's own money, never a chore. */
export const TRADING = new Set([
  'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA', // PumpSwap
  '6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P', // Pump.fun
  'LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo', // Meteora DLMM
  'cpamdpZCGKUy5JxQXB4dcpGPiikHawvSWAd6mEn1sGG', // Meteora DAMM v2
  'Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UaB', // Meteora DAMM v1
  '675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8', // Raydium AMM v4
  'CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK', // Raydium CLMM
  'CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C', // Raydium CPMM
  'LanMV9sAd7wArD4vJFi2qDdfnVhFxYSUg6eADduJ3uj', // Raydium LaunchLab
  'JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4', // Jupiter
  'whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc', // Orca
  'PhoeNiXZ8ByJGLkxNfZRnkUfjvmuYqLR89jjFHGqdXY', // Phoenix
  'rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ', // Pyth receiver (closing one's own price updates)
]);

export interface PaidCall {
  program: string;
  /** First 8 bytes of the instruction data, hex (Anchor discriminator; Steel programs use the first byte). */
  discriminator: string;
  /** "Instruction: X" from the logs, when the program logs it. */
  name?: string;
  payer: string;
  netLamports: number;
  signature: string;
}

export interface PaidGroup {
  key: string;
  program: string;
  discriminator: string;
  name?: string;
  calls: number;
  payers: number;
  medianNetLamports: number;
  example: string;
}

interface RawTx {
  meta: {
    err: unknown; fee: number; preBalances: number[]; postBalances: number[];
    preTokenBalances?: { accountIndex: number; owner?: string; uiTokenAmount: { amount: string } }[];
    postTokenBalances?: { accountIndex: number; owner?: string; uiTokenAmount: { amount: string } }[];
    loadedAddresses?: { writable: string[]; readonly: string[] };
    logMessages?: string[];
  } | null;
  transaction: { signatures: string[]; message: { accountKeys: string[]; instructions: { programIdIndex: number; data: string }[] } };
}

/** The paid calls in one block (pure, so it can be tested on recorded data). */
export function paidCalls(txs: RawTx[]): PaidCall[] {
  const out: PaidCall[] = [];
  for (const t of txs) {
    const m = t.meta;
    if (!m || m.err) continue;
    const keys = [...t.transaction.message.accountKeys, ...(m.loadedAddresses?.writable ?? []), ...(m.loadedAddresses?.readonly ?? [])];
    const payer = keys[0];
    const net = m.postBalances[0] - m.preBalances[0];
    if (net <= 0) continue;
    // The payer's own tokens must not go down (that would be selling or swapping into SOL).
    const own = (arr: NonNullable<typeof m.preTokenBalances>) => new Map(arr.filter(x => x.owner === payer).map(x => [x.accountIndex, BigInt(x.uiTokenAmount.amount)]));
    const pre = own(m.preTokenBalances ?? []);
    const post = own(m.postTokenBalances ?? []);
    if ([...pre].some(([i, v]) => (post.get(i) ?? 0n) < v)) continue;
    const all = t.transaction.message.instructions;
    if (all.some(ix => TRADING.has(keys[ix.programIdIndex]))) continue;
    const ixs = all.filter(ix => !INFRA.has(keys[ix.programIdIndex]));
    if (!ixs.length) continue;
    const ix = ixs[0];
    const program = keys[ix.programIdIndex];
    let disc = '';
    try { disc = Buffer.from(base58Decode(ix.data)).subarray(0, 8).toString('hex'); } catch { /* unreadable data */ }
    const name = m.logMessages?.find(l => l.startsWith('Program log: Instruction: '))?.slice(26);
    out.push({ program, discriminator: disc, name, payer, netLamports: net, signature: t.transaction.signatures[0] });
  }
  return out;
}

/** Group paid calls; keep ones seen at least twice that Crumbs doesn't already run. */
export function groupPaid(calls: PaidCall[], minCalls = 2): PaidGroup[] {
  const groups = new Map<string, PaidCall[]>();
  for (const c of calls) {
    const key = `${c.program}:${c.discriminator.slice(0, 16)}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  const coveredPrograms = new Set(Object.keys(COVERED).map(k => k.split(':')[0]));
  return [...groups].flatMap(([key, cs]) => {
    if (cs.length < minCalls) return [];
    const nets = cs.map(c => c.netLamports).sort((a, b) => a - b);
    const name = cs.find(c => c.name)?.name;
    // An instruction Crumbs already runs isn't news.
    if (coveredPrograms.has(cs[0].program) && name && /checkpoint|run_?task/i.test(name)) return [];
    return [{ key, program: cs[0].program, discriminator: cs[0].discriminator, name, calls: cs.length,
      payers: new Set(cs.map(c => c.payer)).size, medianNetLamports: nets[Math.floor(nets.length / 2)], example: cs[0].signature }];
  }).sort((a, b) => b.calls - a.calls);
}

type Rpc = (method: string, params: unknown[]) => Promise<unknown>;

export function jsonRpc(url: string): Rpc {
  return async (method, params) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
      if (res.status === 429) { await new Promise(r => setTimeout(r, 2_000 * (attempt + 1))); continue; }
      const j = await res.json() as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result;
    }
    throw new Error('rate limited');
  };
}

/**
 * Sample `blocks` blocks spaced `spacing` slots apart (default 100 × 400 ≈ the last 4.5 h), one at a time
 * so memory stays low (a block is a few MB of JSON). Uses the public RPC by default: no Helius credits.
 */
export async function scanPaidChores(rpc: Rpc, opts: { blocks?: number; spacing?: number; pauseMs?: number } = {}): Promise<{ blocks: number; groups: PaidGroup[] }> {
  const latest = await rpc('getSlot', [{ commitment: 'finalized' }]) as number;
  const calls: PaidCall[] = [];
  let blocks = 0;
  for (let k = 0; k < (opts.blocks ?? 100); k++) {
    const slot = latest - 50 - k * (opts.spacing ?? 400);
    try {
      const b = await rpc('getBlock', [slot, { encoding: 'json', maxSupportedTransactionVersion: 1, transactionDetails: 'full', rewards: false }]) as { transactions: RawTx[] } | null;
      if (b) { calls.push(...paidCalls(b.transactions)); blocks++; }
    } catch (e) {
      log.debug('paid scan: block skipped', { slot, error: String(e) });
    }
    if (opts.pauseMs ?? 500) await new Promise(r => setTimeout(r, opts.pauseMs ?? 500));
  }
  return { blocks, groups: groupPaid(calls) };
}

/** Groups not reported before (remembered in the ledger), so the owner only hears about new ones. */
export function newGroups(ledger: Ledger, groups: PaidGroup[]): PaidGroup[] {
  const seen = new Set<string>(JSON.parse(ledger.getState('paid_scan_seen') ?? '[]') as string[]);
  const fresh = groups.filter(g => !seen.has(g.key));
  for (const g of fresh) seen.add(g.key);
  ledger.setState('paid_scan_seen', JSON.stringify([...seen].slice(-2_000)));
  return fresh;
}

export function paidScanText(blocks: number, fresh: PaidGroup[], total: number): string {
  if (!fresh.length) return `🔭 Daily job scan: ${blocks} blocks, ${total} paid patterns, nothing new.`;
  return [
    `🔭 Daily job scan: ${blocks} blocks, ${fresh.length} new way${fresh.length === 1 ? '' : 's'} someone is getting paid:`,
    ...fresh.slice(0, 8).map(g => `• ${g.name ?? `ix ${g.discriminator.slice(0, 8)}`} on ${g.program.slice(0, 8)}…: ${g.calls} calls by ${g.payers} wallet${g.payers === 1 ? '' : 's'}, median +${g.medianNetLamports.toLocaleString('en-US')} lamports\n  https://solscan.io/tx/${g.example}`),
    'Programs with a published IDL go through discovery (Claude + replay with our wallet). Others need a look by hand: tell Claude Code which one.',
  ].join('\n');
}
