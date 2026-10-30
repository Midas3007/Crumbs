import type { Connection, PublicKey } from '@solana/web3.js';
import { log } from './logger.js';

export const BASE_FEE_PER_SIGNATURE = 5000n;

/**
 * Priority fee to offer, in micro-lamports per compute unit.
 * Uses Helius' estimate when available, otherwise the median of recent fees on the touched accounts.
 */
export async function estimatePriorityFee(conn: Connection, writableAccounts: PublicKey[], useHelius: boolean): Promise<number> {
  try {
    if (useHelius) {
      const res = await fetch(conn.rpcEndpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1, method: 'getPriorityFeeEstimate',
          params: [{ accountKeys: writableAccounts.map(k => k.toBase58()), options: { priorityLevel: 'Medium' } }],
        }),
      });
      const json = await res.json() as { result?: { priorityFeeEstimate?: number } };
      const est = json.result?.priorityFeeEstimate;
      if (typeof est === 'number') return Math.ceil(est);
    }
    const recent = await conn.getRecentPrioritizationFees({ lockedWritableAccounts: writableAccounts.slice(0, 128) });
    const fees = recent.map(r => r.prioritizationFee).filter(f => f > 0).sort((a, b) => a - b);
    return fees.length ? fees[Math.floor(fees.length / 2)] : 0;
  } catch (e) {
    log.warn('priority fee estimate failed, using 0', { error: String(e) });
    return 0;
  }
}

/**
 * Crumbs are small: never offer a priority fee that would eat the profit.
 * Returns the highest micro-lamports/CU that keeps (reward - base fee - priority) >= minProfit.
 */
export function clampPriorityFee(
  estimateMicroLamports: number,
  computeUnits: number,
  expectedRewardLamports: bigint,
  baseFeeLamports: bigint,
  minProfitLamports: bigint,
): number {
  const budget = expectedRewardLamports - baseFeeLamports - minProfitLamports;
  if (budget <= 0n || computeUnits <= 0) return 0;
  const maxMicro = Number((budget * 1_000_000n) / BigInt(computeUnits));
  return Math.max(0, Math.min(estimateMicroLamports, maxMicro));
}
