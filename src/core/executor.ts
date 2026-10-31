import type { Connection, Keypair, PublicKey, VersionedTransaction } from '@solana/web3.js';
import { type Config, formatSol } from '../config.js';
import type { Guardrails } from './caps.js';
import { clampPriorityFee, estimatePriorityFee, BASE_FEE_PER_SIGNATURE } from './fees.js';
import type { AttemptRecord, AttemptTiming, Ledger } from './ledger.js';
import { log } from './logger.js';
import { base58Encode } from './base58.js';
import { newJobType } from './approval.js';
import type { ChainClock } from './chainClock.js';
import type { Features } from './features.js';
import type { TipTuner } from './tipTuner.js';
import type { JitoClient } from './jito.js';
import type { Notifier } from './notifier.js';
import { evaluateProfit, type PriceBook } from './profitGuard.js';
import { computeUnitLimit, measureUnits, simulateFinal, transactionFee } from './simulate.js';
import { type BuiltJob, type Candidate, type Job, JobGone, JobSkipped, type ProfitDecision, type ReasonCode, type SimOutcome } from './types.js';

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
/** With Jito a bundle that loses costs nothing, so more may be pending at once (feature jito_slots). */
const MAX_IN_FLIGHT_JITO = 10;
/** fast_retry: when the chain says "not ready" at the due second, try again this often, this many times. */
const FAST_RETRY_MS = 150;
const FAST_RETRIES = 8;
/** parallel_jobs: jobs worked on at once (each waits for its own due time). */
const PARALLEL_JOBS = 4;
/**
 * Names of the v2 speed and profit features (see core/features.ts). Each can be switched off on
 * Telegram and has its own circuit breaker; without a Features object they are all off.
 */
export const FEATURE = {
  chainClock: 'chain_clock',
  fastRetry: 'fast_retry',
  jitoSlots: 'jito_slots',
  adaptiveTip: 'adaptive_tip',
  parallelJobs: 'parallel_jobs',
} as const;

/** Race analysis reads the winner's transaction from the chain; at most one lookup this often (RPC credits). */
const WINNER_LOOKUP_EVERY_MS = 60_000;

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
  /** Look up who won lost races (on in production; uses a little RPC credit). */
  raceAnalysis?: boolean;
  /** Feature flags and circuit breakers: a job whose feature is off is skipped, and sends feed the breakers. */
  features?: Features;
  /** The chain's own clock over websocket (feature chain_clock). */
  chainClock?: ChainClock;
  /** Learned per-job-type Jito tips (feature adaptive_tip). */
  tipTuner?: TipTuner;
}

export interface Attempt {
  candidate: Candidate;
  decision?: ProfitDecision;
  outcome: 'gone' | 'error' | 'rejected' | 'anomaly' | 'shadow' | 'blocked' | 'sent' | 'landed' | 'failed' | 'dropped';
  /** Exactly one per candidate; undefined only while a background send is still settling. */
  reason?: ReasonCode;
  signature?: string;
}

