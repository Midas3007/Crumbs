import { formatSol } from '../config.js';
import type { Ledger } from '../core/ledger.js';
import { coveredBy } from '../discovery/covered.js';

/**
 * Everything the public dashboard shows, as plain JSON (lamports as strings so nothing loses precision).
 * The dashboard app keeps its own copy of this type in dashboard/lib/types.ts — bump `version` on changes.
 */
export interface Snapshot {
  version: 1;
  generatedAt: string;
  mode: 'shadow' | 'live';
  paused: { paused: boolean; reason?: string };
  wallet: { address: string; solLamports: string; usdc: number };
  solUsd: number | null;
  totals: {
    crumbs: number;
    losses: number;
    winRate: number | null;
    realizedNetLamports: string;
    feesPaidLamports: string;
    shadowWins: number;
    shadowNetLamports: string;
    anomalies: number;
    since: string | null;
  };
  today: { day: string; crumbs: number; losses: number; realizedNetLamports: string; shadowWins: number; shadowNetLamports: string };
  daily: { day: string; realizedNetLamports: string; shadowNetLamports: string; crumbs: number; losses: number;
    /** Fees and tips paid on landed sends, and Jito bundles that didn't land (no fee). */
    feesLamports?: string; dropped?: number }[];
  jobTypes: { type: string; protocol: string; status: string; crumbs: number; losses: number; realizedNetLamports: string; shadowWins: number; shadowNetLamports: string }[];
  recent: { ts: string; jobType: string; outcome: string; netLamports: string; signature: string | null }[];
  discoveries: { id: number; program: string; programName: string; instruction: string; status: string; confidence: number; summary: string; foundAt: string;
    score?: number; callsPerHour?: number; competitors?: number }[];
  /** Work done since the agent last started — shows it's busy even on days nothing pays. */
  activity?: { since: string; checks: number; looked: number; profitable: number; sent: number; takenByOthers: number; notWorthIt: number; anomalies: number; errors: number };
  /** Every candidate's end state by reason code (counted per try), all time and today. Lamport sums as strings. */
  funnel?: { allTime: FunnelEntry[]; today: FunnelEntry[] };
  /** Median per-job timings (ms) and who wins the races we lose. */
  latency?: LatencyStats;
  /** Unprofitable-alone jobs that would clear the minimum if base fee + tip were shared in a batch. */
  batchingPotential?: { unprofitable: number; rescuable: number };
  /** Feature switches and their circuit-breaker P&L (lamports as strings). */
  features?: { name: string; description: string; on: boolean; offReason?: string; sends: number; netLamports: string }[];
  /** Wall clock minus the chain's Clock.unix_timestamp, ms (null when the websocket clock isn't live). */
  chainClockLagMs?: number | null;
  /** Learned Jito tip per job type (lamports as strings). */
  tips?: { jobType: string; lamports: string }[];
  /** Baseline (before the v2 features went on) vs since. */
  compare?: { v2Since: string | null; before: PeriodStats; after: PeriodStats | null };
}

export interface PeriodStats {
  hours: number;
  netLamports: string;
  feesLamports: string;
  /** What the protocols paid before our costs: net + fees. */
  grossLamports: string;
  netPerHourLamports: string;
  /** Fees as a share of gross (0-1), null with no gross. */
  feeShare: number | null;
  sent: number;
  landed: number;
  /** Landed ÷ every send that reached an outcome (landed, failed, or a bundle that didn't land). */
  raceWinRate: number | null;
}

export function periodStats(p: ReturnType<Ledger['period']>, hours: number): PeriodStats {
  const gross = p.netLamports + p.feesLamports;
  const sent = p.landed + p.failed + p.dropped;
  return {
    hours: Math.round(hours * 10) / 10,
    netLamports: p.netLamports.toString(), feesLamports: p.feesLamports.toString(), grossLamports: gross.toString(),
    netPerHourLamports: hours > 0 ? BigInt(Math.round(Number(p.netLamports) / hours)).toString() : '0',
    feeShare: gross > 0n ? Number(p.feesLamports) / Number(gross) : null,
    sent, landed: p.landed, raceWinRate: sent ? p.landed / sent : null,
  };
}

/** Which funnel stage each reason drops out at (or ends in). */
export const REASON_STAGE: Record<string, 'before_sim' | 'sim_failed' | 'not_worth_it' | 'not_sent' | 'sent'> = {
  gone_before_sim: 'before_sim', build_error: 'before_sim', rpc_error: 'before_sim',
  taken_by_others: 'sim_failed', not_ready: 'sim_failed', task_failing: 'sim_failed', sim_failed_other: 'sim_failed',
  unprofitable: 'not_worth_it', over_spend_cap: 'not_worth_it', unknown_balance: 'not_worth_it', anomaly: 'not_worth_it',
  shadow: 'not_sent', unapproved: 'not_sent', in_flight_limit: 'not_sent', cap_blocked: 'not_sent', send_error: 'not_sent',
  landed: 'sent', failed_onchain: 'sent', lost_race: 'sent', not_included: 'sent',
};

