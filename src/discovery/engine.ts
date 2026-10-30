import { type Connection, PublicKey } from '@solana/web3.js';
import { type Config, formatSol } from '../config.js';
import { type CreditWatch, isClaudeCreditError } from '../core/creditWatch.js';
import type { Ledger } from '../core/ledger.js';
import { log } from '../core/logger.js';
import type { Notifier } from '../core/notifier.js';
import { type Classifier, type JobCandidate, worthValidating } from './classify.js';
import { draftDisclosure, saveDisclosure } from './disclosure.js';
import { fetchIdl, type ProgramIdl } from './idl.js';
import { screenProgram } from './prefilter.js';
import { discoveryJobType, type ReplaySpec } from './replayJob.js';
import { validateCandidate, type ValidationResult } from './validate.js';

/** What we store per discovery so an approved one can be turned back into a runnable job. */
export interface StoredCandidate {
  candidate: JobCandidate;
  discriminatorHex: string;
  callerIndex: number;
}

export interface DiscoveryReport {
  programsScanned: number;
  skipped: { program: string; why: string }[];
  classified: number;
  validated: { id: number; candidate: JobCandidate; result: ValidationResult }[];
  proposals: { id: number; candidate: JobCandidate; result: ValidationResult }[];
  anomalies: { id: number; candidate: JobCandidate; result: ValidationResult; disclosurePath: string }[];
  rejected: { candidate: JobCandidate; status: string; summary: string }[];
}

export type ValidateFn = typeof validateCandidate;

/**
 * Discovery: read IDLs → cheap signer screen → AI classification → deterministic on-chain validation.
 *  - validated (replay is profitable now, no third-party funds move) → Telegram approval; once approved it runs as a ReplayJob
 *  - paid_not_replayable → Telegram "adapter proposal" (real callers get paid, needs a dedicated adapter)
 *  - anomaly → never executed; disclosure draft saved and sent to the owner
 */
export class DiscoveryEngine {
  constructor(
    private conn: Connection,
    private cfg: Config,
    private ledger: Ledger,
    private notifier: Notifier,
    private classifier: Classifier,
    private opts: { disclosureDir?: string; force?: boolean; credits?: CreditWatch; dailyBudgetUsd?: number; validate?: ValidateFn; fetch?: (p: PublicKey) => Promise<ProgramIdl | undefined> } = {},
  ) {}

  private dayKey() {
    return `claude_usd:${new Date().toISOString().slice(0, 10)}`;
  }

  /** Claude spend so far today (UTC), from the actual token usage of each call. */
  spentTodayUsd(): number {
    return Number(this.ledger.getState(this.dayKey()) ?? 0);
  }

  private addSpend(usd: number) {
    this.ledger.setState(this.dayKey(), String(this.spentTodayUsd() + usd));
  }

  private budgetLeftUsd(): number {
    return this.opts.dailyBudgetUsd === undefined ? Infinity : this.opts.dailyBudgetUsd - this.spentTodayUsd();
  }

  async run(programIds: string[]): Promise<DiscoveryReport> {
    const report: DiscoveryReport = { programsScanned: 0, skipped: [], classified: 0, validated: [], proposals: [], anomalies: [], rejected: [] };
    for (const id of programIds) {
      try {
        await this.scanProgram(id, report);
      } catch (e) {
        if (e instanceof BudgetReached) {
          log.info('daily Claude budget reached; discovery continues tomorrow', { spentUsd: this.spentTodayUsd().toFixed(3), budgetUsd: this.opts.dailyBudgetUsd });
          report.skipped.push({ program: id, why: `daily Claude budget ($${this.opts.dailyBudgetUsd}) reached` });
          break;
        }
        if (isClaudeCreditError(e)) {
          // No point trying the other programs; the next scheduled pass retries.
          await this.opts.credits?.report('claude', e instanceof Error ? e.message : String(e));
          report.skipped.push({ program: id, why: 'Claude API out of credits — discovery stopped' });
          break;
        }
        log.warn('discovery failed for program', { program: id, error: String(e) });
        report.skipped.push({ program: id, why: `error: ${String(e).slice(0, 200)}` });
      }
    }
    log.info('discovery pass done', {
      claudeUsdToday: Number(this.spentTodayUsd().toFixed(4)),
      programs: report.programsScanned, classified: report.classified, validated: report.validated.length,
      proposals: report.proposals.length, anomalies: report.anomalies.length,
    });
    return report;
  }