/** A failed simulation, read from its logs. Adapters can be more precise via Job.failureReason. */
export function genericFailureReason(sim: SimOutcome): ReasonCode {
  const text = `${JSON.stringify(sim.err)} ${sim.logs.join(' ')}`;
  // Anchor 3012 AccountNotInitialized / "account not found": the account we act on is gone.
  if (/AccountNotInitialized|"Custom":3012|AccountNotFound|could not find account/i.test(text)) return 'taken_by_others';
  return 'sim_failed_other';
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
  private lastWinnerLookup = 0;

  private on(feature: string): boolean {
    const f = this.opts.features;
    return !!f && f.has(feature) && f.enabled(feature);
  }

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
        await newJobType(this.ledger, this.notifier, this.cfg.autoApprove, { jobType: job.type, protocol: job.protocol, description: job.description, rewardSource: job.rewardSource });
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
      if (job.feature && this.opts.features && !this.opts.features.enabled(job.feature)) continue;
      let candidates: Candidate[];
      try {
        candidates = await job.detect();
      } catch (e) {
        log.warn('detect failed', { job: job.type, error: String(e) });
        continue;
      }
      const work: Promise<void>[] = [];
      let running = 0;
      const slots: (() => void)[] = [];
      const parallel = this.on(FEATURE.parallelJobs);
      for (const c of candidates) {
        const dueMs = (c.dueAt ?? 0) * 1000;
        const wait = dueMs - Date.now();
        if (wait > MAX_WAIT_FOR_DUE_MS) continue;
        const last = this.lastTried.get(c.id);
        const fresh = Date.now() - dueMs < FRESH_WINDOW_MS;
        if (last !== undefined && Date.now() - last < (fresh ? FRESH_RETRY_MS : RETRY_COOLDOWN_MS)) continue;
        this.lastTried.set(c.id, Date.now());
        const one = async () => {
          await this.waitUntilDue(c);
          this.lastTried.set(c.id, Date.now());
          const t0 = Date.now();
          const a = await this.process(job, c, { visibleMs: c.dueAt ? c.dueAt * 1000 : undefined, detectedMs: t0 });
          this.timing.jobs++;
          this.timing.totalMs += Date.now() - t0;
          if (a.signature && c.dueAt) {
            this.timing.sends++;
            this.timing.totalLateMs += Math.max(0, Date.now() - c.dueAt * 1000);
          }
          this.count(a);
          // Sends are counted when they settle (landed / lost race / ...), everything else now.
          if (a.reason) this.ledger.countReason(job.type, a.reason, funnelAmounts(a.reason, a.decision, this.cfg.caps.minProfitLamports));
          results.push(a);
        };
        if (!parallel) {
          await one();
          continue;
        }
        // Several jobs at once, each waiting for its own due time, so one slow job never delays the next.
        if (running >= PARALLEL_JOBS) await new Promise<void>(r => slots.push(r));
        running++;
        work.push(one().catch(e => log.warn('job failed', { job: job.type, candidate: c.id, error: String(e) })).finally(() => {
          running--;
          slots.shift()?.();
        }));
      }
      await Promise.all(work);
    }
    this.pruneCooldowns();
    return results;
  }

  /**
   * Wait until a job is callable. With chain_clock, that's the first slot whose Clock.unix_timestamp
   * reaches the due time (what the program checks); otherwise our own clock.
   */
  private async waitUntilDue(c: Candidate): Promise<void> {
    if (!c.dueAt) return;
    const clock = this.opts.chainClock;
    if (clock && this.on(FEATURE.chainClock)) clock.start();
    if (clock && this.on(FEATURE.chainClock) && clock.live) {
      if (await clock.waitFor(c.dueAt, Math.max(0, c.dueAt * 1000 - Date.now()) + 3_000)) return;
    }
    const wait = c.dueAt * 1000 - Date.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
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

  private blockhashRefresh?: Promise<void>;

  /**
   * A recent blockhash. After 10 s a fresh one is fetched in the background while the cached one (valid
   * for ~60 s) is used, so a job at its due second never waits for this round trip.
   */
  private async latestBlockhash() {
    const refresh = () => this.blockhashRefresh ??= this.conn.getLatestBlockhash('confirmed')
      .then(b => { this.blockhash = { value: b.blockhash, lastValidBlockHeight: b.lastValidBlockHeight, at: Date.now() }; })
      .finally(() => { this.blockhashRefresh = undefined; });
    const age = this.blockhash ? Date.now() - this.blockhash.at : Infinity;
    if (age > 30_000) await refresh();
    else if (age > 10_000) refresh().catch(e => log.debug('blockhash refresh failed', { error: String(e) }));
    return this.blockhash!;
  }

  /** Simulate and evaluate one candidate. Exposed for tests and for discovery validation (M2). */
  async estimateProfit(built: BuiltJob, jobType?: string): Promise<{ tx?: VersionedTransaction; sim?: SimOutcome; decision: ProfitDecision; built: BuiltJob }> {
    const payer = this.cfg.agentPubkey;
    const jito = this.opts.jito;
    if (jito && built.tipLamports === undefined) {
      // adaptive_tip: the tip learned for this job type, capped so the minimum profit is always left over.
      const tuner = this.opts.tipTuner;
      const tip = tuner && jobType && this.on(FEATURE.adaptiveTip)
        ? tuner.tipFor(jobType, built.expectedRewardLamports, transactionFee(built, 1, 0, 0), this.cfg.caps.minProfitLamports)
        : jito.tipLamports;
      // The tip goes inside the transaction, so the simulation (and the profit guard) see its cost.
      built = { ...built, instructions: [...built.instructions, await jito.client.tipInstruction(payer, tip)], tipLamports: tip,
        features: tip !== jito.tipLamports ? [...(built.features ?? []), FEATURE.adaptiveTip] : built.features };
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
    } else if (outcome.err !== null && known !== undefined && built.cuKey && /exceeded CUs meter|ComputationalBudgetExceeded|compute units/i.test(outcome.logs.join(' '))) {
      // The remembered compute may have been too low for this one: forget it and measure properly.
      this.cuCache.delete(built.cuKey);
      return this.estimateProfit(built, jobType);
    }
    return { tx, sim: outcome, decision: evaluateProfit(outcome, built, this.cfg.caps, this.prices), built };
  }

  async process(job: Job, c: Candidate, timing: AttemptTiming = {}): Promise<Attempt> {
    let built: BuiltJob;
    try {
      built = await job.build(c, this.cfg.agentPubkey);
    } catch (e) {
      if (e instanceof JobSkipped) return { candidate: c, outcome: 'gone', reason: 'skipped_focus' };
      if (e instanceof JobGone) {
        log.debug('job gone', { job: job.type, candidate: c.id, why: e.message });
        this.maybeLookupWinner(job, c, timing);
        return { candidate: c, outcome: 'gone', reason: 'gone_before_sim' };
      }
      log.warn('build failed', { job: job.type, candidate: c.id, error: String(e) });
      return { candidate: c, outcome: 'error', reason: 'build_error' };
    }

    let est: Awaited<ReturnType<Executor['estimateProfit']>>;
    try {
      est = await this.estimateProfit(built, job.type);
      // fast_retry: at the due second the chain may simply not have reached the due time yet. Ask again
      // every 150 ms for ~1.2 s instead of giving up until the next 1 s retry.
      for (let i = 0; i < FAST_RETRIES && c.dueAt && this.on(FEATURE.fastRetry) && Date.now() < c.dueAt * 1000 + 3_000
        && est.decision.verdict === 'simulation_failed' && est.sim && job.failureReason?.(est.sim) === 'not_ready'; i++) {
        await new Promise(r => setTimeout(r, FAST_RETRY_MS));
        est = await this.estimateProfit(est.built, job.type);
        if (est.decision.verdict !== 'simulation_failed') est = { ...est, built: { ...est.built, features: [...(est.built.features ?? []), FEATURE.fastRetry] } };
      }
    } catch (e) {
      log.warn('simulation failed to run', { job: job.type, candidate: c.id, error: String(e) });
      return { candidate: c, outcome: 'error', reason: 'rpc_error' };
    }
    timing = { ...timing, simulatedMs: Date.now() };
    const { decision, sim, tx } = est;
    built = est.built;
    const base = {
      jobType: job.type, candidateId: c.id, mode: this.cfg.mode, verdict: decision.verdict, reason: decision.reason,
      simNetLamports: decision.netLamports, simGrossLamports: decision.grossRewardLamports, simCostLamports: decision.costLamports,
      expectedRewardLamports: built.expectedRewardLamports, unitsConsumed: sim?.unitsConsumed, timing,
    } as const;

    if (decision.verdict === 'anomaly') {
      this.ledger.recordAttempt({ ...base, outcome: 'anomaly', reasonCode: 'anomaly' });
      log.warn('ANOMALY — not executing', { job: job.type, candidate: c.id, reason: decision.reason });
      await this.notifier.alert(
        `🚨 Anomaly guard: ${job.protocol} ${c.description}\n${decision.reason}\nNot executed. Logs:\n${(sim?.logs ?? []).slice(-8).join('\n')}`);
      return { candidate: c, decision, outcome: 'anomaly', reason: 'anomaly' };
    }

    if (!decision.ok || !tx) {
      const reason: ReasonCode = decision.verdict === 'simulation_failed'
        ? (sim && job.failureReason?.(sim)) ?? (sim ? genericFailureReason(sim) : 'sim_failed_other')
        : decision.verdict === 'below_min_profit' ? 'unprofitable'
        : decision.verdict === 'over_job_spend_cap' ? 'over_spend_cap'
        : 'unknown_balance';
      // Failed simulations are counted in the funnel only (thousands a day); the rest keep a row with gross and cost.
      if (decision.verdict !== 'simulation_failed') this.ledger.recordAttempt({ ...base, outcome: 'rejected', reasonCode: reason });
      else if (reason === 'taken_by_others') this.maybeLookupWinner(job, c, timing);
      log.debug('rejected', { job: job.type, candidate: c.id, verdict: decision.verdict, reason: decision.reason, code: reason });
      return { candidate: c, decision, outcome: 'rejected', reason };
    }

    const approved = this.ledger.jobTypeStatus(job.type) === 'approved';
    if (this.cfg.mode === 'shadow' || !approved || !this.cfg.agentKeypair) {
      const reason: ReasonCode = approved ? 'shadow' : 'unapproved';
      this.ledger.recordAttempt({ ...base, mode: 'shadow', outcome: 'shadow', reasonCode: reason });
      log.info('shadow: would earn', { job: job.type, candidate: c.id, net: decision.netLamports, why: approved ? 'shadow mode' : 'job type not approved' });
      return { candidate: c, decision, outcome: 'shadow', reason };
    }

    const maxInFlight = this.opts.jito && this.on(FEATURE.jitoSlots) ? MAX_IN_FLIGHT_JITO : MAX_IN_FLIGHT;
    if (this.inFlight >= maxInFlight) {
      log.debug('too many transactions awaiting confirmation; will retry', { job: job.type, candidate: c.id });
      return { candidate: c, decision, outcome: 'blocked', reason: 'in_flight_limit' };
    }
    const balance = await this.walletLamports();
    const wasPaused = this.guard.state().paused;
    const block = this.guard.checkBeforeSend(balance);
    if (block) {
      this.ledger.recordAttempt({ ...base, outcome: 'skipped', reason: block, reasonCode: 'cap_blocked' });
      if (!wasPaused) await this.notifier.alert(`⏸️ Crumbs paused: ${block}`);
      return { candidate: c, decision, outcome: 'blocked', reason: 'cap_blocked' };
    }

    return this.send(job, c, built, decision, tx, this.cfg.agentKeypair, base);
  }

  /** Who beat us? Read from the chain, sampled (one lookup a minute) to save RPC credits. */
  private maybeLookupWinner(job: Job, c: Candidate, timing: AttemptTiming, attemptId?: number, ours?: string, force = false): void {
    if (!this.opts.raceAnalysis || !job.whoTookIt) return;
    if (!force && Date.now() - this.lastWinnerLookup < WINNER_LOOKUP_EVERY_MS) return;
    this.lastWinnerLookup = Date.now();
    void job.whoTookIt(c, ours).then(w => {
      // Our own earlier run of the same task isn't a lost race.
      if (!w || w.signer === this.cfg.agentPubkey.toBase58()) return;
      // Pre-send losses have no row yet: keep one per sampled race so the report can show who wins and how fast.
      const id = attemptId ?? this.ledger.recordAttempt({
        jobType: job.type, candidateId: c.id, mode: this.cfg.mode, outcome: 'rejected', reasonCode: 'taken_by_others',
        reason: 'sampled race: someone else did it first', timing,
      });
      this.ledger.setWinner(id, w);
      log.debug('race winner', { job: job.type, candidate: c.id, winner: w.signer, slot: w.slot });
    }).catch(e => log.debug('winner lookup failed', { error: String(e) }));
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
      return { candidate: c, decision, outcome: 'error', reason: 'send_error' };
    }
    const id = this.ledger.recordAttempt({ ...base, outcome: 'sent', signature, timing: { ...base.timing, sentMs: Date.now() } });
    log.info('sent', { job: job.type, candidate: c.id, signature, expectedNet: decision.netLamports });
    this.balance = undefined; // our balance is about to change

    if (this.opts.backgroundSettle) {
      // Don't make the next job wait 1-2s for this confirmation.
      this.inFlight++;
      void this.settle(job, c, built, decision, tx, bh.lastValidBlockHeight, signature, id)
        .catch(e => log.warn('settling failed', { signature, error: String(e) }))
        .finally(() => { this.inFlight--; });
      return { candidate: c, decision, outcome: 'sent', signature };
    }
    const outcome = await this.settle(job, c, built, decision, tx, bh.lastValidBlockHeight, signature, id);
    return { candidate: c, decision, outcome, signature };
  }

  /** Wait for the chain's verdict, book the real P&L and check the caps. */
  private async settle(job: Job, c: Candidate, built: BuiltJob, decision: ProfitDecision, tx: VersionedTransaction, lastValidBlockHeight: number, signature: string, id: number): Promise<'landed' | 'failed' | 'dropped'> {
    const counted = (reason: ReasonCode) => this.ledger.countReason(job.type, reason, funnelAmounts(reason, decision, this.cfg.caps.minProfitLamports));
    let landedOk = false;
    if (this.opts.jito) {
      // jito_slots: stop waiting as soon as someone else has done the job (frees the slot in seconds, not ~90 s).
      const early = this.on(FEATURE.jitoSlots) && job.stillAvailable ? () => job.stillAvailable!(c) : undefined;
      const status = await this.awaitSignature(signature, lastValidBlockHeight, early);
      if (early && status === 'dropped') this.verifyLater(job, built, id, signature);
      if (status === 'dropped') {
        // Jito didn't include the bundle: nothing was charged. Was the work done by someone else, or still there?
        const stillThere = await job.stillAvailable?.(c).catch(() => undefined);
        const reason: ReasonCode = stillThere === true ? 'not_included' : 'lost_race';
        this.ledger.settleAttempt(id, 'dropped', 0n,
          reason === 'lost_race' ? 'lost race: someone else did it first, no fee charged' : 'bundle not included (outbid or late), job still open, no fee charged', reason);
        counted(reason);
        this.learnTip(job, reason, c);
        if (reason === 'lost_race') this.maybeLookupWinner(job, c, {}, id, signature, true);
        this.stats.gone++;
        await this.feedBreakers(job, built, 0n);
        log.info('dropped (no fee)', { job: job.type, signature, reason });
        return 'dropped';
      }
      landedOk = status.status === 'landed';
      if (status.slot) {
        const t = await this.conn.getBlockTime(status.slot).catch(() => null);
        this.ledger.setLanded(id, status.slot, t ? t * 1000 : undefined);
      }
    } else try {
      const conf = await this.conn.confirmTransaction({ signature, blockhash: tx.message.recentBlockhash, lastValidBlockHeight }, 'confirmed');
      landedOk = conf.value.err === null;
      this.ledger.setLanded(id, conf.context.slot, Date.now());
    } catch (e) {
      log.warn('confirmation failed', { signature, error: String(e) });
    }

    const realized = await this.realizedNet(signature, this.cfg.agentPubkey, built);
    const outcome = landedOk ? 'landed' : 'failed';
    const reason: ReasonCode = landedOk ? 'landed' : 'failed_onchain';
    this.ledger.settleAttempt(id, outcome, realized.net, landedOk ? undefined : 'landed but failed (fee charged): lost race or failed on-chain', reason);
    counted(reason);
    this.learnTip(job, reason, c);
    await this.feedBreakers(job, built, realized.net);
    if (!landedOk) this.maybeLookupWinner(job, c, {}, id, signature, true);
    log.info(outcome, { job: job.type, signature, realizedNet: realized.net });

    const breach = this.guard.checkAfterSend(realized.net, realized.fee);
    if (breach) await this.notifier.alert(`⏸️ Crumbs paused: ${breach}`);
    return outcome;
  }

  /** adaptive_tip and focus: learn from how a Jito send ended. */
  private learnTip(job: Job, reason: ReasonCode, c?: Candidate): void {
    if (c) job.learn?.(c, reason);
    if (this.opts.jito && this.opts.tipTuner && this.on(FEATURE.adaptiveTip)) this.opts.tipTuner.learn(job.type, reason);
  }

  /**
   * An early "dropped" is a judgement made before the blockhash expired. Check once more later: if it
   * landed after all, book it properly so the ledger never misses earnings.
   */
  private verifyLater(job: Job, built: BuiltJob, id: number, signature: string, afterMs = 90_000): void {
    setTimeout(() => {
      void (async () => {
        const { value } = await this.conn.getSignatureStatuses([signature], { searchTransactionHistory: true });
        const s = value[0];
        if (!s || s.err) return;
        const realized = await this.realizedNet(signature, this.cfg.agentPubkey, built);
        this.ledger.settleAttempt(id, 'landed', realized.net, 'landed after an early "lost" verdict', 'landed');
        this.ledger.countReason(job.type, 'lost_race', {}, -1);
        this.ledger.countReason(job.type, 'landed');
        log.warn('a send judged lost early had landed; booked it', { signature, net: realized.net });
      })().catch(e => log.debug('late verification failed', { signature, error: String(e) }));
    }, afterMs).unref();
  }

  private async feedBreakers(job: Job, built: BuiltJob, net: bigint): Promise<void> {
    const f = this.opts.features;
    if (!f) return;
    for (const name of new Set([...(job.feature ? [job.feature] : []), ...(built.features ?? [])])) {
      await f.record(name, net).catch(e => log.warn('circuit breaker update failed', { feature: name, error: String(e) }));
    }
  }

  /** Poll for a signature until it confirms or its blockhash expires (then it can never land). */
  private async awaitSignature(signature: string, lastValidBlockHeight: number, stillAvailable?: () => Promise<boolean>): Promise<{ status: 'landed' | 'failed'; slot?: number } | 'dropped'> {
    let goneSeen = 0;
    for (let i = 0; i < 45; i++) {
      const { value } = await this.conn.getSignatureStatuses([signature]);
      const s = value[0];
      if (s && (s.confirmationStatus === 'confirmed' || s.confirmationStatus === 'finalized')) return { status: s.err ? 'failed' : 'landed', slot: s.slot };
      if (await this.conn.getBlockHeight('confirmed') > lastValidBlockHeight) return 'dropped';
      // The job is gone and our signature still unseen twice in a row: someone else did it, we can't land.
      if (stillAvailable && !s && i >= 1) {
        goneSeen = (await stillAvailable().catch(() => true)) ? 0 : goneSeen + 1;
        if (goneSeen >= 2) return 'dropped';
      }
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

/** What a reason adds to the funnel's sums: gross and cost when simulated, and the shortfall for unprofitable jobs. */
export function funnelAmounts(reason: ReasonCode, d: ProfitDecision | undefined, minProfit: bigint): { gross?: bigint; cost?: bigint; shortfall?: bigint } {
  if (!d || d.verdict === 'simulation_failed') return {};
  return {
    gross: d.grossRewardLamports, cost: d.costLamports,
    shortfall: reason === 'unprofitable' && d.netLamports < minProfit ? minProfit - d.netLamports : undefined,
  };
}
