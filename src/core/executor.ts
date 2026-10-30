import type { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { type Config, formatSol } from '../config.js';
import type { Guardrails } from './caps.js';
import { clampPriorityFee, estimatePriorityFee, BASE_FEE_PER_SIGNATURE } from './fees.js';
import type { AttemptRecord, Ledger } from './ledger.js';
import { log } from './logger.js';
import type { Notifier } from './notifier.js';
import { evaluateProfit, type PriceBook } from './profitGuard.js';
import { computeUnitLimit, measureUnits, simulateFinal } from './simulate.js';
import { type BuiltJob, type Candidate, type Job, JobGone, type ProfitDecision, type SimOutcome } from './types.js';

/** Don't re-try the same candidate more often than this after a rejection... */
const RETRY_COOLDOWN_MS = 60_000;
/** ...unless it only just became due: then the chain clock may simply be a second behind ours. */
const FRESH_WINDOW_MS = 30_000;
const FRESH_RETRY_MS = 1_000;
/** Adapters may hand over work a little before it's due; we wait for it rather than poll again. */
const MAX_WAIT_FOR_DUE_MS = 3_000;

export interface Attempt {
  candidate: Candidate;
  decision?: ProfitDecision;
  outcome: 'gone' | 'error' | 'rejected' | 'anomaly' | 'shadow' | 'blocked' | 'landed' | 'failed';
  signature?: string;
}

/**
 * The loop at the heart of Crumbs: detect → build → simulate → profit guard → execute (or log in shadow mode).
 * The AI is never in here; every decision in this file is deterministic.
 */
export class Executor {
  private lastTried = new Map<string, number>();
  private blockhash?: { value: string; lastValidBlockHeight: number; at: number };
  private stopped = false;
  private prices: PriceBook = new Map();
  /** Counts since start, for the heartbeat log and /status. */
  readonly stats = { checks: 0, candidates: 0, gone: 0, rejected: 0, shadow: 0, sent: 0, anomalies: 0, errors: 0 };

  constructor(
    private conn: Connection,
    private cfg: Config,
    private ledger: Ledger,
    private guard: Guardrails,
    private notifier: Notifier,
    private jobs: Job[],
  ) {}

  addJob(job: Job) {
    if (!this.jobs.some(j => j.type === job.type)) this.jobs.push(job);
  }

  hasJob(type: string): boolean {
    return this.jobs.some(j => j.type === type);
  }

  setPrices(prices: PriceBook) {
    this.prices = prices;
  }

  /** Register every adapter's job type; new ones ask the owner for approval. */
  async registerJobTypes(): Promise<void> {
    for (const job of this.jobs) {
      const { isNew, status } = this.ledger.registerJobType(job.type, job.protocol, job.description, job.rewardSource);
      if (isNew || status === 'pending') {
        await this.notifier.requestApproval({ jobType: job.type, protocol: job.protocol, description: job.description, rewardSource: job.rewardSource });
      }
    }
  }

  async run(): Promise<void> {
    log.info('crumbs executor started', { mode: this.cfg.mode, agent: this.cfg.agentPubkey.toBase58(), jobs: this.jobs.map(j => j.type) });
    while (!this.stopped) {
      const started = Date.now();
      await this.tick().catch(e => log.error('tick failed', { error: String(e) }));
      const wait = this.cfg.pollIntervalMs - (Date.now() - started);
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
    }
  }

  stop() {
    this.stopped = true;
  }

  async tick(): Promise<Attempt[]> {
    const results: Attempt[] = [];
    this.stats.checks++;
    for (const job of this.jobs) {
      let candidates: Candidate[];
      try {
        candidates = await job.detect();
      } catch (e) {
        log.warn('detect failed', { job: job.type, error: String(e) });
        continue;
      }
      for (const c of candidates) {
        const dueMs = (c.dueAt ?? 0) * 1000;
        const wait = dueMs - Date.now();
        if (wait > MAX_WAIT_FOR_DUE_MS) continue;
        const last = this.lastTried.get(c.id);
        const fresh = Date.now() - dueMs < FRESH_WINDOW_MS;
        if (last !== undefined && Date.now() - last < (fresh ? FRESH_RETRY_MS : RETRY_COOLDOWN_MS)) continue;
        if (wait > 0) await new Promise(r => setTimeout(r, wait));
        this.lastTried.set(c.id, Date.now());
        const a = await this.process(job, c);
        this.count(a);
        results.push(a);
      }
    }
    this.pruneCooldowns();
    return results;
  }

  private count(a: Attempt) {
    const s = this.stats;
    s.candidates++;
    if (a.outcome === 'gone') s.gone++;
    else if (a.outcome === 'rejected') s.rejected++;
    else if (a.outcome === 'shadow') s.shadow++;
    else if (a.outcome === 'anomaly') s.anomalies++;
    else if (a.outcome === 'error' || a.outcome === 'blocked') s.errors++;
    else s.sent++;
  }

  /** One human-readable line: proof of life and what the agent has been doing. */
  heartbeat(): string {
    const s = this.stats;
    return `alive · ${s.checks} checks · ${s.candidates} jobs looked at: ${s.shadow} profitable (shadow), ${s.sent} sent, `
      + `${s.gone} already taken by other bots, ${s.rejected} not worth it, ${s.anomalies} anomalies, ${s.errors} errors`;
  }

  private pruneCooldowns() {
    if (this.lastTried.size < 10_000) return;
    const cutoff = Date.now() - RETRY_COOLDOWN_MS;
    for (const [k, t] of this.lastTried) if (t < cutoff) this.lastTried.delete(k);
  }

  private async latestBlockhash() {
    if (!this.blockhash || Date.now() - this.blockhash.at > 15_000) {
      const b = await this.conn.getLatestBlockhash('confirmed');
      this.blockhash = { value: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight, at: Date.now() };
    }
    return this.blockhash;
  }

  /** Simulate and evaluate one candidate. Exposed for tests and for discovery validation (M2). */
  async estimateProfit(built: BuiltJob): Promise<{ tx?: VersionedTransaction; sim?: SimOutcome; decision: ProfitDecision }> {
    const payer = this.cfg.agentPubkey;
    const { value: blockhash } = await this.latestBlockhash();
    const measured = await measureUnits(this.conn, payer, built, blockhash);
    if (measured.err !== null) {
      const sim: SimOutcome = { err: measured.err, logs: measured.logs, unitsConsumed: measured.units, lamportsPre: 0n, lamportsPost: 0n, feeLamports: 0n, tipLamports: 0n, tokenDeltas: [] };
      return { sim, decision: evaluateProfit(sim, built, this.cfg.caps, this.prices) };
    }
    const cuLimit = computeUnitLimit(measured.units);
    const writable = built.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey));
    const estimate = await estimatePriorityFee(this.conn, writable, !!this.cfg.heliusApiKey);
    const micro = clampPriorityFee(estimate, cuLimit, built.expectedRewardLamports, BASE_FEE_PER_SIGNATURE, this.cfg.caps.minProfitLamports);
    const { tx, outcome } = await simulateFinal(this.conn, payer, built, blockhash, cuLimit, micro);
    return { tx, sim: outcome, decision: evaluateProfit(outcome, built, this.cfg.caps, this.prices) };
  }

  async process(job: Job, c: Candidate): Promise<Attempt> {
    let built: BuiltJob;
    try {
      built = await job.build(c, this.cfg.agentPubkey);
    } catch (e) {
      if (e instanceof JobGone) {
        log.debug('job gone', { job: job.type, candidate: c.id, why: e.message });
        return { candidate: c, outcome: 'gone' };
      }
      log.warn('build failed', { job: job.type, candidate: c.id, error: String(e) });
      return { candidate: c, outcome: 'error' };
    }

    let est: Awaited<ReturnType<Executor['estimateProfit']>>;
    try {
      est = await this.estimateProfit(built);
    } catch (e) {
      log.warn('simulation failed to run', { job: job.type, candidate: c.id, error: String(e) });
      return { candidate: c, outcome: 'error' };
    }
    const { decision, sim, tx } = est;
    const base = {
      jobType: job.type, candidateId: c.id, mode: this.cfg.mode, verdict: decision.verdict, reason: decision.reason,
      simNetLamports: decision.netLamports, simGrossLamports: decision.grossRewardLamports, simCostLamports: decision.costLamports,
      expectedRewardLamports: built.expectedRewardLamports, unitsConsumed: sim?.unitsConsumed,
    } as const;

    if (decision.verdict === 'anomaly') {
      this.ledger.recordAttempt({ ...base, outcome: 'anomaly' });
      log.warn('ANOMALY — not executing', { job: job.type, candidate: c.id, reason: decision.reason });
      await this.notifier.alert(
        `🚨 Anomaly guard: ${job.protocol} ${c.description}\n${decision.reason}\nNot executed. Logs:\n${(sim?.logs ?? []).slice(-8).join('\n')}`);
      return { candidate: c, decision, outcome: 'anomaly' };
    }

    if (!decision.ok || !tx) {
      // Simulation failures are mostly "someone else got there first"; only log them at debug.
      if (decision.verdict !== 'simulation_failed') this.ledger.recordAttempt({ ...base, outcome: 'rejected' });
      log.debug('rejected', { job: job.type, candidate: c.id, verdict: decision.verdict, reason: decision.reason });
      return { candidate: c, decision, outcome: 'rejected' };
    }

    const approved = this.ledger.jobTypeStatus(job.type) === 'approved';
    if (this.cfg.mode === 'shadow' || !approved || !this.cfg.agentKeypair) {
      this.ledger.recordAttempt({ ...base, mode: 'shadow', outcome: 'shadow' });
      log.info('shadow: would earn', { job: job.type, candidate: c.id, net: decision.netLamports, why: approved ? 'shadow mode' : 'job type not approved' });
      return { candidate: c, decision, outcome: 'shadow' };
    }

    const balance = BigInt(await this.conn.getBalance(this.cfg.agentPubkey, 'processed'));
    const wasPaused = this.guard.state().paused;
    const block = this.guard.checkBeforeSend(balance);
    if (block) {
      this.ledger.recordAttempt({ ...base, outcome: 'skipped', reason: block });
      if (!wasPaused) await this.notifier.alert(`⏸️ Crumbs paused: ${block}`);
      return { candidate: c, decision, outcome: 'blocked' };
    }

    return this.send(job, c, built, decision, tx, this.cfg.agentKeypair, base);
  }

  private async send(job: Job, c: Candidate, built: BuiltJob, decision: ProfitDecision, tx: VersionedTransaction, signer: Keypair,
    base: Omit<AttemptRecord, 'outcome'>): Promise<Attempt> {
    tx.sign([signer]);
    const bh = await this.latestBlockhash();
    let signature: string;
    try {
      signature = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
    } catch (e) {
      log.warn('send failed', { job: job.type, candidate: c.id, error: String(e) });
      return { candidate: c, decision, outcome: 'error' };
    }
    const id = this.ledger.recordAttempt({ ...base, outcome: 'sent', signature });
    log.info('sent', { job: job.type, candidate: c.id, signature, expectedNet: decision.netLamports });

    let landedOk = false;
    try {
      const conf = await this.conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight: bh.lastValidBlockHeight }, 'confirmed');
      landedOk = conf.value.err === null;
    } catch (e) {
      log.warn('confirmation failed', { signature, error: String(e) });
    }

    const realized = await this.realizedNet(signature, this.cfg.agentPubkey, built);
    const outcome = landedOk ? 'landed' : 'failed';
    this.ledger.settleAttempt(id, outcome, realized.net, landedOk ? undefined : 'lost race or failed on-chain');
    log.info(outcome, { job: job.type, signature, realizedNet: realized.net });

    const breach = this.guard.checkAfterSend(realized.net, realized.fee);
    if (breach) await this.notifier.alert(`⏸️ Crumbs paused: ${breach}`);
    return { candidate: c, decision, outcome, signature };
  }

  /** What the tx actually did to the agent's balances, read back from the chain. */
  private async realizedNet(signature: string, agent: PublicKey, built: BuiltJob): Promise<{ net: bigint; fee: bigint }> {
    for (let i = 0; i < 5; i++) {
      const tx = await this.conn.getTransaction(signature, { commitment: 'confirmed', maxSupportedTransactionVersion: 0 });
      if (tx?.meta) {
        const keys = tx.transaction.message.getAccountKeys({ accountKeysFromLookups: tx.meta.loadedAddresses });
        const idx = keys.staticAccountKeys.findIndex(k => k.equals(agent));
        let net = idx >= 0 ? BigInt(tx.meta.postBalances[idx] - tx.meta.preBalances[idx]) : 0n;
        for (const w of built.watchedTokenAccounts ?? []) {
          const find = (arr: typeof tx.meta.preTokenBalances) => arr?.find(b => keys.get(b.accountIndex)?.equals(w.address));
          const delta = BigInt(find(tx.meta.postTokenBalances)?.uiTokenAmount.amount ?? '0') - BigInt(find(tx.meta.preTokenBalances)?.uiTokenAmount.amount ?? '0');
          const price = this.prices.get(w.mint) ?? 0;
          net += BigInt(Math.floor((Number(delta) / 10 ** w.decimals) * price));
        }
        return { net, fee: BigInt(tx.meta.fee) + (built.tipLamports ?? 0n) };
      }
      await new Promise(r => setTimeout(r, 1500));
    }
    // Never landed (dropped or expired): no fee was charged, nothing earned.
    log.warn('tx not found on chain; treating as dropped', { signature });
    return { net: 0n, fee: 0n };
  }

  summaryText(): string {
    const d = this.ledger.daySummary();
    return [
      `🍞 Crumbs — ${d.day} (${this.cfg.mode} mode)`,
      `Live: ${d.landed} landed, ${d.failed} lost · net ${formatSol(d.realizedNetLamports)}`,
      `Shadow: ${d.shadowWins} profitable sims · would have earned ${formatSol(d.shadowNetLamports)}`,
      `Fees paid: ${formatSol(d.feesPaidLamports)}`,
      `Since start: ${this.heartbeat()}`,
    ].join('\n');
  }
}

