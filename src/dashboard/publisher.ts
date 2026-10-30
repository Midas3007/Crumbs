import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Connection } from '@solana/web3.js';
import type { Config } from '../config.js';
import type { Guardrails } from '../core/caps.js';
import type { Ledger } from '../core/ledger.js';
import { log } from '../core/logger.js';
import { solUsd } from '../core/prices.js';
import { associatedTokenAddress, USDC_MINT } from '../core/tokens.js';
import { PublicKey } from '@solana/web3.js';
import { buildSnapshot, type Snapshot } from './snapshot.js';

/**
 * Builds the dashboard snapshot, writes it to disk (data/snapshot.json) and, if DASHBOARD_URL is set,
 * pushes it to the dashboard's /api/snapshot with the shared secret. Plain fetch: nothing extra to install.
 */
export class Publisher {
  private lastPushError = '';
  latest?: Snapshot;
  solUsd: number | null = null;

  constructor(private conn: Connection, private cfg: Config, private ledger: Ledger, private guard: Guardrails, private file = 'data/snapshot.json') {}

  async publish(): Promise<Snapshot> {
    const [price, lamports, usdc] = await Promise.all([
      solUsd(this.conn).catch(() => undefined),
      this.conn.getBalance(this.cfg.agentPubkey).catch(() => 0),
      this.conn.getTokenAccountBalance(associatedTokenAddress(this.cfg.agentPubkey, new PublicKey(USDC_MINT)))
        .then(b => Number(b.value.uiAmount ?? 0)).catch(() => 0),
    ]);
    if (price) this.solUsd = price.usd;
    const state = this.guard.state();
    const snap = buildSnapshot(this.ledger, {
      mode: this.cfg.mode, paused: { paused: state.paused, reason: state.reason },
      wallet: this.cfg.agentPubkey.toBase58(), solLamports: BigInt(lamports), usdc, solUsd: this.solUsd,
    });
    this.latest = snap;

    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(snap, null, 2));

    const { url, secret } = this.cfg.dashboard;
    if (url && secret) {
      try {
        const res = await fetch(new URL('/api/snapshot', url), {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` },
          body: JSON.stringify(snap),
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text().catch(() => '')}`.slice(0, 200));
        if (this.lastPushError) log.info('dashboard push working again');
        this.lastPushError = '';
      } catch (e) {
        const msg = String(e);
        if (msg !== this.lastPushError) log.warn('dashboard push failed', { error: msg });
        this.lastPushError = msg;
      }
    }
    return snap;
  }
}
