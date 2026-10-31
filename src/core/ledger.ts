import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { RaceWinner, ReasonCode } from './types.js';

export type JobTypeStatus = 'pending' | 'approved' | 'rejected';
export type AttemptOutcome = 'shadow' | 'sent' | 'landed' | 'failed' | 'dropped' | 'rejected' | 'anomaly' | 'skipped';

/** Per-job timestamps in ms. `visibleMs` is when the work became callable (e.g. a task's due time). */
export interface AttemptTiming {
  visibleMs?: number;
  detectedMs?: number;
  simulatedMs?: number;
  sentMs?: number;
}

export interface FunnelRow {
  reason: ReasonCode;
  n: number;
  grossLamports: bigint;
  costLamports: bigint;
  /** For 'unprofitable': how far below the minimum profit, summed. */
  shortfallLamports: bigint;
}

export interface AttemptRecord {
  jobType: string;
  candidateId: string;
  mode: 'shadow' | 'live';
  outcome: AttemptOutcome;
  verdict?: string;
  reason?: string;
  simNetLamports?: bigint;
  simGrossLamports?: bigint;
  simCostLamports?: bigint;
  expectedRewardLamports?: bigint;
  unitsConsumed?: number;
  signature?: string;
  realizedNetLamports?: bigint;
  reasonCode?: ReasonCode;
  timing?: AttemptTiming;
}

export interface DaySummary {
  day: string;
  attempts: number;
  shadowWins: number;
  shadowNetLamports: bigint;
  landed: number;
  failed: number;
  realizedNetLamports: bigint;
  realizedLossLamports: bigint;
  feesPaidLamports: bigint;
}

export interface DiscoveryRow {
  id: number;
  program_id: string;
  program_name: string;
  instruction: string;
  status: string;
  confidence: number;
  summary: string;
  candidate_json: string;
  validation_json?: string | null;
  created_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS job_types (
  type TEXT PRIMARY KEY,
  protocol TEXT NOT NULL,
  description TEXT NOT NULL,
  reward_source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL,
  decided_at INTEGER
);
CREATE TABLE IF NOT EXISTS attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  day TEXT NOT NULL,
  job_type TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  mode TEXT NOT NULL,
  outcome TEXT NOT NULL,
  verdict TEXT,
  reason TEXT,
  sim_net INTEGER,
  sim_gross INTEGER,
  sim_cost INTEGER,
  expected_reward INTEGER,
  units INTEGER,
  signature TEXT,
  realized_net INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_day ON attempts(day);
CREATE INDEX IF NOT EXISTS attempts_candidate ON attempts(candidate_id);
CREATE TABLE IF NOT EXISTS discovery_programs (
  program_id TEXT PRIMARY KEY,
  name TEXT,
  idl_hash TEXT,
  scanned_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS classifications (
  program_id TEXT NOT NULL,
  idl_hash TEXT NOT NULL,
  candidates_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (program_id, idl_hash)
);
CREATE TABLE IF NOT EXISTS discoveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  program_id TEXT NOT NULL,
  program_name TEXT NOT NULL,
  instruction TEXT NOT NULL,
  status TEXT NOT NULL,
  confidence REAL NOT NULL,
  summary TEXT NOT NULL,
  candidate_json TEXT NOT NULL,
  validation_json TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(program_id, instruction)
);
CREATE TABLE IF NOT EXISTS funnel (
  day TEXT NOT NULL,
  job_type TEXT NOT NULL,
  reason TEXT NOT NULL,
  n INTEGER NOT NULL DEFAULT 0,
  gross_sum INTEGER NOT NULL DEFAULT 0,
  cost_sum INTEGER NOT NULL DEFAULT 0,
  shortfall_sum INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, job_type, reason)
);
CREATE TABLE IF NOT EXISTS state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const big = (v: unknown) => (v === null || v === undefined ? 0n : BigInt(v as number | bigint));

/** SQLite-backed record of job types, every attempt (shadow and live) and agent state. */
export class Ledger {
  readonly db: DatabaseSync;

