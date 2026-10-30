import { CopyButton } from '@/components/CopyButton';
import { type DayPoint, DailyChart } from '@/components/DailyChart';
import { ago, fmtSol, fmtUsd, shareText, short, solscanAccount, solscanTx } from '@/lib/format';
import { loadSnapshot } from '@/lib/store';
import type { Snapshot } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { color: string; icon: string; label: string }> = {
  validated: { color: 'var(--good)', icon: '✓', label: 'Validated' },
  paid_not_replayable: { color: 'var(--series-1)', icon: '◆', label: 'Needs adapter' },
  anomaly: { color: 'var(--critical)', icon: '⚠', label: 'Anomaly · disclosed' },
  unprofitable: { color: 'var(--muted)', icon: '–', label: 'Unprofitable' },
  failed: { color: 'var(--muted)', icon: '–', label: 'Not reproducible' },
  no_live_trigger: { color: 'var(--muted)', icon: '…', label: 'No live trigger' },
  approved: { color: 'var(--good)', icon: '✓', label: 'Approved' },
  pending: { color: 'var(--warning)', icon: '⏳', label: 'Awaiting approval' },
  rejected: { color: 'var(--muted)', icon: '✕', label: 'Rejected' },
  landed: { color: 'var(--good)', icon: '✓', label: 'Landed' },
  failed_tx: { color: 'var(--critical)', icon: '✕', label: 'Lost race' },
  sent: { color: 'var(--warning)', icon: '…', label: 'Sent' },
  shadow: { color: 'var(--series-2)', icon: '◌', label: 'Shadow' },
};

function Status({ k }: { k: string }) {
  const s = STATUS[k] ?? { color: 'var(--muted)', icon: '•', label: k };
  return <span className="status"><span className="dot" style={{ background: s.color }} aria-hidden="true" />{s.icon === '⚠' ? '⚠ ' : ''}{s.label}</span>;
}

/** Last 14 days, gaps filled with zeros so the axis is honest about quiet days. */
function lastDays(s: Snapshot, n = 14): DayPoint[] {
  const byDay = new Map(s.daily.map(d => [d.day, d]));
  const end = Date.parse(`${s.today.day}T00:00:00Z`);
  return Array.from({ length: n }, (_, i) => {
    const day = new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    return { day, realized: Number(d?.realizedNetLamports ?? 0), shadow: Number(d?.shadowNetLamports ?? 0), crumbs: d?.crumbs ?? 0, losses: d?.losses ?? 0 };
  });
}

