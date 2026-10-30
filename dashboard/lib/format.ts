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