  constructor(path: string, private now: () => number = Date.now) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode = WAL;');
    this.db.exec(SCHEMA);
    this.migrate();
  }

  /** Columns added after the first release; added in place so existing history is kept. */
  private migrate() {
    const have = new Set((this.db.prepare('PRAGMA table_info(attempts)').all() as { name: string }[]).map(c => c.name));
    const add: [string, string][] = [
      ['reason_code', 'TEXT'], ['visible_ms', 'INTEGER'], ['detected_ms', 'INTEGER'], ['simulated_ms', 'INTEGER'], ['sent_ms', 'INTEGER'],
      ['landed_slot', 'INTEGER'], ['landed_ms', 'INTEGER'],
      ['winner_sig', 'TEXT'], ['winner_signer', 'TEXT'], ['winner_slot', 'INTEGER'], ['winner_ms', 'INTEGER'],
    ];
    for (const [name, type] of add) if (!have.has(name)) this.db.exec(`ALTER TABLE attempts ADD COLUMN ${name} ${type}`);
  }

  /** Count one candidate's end state in the funnel (cheap: one row per day, job type and reason). */
  countReason(jobType: string, reason: ReasonCode, amounts: { gross?: bigint; cost?: bigint; shortfall?: bigint } = {}, delta = 1): void {
    this.db.prepare(`INSERT INTO funnel (day, job_type, reason, n, gross_sum, cost_sum, shortfall_sum) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day, job_type, reason) DO UPDATE SET n = n + excluded.n, gross_sum = gross_sum + excluded.gross_sum,
        cost_sum = cost_sum + excluded.cost_sum, shortfall_sum = shortfall_sum + excluded.shortfall_sum`)
      .run(utcDay(this.now()), jobType, reason, delta, amounts.gross ?? 0n, amounts.cost ?? 0n, amounts.shortfall ?? 0n);
  }

  /** Funnel totals by reason, from `sinceDay` (inclusive) or all time. */
  funnel(sinceDay?: string, jobType?: string): FunnelRow[] {
    const rows = this.db.prepare(`SELECT reason, SUM(n) AS n, SUM(gross_sum) AS g, SUM(cost_sum) AS c, SUM(shortfall_sum) AS s
      FROM funnel WHERE day >= ? AND (? IS NULL OR job_type = ?) GROUP BY reason ORDER BY SUM(n) DESC`)
      .all(sinceDay ?? '', jobType ?? null, jobType ?? null) as Record<string, string | number | bigint | null>[];
    return rows.map(r => ({ reason: String(r.reason) as ReasonCode, n: Number(r.n ?? 0), grossLamports: big(r.g), costLamports: big(r.c), shortfallLamports: big(r.s) }));
  }

  /**
   * Of the jobs rejected as unprofitable alone, how many would clear the minimum if `sharedLamports`
   * of their cost (base fee + tip) were shared with other tasks in one transaction.
   */
  batchingPotential(sharedLamports: bigint, minProfit: bigint): { unprofitable: number; rescuable: number } {
    const r = this.db.prepare(`SELECT COUNT(*) AS n,
        SUM(CASE WHEN sim_gross - (sim_cost - ?) >= ? THEN 1 ELSE 0 END) AS ok
      FROM attempts WHERE reason_code = 'unprofitable'`).get(sharedLamports, minProfit) as Record<string, number | bigint | null>;
    return { unprofitable: Number(r.n ?? 0), rescuable: Number(r.ok ?? 0) };
  }

  /** Record when a sent transaction landed (slot and block time). */
  setLanded(id: number, slot: number, ms: number | undefined): void {
    this.db.prepare('UPDATE attempts SET landed_slot = ?, landed_ms = ? WHERE id = ?').run(slot, ms ?? null, id);
  }

  /** Record who beat us to a job. */
  setWinner(id: number, w: RaceWinner): void {
    this.db.prepare('UPDATE attempts SET winner_sig = ?, winner_signer = ?, winner_slot = ?, winner_ms = ? WHERE id = ?')
      .run(w.signature, w.signer, w.slot, w.blockTimeMs ?? null, id);
  }

  /** Per-attempt timings for sent and profitable jobs, newest first (for the latency report). */
  timings(limit = 2000, sinceMs = 0): { reasonCode: string | null; visibleMs: number | null; detectedMs: number | null; simulatedMs: number | null; sentMs: number | null; landedMs: number | null; winnerMs: number | null; winnerSigner: string | null }[] {
    const rows = this.db.prepare(`SELECT reason_code, visible_ms, detected_ms, simulated_ms, sent_ms, landed_ms, winner_ms, winner_signer
      FROM attempts WHERE detected_ms IS NOT NULL AND ts >= ? ORDER BY ts DESC LIMIT ?`).all(sinceMs, limit) as Record<string, string | number | null>[];
    const n = (v: string | number | null) => (v === null ? null : Number(v));
    return rows.map(r => ({
      reasonCode: r.reason_code === null ? null : String(r.reason_code), visibleMs: n(r.visible_ms), detectedMs: n(r.detected_ms),
      simulatedMs: n(r.simulated_ms), sentMs: n(r.sent_ms), landedMs: n(r.landed_ms), winnerMs: n(r.winner_ms),
      winnerSigner: r.winner_signer === null ? null : String(r.winner_signer),
    }));
  }

  registerJobType(type: string, protocol: string, description: string, rewardSource: string): { isNew: boolean; status: JobTypeStatus } {
    const existing = this.db.prepare('SELECT status FROM job_types WHERE type = ?').get(type) as { status: JobTypeStatus } | undefined;
    if (existing) return { isNew: false, status: existing.status };
    this.db.prepare('INSERT INTO job_types (type, protocol, description, reward_source, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(type, protocol, description, rewardSource, this.now());
    return { isNew: true, status: 'pending' };
  }

  jobTypeStatus(type: string): JobTypeStatus | undefined {
    const row = this.db.prepare('SELECT status FROM job_types WHERE type = ?').get(type) as { status: JobTypeStatus } | undefined;
    return row?.status;
  }

  setJobTypeStatus(type: string, status: JobTypeStatus): boolean {
    const r = this.db.prepare('UPDATE job_types SET status = ?, decided_at = ? WHERE type = ?').run(status, this.now(), type);
    return Number(r.changes) > 0;
  }

  listJobTypes(): { type: string; protocol: string; description: string; status: JobTypeStatus }[] {
    return this.db.prepare('SELECT type, protocol, description, status FROM job_types ORDER BY created_at').all() as never;
  }

  recordAttempt(a: AttemptRecord): number {
    const ts = this.now();
    const r = this.db.prepare(`INSERT INTO attempts
      (ts, day, job_type, candidate_id, mode, outcome, verdict, reason, sim_net, sim_gross, sim_cost, expected_reward, units, signature, realized_net,
       reason_code, visible_ms, detected_ms, simulated_ms, sent_ms)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ts, utcDay(ts), a.jobType, a.candidateId, a.mode, a.outcome, a.verdict ?? null, a.reason ?? null,
      a.simNetLamports ?? null, a.simGrossLamports ?? null, a.simCostLamports ?? null, a.expectedRewardLamports ?? null,
      a.unitsConsumed ?? null, a.signature ?? null, a.realizedNetLamports ?? null,
      a.reasonCode ?? null, a.timing?.visibleMs ?? null, a.timing?.detectedMs ?? null, a.timing?.simulatedMs ?? null, a.timing?.sentMs ?? null);
    return Number(r.lastInsertRowid);
  }

  /** Fill in the on-chain result of a sent attempt. */
  settleAttempt(id: number, outcome: 'landed' | 'failed' | 'dropped', realizedNetLamports: bigint, reason?: string, reasonCode?: ReasonCode): void {
    this.db.prepare('UPDATE attempts SET outcome = ?, realized_net = ?, reason = COALESCE(?, reason), reason_code = COALESCE(?, reason_code) WHERE id = ?')
      .run(outcome, realizedNetLamports, reason ?? null, reasonCode ?? null, id);
  }

  /** When did we last try this candidate? Used to avoid hammering the same job. */
  lastAttemptAt(candidateId: string): number | undefined {
    const row = this.db.prepare('SELECT MAX(ts) AS ts FROM attempts WHERE candidate_id = ?').get(candidateId) as { ts: number | null };
    return row.ts ?? undefined;
  }

  daySummary(day = utcDay(this.now())): DaySummary {
    const row = this.db.prepare(`SELECT
        COUNT(*) AS attempts,
        SUM(CASE WHEN outcome = 'shadow' AND verdict = 'profitable' THEN 1 ELSE 0 END) AS shadow_wins,
        SUM(CASE WHEN outcome = 'shadow' AND verdict = 'profitable' THEN sim_net ELSE 0 END) AS shadow_net,
        SUM(CASE WHEN outcome = 'landed' THEN 1 ELSE 0 END) AS landed,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN outcome IN ('landed','failed') THEN realized_net ELSE 0 END) AS realized_net,
        SUM(CASE WHEN outcome IN ('landed','failed') AND realized_net < 0 THEN -realized_net ELSE 0 END) AS realized_loss,
        SUM(CASE WHEN outcome IN ('landed','failed') THEN sim_cost ELSE 0 END) AS fees
      FROM attempts WHERE day = ?`).get(day) as Record<string, number | bigint | null>;
    return {
      day,
      attempts: Number(row.attempts ?? 0),
      shadowWins: Number(row.shadow_wins ?? 0),
      shadowNetLamports: big(row.shadow_net),
      landed: Number(row.landed ?? 0),
      failed: Number(row.failed ?? 0),
      realizedNetLamports: big(row.realized_net),
      realizedLossLamports: big(row.realized_loss),
      feesPaidLamports: big(row.fees),
    };
  }

  /** Has this exact IDL version already been classified? */
  programScanned(programId: string, idlHash: string): boolean {
    const row = this.db.prepare('SELECT idl_hash FROM discovery_programs WHERE program_id = ?').get(programId) as { idl_hash: string } | undefined;
    return row?.idl_hash === idlHash;
  }

  markProgramScanned(programId: string, name: string | null, idlHash: string | null): void {
    this.db.prepare(`INSERT INTO discovery_programs (program_id, name, idl_hash, scanned_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(program_id) DO UPDATE SET name = excluded.name, idl_hash = excluded.idl_hash, scanned_at = excluded.scanned_at`)
      .run(programId, name, idlHash, this.now());
  }

  /** Claude's answer for this exact IDL version, if we already paid for it. */
  getClassification(programId: string, idlHash: string): unknown[] | undefined {
    const row = this.db.prepare('SELECT candidates_json FROM classifications WHERE program_id = ? AND idl_hash = ?').get(programId, idlHash) as { candidates_json: string } | undefined;
    return row ? (JSON.parse(row.candidates_json) as unknown[]) : undefined;
  }

  saveClassification(programId: string, idlHash: string, candidates: unknown[]): void {
    this.db.prepare('INSERT OR REPLACE INTO classifications (program_id, idl_hash, candidates_json, created_at) VALUES (?, ?, ?, ?)')
      .run(programId, idlHash, JSON.stringify(candidates), this.now());
  }

  /** Insert or update a discovered candidate; returns its id. */
  upsertDiscovery(d: { programId: string; programName: string; instruction: string; status: string; confidence: number; summary: string; candidate: unknown; validation?: unknown }): number {
    const json = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x));
    const now = this.now();
    this.db.prepare(`INSERT INTO discoveries (program_id, program_name, instruction, status, confidence, summary, candidate_json, validation_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(program_id, instruction) DO UPDATE SET status = excluded.status, confidence = excluded.confidence, summary = excluded.summary,
        candidate_json = excluded.candidate_json, validation_json = excluded.validation_json, updated_at = excluded.updated_at`)
      .run(d.programId, d.programName, d.instruction, d.status, d.confidence, d.summary, json(d.candidate), d.validation === undefined ? null : json(d.validation), now, now);
    const row = this.db.prepare('SELECT id FROM discoveries WHERE program_id = ? AND instruction = ?').get(d.programId, d.instruction) as { id: number };
    return row.id;
  }

  listDiscoveries(): DiscoveryRow[] {
    return this.db.prepare('SELECT id, program_id, program_name, instruction, status, confidence, summary, candidate_json, validation_json, created_at FROM discoveries ORDER BY updated_at DESC').all() as never;
  }

  getDiscovery(id: number): DiscoveryRow | undefined {
    return this.db.prepare('SELECT id, program_id, program_name, instruction, status, confidence, summary, candidate_json, created_at FROM discoveries WHERE id = ?').get(id) as never;
  }

  /** All-time totals for the dashboard. */
  totals(): { attempts: number; landed: number; failed: number; realizedNetLamports: bigint; realizedLossLamports: bigint; feesPaidLamports: bigint; shadowWins: number; shadowNetLamports: bigint; anomalies: number; firstTs: number | null } {
    const r = this.db.prepare(`SELECT
        COUNT(*) AS attempts,
        SUM(CASE WHEN outcome = 'landed' THEN 1 ELSE 0 END) AS landed,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN outcome IN ('landed','failed') THEN realized_net ELSE 0 END) AS realized_net,
        SUM(CASE WHEN outcome IN ('landed','failed') AND realized_net < 0 THEN -realized_net ELSE 0 END) AS realized_loss,
        SUM(CASE WHEN outcome IN ('landed','failed') THEN sim_cost ELSE 0 END) AS fees,
        SUM(CASE WHEN outcome = 'shadow' AND verdict = 'profitable' THEN 1 ELSE 0 END) AS shadow_wins,
        SUM(CASE WHEN outcome = 'shadow' AND verdict = 'profitable' THEN sim_net ELSE 0 END) AS shadow_net,
        SUM(CASE WHEN outcome = 'anomaly' THEN 1 ELSE 0 END) AS anomalies,
        MIN(ts) AS first_ts
      FROM attempts`).get() as Record<string, number | bigint | null>;
    return {
      attempts: Number(r.attempts ?? 0), landed: Number(r.landed ?? 0), failed: Number(r.failed ?? 0),
      realizedNetLamports: big(r.realized_net), realizedLossLamports: big(r.realized_loss), feesPaidLamports: big(r.fees),
      shadowWins: Number(r.shadow_wins ?? 0), shadowNetLamports: big(r.shadow_net), anomalies: Number(r.anomalies ?? 0),
      firstTs: r.first_ts === null ? null : Number(r.first_ts),
    };
  }

  /** One row per UTC day for the last `days` days that had activity. */
  dailySeries(days = 30): { day: string; realizedNetLamports: bigint; shadowNetLamports: bigint; landed: number; failed: number; shadowWins: number; feesLamports: bigint; dropped: number }[] {
    const since = utcDay(this.now() - (days - 1) * 86_400_000);
    const rows = this.db.prepare(`SELECT day,
        SUM(CASE WHEN outcome IN ('landed','failed') THEN realized_net ELSE 0 END) AS realized_net,
        SUM(CASE WHEN outcome IN ('landed','failed') THEN sim_cost ELSE 0 END) AS fees,
        SUM(CASE WHEN outcome = 'dropped' THEN 1 ELSE 0 END) AS dropped,
        SUM(CASE WHEN outcome = 'shadow' AND verdict = 'profitable' THEN sim_net ELSE 0 END) AS shadow_net,
        SUM(CASE WHEN outcome = 'landed' THEN 1 ELSE 0 END) AS landed,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN outcome = 'shadow' AND verdict = 'profitable' THEN 1 ELSE 0 END) AS shadow_wins
      FROM attempts WHERE day >= ? GROUP BY day ORDER BY day`).all(since) as Record<string, string | number | bigint | null>[];
    return rows.map(r => ({
      day: String(r.day), realizedNetLamports: big(r.realized_net), shadowNetLamports: big(r.shadow_net),
      landed: Number(r.landed ?? 0), failed: Number(r.failed ?? 0), shadowWins: Number(r.shadow_wins ?? 0),
      feesLamports: big(r.fees), dropped: Number(r.dropped ?? 0),
    }));
  }

  /** Realised P&L of live sends that settled at or after `sinceMs` (for the USDC sweep). */
  realizedSince(sinceMs: number, untilMs: number): bigint {
    const r = this.db.prepare(`SELECT SUM(realized_net) AS net FROM attempts
      WHERE outcome IN ('landed','failed') AND mode = 'live' AND ts >= ? AND ts < ?`).get(sinceMs, untilMs) as { net: number | bigint | null };
    return big(r.net);
  }

  /** Live results between two times (ms): for the before/after comparison. */
  period(fromMs: number, toMs: number): { netLamports: bigint; feesLamports: bigint; landed: number; failed: number; dropped: number } {
    const r = this.db.prepare(`SELECT
        SUM(CASE WHEN outcome IN ('landed','failed') THEN realized_net ELSE 0 END) AS net,
        SUM(CASE WHEN outcome IN ('landed','failed') THEN sim_cost ELSE 0 END) AS fees,
        SUM(CASE WHEN outcome = 'landed' THEN 1 ELSE 0 END) AS landed,
        SUM(CASE WHEN outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN outcome = 'dropped' THEN 1 ELSE 0 END) AS dropped
      FROM attempts WHERE ts >= ? AND ts < ? AND mode = 'live'`).get(fromMs, toMs) as Record<string, number | bigint | null>;
    return { netLamports: big(r.net), feesLamports: big(r.fees), landed: Number(r.landed ?? 0), failed: Number(r.failed ?? 0), dropped: Number(r.dropped ?? 0) };
  }

  /** Per job type: what it has earned live and in shadow. */
  byJobType(): { type: string; protocol: string; status: string; landed: number; failed: number; realizedNetLamports: bigint; shadowWins: number; shadowNetLamports: bigint }[] {
    const rows = this.db.prepare(`SELECT j.type, j.protocol, j.status,
        SUM(CASE WHEN a.outcome = 'landed' THEN 1 ELSE 0 END) AS landed,
        SUM(CASE WHEN a.outcome = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN a.outcome IN ('landed','failed') THEN a.realized_net ELSE 0 END) AS realized_net,
        SUM(CASE WHEN a.outcome = 'shadow' AND a.verdict = 'profitable' THEN 1 ELSE 0 END) AS shadow_wins,
        SUM(CASE WHEN a.outcome = 'shadow' AND a.verdict = 'profitable' THEN a.sim_net ELSE 0 END) AS shadow_net
      FROM job_types j LEFT JOIN attempts a ON a.job_type = j.type
      GROUP BY j.type ORDER BY j.created_at`).all() as Record<string, string | number | bigint | null>[];
    return rows.map(r => ({
      type: String(r.type), protocol: String(r.protocol), status: String(r.status),
      landed: Number(r.landed ?? 0), failed: Number(r.failed ?? 0), realizedNetLamports: big(r.realized_net),
      shadowWins: Number(r.shadow_wins ?? 0), shadowNetLamports: big(r.shadow_net),
    }));
  }

  /** Latest sent, shadow and anomaly attempts (rejections are noise for the dashboard). */
  recentAttempts(limit = 25): { ts: number; jobType: string; outcome: string; netLamports: bigint; signature: string | null; reason: string | null }[] {
    const rows = this.db.prepare(`SELECT ts, job_type, outcome, COALESCE(realized_net, sim_net) AS net, signature, reason
      FROM attempts WHERE outcome IN ('landed','failed','sent','shadow','anomaly') ORDER BY ts DESC LIMIT ?`).all(limit) as Record<string, string | number | bigint | null>[];
    return rows.map(r => ({
      ts: Number(r.ts), jobType: String(r.job_type), outcome: String(r.outcome), netLamports: big(r.net),
      signature: r.signature === null ? null : String(r.signature), reason: r.reason === null ? null : String(r.reason),
    }));
  }

  getState(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setState(key: string, value: string): void {
    this.db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  deleteState(key: string): void {
    this.db.prepare('DELETE FROM state WHERE key = ?').run(key);
  }
}
