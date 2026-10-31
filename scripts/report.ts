/**
 * Turn a dashboard snapshot into a short markdown report (reports/<name>.md).
 *
 *   npm run report -- baseline                         # reads the live dashboard
 *   npm run report -- baseline --from data/snapshot.json
 *
 * Every later milestone is judged against reports/baseline.md, so the numbers here come only from
 * the snapshot the agent publishes (which anyone can fetch from /api/snapshot).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { formatSol } from '../src/config.js';
import { funnelStages, REASON_STAGE, type Snapshot } from '../src/dashboard/snapshot.js';

const REASON_TEXT: Record<string, string> = {
  gone_before_sim: 'already gone when we built it (someone else did it)',
  taken_by_others: 'simulation shows someone else already did it',
  not_ready: 'not callable yet (task not due on-chain)',
  task_failing: "the task's own instruction fails (stuck task)",
  sim_failed_other: 'simulation failed, other reason',
  build_error: 'could not build the transaction',
  rpc_error: 'RPC error while simulating',
  unprofitable: 'unprofitable after fees and tip',
  over_spend_cap: 'over the per-job spend cap',
  unknown_balance: 'pays a token we cannot price',
  anomaly: 'anomaly guard (too good to be true)',
  shadow: 'profitable, shadow mode',
  unapproved: 'profitable, job type not approved',
  in_flight_limit: 'profitable, but 3 sends were already awaiting their outcome',
  cap_blocked: 'profitable, blocked by a cap or the kill switch',
  send_error: 'profitable, send failed',
  landed: 'sent and landed: earned',
  failed_onchain: 'sent, landed but failed (fee charged)',
  lost_race: 'sent, not included: someone else was faster (no fee)',
  not_included: 'sent, not included while the job was still open: outbid or late (no fee)',
};

async function main() {
  const name = process.argv[2] ?? 'report';
  const fromIdx = process.argv.indexOf('--from');
  const from = fromIdx > 0 ? process.argv[fromIdx + 1] : 'https://crumbs-midart.vercel.app/api/snapshot';
  const s = (from.startsWith('http') ? await (await fetch(from)).json() : JSON.parse(readFileSync(from, 'utf8'))) as Snapshot;
  if (!s.funnel) throw new Error('This snapshot has no funnel yet: the agent needs the Milestone 0 build.');

  const usd = (l: bigint) => (s.solUsd ? ` ($${((Number(l) / 1e9) * s.solUsd).toFixed(4)})` : '');
  const lam = (v: string | bigint) => `${BigInt(v).toLocaleString('en-US')} lamports`;
  const ms = (v: number | null | undefined) => (v === null || v === undefined ? 'n/a' : v >= 10_000 ? `${(v / 1000).toFixed(1)} s` : `${v} ms`);

  const all = s.funnel.allTime;
  const st = funnelStages(all);
  const n = (r: string) => all.find(e => e.reason === r)?.n ?? 0;
  const row = (r: string) => all.find(e => e.reason === r);
  const unprof = row('unprofitable');
  const lat = s.latency;
  const hoursRunning = s.activity ? (Date.parse(s.generatedAt) - Date.parse(s.activity.since)) / 3_600_000 : null;
  const net = BigInt(s.totals.realizedNetLamports);
  const fees = BigInt(s.totals.feesPaidLamports);
  const gross = net + fees;
  const sentTotal = st.sent;
  const raceWins = n('landed');
  const raceLosses = n('lost_race') + n('not_included') + n('failed_onchain');

  const lines = [
    `# Crumbs report: ${name}`,
    '',
    `Snapshot ${s.generatedAt} · mode ${s.mode} · counting since the funnel started (${all.length ? 'Milestone 0 build' : 'no data'}).`,
    'Counts are per try: a job retried three times counts three times.',
    '',
    '## In two minutes',
    '',
    `- **Funnel:** ${st.looked.toLocaleString()} tries → ${st.simulated.toLocaleString()} simulated → ${st.simOk.toLocaleString()} simulated OK → `
      + `${st.profitable} profitable → ${st.sent} sent → ${st.landed} landed.`,
    `- **Biggest drop-off:** ${[...all].sort((a, b) => b.n - a.n).slice(0, 3).map(e => `${REASON_TEXT[e.reason] ?? e.reason} (${e.n.toLocaleString()})`).join('; ')}.`,
    `- **Races:** ${raceWins} won, ${raceLosses} lost of ${sentTotal} sent${sentTotal ? ` (${Math.round((100 * raceWins) / sentTotal)}% win rate)` : ''}; `
      + `${n('in_flight_limit')} profitable tries held back because 3 sends were already pending.`,
    `- **Money, all time:** net ${formatSol(net)}${usd(net)}, fees and tips ${formatSol(fees)}${usd(fees)}`
      + (gross > 0n ? `: fees are ${Math.round((100 * Number(fees)) / Number(gross))}% of gross.` : '.'),
    s.batchingPotential
      ? `- **Batching potential:** ${s.batchingPotential.rescuable} of ${s.batchingPotential.unprofitable} unprofitable-alone jobs would clear the minimum if the base fee and tip were shared.`
      : '',
    lat && lat.samples
      ? `- **Speed (medians):** sent ${ms(lat.sentAfterVisible)} after the job became callable; simulation ${ms(lat.simulate)}, send ${ms(lat.send)}. `
        + `Winners of lost races landed ${ms(lat.winnerAfterVisible)} after it became callable.`
      : '- **Speed:** no timed samples yet.',
    '',
    '## Funnel by reason',
    '',
    '| Reason | Tries | Stage | Avg gross | Avg cost |',
    '|---|---:|---|---:|---:|',
    ...all.map(e => {
      const avg = (v: string) => (e.n && BigInt(v) !== 0n ? lam(BigInt(v) / BigInt(e.n)) : '');
      return `| ${REASON_TEXT[e.reason] ?? e.reason} | ${e.n.toLocaleString()} | ${REASON_STAGE[e.reason] ?? '?'} | ${avg(e.grossLamports)} | ${avg(e.costLamports)} |`;
    }),
    '',
    unprof
      ? `Unprofitable jobs fell short of the minimum by ${lam(BigInt(unprof.shortfallLamports) / BigInt(Math.max(1, unprof.n)))} on average.`
      : 'No unprofitable-after-fees jobs yet: everything that simulated fine cleared the minimum.',
    '',
    '## Speed',
    '',
    lat && lat.samples ? [
      `${lat.samples} timed jobs (sent, profitable and sampled races).`,
      '',
      '| Step (median) | Time |',
      '|---|---:|',
      `| Job callable → we start on it | ${ms(lat.detectAfterVisible)} |`,
      `| Final simulation | ${ms(lat.simulate)} |`,
      `| Signing and sending | ${ms(lat.send)} |`,
      `| Job callable → our send | ${ms(lat.sentAfterVisible)} |`,
      `| Job callable → our landing (1 s resolution) | ${ms(lat.landedAfterVisible)} |`,
      `| Job callable → the winner's landing, races we lost (1 s resolution) | ${ms(lat.winnerAfterVisible)} |`,
      '',
      lat.winners.length ? `Who beats us: ${lat.winners.map(w => `\`${w.signer.slice(0, 4)}…${w.signer.slice(-4)}\` (${w.n})`).join(', ')}.` : '',
    ].join('\n') : 'No timed samples yet.',
    '',
    '## All-time dashboard numbers',
    '',
    `- ${s.totals.crumbs} landed, ${s.totals.losses} failed on-chain, net ${formatSol(net)}.`,
    hoursRunning ? `- Agent up ${hoursRunning.toFixed(1)} h since the last restart: ${s.activity?.checks.toLocaleString()} checks.` : '',
    '',
  ];
  mkdirSync('reports', { recursive: true });
  const out = `reports/${name}.md`;
  writeFileSync(out, lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'));
  console.log(`wrote ${out}`);
}

main().catch(e => {
  console.error(e instanceof Error ? e.message : String(e));
  process.exit(1);
});
