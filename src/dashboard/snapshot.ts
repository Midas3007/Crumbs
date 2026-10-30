import { formatSol } from '../config.js';
import type { Ledger } from '../core/ledger.js';

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
  daily: { day: string; realizedNetLamports: string; shadowNetLamports: string; crumbs: number; losses: number }[];
  jobTypes: { type: string; protocol: string; status: string; crumbs: number; losses: number; realizedNetLamports: string; shadowWins: number; shadowNetLamports: string }[];
  recent: { ts: string; jobType: string; outcome: string; netLamports: string; signature: string | null }[];
  discoveries: { id: number; program: string; programName: string; instruction: string; status: string; confidence: number; summary: string; foundAt: string }[];
}

export interface SnapshotInputs {
  mode: 'shadow' | 'live';
  paused: { paused: boolean; reason?: string };
  wallet: string;
  solLamports: bigint;
  usdc: number;
  solUsd: number | null;
  now?: Date;
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
    })),
    jobTypes: ledger.byJobType().map(j => ({
      type: j.type, protocol: j.protocol, status: j.status, crumbs: j.landed, losses: j.failed,
      realizedNetLamports: j.realizedNetLamports.toString(), shadowWins: j.shadowWins, shadowNetLamports: j.shadowNetLamports.toString(),
    })),
    recent: ledger.recentAttempts(25).map(r => ({
      ts: new Date(r.ts).toISOString(), jobType: r.jobType, outcome: r.outcome, netLamports: r.netLamports.toString(), signature: r.signature,
    })),
    discoveries: ledger.listDiscoveries().slice(0, 30).map(x => ({
      id: x.id, program: x.program_id, programName: x.program_name, instruction: x.instruction, status: x.status,
      confidence: x.confidence, summary: x.summary, foundAt: new Date(x.created_at).toISOString(),
    })),
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
