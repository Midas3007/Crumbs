import type { Ledger } from './ledger.js';
import type { ReasonCode } from './types.js';

/**
 * Per-job-type Jito tip, learned from our own wins and losses. Jito orders bundles by tip, so a bundle
 * that wasn't included while the job was still open ("not_included") was most likely outbid: tip more.
 * A win lets it drift back down. It never goes below Jito's minimum, and the executor caps it per job so
 * the profit guard's minimum is always left over.
 *
 * A lost race does NOT raise it. Measured on Oct 31: Helium's crank bot doesn't bid in Jito's auction, it
 * lands earlier in the same second, so raising the tip after each of 139 lost races only took the tip to
 * its cap and cut the next win from +4,000-9,000 to +2,000 lamports without winning more.
 */
/** v2 key: tips learned under the old rule (which raised them on lost races) start again from the minimum. */
const KEY = 'tip_v2:';

export class TipTuner {
  constructor(private ledger: Ledger, private minTip: bigint, private maxTip = 200_000n) {}

  tip(jobType: string): bigint {
    const v = this.ledger.getState(`${KEY}${jobType}`);
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
      : outcome === 'landed' ? (t * 9n) / 10n
      : t;
    const clamped = next < this.minTip ? this.minTip : next > this.maxTip ? this.maxTip : next;
    if (clamped !== t) this.ledger.setState(`${KEY}${jobType}`, clamped.toString());
  }
}
