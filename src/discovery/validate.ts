import {
  type AccountMeta, ComputeBudgetProgram, type Connection, Ed25519Program, PublicKey, Secp256k1Program, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction, type VersionedTransactionResponse,
} from '@solana/web3.js';
import type { Caps } from '../config.js';
import { evaluateProfit, type PriceBook } from '../core/profitGuard.js';
import { associatedTokenAddress, ATA_PROGRAM_ID, isTokenProgram, readTokenAccount } from '../core/tokens.js';
import type { BuiltJob, ProfitDecision, SimOutcome, WatchedTokenAccount } from '../core/types.js';

/**
 * Deterministic proof for an AI-proposed job: find real recent calls of the instruction on mainnet,
 * replay them with OUR wallet as the caller, and simulate. If the agent's balance goes up after fees
 * and nobody else's funds move, the job is real. No AI in here.
 */

const MEMO_PROGRAMS = new Set(['MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr', 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo']);

/** A successful mainnet transaction that called the instruction, ready to replay. */
export interface RecordedCall {
  signature: string;
  slot: number;
  /** Every instruction of that tx we'd replay (target + harmless companions like ed25519 proofs). */
  instructions: { programId: PublicKey; keys: AccountMeta[]; data: Buffer }[];
  caller: PublicKey;
  /** What the original caller earned: their lamport change with the fee added back, plus token gains. */
  callerGrossLamports: bigint;
  callerTokenGains: { mint: string; amount: bigint; decimals: number }[];
  /** Original caller's token accounts → mint/token program, so we can swap in ours. */
  callerTokenAccounts: Map<string, { mint: PublicKey; tokenProgram: PublicKey }>;
}

export interface FundMovement {
  account: string;
  kind: 'wallet_lamports' | 'user_tokens';
  owner: string;
  delta: bigint;
}

/**
 * validated: a replay with our wallet is profitable right now — can run autonomously once approved.
 * paid_not_replayable: real callers earn from it, but each call consumes its work (one-shot tasks,
 *   liquidations) so a blind replay can't succeed — it needs a dedicated adapter.
 */
export type ValidationStatus = 'validated' | 'paid_not_replayable' | 'unprofitable' | 'failed' | 'no_live_trigger' | 'anomaly';

export interface ValidationResult {
  status: ValidationStatus;
  summary: string;
  attempts: {
    replayedSignature: string;
    decision: ProfitDecision;
    unitsConsumed: number;
    logs: string[];
    thirdPartyMovements: FundMovement[];
  }[];
  historicalGrossLamports: bigint[];
  anomaly?: { kind: 'third_party_funds' | 'pays_more_than_history'; detail: string; replayedSignature: string };
}

const isCompanion = (programId: PublicKey) =>
  programId.equals(ComputeBudgetProgram.programId) || programId.equals(Ed25519Program.programId)
  || programId.equals(Secp256k1Program.programId) || programId.equals(ATA_PROGRAM_ID)
  || MEMO_PROGRAMS.has(programId.toBase58());

/**
 * Turn one historical tx into a RecordedCall, or undefined if it isn't safely replayable:
 * failed, more than one signer, or bundled with unrelated instructions (e.g. a user's swap).
 */
export function recordCall(tx: VersionedTransactionResponse, signature: string, program: PublicKey, discriminator: Buffer, callerIndexInIx: number): RecordedCall | undefined {
  const meta = tx.meta;
  if (!meta || meta.err) return undefined;
  const msg = tx.transaction.message;
  if (msg.header.numRequiredSignatures !== 1) return undefined;
  const keys = msg.getAccountKeys({ accountKeysFromLookups: meta.loadedAddresses });

  const instructions: RecordedCall['instructions'] = [];
  let caller: PublicKey | undefined;
  for (const ix of msg.compiledInstructions) {
    const programId = keys.get(ix.programIdIndex)!;
    if (programId.equals(ComputeBudgetProgram.programId)) continue; // we set our own
    const data = Buffer.from(ix.data);
    const isTarget = programId.equals(program) && data.subarray(0, 8).equals(discriminator);
    if (!isTarget && !programId.equals(program) && !isCompanion(programId)) return undefined;
    const metas: AccountMeta[] = ix.accountKeyIndexes.map(i => ({
      pubkey: keys.get(i)!, isSigner: msg.isAccountSigner(i), isWritable: msg.isAccountWritable(i),
    }));
    if (isTarget && !caller) caller = metas[callerIndexInIx]?.pubkey;
    instructions.push({ programId, keys: metas, data });
  }
  if (!caller) return undefined;
  const feePayer = keys.get(0)!;
  if (!feePayer.equals(caller)) return undefined; // we only replay calls where the caller paid its own way

  const callerIdx = keys.staticAccountKeys.findIndex(k => k.equals(caller!));
  const lamportDelta = BigInt(meta.postBalances[callerIdx] - meta.preBalances[callerIdx]);
  const callerTokenAccounts = new Map<string, { mint: PublicKey; tokenProgram: PublicKey }>();
  const gains: RecordedCall['callerTokenGains'] = [];
  for (const post of meta.postTokenBalances ?? []) {
    if (post.owner !== caller.toBase58()) continue;
    const account = keys.get(post.accountIndex)!;
    const tokenProgram = post.programId ? new PublicKey(post.programId) : undefined;
    callerTokenAccounts.set(account.toBase58(), { mint: new PublicKey(post.mint), tokenProgram: tokenProgram ?? new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
    const pre = meta.preTokenBalances?.find(p => p.accountIndex === post.accountIndex);
    const gain = BigInt(post.uiTokenAmount.amount) - BigInt(pre?.uiTokenAmount.amount ?? '0');
    if (gain !== 0n) gains.push({ mint: post.mint, amount: gain, decimals: post.uiTokenAmount.decimals });
  }
  return {
    signature, slot: tx.slot, instructions, caller,
    callerGrossLamports: lamportDelta + BigInt(meta.fee),
    callerTokenGains: gains,
    callerTokenAccounts,
  };
}

/**
 * getTransaction, but a transaction we can't decode (e.g. Solana's newer transaction version 1, which
 * web3.js v1 rejects) is skipped instead of failing the whole scan.
 */
export async function fetchTxOrSkip(conn: Connection, signature: string): Promise<VersionedTransactionResponse | null> {
  try {
    return await conn.getTransaction(signature, { maxSupportedTransactionVersion: 0, commitment: 'confirmed' });
  } catch (e) {
    if (/version|not supported/i.test(String(e))) return null;
    throw e;
  }
}

/** Recent successful calls of an instruction, newest first. */
export async function findRecentCalls(
  conn: Connection, program: PublicKey, discriminator: Buffer, callerIndexInIx: number,
  opts: { scan?: number; want?: number; delayMs?: number } = {},
): Promise<RecordedCall[]> {
  const sigs = await conn.getSignaturesForAddress(program, { limit: opts.scan ?? 100 });
  const out: RecordedCall[] = [];
  for (const s of sigs) {
    if (s.err) continue;
    if (opts.delayMs) await new Promise(r => setTimeout(r, opts.delayMs));
    const tx = await fetchTxOrSkip(conn, s.signature);
    if (!tx) continue;
    const call = recordCall(tx, s.signature, program, discriminator, callerIndexInIx);
    if (call) out.push(call);
    if (out.length >= (opts.want ?? 3)) break;
  }
  return out;
}

/** Rewrite a recorded call so the agent is the caller: its wallet and its token accounts replace the original caller's. */
export function rewriteForAgent(call: RecordedCall, agent: PublicKey, expectedRewardLamports: bigint): BuiltJob {
  const watched = new Map<string, WatchedTokenAccount>();
  const swap = (k: PublicKey): PublicKey => {
    if (k.equals(call.caller)) return agent;
    const tokenAcct = call.callerTokenAccounts.get(k.toBase58());
    if (tokenAcct) {
      const ours = associatedTokenAddress(agent, tokenAcct.mint, tokenAcct.tokenProgram);
      const gain = call.callerTokenGains.find(g => g.mint === tokenAcct.mint.toBase58());
      watched.set(ours.toBase58(), { address: ours, mint: tokenAcct.mint.toBase58(), decimals: gain?.decimals ?? 0 });
      return ours;
    }
    return k;
  };
  const instructions = call.instructions.map(ix => new TransactionInstruction({
    programId: ix.programId,
    data: ix.data,
    keys: ix.keys.map(m => {
      const pubkey = swap(m.pubkey);
      return { pubkey, isWritable: m.isWritable, isSigner: pubkey.equals(agent) && m.isSigner };
    }),
  }));
  return { instructions, lookupTables: [], expectedRewardLamports, watchedTokenAccounts: [...watched.values()] };
}

/**
 * Which accounts outside the agent and the protocol lost value? Wallets (system-owned) losing lamports
 * and token accounts owned by a real keypair (on-curve authority) losing tokens are third-party funds.
 * Program-owned state and PDA-owned vaults moving is the protocol doing its job.
 */
export function thirdPartyMovements(
  addresses: PublicKey[],
  pre: ({ lamports: number; owner: PublicKey; data: Buffer } | null)[],
  post: ({ lamports: number; owner: string; data: string[] | unknown } | null)[],
  agent: PublicKey,
  agentAccounts: Set<string>,
): FundMovement[] {
  const out: FundMovement[] = [];
  addresses.forEach((addr, i) => {
    const before = pre[i];
    if (!before || addr.equals(agent) || agentAccounts.has(addr.toBase58())) return;
    const after = post[i];
    const afterLamports = after?.lamports ?? 0;
    if (before.owner.equals(SystemProgram.programId) && afterLamports < before.lamports) {
      out.push({ account: addr.toBase58(), kind: 'wallet_lamports', owner: addr.toBase58(), delta: BigInt(afterLamports - before.lamports) });
    }
    if (isTokenProgram(before.owner)) {
      const tBefore = readTokenAccount(before.data);
      const rawAfter = after && Array.isArray(after.data) ? Buffer.from(after.data[0] as string, 'base64') : undefined;
      const tAfter = rawAfter ? readTokenAccount(rawAfter) : undefined;
      if (tBefore && PublicKey.isOnCurve(tBefore.authority.toBytes()) && !tBefore.authority.equals(agent)) {
        const delta = (tAfter?.amount ?? 0n) - tBefore.amount;
        if (delta < 0n) out.push({ account: addr.toBase58(), kind: 'user_tokens', owner: tBefore.authority.toBase58(), delta });
      }
    }
  });
  return out;
}

/** Simulate one rewritten call and report profit + any third-party fund movement. */
export async function simulateReplay(conn: Connection, agent: PublicKey, job: BuiltJob, caps: Caps, prices: PriceBook) {
  const { blockhash } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({
    payerKey: agent, recentBlockhash: blockhash,
    instructions: [ComputeBudgetProgram.setComputeUnitLimit({ units: 1_400_000 }), ...job.instructions],
  }).compileToV0Message(job.lookupTables);
  const tx = new VersionedTransaction(msg);

  const watched = job.watchedTokenAccounts ?? [];
  const writable = msg.staticAccountKeys.filter((_, i) => msg.isAccountWritable(i));
  const others = writable.filter(k => !k.equals(agent) && !watched.some(w => w.address.equals(k))).slice(0, 40);
  const addresses = [agent, ...watched.map(w => w.address), ...others];

  const [pre, fee] = await Promise.all([conn.getMultipleAccountsInfo(addresses, 'processed'), conn.getFeeForMessage(msg, 'processed')]);
  const r = await conn.simulateTransaction(tx, {
    sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed',
    accounts: { encoding: 'base64', addresses: addresses.map(a => a.toBase58()) },
  });
  const post = r.value.accounts ?? [];
  const tokenAmt = (i: number, src: 'pre' | 'post'): bigint => {
    const d = src === 'pre' ? pre[i]?.data : (Array.isArray(post[i]?.data) ? Buffer.from((post[i]!.data as string[])[0], 'base64') : undefined);
    return d ? (readTokenAccount(Buffer.from(d))?.amount ?? 0n) : 0n;
  };
  const sim: SimOutcome = {
    err: r.value.err,
    logs: r.value.logs ?? [],
    unitsConsumed: r.value.unitsConsumed ?? 0,
    lamportsPre: BigInt(pre[0]?.lamports ?? 0),
    lamportsPost: BigInt(post[0]?.lamports ?? 0),
    feeLamports: BigInt(fee.value ?? 5000),
    tipLamports: 0n,
    tokenDeltas: watched.map((w, i) => ({ mint: w.mint, decimals: w.decimals, pre: tokenAmt(i + 1, 'pre'), post: tokenAmt(i + 1, 'post') })),
  };
  const movements = r.value.err ? [] : thirdPartyMovements(
    addresses.slice(1 + watched.length),
    pre.slice(1 + watched.length).map(a => (a ? { lamports: a.lamports, owner: a.owner, data: Buffer.from(a.data) } : null)),
    post.slice(1 + watched.length).map(a => (a ? { lamports: a.lamports, owner: a.owner, data: a.data } : null)),
    agent, new Set(watched.map(w => w.address.toBase58())),
  );
  return { sim, decision: evaluateProfit(sim, job, caps, prices), movements };
}

/** Replay up to `want` recent calls; decide validated / unprofitable / failed / anomaly. */
export async function validateCandidate(
  conn: Connection, agent: PublicKey, program: PublicKey, discriminator: Buffer, callerIndexInIx: number,
  caps: Caps, prices: PriceBook = new Map(), opts: { scan?: number; want?: number; delayMs?: number } = {},
): Promise<ValidationResult> {
  const calls = await findRecentCalls(conn, program, discriminator, callerIndexInIx, opts);
  const historical = calls.map(c => c.callerGrossLamports);
  if (calls.length === 0) {
    return { status: 'no_live_trigger', summary: 'no recent replayable calls on mainnet', attempts: [], historicalGrossLamports: [] };
  }
  const maxHistorical = historical.reduce((a, b) => (b > a ? b : a), 0n);
  const attempts: ValidationResult['attempts'] = [];
  for (const call of calls) {
    // The documented reward for the anomaly guard is the most any real caller earned recently.
    // A replay that pays far more than that is treated as a possible bug.
    const job = rewriteForAgent(call, agent, maxHistorical > 0n ? maxHistorical : 0n);
    const { sim, decision, movements } = await simulateReplay(conn, agent, job, caps, prices);
    attempts.push({ replayedSignature: call.signature, decision, unitsConsumed: sim.unitsConsumed, logs: sim.logs.slice(-12), thirdPartyMovements: movements });

    if (movements.length > 0) {
      return {
        status: 'anomaly', attempts, historicalGrossLamports: historical,
        summary: `replay moves funds of ${movements.length} third-party account(s)`,
        anomaly: { kind: 'third_party_funds', replayedSignature: call.signature, detail: movements.map(m => `${m.account} (${m.kind}, owner ${m.owner}) ${m.delta}`).join('; ') },
      };
    }
    if (decision.verdict === 'anomaly') {
      return {
        status: 'anomaly', attempts, historicalGrossLamports: historical,
        summary: decision.reason,
        anomaly: { kind: 'pays_more_than_history', replayedSignature: call.signature, detail: `${decision.reason}; recent callers earned at most ${maxHistorical} lamports` },
      };
    }
    if (decision.ok) {
      return { status: 'validated', attempts, historicalGrossLamports: historical, summary: `replay of ${call.signature.slice(0, 12)}… nets +${decision.netLamports} lamports for the agent` };
    }
  }
  const allFailed = attempts.every(a => a.decision.verdict === 'simulation_failed');
  const paidCallers = historical.filter(h => h > 5_000n).length;
  if (allFailed && paidCallers > 0) {
    return {
      status: 'paid_not_replayable', attempts, historicalGrossLamports: historical,
      summary: `${paidCallers}/${historical.length} recent callers were paid (up to ${maxHistorical} lamports gross), but each call consumes its work — needs a dedicated adapter`,
    };
  }
  return {
    status: allFailed ? 'failed' : 'unprofitable', attempts, historicalGrossLamports: historical,
    summary: allFailed ? 'every replay failed in simulation and recent callers were not paid' : attempts.map(a => a.decision.reason).join('; '),
  };
}
