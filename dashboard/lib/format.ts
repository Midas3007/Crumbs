export const sol = (lamports: string | number | bigint) => Number(lamports) / 1e9;

/** SOL with enough decimals to show a crumb (0.000005), no trailing zeros. */
export function fmtSol(lamports: string | number | bigint, signed = false): string {
  const v = sol(lamports);
  const abs = Math.abs(v);
  // Crumbs are tiny: below a millionth of a SOL, show every lamport rather than rounding to 0.
  const digits = abs === 0 ? 0 : abs >= 1 ? 3 : abs >= 0.01 ? 4 : abs >= 0.000001 ? 6 : 9;
  const s = abs.toFixed(digits).replace(/\.?0+$/, '') || '0';
  const sign = v < 0 ? '−' : signed && v > 0 ? '+' : '';
  return `${sign}${s} SOL`;
}

export function fmtUsd(lamports: string | number | bigint, solUsd: number | null, signed = false): string | null {
  if (!solUsd) return null;
  const v = sol(lamports) * solUsd;
  const abs = Math.abs(v);
  if (abs > 0 && abs < 0.0001) return '<$0.0001';
  const s = abs < 0.01 && abs > 0 ? abs.toFixed(4) : abs.toFixed(2);
  return `${v < 0 ? '−' : signed && v > 0 ? '+' : ''}$${s}`;
}

export const short = (addr: string, n = 4) => `${addr.slice(0, n)}…${addr.slice(-n)}`;
export const solscanTx = (sig: string) => `https://solscan.io/tx/${sig}`;
export const solscanAccount = (addr: string) => `https://solscan.io/account/${addr}`;

export function ago(iso: string, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - Date.parse(iso)) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

export function shareText(s: { mode: string; solUsd: number | null; today: { crumbs: number; losses: number; realizedNetLamports: string; shadowWins: number; shadowNetLamports: string } }): string {
  const usd = (l: string) => { const u = fmtUsd(l, s.solUsd, true); return u ? ` (${u})` : ''; };
  if (s.mode === 'shadow' || (s.today.crumbs === 0 && s.today.shadowWins > 0)) {
    return `Crumbs found ${s.today.shadowWins} profitable crumbs today in shadow mode: would have earned ${fmtSol(s.today.shadowNetLamports, true)}${usd(s.today.shadowNetLamports)}.`;
  }
  return `Crumbs ate ${s.today.crumbs} crumbs today: ${fmtSol(s.today.realizedNetLamports, true)}${usd(s.today.realizedNetLamports)}, ${s.today.losses} losses.`;
}

/**
 * Crumb-sized amounts: lamports when the dollar value would round to nothing, with USD alongside.
 * "9,000 lamports · $0.0009" rather than "0.000009 SOL".
 */
export function fmtCrumb(lamports: string | number | bigint, solUsd: number | null, signed = false): string {
  const n = Number(lamports);
  const usd = fmtUsd(lamports, solUsd, signed);
  if (Math.abs(n) >= 10_000_000 || !usd) return `${fmtSol(lamports, signed)}${usd ? ` · ${usd}` : ''}`;
  const sign = n < 0 ? '−' : signed && n > 0 ? '+' : '';
  return `${sign}${Math.abs(n).toLocaleString('en-US')} lamports · ${usd}`;
}

export const pct = (x: number | null | undefined, digits = 0) => (x === null || x === undefined ? '—' : `${(x * 100).toFixed(digits)}%`);

export function fmtMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '—';
  return Math.abs(ms) >= 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms).toLocaleString('en-US')} ms`;
}

/** Plain words for the agent's reason codes. */
export const REASON_TEXT: Record<string, string> = {
  gone_before_sim: 'already done by another bot',
  taken_by_others: 'another bot did it first',
  not_ready: 'not callable yet on-chain',
  task_failing: 'stuck task (its own instruction fails)',
  sim_failed_other: 'simulation failed',
  build_error: 'could not build',
  rpc_error: 'RPC error',
  unprofitable: 'unprofitable after fees',
  over_spend_cap: 'over the per-job spend cap',
  unknown_balance: 'pays a token we cannot price',
  anomaly: 'too good to be true (refused)',
  shadow: 'shadow mode',
  unapproved: 'job type not approved',
  in_flight_limit: 'too many sends pending',
  cap_blocked: 'blocked by a cap',
  send_error: 'send failed',
  landed: 'landed: earned',
  failed_onchain: 'landed but failed (fee paid)',
  lost_race: 'lost the race (no fee, Jito)',
  not_included: 'outbid (no fee, Jito)',
};

/** Which funnel stage each reason drops out at. Mirror of src/dashboard/snapshot.ts. */
export const REASON_STAGE: Record<string, number> = {
  gone_before_sim: 0, build_error: 0, rpc_error: 0,
  taken_by_others: 1, not_ready: 1, task_failing: 1, sim_failed_other: 1,
  unprofitable: 2, over_spend_cap: 2, unknown_balance: 2, anomaly: 2,
  shadow: 3, unapproved: 3, in_flight_limit: 3, cap_blocked: 3, send_error: 3,
  lost_race: 4, not_included: 4, failed_onchain: 4, landed: 5,
};
