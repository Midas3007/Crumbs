// Mirror of src/dashboard/snapshot.ts in the agent. Keep in sync; bump `version` on breaking changes.
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
  /** Work done since the agent last started — shows it's busy even on days nothing pays. */
  activity?: { since: string; checks: number; looked: number; profitable: number; sent: number; takenByOthers: number; notWorthIt: number; anomalies: number; errors: number };
}

export function isSnapshot(x: unknown): x is Snapshot {
  const s = x as Snapshot;
  return !!s && s.version === 1 && typeof s.generatedAt === 'string' && typeof s.wallet?.address === 'string' && Array.isArray(s.daily);
}
