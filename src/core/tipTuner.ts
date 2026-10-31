import type { Ledger } from './ledger.js';
import type { ReasonCode } from './types.js';

/**
 * Per-job-type Jito tip, learned from our own wins and losses. Jito orders bundles by tip, so a bundle
 * that wasn't included while the job was still open ("not_included") was most likely outbid: tip more.
 * A lost race nudges it up a little; a win lets it drift back down. It never goes below Jito's minimum,
 * and the executor caps it per job so the profit guard's minimum is always left over.
 */
export class TipTuner {
  constructor(private ledger: Ledger, private minTip: bigint, private maxTip = 200_000n) {}

  tip(jobType: string): bigint {
    const v = this.ledger.getState(`tip:${jobType}`);
    return v ? BigInt(v) : this.minTip;
  }

  /** The tip for one job: learned value, capped so `reward - fees - tip >= minProfit`. */
  tipFor(jobType: string, rewardLamports: bigint, feeLamports: bigint, minProfit: bigint): bigint {
    const room = rewardLamports - feeLamports - minProfit;
    const t = this.tip(jobType);
    return room < this.minTip ? this.minTip : t > room ? room : t;
  }

  learn(jobType: string, outcome: ReasonCode): void {
    const t = this.tip(jobType);
    const next = outcome === 'not_included' ? (t * 3n) / 2n
      : outcome === 'lost_race' ? (t * 5n) / 4n
      : outcome === 'landed' ? (t * 9n) / 10n
      : t;
    const clamped = next < this.minTip ? this.minTip : next > this.maxTip ? this.maxTip : next;
    if (clamped !== t) this.ledger.setState(`tip:${jobType}`, clamped.toString());
  }
}
