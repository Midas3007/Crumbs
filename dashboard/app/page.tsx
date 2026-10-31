import { CopyButton } from '@/components/CopyButton';
import { type DayPoint, DailyChart } from '@/components/DailyChart';
import { Funnel } from '@/components/Funnel';
import { type MiniPoint, MiniBars } from '@/components/MiniBars';
import { ago, fmtCrumb, fmtMs, fmtSol, fmtUsd, pct, shareText, short, solscanAccount, solscanTx } from '@/lib/format';
import { loadSnapshot } from '@/lib/store';
import type { Snapshot } from '@/lib/types';

export const dynamic = 'force-dynamic';

const STATUS: Record<string, { color: string; icon: string; label: string }> = {
  validated: { color: 'var(--good)', icon: '✓', label: 'Validated' },
  paid_not_replayable: { color: 'var(--series-1)', icon: '◆', label: 'Needs adapter' },
  covered: { color: 'var(--good)', icon: '✓', label: 'Already running' },
  dropped: { color: 'var(--muted)', icon: '–', label: 'Not landed (no fee)' },
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

/** Daily fees as a share of what protocols paid, and race win rate, over the last 14 days. */
function dailyRates(s: Snapshot, n = 14): { fee: MiniPoint[]; win: MiniPoint[] } {
  const byDay = new Map(s.daily.map(d => [d.day, d]));
  const end = Date.parse(`${s.today.day}T00:00:00Z`);
  const fee: MiniPoint[] = [];
  const win: MiniPoint[] = [];
  for (let i = 0; i < n; i++) {
    const day = new Date(end - (n - 1 - i) * 86_400_000).toISOString().slice(0, 10);
    const d = byDay.get(day);
    const fees = Number(d?.feesLamports ?? 0);
    const gross = Number(d?.realizedNetLamports ?? 0) + fees;
    fee.push({ day, value: d && gross > 0 ? Math.min(1, fees / gross) : null, detail: `${fees.toLocaleString('en-US')} of ${gross.toLocaleString('en-US')} lamports` });
    const sent = (d?.crumbs ?? 0) + (d?.losses ?? 0) + (d?.dropped ?? 0);
    win.push({ day, value: sent ? (d?.crumbs ?? 0) / sent : null, detail: `${d?.crumbs ?? 0} won of ${sent} sent` });
  }
  return { fee, win };
}

const FEATURE_TEXT: Record<string, string> = {
  'adapter:tuktuk.run_task': 'Helium TukTuk tasks',
  chain_clock: "Fire on the chain's own clock",
  fast_retry: 'Retry every 150 ms at the due second',
  jito_slots: 'Free a send slot the moment a race is lost',
  parallel_jobs: 'Up to 4 jobs at once',
  adaptive_tip: 'Learn the Jito tip from wins and losses',
  live_tasks: 'New tasks over websocket',
  focus: 'Stop racing tasks we keep losing',
  'adapter:ore.checkpoint': 'ORE checkpoint bounties',
};

export default async function Page() {
  const s = await loadSnapshot();
  if (!s) {
    return (
      <main className="wrap">
        <div className="brand"><span className="logo" aria-hidden="true">🍞</span><div><h1>Crumbs</h1><div className="motto">To get the bread, you need to eat the crumbs.</div></div></div>
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
        <div className="brand"><span className="logo" aria-hidden="true">🍞</span><div><h1>Crumbs</h1><div className="motto">To get the bread, you need to eat the crumbs.</div></div></div>
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
          <div className="note">{fmtCrumb(net, s.solUsd, true)} · after every fee</div>
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
          <div className="note">{fmtCrumb(s.totals.feesPaidLamports, s.solUsd)} · {s.totals.anomalies} too-good-to-be-true jobs refused</div>
        </div>
      </section>

      {s.activity ? (
        <section className="card activity" aria-label="What the agent is doing" style={{ marginBottom: 16 }}>
          <h2>On the job</h2>
          <p className="sub">Since the agent last started ({ago(s.activity.since, Date.parse(s.generatedAt))}). Every job is simulated before anything is sent.</p>
          <div className="activity-row">
            <div><b>{s.activity.checks.toLocaleString('en-US')}</b><span>checks</span></div>
            <div><b>{s.activity.looked.toLocaleString('en-US')}</b><span>jobs simulated</span></div>
            <div><b>{s.activity.takenByOthers.toLocaleString('en-US')}</b><span>taken first by faster bots</span></div>
            <div><b>{s.activity.notWorthIt.toLocaleString('en-US')}</b><span>not worth it or not ready yet</span></div>
            <div><b>{s.activity.profitable.toLocaleString('en-US')}</b><span>profitable</span></div>
            <div><b>{s.activity.anomalies.toLocaleString('en-US')}</b><span>refused as too good to be true</span></div>
          </div>
        </section>
      ) : null}

      {s.funnel ? (
        <section className="card" aria-label="Where the jobs go" style={{ marginBottom: 16 }}>
          <h2>Where the jobs go</h2>
          <p className="sub">Every job Crumbs looked at, from first try to landing, and why each one dropped out. Since the measuring build (Oct 31).</p>
          <Funnel entries={s.funnel.allTime} />
        </section>
      ) : null}

      {s.funnel ? (() => {
        const r = dailyRates(s);
        return (
          <div className="grid two" style={{ marginTop: 0, marginBottom: 16 }}>
            <section className="card" aria-label="Fees as a share of income">
              <h2>Fees as a share of what protocols paid</h2>
              <p className="sub">Base fee and Jito tip on each landed job, divided by the reward. Lower is better.</p>
              <MiniBars points={r.fee} label="Daily fees as a share of gross rewards" color="var(--series-2)" />
            </section>
            <section className="card" aria-label="Race win rate">
              <h2>Race win rate</h2>
              <p className="sub">Jobs won out of jobs sent. Lost races sent through Jito cost nothing.</p>
              <MiniBars points={r.win} label="Daily race win rate" />
            </section>
          </div>
        );
      })() : null}

      {s.latency || s.compare ? (
        <div className="grid two" style={{ marginTop: 0, marginBottom: 16 }}>
          {s.latency ? (
            <section className="card" aria-label="Speed">
              <h2>Speed</h2>
              <p className="sub">Medians over {s.latency.samples.toLocaleString('en-US')} timed jobs, from the moment a job became callable.</p>
              <table><tbody>
                <tr><td>Callable → we start on it</td><td className="num">{fmtMs(s.latency.detectAfterVisible)}</td></tr>
                <tr><td>Final simulation</td><td className="num">{fmtMs(s.latency.simulate)}</td></tr>
                <tr><td>Callable → sent</td><td className="num">{fmtMs(s.latency.sentAfterVisible)}</td></tr>
                <tr><td><b>Callable → landed</b> (1 s resolution)</td><td className="num"><b>{fmtMs(s.latency.landedAfterVisible)}</b></td></tr>
                <tr><td>Winners of races we lost landed after</td><td className="num">{fmtMs(s.latency.winnerAfterVisible)}</td></tr>
                {s.chainClockLagMs !== undefined && s.chainClockLagMs !== null ? <tr><td>Chain clock behind ours</td><td className="num">{fmtMs(s.chainClockLagMs)}</td></tr> : null}
              </tbody></table>
              {s.latency.winners.length ? <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>Who beats us: {s.latency.winners.map((w, i) => <span key={w.signer}>{i ? ', ' : ''}<a href={solscanAccount(w.signer)} target="_blank" rel="noreferrer" className="mono">{short(w.signer)}</a> ({w.n})</span>)}</p> : null}
            </section>
          ) : null}
          {s.compare ? (
            <section className="card" aria-label="Before and after v2">
              <h2>Before and after v2</h2>
              <p className="sub">{s.compare.after ? `Baseline until ${s.compare.v2Since?.slice(0, 16).replace('T', ' ')} UTC, then the v2 speed features.` : 'Baseline so far; the v2 speed features are not switched on yet.'}</p>
              <div className="scroll"><table className="compare">
                <thead><tr><th /><th className="num">Baseline</th><th className="num">v2</th></tr></thead>
                <tbody>
                  <tr><td>Hours</td><td className="num">{s.compare.before.hours}</td><td className="num">{s.compare.after?.hours ?? '—'}</td></tr>
                  <tr><td>Earned per hour (lamports)</td><td className="num">{Number(s.compare.before.netPerHourLamports).toLocaleString('en-US')}</td><td className="num">{s.compare.after ? Number(s.compare.after.netPerHourLamports).toLocaleString('en-US') : '—'}</td></tr>
                  <tr><td>Fees ÷ gross</td><td className="num">{pct(s.compare.before.feeShare)}</td><td className="num">{pct(s.compare.after?.feeShare)}</td></tr>
                  <tr><td>Race win rate</td><td className="num">{pct(s.compare.before.raceWinRate)}<div className="dim">{s.compare.before.landed} of {s.compare.before.sent}</div></td><td className="num">{s.compare.after ? <>{pct(s.compare.after.raceWinRate)}<div className="dim">{s.compare.after.landed} of {s.compare.after.sent}</div></> : '—'}</td></tr>
                  <tr><td>Net (lamports)</td><td className="num">{Number(s.compare.before.netLamports).toLocaleString('en-US')}<div className="dim">{fmtUsd(s.compare.before.netLamports, s.solUsd, true) ?? ''}</div></td><td className="num">{s.compare.after ? <>{Number(s.compare.after.netLamports).toLocaleString('en-US')}<div className="dim">{fmtUsd(s.compare.after.netLamports, s.solUsd, true) ?? ''}</div></> : '—'}</td></tr>
                </tbody>
              </table></div>
              {s.batchingPotential ? <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>Rescued by batching: none. Two TukTuk tasks don&apos;t fit in one Solana transaction, so batching was researched and not built. {s.batchingPotential.rescuable} of {s.batchingPotential.unprofitable} unprofitable-alone jobs would have cleared the bar with shared fees.</p> : null}
            </section>
          ) : null}
        </div>
      ) : null}

      {s.features?.length ? (
        <section className="card" aria-label="Feature switches" style={{ marginBottom: 16 }}>
          <h2>Switches and circuit breakers</h2>
          <p className="sub">Each way of making money can be switched off on Telegram, and switches itself off if it loses more than 20,000 lamports over its first 50 sends or any hour.</p>
          <div className="scroll"><table>
            <thead><tr><th>Feature</th><th>State</th><th className="num">Sends</th><th className="num">Net</th></tr></thead>
            <tbody>{s.features.map(f => (
              <tr key={f.name}>
                <td><div>{FEATURE_TEXT[f.name] ?? f.description}</div><div className="mono" style={{ color: 'var(--muted)' }}>{f.name}</div></td>
                <td><span className="status"><span className="dot" style={{ background: f.on ? 'var(--good)' : 'var(--muted)' }} aria-hidden="true" />{f.on ? 'On' : 'Off'}</span>{!f.on && f.offReason?.startsWith('circuit') ? <div style={{ color: 'var(--critical)', fontSize: 12 }}>breaker tripped</div> : null}</td>
                <td className="num">{f.sends}</td>
                <td className="num">{Number(f.netLamports).toLocaleString('en-US')} lamports</td>
              </tr>
            ))}</tbody>
          </table></div>
          {s.tips?.length ? <p className="sub" style={{ marginTop: 10, marginBottom: 0 }}>Jito tip now: {s.tips.map(t => `${t.jobType} ${Number(t.lamports).toLocaleString('en-US')} lamports`).join(' · ')}</p> : null}
        </section>
      ) : null}

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
                  <td className="num">{Math.abs(Number(r.netLamports)) < 10_000_000 ? `${Number(r.netLamports) > 0 ? '+' : Number(r.netLamports) < 0 ? '−' : ''}${Math.abs(Number(r.netLamports)).toLocaleString('en-US')} lamports` : fmtSol(r.netLamports, true)}<div style={{ color: 'var(--muted)' }}>{fmtUsd(r.netLamports, s.solUsd, true) ?? ''}</div></td>
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
                {d.score ? <div className="why">Opportunity score {d.score.toLocaleString('en-US')} lamports/h · {d.callsPerHour} calls/h · {d.competitors} bot{d.competitors === 1 ? '' : 's'} already calling it</div> : null}
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
