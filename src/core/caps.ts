import type { Caps } from '../config.js';
import { formatSol } from '../config.js';
import type { Ledger } from './ledger.js';

export interface PauseState {
  paused: boolean;
  reason?: string;
  /** Env-flag pauses can't be lifted from Telegram. */
  locked: boolean;
}

/**
 * Kill switch and spending caps. Every send goes through `checkBeforeSend`; every landed or
 * failed tx goes through `checkAfterSend`. A breach pauses the agent and returns an alert.
 */
export class Guardrails {
  constructor(private ledger: Ledger, private caps: Caps, private envPaused: boolean) {}

  state(): PauseState {
    if (this.envPaused) return { paused: true, reason: 'CRUMBS_PAUSED env flag is set', locked: true };
    const reason = this.ledger.getState('paused');
    return reason ? { paused: true, reason, locked: false } : { paused: false, locked: false };
  }

  pause(reason: string): void {
    this.ledger.setState('paused', reason);
  }

  /** Returns false if the pause can't be lifted (env flag). */
  resume(): boolean {
    if (this.envPaused) return false;
    this.ledger.deleteState('paused');
    return true;
  }

  /** May we send a transaction right now? Returns a reason if not. */
  checkBeforeSend(walletLamports: bigint): string | undefined {
    const s = this.state();
    if (s.paused) return `paused: ${s.reason}`;
    if (walletLamports > this.caps.walletCapLamports) {
      const reason = `wallet holds ${formatSol(walletLamports)}, above the ${formatSol(this.caps.walletCapLamports)} cap — move the excess out`;
      this.pause(reason);
      return reason;
    }
    const today = this.ledger.daySummary();
    if (today.realizedLossLamports >= this.caps.dailyLossCapLamports) {
      const reason = `daily loss cap hit: lost ${formatSol(today.realizedLossLamports)} today`;
      this.pause(reason);
      return reason;
    }
    return undefined;
  }

  /** Call after a sent tx settles. Returns an alert message if a cap was breached (agent is now paused). */
  checkAfterSend(realizedNetLamports: bigint, spentLamports: bigint): string | undefined {
    if (spentLamports > this.caps.perJobSpendCapLamports) {
      const reason = `per-job spend cap breached: one job spent ${formatSol(spentLamports)} (cap ${formatSol(this.caps.perJobSpendCapLamports)})`;
      this.pause(reason);
      return reason;
    }
    const today = this.ledger.daySummary();
    if (today.realizedLossLamports >= this.caps.dailyLossCapLamports) {
      const reason = `daily loss cap hit: lost ${formatSol(today.realizedLossLamports)} today (last job ${formatSol(realizedNetLamports)})`;
      this.pause(reason);
      return reason;
    }
    return undefined;
  }
}
