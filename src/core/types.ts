import type { AddressLookupTableAccount, PublicKey, TransactionInstruction } from '@solana/web3.js';

/** A piece of work an adapter found. `id` must be stable so the executor can de-duplicate attempts. */
export interface Candidate {
  id: string;
  jobType: string;
  description: string;
  /** Unix seconds when the job becomes callable, if known. */
  dueAt?: number;
  data?: unknown;
}

/** An agent-owned token account whose balance change counts towards profit. */
export interface WatchedTokenAccount {
  address: PublicKey;
  mint: string;
  decimals: number;
}

export interface BuiltJob {
  instructions: TransactionInstruction[];
  lookupTables: AddressLookupTableAccount[];
  /** The reward the protocol documents for this call, in lamports. Used by the anomaly guard. */
  expectedRewardLamports: bigint;
  /** Agent-owned token accounts the call may credit (e.g. a USDC reward). */
  watchedTokenAccounts?: WatchedTokenAccount[];
  /** Optional Jito tip already included in `instructions`. */
  tipLamports?: bigint;
  /**
   * Jobs with the same key use about the same compute, so the executor can reuse a measurement
   * and skip a simulation round trip at the due second.
   */
  cuKey?: string;
}

/** Thrown by build() when the work has disappeared (someone else did it) — not an error worth alerting on. */
export class JobGone extends Error {}

export interface TokenDelta {
  mint: string;
  decimals: number;
  pre: bigint;
  post: bigint;
}

/** What the simulator learned about one candidate transaction. */
export interface SimOutcome {
  err: unknown | null;
  logs: string[];
  unitsConsumed: number;
  /** Agent wallet lamports before, and after the simulated tx (after base + priority fee). */
  lamportsPre: bigint;
  lamportsPost: bigint;
  /** Base fee + priority fee charged for this tx. */
  feeLamports: bigint;
  tipLamports: bigint;
  tokenDeltas: TokenDelta[];
}

export type Verdict =
  | 'profitable'
  | 'simulation_failed'
  | 'unknown_balance_effect'
  | 'over_job_spend_cap'
  | 'below_min_profit'
  | 'anomaly';

export interface ProfitDecision {
  verdict: Verdict;
  ok: boolean;
  /** Everything the agent ends up with minus everything it paid (fees and tips included). */
  netLamports: bigint;
  /** What the protocol paid before costs. */
  grossRewardLamports: bigint;
  costLamports: bigint;
  reason: string;
}

/**
 * A job adapter. `detect` finds work, `build` creates the transaction for one piece of work.
 * `estimateProfit` and `execute` are shared across adapters (see core/executor.ts), so profit
 * is always proven the same way no matter who wrote the adapter.
 */
export interface Job {
  /** Stable id, e.g. "tuktuk.run_task". New ids need approval on Telegram before going live. */
  type: string;
  protocol: string;
  description: string;
  /** Where the reward mechanics are documented (source file, docs page). Shown in approvals. */
  rewardSource: string;
  detect(): Promise<Candidate[]>;
  build(candidate: Candidate, agent: PublicKey): Promise<BuiltJob>;
}
