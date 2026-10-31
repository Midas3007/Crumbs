import type { Ledger } from './ledger.js';
import { log } from './logger.js';

export interface FeatureSpec {
  name: string;
  description: string;
  /** On unless the owner (or the circuit breaker) has switched it off. */
  defaultOn: boolean;
}

export interface BreakerOptions {
  /** Trip when the feature's P&L is below minus this (lamports). Default 20,000 (~$0.002). */
  thresholdLamports?: bigint;
  /** Judge the first this-many sends after the feature is (re)enabled. */
  firstSends?: number;
  /** ...and every rolling window of this length. */
  windowMs?: number;
}

export interface FeatureStatus {
  name: string;
  description: string;
  on: boolean;
  /** Why it's off, when it is. */
  offReason?: string;
  sends: number;
  netLamports: bigint;
}

/**
 * Feature flags with a circuit breaker each. Every new way of making money (batching, a new sender,
 * a new adapter) is a feature: the owner can switch it off from Telegram, and it switches itself off
 * if its sends lose money over its first 50 sends or over any rolling hour. The rest keeps running.
 * State lives in the ledger, so an off switch survives restarts.
 */
export class Features {
  private readonly threshold: bigint;
  private readonly firstSends: number;
  private readonly windowMs: number;

  constructor(private ledger: Ledger, private specs: FeatureSpec[], private alert: (text: string) => Promise<void> | void,
    opts: BreakerOptions = {}, private now: () => number = Date.now) {
    this.threshold = opts.thresholdLamports ?? 20_000n;
    this.firstSends = opts.firstSends ?? 50;
    this.windowMs = opts.windowMs ?? 3_600_000;
    ledger.db.exec(`CREATE TABLE IF NOT EXISTS feature_sends (
      id INTEGER PRIMARY KEY AUTOINCREMENT, feature TEXT NOT NULL, ts INTEGER NOT NULL, net INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS feature_sends_f ON feature_sends(feature, ts);`);
  }

  private spec(name: string): FeatureSpec {
    const s = this.specs.find(x => x.name === name);
    if (!s) throw new Error(`unknown feature ${name}`);
    return s;
  }

  /** Add a feature at runtime (e.g. each discovered job type gets its own breaker). */
  register(spec: FeatureSpec): void {
    if (!this.has(spec.name)) this.specs.push(spec);
  }

  has(name: string): boolean {
    return this.specs.some(x => x.name === name);
  }

  enabled(name: string): boolean {
    const v = this.ledger.getState(`feature:${name}`);
    return v === undefined ? this.spec(name).defaultOn : v === 'on';
  }

  /** Owner switch. Turning a feature on starts a fresh first-50 judgement. */
  set(name: string, on: boolean, reason = 'switched off by the owner'): void {
    this.spec(name);
    this.ledger.setState(`feature:${name}`, on ? 'on' : 'off');
    if (on) {
      this.ledger.deleteState(`feature_off_reason:${name}`);
      this.ledger.setState(`feature_since:${name}`, String(this.now()));
    } else {
      this.ledger.setState(`feature_off_reason:${name}`, reason);
    }
  }

  /** Book one settled send's realised net for a feature, and trip the breaker if it's losing. */
  async record(name: string, netLamports: bigint): Promise<void> {
    const ts = this.now();
    this.ledger.db.prepare('INSERT INTO feature_sends (feature, ts, net) VALUES (?, ?, ?)').run(name, ts, netLamports);
    if (!this.enabled(name)) return;
    const since = Number(this.ledger.getState(`feature_since:${name}`) ?? 0);
    const sum = (from: number) => this.ledger.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(net), 0) AS net FROM feature_sends WHERE feature = ? AND ts >= ?')
      .get(name, from) as { n: number | bigint; net: number | bigint };
    const all = sum(since);
    const hour = sum(Math.max(since, ts - this.windowMs));
    let why: string | undefined;
    // The first-sends judgement covers sends 1..firstSends after (re)enabling; after that only the rolling hour applies.
    if (Number(all.n) <= this.firstSends && BigInt(all.net) < -this.threshold) {
      why = `its first ${all.n} sends lost ${-BigInt(all.net)} lamports (limit ${this.threshold})`;
    } else if (BigInt(hour.net) < -this.threshold) {
      why = `it lost ${-BigInt(hour.net)} lamports over the last hour across ${hour.n} sends (limit ${this.threshold})`;
    }
    if (!why) return;
    this.set(name, false, `circuit breaker: ${why}`);
    log.warn('circuit breaker tripped', { feature: name, why });
    await this.alert(`🔌 Circuit breaker: switched off "${name}" because ${why}. Everything else keeps running. /features to switch it back on.`);
  }

  status(): FeatureStatus[] {
    return this.specs.map(s => {
      const r = this.ledger.db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(net), 0) AS net FROM feature_sends WHERE feature = ?').get(s.name) as { n: number; net: number | bigint };
      const on = this.enabled(s.name);
      return { name: s.name, description: s.description, on, offReason: on ? undefined : this.ledger.getState(`feature_off_reason:${s.name}`) ?? 'off by default',
        sends: Number(r.n), netLamports: BigInt(r.net) };
    });
  }
}
