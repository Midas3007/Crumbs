import type { Caps } from '../config.js';
import type { BuiltJob, ProfitDecision, SimOutcome } from './types.js';

/** Lamports per one whole token, keyed by mint. Tokens without a price can't be valued. */
export type PriceBook = ReadonlyMap<string, number>;

/**
 * Decide whether a simulated job is worth sending. Pure function: everything it needs is passed in.
 *
 * The simulated post-balance already has the base fee, priority fee and any in-tx tip taken off
 * (verified on mainnet: a 1-lamport transfer with 5000 base + 1000 priority shows a delta of -6001),
 * so the agent's lamport delta *is* the SOL part of the net profit.
 */
export function evaluateProfit(sim: SimOutcome, job: BuiltJob, caps: Caps, prices: PriceBook = new Map()): ProfitDecision {
  const cost = sim.feeLamports + sim.tipLamports;
  const decision = (verdict: ProfitDecision['verdict'], net: bigint, gross: bigint, reason: string): ProfitDecision =>
    ({ verdict, ok: verdict === 'profitable', netLamports: net, grossRewardLamports: gross, costLamports: cost, reason });

  if (sim.err !== null) return decision('simulation_failed', 0n, 0n, `simulation error: ${JSON.stringify(sim.err)}`);

  let tokenValue = 0n;
  for (const t of sim.tokenDeltas) {
    const delta = t.post - t.pre;
    if (delta === 0n) continue;
    const price = prices.get(t.mint);
    if (price === undefined) {
      return decision('unknown_balance_effect', 0n, 0n, `token ${t.mint} changed by ${delta} and has no price`);
    }
    tokenValue += BigInt(Math.floor((Number(delta) / 10 ** t.decimals) * price));
  }

  const net = sim.lamportsPost - sim.lamportsPre + tokenValue;
  const gross = net + cost;

  // Paid far more than documented: possibly a bug. Never execute; the caller drafts a disclosure.
  const ceiling = BigInt(Math.ceil(Number(job.expectedRewardLamports) * caps.anomalyMultiple));
  if (gross > ceiling) {
    return decision('anomaly', net, gross,
      `simulated reward ${gross} exceeds ${caps.anomalyMultiple}x the documented ${job.expectedRewardLamports}`);
  }
  if (cost > caps.perJobSpendCapLamports) {
    return decision('over_job_spend_cap', net, gross, `cost ${cost} > per-job cap ${caps.perJobSpendCapLamports}`);
  }
  if (net < caps.minProfitLamports) {
    return decision('below_min_profit', net, gross, `net ${net} < minimum ${caps.minProfitLamports}`);
  }
  return decision('profitable', net, gross, `net +${net} lamports`);
}