  private async scanProgram(programId: string, report: DiscoveryReport): Promise<void> {
    const program = new PublicKey(programId);
    const idl = await (this.opts.fetch ?? (p => fetchIdl(this.conn, p)))(program);
    if (!idl) {
      this.ledger.markProgramScanned(programId, null, null);
      report.skipped.push({ program: programId, why: 'no on-chain Anchor IDL' });
      return;
    }
    if (!this.opts.force && this.ledger.programScanned(programId, idl.hash)) {
      report.skipped.push({ program: programId, why: 'already classified this IDL version' });
      return;
    }
    report.programsScanned++;

    const screened = screenProgram(idl.instructions);
    // Reuse a classification we already paid for (e.g. validation failed last time); otherwise ask Claude once and keep the answer.
    const cached = this.ledger.getClassification(programId, idl.hash) as JobCandidate[] | undefined;
    if (!cached && screened.length > 0 && this.budgetLeftUsd() <= 0) throw new BudgetReached();
    const candidates = cached ?? await this.classifier.classify(idl, screened);
    if (!cached) {
      this.ledger.saveClassification(programId, idl.hash, candidates);
      this.addSpend(this.classifier.lastCostUsd ?? 0);
    }
    if (screened.length && !cached) await this.opts.credits?.recovered('claude');
    report.classified += candidates.length;
    log.info('classified', { program: idl.name, screened: screened.length, worth: candidates.filter(c => worthValidating(c)).length });

    for (const c of candidates) {
      const ix = idl.instructions.find(i => i.name === c.instruction)!;
      const named = ix.accounts.findIndex(a => a.name === c.callerAccount && a.signer);
      const callerIndex = named >= 0 ? named : ix.accounts.findIndex(a => a.signer);
      const stored: StoredCandidate = { candidate: c, discriminatorHex: ix.discriminator.toString('hex'), callerIndex };

      if (!worthValidating(c)) {
        const why = c.harmsUsers ? 'could harm users' : !c.permissionless ? 'not permissionless' : !c.paysCaller ? 'does not pay the caller' : `low confidence ${c.confidence}`;
        report.rejected.push({ candidate: c, status: 'not_a_job', summary: why });
        continue;
      }

      const result = await (this.opts.validate ?? validateCandidate)(this.conn, this.cfg.agentPubkey, new PublicKey(c.program), ix.discriminator, callerIndex, this.cfg.caps, new Map(), { scan: 80, want: 3, delayMs: 150 });
      const id = this.ledger.upsertDiscovery({
        programId: c.program, programName: c.programName, instruction: c.instruction, status: result.status,
        confidence: c.confidence, summary: result.summary, candidate: stored, validation: result,
      });

      if (result.status === 'validated') {
        report.validated.push({ id, candidate: c, result });
        const type = discoveryJobType(id);
        const { isNew } = this.ledger.registerJobType(type, c.programName, `${c.instruction} (discovered)`, c.rewardSource);
        if (isNew) await this.notifier.requestApproval({ jobType: type, protocol: c.programName, description: `${c.instruction} — ${c.trigger}`, rewardSource: c.rewardSource, evidence: evidenceText(c, result) });
      } else if (result.status === 'paid_not_replayable') {
        report.proposals.push({ id, candidate: c, result });
        await this.notifier.alert(`🔎 Discovery: ${c.programName}::${c.instruction} pays its callers but needs a dedicated adapter.\n${evidenceText(c, result)}`);
      } else if (result.status === 'anomaly') {
        const d = draftDisclosure(c, result, this.cfg.agentPubkey.toBase58());
        const path = saveDisclosure(this.opts.disclosureDir ?? 'data/disclosures', d);
        report.anomalies.push({ id, candidate: c, result, disclosurePath: path });
        log.warn('anomaly found — drafted disclosure, never executing', { program: c.program, instruction: c.instruction, path });
        await this.notifier.alert(`🚨 Anomaly guard: ${c.programName}::${c.instruction}\n${result.summary}\nNot executed. Disclosure draft attached.`);
        await this.notifier.sendDocument(d.filename, d.markdown, `Disclosure draft: ${c.programName}::${c.instruction}`);
      } else {
        report.rejected.push({ candidate: c, status: result.status, summary: result.summary });
      }
    }
    this.ledger.markProgramScanned(programId, idl.name, idl.hash);
  }
}

class BudgetReached extends Error {}

export function evidenceText(c: JobCandidate, v: ValidationResult): string {
  const best = v.attempts.find(a => a.decision.ok) ?? v.attempts[0];
  return [
    `AI (confidence ${c.confidence.toFixed(2)}): ${c.evidence.slice(0, 3).join(' · ')}`,
    `Trigger: ${c.trigger}`,
    `Simulation: ${v.summary}`,
    best ? `Replayed ${best.replayedSignature.slice(0, 16)}…: ${best.decision.reason}, ${best.unitsConsumed} CU` : '',
    v.historicalGrossLamports.length ? `Recent callers earned (gross): ${v.historicalGrossLamports.map(h => formatSol(h)).join(', ')}` : '',
    v.recentCallers !== undefined ? `Competition: ${v.recentCallers === 1 ? '1 wallet makes these calls (one bot owns it)' : `${v.recentCallers} different wallets made the last ${v.historicalGrossLamports.length} calls`}` : '',
  ].filter(Boolean).join('\n');
}

/** Rebuild the runtime spec of an approved discovery from the ledger. */
export function replaySpecFromLedger(ledger: Ledger, discoveryId: number): ReplaySpec | undefined {
  const row = ledger.getDiscovery(discoveryId);
  if (!row || row.status !== 'validated') return undefined;
  const s = JSON.parse(row.candidate_json) as StoredCandidate;
  return { discoveryId, candidate: s.candidate, discriminator: Buffer.from(s.discriminatorHex, 'hex'), callerIndex: s.callerIndex };
}
