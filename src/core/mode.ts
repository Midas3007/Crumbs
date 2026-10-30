import { type Config, formatSol, type Mode } from '../config.js';
import type { Ledger } from './ledger.js';

export interface ChecklistItem {
  ok: boolean;
  /** A blocker stops going live; a warning is shown but doesn't. */
  blocker: boolean;
  text: string;
}

/**
 * Shadow/live switch controlled from Telegram (/live, /shadow). The choice is saved in the ledger so it
 * survives restarts; the CRUMBS_MODE env var is only the starting value. Executor, publisher and
 * sweeper all read cfg.mode on every use, so a switch takes effect on the next tick.
 */
export class ModeSwitch {
  constructor(private cfg: Config, private ledger: Ledger) {
    const saved = ledger.getState('mode');
    if (saved === 'live' && cfg.agentKeypair) cfg.mode = 'live';
    if (saved === 'shadow') cfg.mode = 'shadow';
  }

  get mode(): Mode {
    return this.cfg.mode;
  }

  /** The go-live checklist from the brief, minus the 24h shadow run (owner waived it). */
  checklist(walletLamports: bigint, paused: { paused: boolean; locked: boolean; reason?: string }): ChecklistItem[] {
    const caps = this.cfg.caps;
    const approved = this.ledger.listJobTypes().filter(j => j.status === 'approved');
    const minFees = 2_000_000n; // 0.002 SOL ≈ 200 transactions' fees
    return [
      { ok: Boolean(this.cfg.agentKeypair), blocker: true, text: this.cfg.agentKeypair ? 'Wallet key loaded' : 'No wallet key on this server (set AGENT_KEYPAIR_PATH)' },
      { ok: walletLamports >= minFees, blocker: true, text: `Wallet has ${formatSol(walletLamports)} (needs at least ${formatSol(minFees)} for fees)` },
      { ok: walletLamports <= caps.walletCapLamports, blocker: true, text: `Wallet within its ${formatSol(caps.walletCapLamports)} cap` },
      { ok: !paused.locked, blocker: true, text: paused.locked ? 'CRUMBS_PAUSED env flag is set on the server' : 'Kill switch ready: /pause stops everything instantly' },
      { ok: true, blocker: false, text: `Caps: lose at most ${formatSol(caps.dailyLossCapLamports)}/day, ${formatSol(caps.perJobSpendCapLamports)} fees per job, profit ≥ ${caps.minProfitLamports} lamports` },
      { ok: approved.length > 0, blocker: false, text: approved.length ? `Approved job types: ${approved.map(j => j.type).join(', ')}` : 'No job types approved yet: nothing will be sent until you approve one in /jobs' },
      { ok: !paused.paused || paused.locked, blocker: false, text: paused.paused && !paused.locked ? `Currently paused (${paused.reason}); /resume to start sending` : 'Not paused' },
      { ok: false, blocker: false, text: 'Skipping the 24h shadow run (your call): expect few or no wins on fresh TukTuk tasks' },
    ];
  }

  canGoLive(items: ChecklistItem[]): boolean {
    return items.every(i => i.ok || !i.blocker);
  }

  setLive(): void {
    if (!this.cfg.agentKeypair) throw new Error('no wallet key loaded');
    this.cfg.mode = 'live';
    this.ledger.setState('mode', 'live');
  }

  setShadow(): void {
    this.cfg.mode = 'shadow';
    this.ledger.setState('mode', 'shadow');
  }
}

export function checklistText(items: ChecklistItem[]): string {
  return items.map(i => `${i.ok ? '✅' : i.blocker ? '⛔' : '⚠️'} ${i.text}`).join('\n');
}