/** checks → looked at → simulated → simulated OK → profitable → sent → landed, from reason counts. */
export function funnelStages(entries: { reason: string; n: number }[]) {
  const by = (stage: string) => entries.filter(e => REASON_STAGE[e.reason] === stage).reduce((n, e) => n + e.n, 0);
  const looked = entries.reduce((n, e) => n + e.n, 0);
  const simulated = looked - by('before_sim');
  const simOk = simulated - by('sim_failed');
  const profitable = simOk - by('not_worth_it');
  const sent = profitable - by('not_sent');
  const landed = entries.find(e => e.reason === 'landed')?.n ?? 0;
  return { looked, simulated, simOk, profitable, sent, landed };
}

export interface FunnelEntry { reason: string; n: number; grossLamports: string; costLamports: string; shortfallLamports: string }

export interface LatencyStats {
  samples: number;
  /** Medians in ms; null when there's no sample yet. */
  detectAfterVisible: number | null;
  simulate: number | null;
  send: number | null;
  sentAfterVisible: number | null;
  /** Block time has 1s resolution, so these are rough. */
  landedAfterVisible: number | null;
  winnerAfterVisible: number | null;
  /** Who beat us, most frequent first. */
  winners: { signer: string; n: number }[];
}

/**
 * The discovery feed, best opportunities first: paid jobs by score (reward × calls per hour ÷ competitors),
 * then the rest by recency. Instructions Crumbs already runs show as "covered".
 */
export function rankDiscoveries(rows: ReturnType<Ledger['listDiscoveries']>): Snapshot['discoveries'] {
  const items = rows.map(x => {
    let v: { score?: number; callsPerHour?: number; recentCallers?: number } = {};
    try { v = x.validation_json ? JSON.parse(x.validation_json) : {}; } catch { /* old row */ }
    const covered = coveredBy(x.program_id, x.instruction);
    return {
      id: x.id, program: x.program_id, programName: x.program_name, instruction: x.instruction,
      status: covered ? 'covered' : x.status, confidence: x.confidence,
      summary: covered ? `already running as ${covered}` : x.summary, foundAt: new Date(x.created_at).toISOString(),
      score: v.score, callsPerHour: v.callsPerHour, competitors: v.recentCallers,
    };
  });
  // Paid jobs first (best score first), then the rest, and what we already run last.
  const group = (s: string) => (s === 'validated' || s === 'paid_not_replayable' ? 0 : s === 'covered' ? 2 : 1);
  return items.sort((a, b) => group(a.status) - group(b.status) || (b.score ?? 0) - (a.score ?? 0));
}

function compareStats(ledger: Ledger, firstTs: number | null, v2Since: number | null, now: number): Snapshot['compare'] {
  if (firstTs === null) return undefined;
  const cut = v2Since ?? now;
  return {
    v2Since: v2Since === null ? null : new Date(v2Since).toISOString(),
    before: periodStats(ledger.period(firstTs, cut), (cut - firstTs) / 3_600_000),
    after: v2Since === null ? null : periodStats(ledger.period(v2Since, now + 1), (now - v2Since) / 3_600_000),
  };
}

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return Math.round(s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2);
}

export function latencyStats(rows: ReturnType<Ledger['timings']>): LatencyStats {
  const diff = (a: (r: typeof rows[number]) => number | null, b: (r: typeof rows[number]) => number | null) =>
    median(rows.flatMap(r => { const x = a(r); const y = b(r); return x !== null && y !== null ? [x - y] : []; }));
  const counts = new Map<string, number>();
  for (const r of rows) if (r.winnerSigner) counts.set(r.winnerSigner, (counts.get(r.winnerSigner) ?? 0) + 1);
  return {
    samples: rows.length,
    detectAfterVisible: diff(r => r.detectedMs, r => r.visibleMs),
    simulate: diff(r => r.simulatedMs, r => r.detectedMs),
    send: diff(r => r.sentMs, r => r.simulatedMs),
    sentAfterVisible: diff(r => r.sentMs, r => r.visibleMs),
    landedAfterVisible: diff(r => r.landedMs, r => r.visibleMs),
    winnerAfterVisible: diff(r => r.winnerMs, r => r.visibleMs),
    winners: [...counts].map(([signer, n]) => ({ signer, n })).sort((a, b) => b.n - a.n).slice(0, 5),
  };
}

const funnelEntries = (rows: ReturnType<Ledger['funnel']>): FunnelEntry[] => rows.map(r => ({
  reason: r.reason, n: r.n, grossLamports: r.grossLamports.toString(), costLamports: r.costLamports.toString(), shortfallLamports: r.shortfallLamports.toString(),
}));

