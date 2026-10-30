import { type Connection, PublicKey } from '@solana/web3.js';
import type { BuiltJob, Candidate, Job } from '../core/types.js';
import { JobGone } from '../core/types.js';
import type { JobCandidate } from './classify.js';
import { findRecentCalls, type RecordedCall, rewriteForAgent } from './validate.js';

export interface ReplaySpec {
  discoveryId: number;
  candidate: JobCandidate;
  discriminator: Buffer;
  callerIndex: number;
}

export const discoveryJobType = (id: number) => `disc.${id}`;

/**
 * Generic runtime for an approved discovery that validated by replay: a recurring crank on shared
 * state. Every window it takes the newest real call's accounts, swaps in our wallet, and hands it to
 * the executor — which simulates and only sends if the profit guard says yes. One-shot jobs never
 * get here (they're "paid_not_replayable" and need a dedicated adapter).
 */
export class ReplayJob implements Job {
  readonly type: string;
  readonly protocol: string;
  readonly description: string;
  readonly rewardSource: string;
  private latest?: RecordedCall;
  private latestAt = 0;
  private maxHistorical = 0n;

  constructor(private conn: Connection, private spec: ReplaySpec, private windowMs = 30_000, private now: () => number = Date.now) {
    this.type = discoveryJobType(spec.discoveryId);
    this.protocol = spec.candidate.programName;
    this.description = `${spec.candidate.instruction} (discovered): ${spec.candidate.rewardSource}`;
    this.rewardSource = spec.candidate.evidence.join(' · ') || spec.candidate.rewardSource;
  }

  async detect(): Promise<Candidate[]> {
    if (this.now() - this.latestAt >= this.windowMs) {
      const program = new PublicKey(this.spec.candidate.program);
      const calls = await findRecentCalls(this.conn, program, this.spec.discriminator, this.spec.callerIndex, { scan: 40, want: 3 });
      this.latestAt = this.now();
      if (calls.length) {
        this.latest = calls[0];
        this.maxHistorical = calls.map(c => c.callerGrossLamports).reduce((a, b) => (b > a ? b : a), 0n);
      }
    }
    if (!this.latest) return [];
    const window = Math.floor(this.now() / this.windowMs);
    return [{ id: `${this.type}:${window}`, jobType: this.type, description: `${this.spec.candidate.programName}::${this.spec.candidate.instruction}` }];
  }

  async build(_c: Candidate, agent: PublicKey): Promise<BuiltJob> {
    if (!this.latest) throw new JobGone('no recent call to replay');
    return rewriteForAgent(this.latest, agent, this.maxHistorical);
  }
}