export default async function Page() {
  const s = await loadSnapshot();
  if (!s) {
    return (
      <main className="wrap">
        <div className="brand"><span className="logo" aria-hidden="true">🍞</span><h1>Crumbs</h1></div>
        <p className="tagline">No data yet. The agent pushes a snapshot here every minute once <code>DASHBOARD_URL</code> and <code>DASHBOARD_SECRET</code> are set.</p>
      </main>
    );
  }
  const stale = Date.now() - Date.parse(s.generatedAt) > 5 * 60_000;
  const live = s.mode === 'live';
  const net = live ? s.totals.realizedNetLamports : s.totals.shadowNetLamports;
  const mode = s.paused.paused
    ? { color: 'var(--critical)', text: 'Paused' }
    : live ? { color: 'var(--good)', text: 'Live' } : { color: 'var(--series-2)', text: 'Shadow mode' };
  const share = shareText(s);
  // Sent transactions are the verifiable ones: show those first, then the latest shadow finds.
  const recent = [...s.recent.filter(r => r.signature), ...s.recent.filter(r => !r.signature)].slice(0, 12);

  return (
    <main className="wrap">
      <header className="top">
        <div className="brand"><span className="logo" aria-hidden="true">🍞</span><h1>Crumbs</h1></div>
        <div className="meta">
          <span className="pill"><span className="dot" style={{ background: mode.color }} aria-hidden="true" />{mode.text}</span>
          <span>Updated {ago(s.generatedAt)}{stale ? ' · agent may be offline' : ''}</span>
          {s.solUsd ? <span>SOL ${s.solUsd.toFixed(2)} (Pyth, on-chain)</span> : null}
        </div>
      </header>
      <p className="tagline">
        An autonomous agent that earns the small keeper rewards Solana protocols pay strangers for doing chores. It simulates every transaction first and only sends it if it profits after fees, inside hard spending limits.
      </p>

      {s.paused.paused ? <div className="banner">⏸ Paused: {s.paused.reason}</div> : null}
      {!live ? <div className="banner">◌ <b>Shadow mode:</b> the agent does everything except send. Figures below are what it <i>would</i> have earned, proven by simulation; nothing has been spent.</div> : null}

      <section className="grid kpis" aria-label="Key figures">
        <div className="card kpi">
          <div className="label">{live ? 'Net earned, all time' : 'Would have earned (shadow)'}</div>
          <div className="value">{fmtSol(net, true)}</div>
          <div className="note">{fmtUsd(net, s.solUsd, true) ?? 'USD price unavailable'} · after every fee</div>
        </div>
        <div className="card kpi">
          <div className="label">{live ? 'Crumbs eaten' : 'Profitable crumbs found'}</div>
          <div className="value">{live ? s.totals.crumbs : s.totals.shadowWins}</div>
          <div className="note">{live ? `${s.totals.losses} lost races` : 'simulated, not sent'} · today {live ? s.today.crumbs : s.today.shadowWins}</div>
        </div>
        <div className="card kpi">
          <div className="label">Win rate of sent transactions</div>
          <div className="value">{s.totals.winRate === null ? '—' : `${Math.round(s.totals.winRate * 100)}%`}</div>
          <div className="note">{s.totals.crumbs + s.totals.losses} sent · only profitable simulations are sent</div>
        </div>
        <div className="card kpi">
          <div className="label">Fees paid</div>
          <div className="value">{fmtSol(s.totals.feesPaidLamports)}</div>
          <div className="note">{s.totals.anomalies} too-good-to-be-true jobs refused</div>
        </div>
      </section>

      <section className="card" aria-label="Daily earnings">
        <h2>Daily earnings, last 14 days</h2>
        <p className="sub">Blue is real profit from transactions on-chain; orange is what shadow-mode simulations say it would have earned.</p>
        <DailyChart points={lastDays(s)} solUsd={s.solUsd} />
      </section>

      <div className="grid two">
        <section className="card" aria-label="Jobs by type">
          <h2>Jobs by type</h2>
          <p className="sub">Each job type needs the owner&apos;s approval on Telegram before it goes live.</p>
          {s.jobTypes.length ? (
            <div className="scroll"><table>
              <thead><tr><th>Job</th><th>Status</th><th className="num">Crumbs</th><th className="num">Earned</th></tr></thead>
              <tbody>{s.jobTypes.map(j => (
                <tr key={j.type}>
                  <td><div>{j.protocol}</div><div className="mono" style={{ color: 'var(--muted)' }}>{j.type}</div></td>
                  <td><Status k={j.status} /></td>
                  <td className="num">{j.crumbs}{j.losses ? ` / ${j.losses} lost` : ''}</td>
                  <td className="num">{fmtSol(j.realizedNetLamports, true)}<div style={{ color: 'var(--muted)' }}>shadow {fmtSol(j.shadowNetLamports, true)}</div></td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="empty">No job types registered yet.</p>}
        </section>

        <section className="card" aria-label="Wallet">
          <h2>Wallet</h2>
          <p className="sub">Small hot wallet with hard caps. Every figure here can be checked on-chain.</p>
          <div className="mono" style={{ overflowWrap: 'anywhere' }}><a href={solscanAccount(s.wallet.address)} target="_blank" rel="noreferrer">{s.wallet.address}</a></div>
          <table style={{ marginTop: 12 }}>
            <tbody>
              <tr><td>SOL</td><td className="num">{fmtSol(s.wallet.solLamports)}</td><td className="num">{fmtUsd(s.wallet.solLamports, s.solUsd) ?? ''}</td></tr>
              <tr><td>USDC (earnings swept from SOL)</td><td className="num">{s.wallet.usdc.toFixed(2)} USDC</td><td className="num">${s.wallet.usdc.toFixed(2)}</td></tr>
            </tbody>
          </table>
          {s.totals.since ? <p className="sub" style={{ marginTop: 12 }}>Running since {s.totals.since.slice(0, 10)}.</p> : null}
        </section>
      </div>

      <div className="grid two">
        <section className="card" aria-label="Recent activity">
          <h2>Recent activity</h2>
          <p className="sub">Sent transactions first; each links to Solscan.</p>
          {recent.length ? (
            <div className="scroll"><table>
              <thead><tr><th>When</th><th className="hide-narrow">Job</th><th>Result</th><th className="num">Net</th></tr></thead>
              <tbody>{recent.map((r, i) => (
                <tr key={`${r.ts}-${i}`}>
                  <td>{ago(r.ts, Date.parse(s.generatedAt))}</td>
                  <td className="mono hide-narrow">{r.jobType}</td>
                  <td>{r.signature ? <a href={solscanTx(r.signature)} target="_blank" rel="noreferrer"><Status k={r.outcome === 'failed' ? 'failed_tx' : r.outcome} /> {short(r.signature)}</a> : <Status k={r.outcome === 'failed' ? 'failed_tx' : r.outcome} />}</td>
                  <td className="num">{fmtSol(r.netLamports, true)}</td>
                </tr>
              ))}</tbody>
            </table></div>
          ) : <p className="empty">Nothing yet. Crumbs is watching for profitable jobs.</p>}
        </section>

        <section className="card" aria-label="Discovery feed">
          <h2>Discovery feed</h2>
          <p className="sub">The AI reads programs to find paid chores; on-chain simulation decides. Anomalies are never executed: they become bug-bounty disclosures.</p>
          {s.discoveries.length ? (
            <ul className="feed">{s.discoveries.map(d => (
              <li key={d.id}>
                <div className="row1">
                  <span className="what">{d.programName}::<span className="mono">{d.instruction}</span></span>
                  <Status k={d.status} />
                </div>
                <div className="why">{d.summary}</div>
                <div className="why">AI confidence {Math.round(d.confidence * 100)}% · {ago(d.foundAt, Date.parse(s.generatedAt))} · <a href={solscanAccount(d.program)} target="_blank" rel="noreferrer">{short(d.program)}</a></div>
              </li>
            ))}</ul>
          ) : <p className="empty">No discoveries yet.</p>}
        </section>
      </div>

      <section className="card share" style={{ marginTop: 16 }} aria-label="Share">
        <blockquote>🍞 {share}</blockquote>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <CopyButton text={`🍞 ${share}`} label="Copy" />
          <a className="btn" href="/api/card" target="_blank" rel="noreferrer">Share card</a>
          <a className="btn" href="/api/snapshot" target="_blank" rel="noreferrer">Raw data</a>
        </div>
      </section>

      <footer>Crumbs only calls instructions protocols designed for anyone to call for a reward. It never front-runs users or touches their funds, and simulates every transaction before sending.</footer>
    </main>
  );
}
