import type { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { type Config, formatSol } from '../config.js';
import type { Guardrails } from './caps.js';
import { clampPriorityFee, estimatePriorityFee, BASE_FEE_PER_SIGNATURE } from './fees.js';
import type { AttemptRecord, Ledger } from './ledger.js';
import { log } from './logger.js';
import { base58Encode } from './base58.js';
import type { JitoClient } from './jito.js';
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
/** Speed: reuse the priority-fee estimate and wallet balance for a few seconds instead of asking every job. */
const FEE_CACHE_MS = 10_000;
const BALANCE_CACHE_MS = 20_000;
/** Sends waiting for confirmation in the background at once; more waits for the next tick. */
const MAX_IN_FLIGHT = 3;

export interface ExecutorOptions {
  /** Confirm sent transactions in the background so the next job isn't kept waiting (on in production). */
  backgroundSettle?: boolean;
  /**
   * Send through Jito bundles: a bundle only lands if the transaction succeeds, so a lost race costs
   * nothing. The tip replaces the priority fee and is counted by the profit guard.
   */
  jito?: { client: JitoClient; tipLamports: bigint };
  /** How often to check whether a bundle landed (tests use 0). */
  jitoPollMs?: number;
}

export interface Attempt {
  candidate: Candidate;
  decision?: ProfitDecision;
  outcome: 'gone' | 'error' | 'rejected' | 'anomaly' | 'shadow' | 'blocked' | 'sent' | 'landed' | 'failed' | 'dropped';
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
  readonly startedAt = new Date().toISOString();
  readonly stats = { checks: 0, candidates: 0, gone: 0, rejected: 0, shadow: 0, sent: 0, anomalies: 0, errors: 0 };
  /** How long a job takes from "start" to "decision/sent", and how late after its due time we sent. */
  private timing = { jobs: 0, totalMs: 0, sends: 0, totalLateMs: 0 };
  private cuCache = new Map<string, number>();
  private feeCache = new Map<string, { micro: number; at: number }>();
  private balance?: { lamports: bigint; at: number };
  private inFlight = 0;

  constructor(
    private conn: Connection,
    private cfg: Config,
    private ledger: Ledger,
    private guard: Guardrails,
    private notifier: Notifier,
    private jobs: Job[],
    private opts: ExecutorOptions = {},
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
        const t0 = Date.now();
        const a = await this.process(job, c);
        this.timing.jobs++;
        this.timing.totalMs += Date.now() - t0;
        if (a.signature && c.dueAt) {
          this.timing.sends++;
          this.timing.totalLateMs += Math.max(0, Date.now() - c.dueAt * 1000);
        }
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
    const t = this.timing;
    const speed = t.jobs ? ` · ${Math.round(t.totalMs / t.jobs)}ms per job` : '';
    const late = t.sends ? `, sent ${Math.round(t.totalLateMs / t.sends)}ms after due on average` : '';
    return `alive · ${s.checks} checks · ${s.candidates} jobs looked at: ${s.shadow} profitable (shadow), ${s.sent} sent, `
      + `${s.gone} already taken by other bots, ${s.rejected} not worth it, ${s.anomalies} anomalies, ${s.errors} errors${speed}${late}`;
  }

  /** Average ms from picking up a job to deciding (and sending). */
  avgJobMs(): number | null {
    return this.timing.jobs ? Math.round(this.timing.totalMs / this.timing.jobs) : null;
  }

  private async priorityFee(key: string, writable: PublicKey[]): Promise<number> {
    const hit = this.feeCache.get(key);
    if (hit && Date.now() - hit.at < FEE_CACHE_MS) return hit.micro;
    const micro = await estimatePriorityFee(this.conn, writable, !!this.cfg.heliusApiKey);
    this.feeCache.set(key, { micro, at: Date.now() });
    return micro;
  }

  private async walletLamports(): Promise<bigint> {
    if (!this.balance || Date.now() - this.balance.at > BALANCE_CACHE_MS) {
      this.balance = { lamports: BigInt(await this.conn.getBalance(this.cfg.agentPubkey, 'processed')), at: Date.now() };
    }
    return this.balance.lamports;
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
  async estimateProfit(built: BuiltJob): Promise<{ tx?: VersionedTransaction; sim?: SimOutcome; decision: ProfitDecision; built: BuiltJob }> {
    const payer = this.cfg.agentPubkey;
    const jito = this.opts.jito;
    if (jito && built.tipLamports === undefined) {
      // The tip goes inside the transaction, so the simulation (and the profit guard) see its cost.
      built = { ...built, instructions: [...built.instructions, await jito.client.tipInstruction(payer, jito.tipLamports)], tipLamports: jito.tipLamports };
    }
    const { value: blockhash } = await this.latestBlockhash();
    const writable = built.instructions.flatMap(ix => ix.keys.filter(k => k.isWritable).map(k => k.pubkey));
    const feeKey = built.cuKey ?? built.instructions.at(-1)?.programId.toBase58() ?? 'default';

    // Speed: if we've measured this kind of job before, skip the measuring simulation and go straight to the final one.
    const known = built.cuKey ? this.cuCache.get(built.cuKey) : undefined;
    let units: number;
    if (known !== undefined) {
      units = known;
    } else {
      const measured = await measureUnits(this.conn, payer, built, blockhash);
      if (measured.err !== null) {
        const sim: SimOutcome = { err: measured.err, logs: measured.logs, unitsConsumed: measured.units, lamportsPre: 0n, lamportsPost: 0n, feeLamports: 0n, tipLamports: 0n, tokenDeltas: [] };
        return { sim, decision: evaluateProfit(sim, built, this.cfg.caps, this.prices), built };
      }
      units = measured.units;
    }
    const cuLimit = computeUnitLimit(units);
    // With Jito the tip buys inclusion, so no priority fee on top.
    const micro = jito ? 0 : clampPriorityFee(await this.priorityFee(feeKey, writable), cuLimit, built.expectedRewardLamports, BASE_FEE_PER_SIGNATURE, this.cfg.caps.minProfitLamports);
    const { tx, outcome } = await simulateFinal(this.conn, payer, built, blockhash, cuLimit, micro);
    if (outcome.err === null && built.cuKey) {
      this.cuCache.set(built.cuKey, Math.max(outcome.unitsConsumed, this.cuCache.get(built.cuKey) ?? 0));
    } else if (outcome.err !== null && known !== undefined && built.cuKey) {
      // The remembered compute may have been too low for this one: forget it and measure properly.
      this.cuCache.delete(built.cuKey);
      return this.estimateProfit(built);
    }
    return { tx, sim: outcome, decision: evaluateProfit(outcome, built, this.cfg.caps, this.prices), built };
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
    built = est.built;
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

    if (this.inFlight >= MAX_IN_FLIGHT) {
      log.debug('too many transactions awaiting confirmation; will retry', { job: job.type, candidate: c.id });
      return { candidate: c, decision, outcome: 'blocked' };
    }
    const balance = await this.walletLamports();
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
      if (this.opts.jito) {
        signature = base58Encode(tx.signatures[0]);
        await this.opts.jito.client.sendBundle(tx);
      } else {
        signature = await this.conn.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 });
      }
    } catch (e) {
      log.warn('send failed', { job: job.type, candidate: c.id, error: String(e) });
      return { candidate: c, decision, outcome: 'error' };
    }
    const id = this.ledger.recordAttempt({ ...base, outcome: 'sent', signature });
    log.info('sent', { job: job.type, candidate: c.id, signature, expectedNet: decision.netLamports });
    this.balance = undefined; // our balance is about to change

    if (this.opts.backgroundSettle) {
      // Don't make the next job wait 1-2s for this confirmation.
      this.inFlight++;
      void this.settle(job, built, tx, bh.lastValidBlockHeight, signature, id)
        .catch(e => log.warn('settling failed', { signature, error: String(e) }))
        .finally(() => { this.inFlight--; });
      return { candidate: c, decision, outcome: 'sent', signature };
    }
    const outcome = await this.settle(job, built, tx, bh.lastValidBlockHeight, signature, id);
    return { candidate: c, decision, outcome, signature };
  }

  /** Wait for the chain's verdict, book the real P&L and check the caps. */
  private async settle(job: Job, built: BuiltJob, tx: VersionedTransaction, lastValidBlockHeight: number, signature: string, id: number): Promise<'landed' | 'failed' | 'dropped'> {
    let landedOk = false;
    if (this.opts.jito) {
      const status = await this.awaitSignature(signature, lastValidBlockHeight);
      if (status === 'dropped') {
        // Jito didn't include the bundle (someone was faster, or a higher tip won): nothing was charged.
        this.ledger.settleAttempt(id, 'dropped', 0n, 'bundle not included: lost race or outbid, no fee charged');
        this.stats.gone++;
        log.info('dropped (no fee)', { job: job.type, signature });
        return 'dropped';
      }
      landedOk = status === 'landed';
    } else try {
      const conf = await this.conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
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
    return outcome;
  }

  /** Poll for a signature until it confirms or its blockhash expires (then it can never land). */
  private async awaitSignature(signature: string, lastValidBlockHeight: number): Promise<'landed' | 'failed' | 'dropped'> {
    for (let i = 0; i < 45; i++) {
      const { value } = await this.conn.getSignatureStatuses([signature]);
      const s = value[0];
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return s.err ? 'failed' : 'landed';
      if (await this.conn.getBlockHeight('confirmed') > lastValidBlockHeight) return 'dropped';
      await new Promise(r => setTimeout(r, this.opts.jitoPollMs ?? 2000));
    }
    return 'dropped';
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

