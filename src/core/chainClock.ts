import { type Connection, SYSVAR_CLOCK_PUBKEY } from '@solana/web3.js';
import { log } from './logger.js';

/** Clock sysvar: slot u64, epoch_start_timestamp i64, epoch u64, leader_schedule_epoch u64, unix_timestamp i64. */
export function decodeClock(data: Buffer): { slot: number; unixTimestamp: number } {
  return { slot: Number(data.readBigUInt64LE(0)), unixTimestamp: Number(data.readBigInt64LE(32)) };
}

/**
 * The chain's own clock, pushed to us every slot over the RPC websocket (free on Helius' plans).
 * Programs like TukTuk compare a job's due time with Clock.unix_timestamp, which can run a second or
 * more behind (or ahead of) the server's wall clock. Simulating by wall clock means either asking too
 * early ("not ready") or waiting a whole retry. Waiting for the chain's clock fires on the first slot
 * where the job is actually callable.
 */
export class ChainClock {
  private latest?: { slot: number; unixTimestamp: number; receivedAt: number };
  private subscription?: number;
  private waiters: { due: number; resolve: (ok: boolean) => void; timer: NodeJS.Timeout }[] = [];
  /** Wall clock minus chain clock, in ms, averaged (positive = the chain is behind us). */
  lagMs: number | null = null;

  constructor(private conn: Connection, private now: () => number = Date.now) {}

  start(): void {
    if (this.subscription !== undefined || typeof this.conn.onAccountChange !== 'function') return;
    this.subscription = this.conn.onAccountChange(SYSVAR_CLOCK_PUBKEY, info => this.update(decodeClock(info.data)), { commitment: 'processed' });
    log.info('chain clock: subscribed to the Clock sysvar over websocket');
  }

  async stop(): Promise<void> {
    if (this.subscription !== undefined) await this.conn.removeAccountChangeListener(this.subscription).catch(() => undefined);
    this.subscription = undefined;
  }

  /** Feed one Clock update (also used by tests). */
  update(c: { slot: number; unixTimestamp: number }): void {
    if (this.latest && c.slot <= this.latest.slot) return;
    const receivedAt = this.now();
    if (!this.latest || c.unixTimestamp !== this.latest.unixTimestamp) {
      // A new chain second just started: compare it with our clock.
      const lag = receivedAt - c.unixTimestamp * 1000;
      this.lagMs = this.lagMs === null ? lag : Math.round(this.lagMs * 0.9 + lag * 0.1);
    }
    this.latest = { ...c, receivedAt };
    for (const w of [...this.waiters]) if (c.unixTimestamp >= w.due) this.settle(w, true);
  }

  /** Is the clock live (an update in the last 5 s)? */
  get live(): boolean {
    return !!this.latest && this.now() - this.latest.receivedAt < 5_000;
  }

  get unixTimestamp(): number | undefined {
    return this.latest?.unixTimestamp;
  }

  private settle(w: (typeof this.waiters)[number], ok: boolean) {
    clearTimeout(w.timer);
    this.waiters = this.waiters.filter(x => x !== w);
    w.resolve(ok);
  }

  /**
   * Resolve true as soon as the chain's clock reaches `dueSec`, or false after `timeoutMs` (or straight
   * away if the clock isn't live, so the caller falls back to the wall clock).
   */
  waitFor(dueSec: number, timeoutMs = 5_000): Promise<boolean> {
    if (!this.live) return Promise.resolve(false);
    if ((this.latest?.unixTimestamp ?? 0) >= dueSec) return Promise.resolve(true);
    return new Promise(resolve => {
      const w = { due: dueSec, resolve, timer: setTimeout(() => this.settle(w, false), timeoutMs) };
      this.waiters.push(w);
    });
  }
}
