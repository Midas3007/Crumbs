import {
  ComputeBudgetProgram,
  type Connection,
  type PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import type { BuiltJob, SimOutcome, TokenDelta } from './types.js';

const MAX_CU = 1_400_000;

/** SPL token account: amount is a u64 at byte 64. */
export function tokenAmount(data: Buffer | Uint8Array | null | undefined): bigint {
  if (!data || data.length < 72) return 0n;
  return Buffer.from(data).readBigUInt64LE(64);
}

export function compile(payer: PublicKey, job: BuiltJob, blockhash: string, cuLimit: number, microLamports: number): VersionedTransaction {
  const budget = [ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit })];
  if (microLamports > 0) budget.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports }));
  const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: [...budget, ...job.instructions] })
    .compileToV0Message(job.lookupTables);
  return new VersionedTransaction(msg);
}

/** First pass: how many compute units does the job use? Returns the error instead if it fails. */
export async function measureUnits(conn: Connection, payer: PublicKey, job: BuiltJob, blockhash: string): Promise<{ units: number; err: unknown | null; logs: string[] }> {
  const tx = compile(payer, job, blockhash, MAX_CU, 0);
  const r = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' });
  return { units: r.value.unitsConsumed ?? 0, err: r.value.err, logs: r.value.logs ?? [] };
}

export function computeUnitLimit(measured: number): number {
  return Math.min(MAX_CU, Math.ceil((measured + 300) * 1.1));
}

/**
 * Second pass: simulate the exact transaction we'd send and read the agent's balances before and after.
 * The returned tx is unsigned; the executor signs it only if the profit guard approves.
 */
export async function simulateFinal(
  conn: Connection,
  payer: PublicKey,
  job: BuiltJob,
  blockhash: string,
  cuLimit: number,
  microLamports: number,
): Promise<{ tx: VersionedTransaction; outcome: SimOutcome }> {
  const tx = compile(payer, job, blockhash, cuLimit, microLamports);
  const watched = job.watchedTokenAccounts ?? [];
  const addresses = [payer, ...watched.map(w => w.address)];

  const [pre, fee] = await Promise.all([
    conn.getMultipleAccountsInfo(addresses, 'processed'),
    conn.getFeeForMessage(tx.message, 'processed'),
  ]);
  const r = await conn.simulateTransaction(tx, {
    sigVerify: false,
    commitment: 'processed',
    accounts: { encoding: 'base64', addresses: addresses.map(a => a.toBase58()) },
  });

  const post = r.value.accounts ?? [];
  const postData = (i: number) => {
    const d = post[i]?.data;
    return Array.isArray(d) ? Buffer.from(d[0], 'base64') : undefined;
  };
  const tokenDeltas: TokenDelta[] = watched.map((w, i) => ({
    mint: w.mint,
    decimals: w.decimals,
    pre: tokenAmount(pre[i + 1]?.data),
    post: tokenAmount(postData(i + 1)),
  }));

  // Base + priority fee. If the RPC can't price the message, fall back to what we know we set.
  const priority = BigInt(Math.ceil((cuLimit * microLamports) / 1_000_000));
  const feeLamports = fee.value !== null ? BigInt(fee.value) : 5000n * BigInt(tx.message.header.numRequiredSignatures) + priority;

  return {
    tx,
    outcome: {
      err: r.value.err,
      logs: r.value.logs ?? [],
      unitsConsumed: r.value.unitsConsumed ?? 0,
      lamportsPre: BigInt(pre[0]?.lamports ?? 0),
      lamportsPost: BigInt(post[0]?.lamports ?? 0),
      feeLamports,
      tipLamports: job.tipLamports ?? 0n,
      tokenDeltas,
    },
  };
}
