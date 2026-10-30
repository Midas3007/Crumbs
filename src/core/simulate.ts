import {
  ComputeBudgetProgram,
  Ed25519Program,
  Secp256k1Program,
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

/**
 * Solana's fee: 5000 lamports per signature — including signatures checked by the ed25519/secp256k1
 * precompiles — plus the priority fee (CU limit × micro-lamports per CU). Matches getFeeForMessage
 * (verified on mainnet: 1 signature, 1000 CU at 1,000,000 µL = 6000).
 */
export function transactionFee(job: BuiltJob, txSignatures: number, cuLimit: number, microLamports: number): bigint {
  const precompileSigs = job.instructions
    .filter(ix => ix.programId.equals(Ed25519Program.programId) || ix.programId.equals(Secp256k1Program.programId))
    .reduce((n, ix) => n + (ix.data[0] ?? 0), 0);
  const priority = BigInt(Math.ceil((cuLimit * microLamports) / 1_000_000));
  return 5000n * BigInt(txSignatures + precompileSigs) + priority;
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

  // Balances before and the simulation run in parallel: one round trip instead of two.
  const [pre, r] = await Promise.all([
    conn.getMultipleAccountsInfo(addresses, 'processed'),
    conn.simulateTransaction(tx, {
      sigVerify: false,
      commitment: 'processed',
      accounts: { encoding: 'base64', addresses: addresses.map(a => a.toBase58()) },
    }),
  ]);

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

  // Computed locally instead of asking the RPC (one round trip less at the due second).
  const feeLamports = transactionFee(job, tx.message.header.numRequiredSignatures, cuLimit, microLamports);

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
