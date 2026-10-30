import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export type JobTypeStatus = 'pending' | 'approved' | 'rejected';
export type AttemptOutcome = 'shadow' | 'sent' | 'landed' | 'failed' | 'rejected' | 'anomaly' | 'skipped';

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
      (ts, day, job_type, candidate_id, mode, outcome, verdict, reason, sim_net, sim_gross, sim_cost, expected_reward, units, signature, realized_net)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      ts, utcDay(ts), a.jobType, a.candidateId, a.mode, a.outcome, a.verdict ?? null, a.reason ?? null,
      a.simNetLamports ?? null, a.simGrossLamports ?? null, a.simCostLamports ?? null, a.expectedRewardLamports ?? null,
      a.unitsConsumed ?? null, a.signature ?? null, a.realizedNetLamports ?? null);
    return Number(r.lastInsertRowid);
  }

  /** Fill in the on-chain result of a sent attempt. */
  settleAttempt(id: number, outcome: 'landed' | 'failed', realizedNetLamports: bigint, reason?: string): void {
    this.db.prepare('UPDATE attempts SET outcome = ?, realized_net = ?, reason = COALESCE(?, reason) WHERE id = ?')
      .run(outcome, realizedNetLamports, reason ?? null, id);
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
    return this.db.prepare('SELECT id, program_id, program_name, instruction, status, confidence, summary, candidate_json, created_at FROM discoveries ORDER BY updated_at DESC').all() as never;
  }

  getDiscovery(id: number): DiscoveryRow | undefined {
    return this.db.prepare('SELECT id, program_id, program_name, instruction, status, confidence, summary, candidate_json, created_at FROM discoveries WHERE id = ?').get(id) as never;
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