export interface SnapshotInputs {
  mode: 'shadow' | 'live';
  paused: { paused: boolean; reason?: string };
  wallet: string;
  solLamports: bigint;
  usdc: number;
  solUsd: number | null;
  now?: Date;
  activity?: Snapshot['activity'];
  /** Per-transaction cost a batch would share (base fee + tip), for the batching estimate. */
  sharedCostLamports?: bigint;
  minProfitLamports?: bigint;
  features?: { name: string; description: string; on: boolean; offReason?: string; sends: number; netLamports: bigint }[];
  chainClockLagMs?: number | null;
  tips?: { jobType: string; lamports: bigint }[];
  /** When the v2 features were switched on (ms); the baseline is everything before. */
  v2SinceMs?: number | null;
}

export function buildSnapshot(ledger: Ledger, i: SnapshotInputs): Snapshot {
  const t = ledger.totals();
  const d = ledger.daySummary();
  const sent = t.landed + t.failed;
  return {
    version: 1,
    generatedAt: (i.now ?? new Date()).toISOString(),
    mode: i.mode,
    paused: i.paused,
    wallet: { address: i.wallet, solLamports: i.solLamports.toString(), usdc: i.usdc },
    solUsd: i.solUsd,
    totals: {
      crumbs: t.landed,
      losses: t.failed,
      winRate: sent ? t.landed / sent : null,
      realizedNetLamports: t.realizedNetLamports.toString(),
      feesPaidLamports: t.feesPaidLamports.toString(),
      shadowWins: t.shadowWins,
      shadowNetLamports: t.shadowNetLamports.toString(),
      anomalies: t.anomalies,
      since: t.firstTs === null ? null : new Date(t.firstTs).toISOString(),
    },
    today: {
      day: d.day, crumbs: d.landed, losses: d.failed, realizedNetLamports: d.realizedNetLamports.toString(),
      shadowWins: d.shadowWins, shadowNetLamports: d.shadowNetLamports.toString(),
    },
    daily: ledger.dailySeries(30).map(r => ({
      day: r.day, realizedNetLamports: r.realizedNetLamports.toString(), shadowNetLamports: r.shadowNetLamports.toString(), crumbs: r.landed, losses: r.failed,
      feesLamports: r.feesLamports.toString(), dropped: r.dropped,
    })),
    jobTypes: ledger.byJobType().map(j => ({
      type: j.type, protocol: j.protocol, status: j.status, crumbs: j.landed, losses: j.failed,
      realizedNetLamports: j.realizedNetLamports.toString(), shadowWins: j.shadowWins, shadowNetLamports: j.shadowNetLamports.toString(),
    })),
    recent: ledger.recentAttempts(25).map(r => ({
      ts: new Date(r.ts).toISOString(), jobType: r.jobType, outcome: r.outcome, netLamports: r.netLamports.toString(), signature: r.signature,
    })),
    discoveries: rankDiscoveries(ledger.listDiscoveries()).slice(0, 30),
    activity: i.activity,
    funnel: { allTime: funnelEntries(ledger.funnel()), today: funnelEntries(ledger.funnel(d.day)) },
    latency: latencyStats(ledger.timings()),
    compare: compareStats(ledger, t.firstTs, i.v2SinceMs ?? null, (i.now ?? new Date()).getTime()),
    features: i.features?.map(f => ({ ...f, netLamports: f.netLamports.toString() })),
    chainClockLagMs: i.chainClockLagMs,
    tips: i.tips?.map(t => ({ jobType: t.jobType, lamports: t.lamports.toString() })),
    batchingPotential: i.sharedCostLamports !== undefined && i.minProfitLamports !== undefined
      ? ledger.batchingPotential(i.sharedCostLamports, i.minProfitLamports) : undefined,
  };
}

const sol = (lamports: string | bigint) => Number(BigInt(lamports)) / 1e9;

function usdText(lamports: string, solUsd: number | null): string {
  if (!solUsd) return '';
  const v = sol(lamports) * solUsd;
  const abs = Math.abs(v);
  if (abs < 0.0001) return ''; // a dollar figure that rounds to nothing adds noise
  const digits = abs >= 0.01 ? 2 : 4;
  return ` (~${v < 0 ? '-' : '+'}$${abs.toFixed(digits)})`;
}

/** "Crumbs ate 412 crumbs today: +1.84 SOL, 0 losses." In shadow mode, says what it would have earned. */
export function shareText(s: Snapshot): string {
  // Exact lamports, trailing zeros trimmed: crumbs are tiny, so never round them away.
  const usd = (l: string) => usdText(l, s.solUsd);
  const fmt = (l: string) => `${BigInt(l) > 0n ? '+' : ''}${formatSol(BigInt(l))}`;
  if (s.mode === 'shadow' || (s.today.crumbs === 0 && s.today.shadowWins > 0)) {
    return `🍞 Crumbs found ${s.today.shadowWins} profitable crumbs today (shadow mode): would have earned ${fmt(s.today.shadowNetLamports)}${usd(s.today.shadowNetLamports)}.`;
  }
  return `🍞 Crumbs ate ${s.today.crumbs} crumbs today: ${fmt(s.today.realizedNetLamports)}${usd(s.today.realizedNetLamports)}, ${s.today.losses} losses.`;
}
