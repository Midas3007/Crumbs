import { Connection } from '@solana/web3.js';
import { TuktukJob } from './adapters/tuktuk/adapter.js';
import { formatSol, loadConfig } from './config.js';
import { Guardrails } from './core/caps.js';
import { ModeSwitch } from './core/mode.js';
import { Features } from './core/features.js';
import { Focus } from './core/focus.js';
import { Executor, FEATURE } from './core/executor.js';
import { ChainClock } from './core/chainClock.js';
import { TipTuner } from './core/tipTuner.js';
import { JitoClient } from './core/jito.js';
import { BASE_FEE_PER_SIGNATURE } from './core/fees.js';
import { CreditWatch, creditWatchingFetch } from './core/creditWatch.js';
import { Ledger } from './core/ledger.js';
import { log, setLogLevel } from './core/logger.js';
import { LogNotifier, type Notifier } from './core/notifier.js';
import { Sweeper } from './core/sweeper.js';
import type { Job } from './core/types.js';
import { ClaudeClassifier } from './discovery/classify.js';
import { DiscoveryEngine, replaySpecFromLedger } from './discovery/engine.js';
import { manualPrograms, recentlyDeployedPrograms } from './discovery/programs.js';
import { ReplayJob } from './discovery/replayJob.js';
import { TelegramNotifier, telegramConfigProblem } from './telegram/bot.js';
import { priceBook } from './core/prices.js';
import { Publisher } from './dashboard/publisher.js';
import { shareText } from './dashboard/snapshot.js';

async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const ledger = new Ledger(cfg.dbPath);
  const guard = new Guardrails(ledger, cfg.caps, cfg.envPaused);
  const modeSwitch = new ModeSwitch(cfg, ledger); // applies a /live or /shadow saved before a restart
  let notifier: Notifier = new LogNotifier();
  // Alerts when the Claude API or the RPC provider runs out of credits.
  const credits = new CreditWatch(t => notifier.alert(t));
  const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed', fetch: creditWatchingFetch(credits) });
  // Each way of making money has an on/off switch (/features) and a circuit breaker that switches it off if it loses.
  // v2 speed features start off until the baseline is recorded (V2_FEATURES=on switches them all on).
  const v2 = (process.env.V2_FEATURES ?? 'off') === 'on';
  const features = new Features(ledger, [
    { name: 'adapter:tuktuk.run_task', description: 'Helium TukTuk tasks', defaultOn: true },
    { name: FEATURE.chainClock, description: "fire on the chain's own clock (websocket), not ours", defaultOn: v2 },
    { name: FEATURE.fastRetry, description: 'when "not ready" at the due second, retry every 150 ms', defaultOn: v2 },
    { name: FEATURE.jitoSlots, description: 'free a send slot as soon as a race is lost; up to 10 pending Jito sends', defaultOn: v2 },
    { name: FEATURE.parallelJobs, description: 'work on up to 4 jobs at once', defaultOn: v2 },
    { name: FEATURE.adaptiveTip, description: 'learn the Jito tip per job type from wins and losses', defaultOn: v2 },
    { name: 'focus', description: 'stop racing kinds of task we keep losing (saves Helius credits); keep the ones we win', defaultOn: true },
    { name: 'live_tasks', description: 'new TukTuk tasks over websocket; full re-read every 10 min instead of every minute', defaultOn: v2 },
  ], t => notifier.alert(t), { thresholdLamports: cfg.breakerThresholdLamports });
  // The before/after line: the first time any v2 speed feature is on. Everything earlier is the baseline.
  const v2Since = () => {
    const saved = ledger.getState('v2_since');
    if (saved) return Number(saved);
    if (!Object.values(FEATURE).some(f => features.enabled(f))) return null;
    ledger.setState('v2_since', String(Date.now()));
    return Date.now();
  };
  const focus = new Focus();
  const chainClock = new ChainClock(conn); // subscribes on first use, only while chain_clock is on
  const tipTuner = new TipTuner(ledger, cfg.jito.tipLamports);

  const jobs: Job[] = [
    new TuktukJob(conn, { minRewardLamports: BASE_FEE_PER_SIGNATURE + cfg.caps.minProfitLamports, agent: cfg.agentPubkey, prepareSec: 10, liveTasks: () => features.enabled('live_tasks'),
      focus: { enabled: () => features.enabled('focus'), tracker: focus } }),
  ];

  let summary = () => '';
  let share = () => '';
  let telegram: TelegramNotifier | undefined;
  const tgProblem = cfg.telegram && telegramConfigProblem(cfg.telegram.token, cfg.telegram.chatId);
  if (tgProblem) {
    log.error(`TELEGRAM_CHAT_ID looks wrong: ${tgProblem}. Run \`npm run telegram-setup\` to find the right one. Alerts go to the log until then.`);
  } else if (cfg.telegram) {
    telegram = new TelegramNotifier(cfg.telegram.token, cfg.telegram.chatId, ledger, guard, () => summary(), () => share(),
      { mode: modeSwitch, walletLamports: async () => BigInt(await conn.getBalance(cfg.agentPubkey, 'confirmed')), features });
    notifier = telegram;
    telegram.start();
  } else {
    log.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: alerts go to the log, approve with `npm run approve -- <type>`');
  }

  const executor = new Executor(conn, cfg, ledger, guard, notifier, jobs, {
    backgroundSettle: true,
    raceAnalysis: true,
    features,
    chainClock,
    tipTuner,
    jito: cfg.jito.enabled ? { client: new JitoClient(cfg.jito.url), tipLamports: cfg.jito.tipLamports } : undefined,
  });
  const publisher = new Publisher(conn, cfg, ledger, guard, 'data/snapshot.json', () => {
    const s = executor.stats;
    return { since: executor.startedAt, checks: s.checks, looked: s.candidates, profitable: s.shadow + s.sent, sent: s.sent,
      takenByOthers: s.gone, notWorthIt: s.rejected, anomalies: s.anomalies, errors: s.errors };
  }, () => ({
    features: features.status(),
    chainClockLagMs: chainClock.live ? chainClock.lagMs : null,
    tips: jobs.map(j => ({ jobType: j.type, lamports: tipTuner.tip(j.type) })),
    v2SinceMs: v2Since(),
  }));
  const dashLink = cfg.dashboard.url ? `\n${cfg.dashboard.url}` : '';
  summary = () => executor.summaryText() + (publisher.latest ? `\n\n${shareText(publisher.latest)}` : '') + dashLink;
  share = () => (publisher.latest ? shareText(publisher.latest) : 'No data yet — give me a minute.') + dashLink;

  const balance = BigInt(await conn.getBalance(cfg.agentPubkey));
  log.info('starting', { mode: cfg.mode, wallet: cfg.agentPubkey.toBase58(), balance: formatSol(balance), paused: guard.state() });
  if (balance === 0n) log.warn('agent wallet is empty: simulations need a fee payer with some SOL (0.01 SOL is plenty for shadow mode)');
  await notifier.alert(`🍞 Crumbs started in ${cfg.mode} mode. To get the bread, you need to eat the crumbs.\nWallet ${cfg.agentPubkey.toBase58()} · ${formatSol(balance)}`);
  await executor.registerJobTypes();

  const timers: NodeJS.Timeout[] = [];
  if (cfg.sweep.enabled && cfg.agentKeypair) {
    const sweeper = new Sweeper(conn, cfg, cfg.agentKeypair, t => notifier.alert(t), ledger);
    timers.push(setInterval(() => {
      if (cfg.mode !== 'live' || guard.state().paused) return; // mode can change at runtime via /live, /shadow
      sweeper.maybeSweep().catch(e => log.warn('sweep failed', { error: String(e) }));
    }, 15 * 60_000));
  }
  // Approved discoveries become live jobs (checked every minute, so a Telegram approval takes effect quickly).
  const loadApprovedDiscoveries = () => {
    for (const jt of ledger.listJobTypes()) {
      const m = /^disc\.(\d+)$/.exec(jt.type);
      if (!m || jt.status !== 'approved' || executor.hasJob(jt.type)) continue;
      const spec = replaySpecFromLedger(ledger, Number(m[1]));
      if (spec) {
        const job = new ReplayJob(conn, spec);
        features.register({ name: job.feature, description: `${spec.candidate.programName}::${spec.candidate.instruction} (discovered)`, defaultOn: true });
        executor.addJob(job);
        log.info('discovered job is live', { type: jt.type, program: spec.candidate.programName, instruction: spec.candidate.instruction });
      }
    }
  };
  loadApprovedDiscoveries();
  timers.push(setInterval(loadApprovedDiscoveries, 60_000));

  if (cfg.discovery.anthropicApiKey) {
    // Public RPC for the big deploy listing; no automatic 429 retries so a busy RPC doesn't stall discovery.
    const listingConn = new Connection(cfg.discovery.listingRpcUrl, { disableRetryOnRateLimit: true });
    const engine = new DiscoveryEngine(conn, cfg, ledger, notifier, new ClaudeClassifier(cfg.discovery.anthropicApiKey), { credits, dailyBudgetUsd: cfg.discovery.dailyBudgetUsd });
    const discover = async () => {
      const programs = [...manualPrograms(), ...(cfg.discovery.includeRecentDeploys ? await recentlyDeployedPrograms(listingConn, 40, [conn, listingConn]) : [])];
      await engine.run([...new Set(programs)]);
    };
    setTimeout(() => void discover().catch(e => log.warn('discovery failed', { error: String(e) })), 60_000);
    timers.push(setInterval(() => void discover().catch(e => log.warn('discovery failed', { error: String(e) })), cfg.discovery.intervalHours * 3_600_000));
  } else {
    log.warn('ANTHROPIC_API_KEY not set: discovery is off');
  }

  // Dashboard snapshot every minute; the SOL price it reads also lets the profit guard value USDC rewards.
  const publish = () => publisher.publish()
    .then(() => { if (publisher.solUsd) executor.setPrices(priceBook(publisher.solUsd)); })
    .catch(e => log.warn('snapshot failed', { error: String(e) }));
  void publish();
  timers.push(setInterval(publish, 60_000));

  // Proof of life in the log every 5 minutes (shadow mode is otherwise quiet when nothing pays).
  timers.push(setInterval(() => {
    const skipping = focus.summary().filter(k => k.skipping).map(k => k.kind);
    log.info(`${executor.heartbeat()} · chain clock ${chainClock.live ? `live, ${chainClock.lagMs}ms behind our clock` : 'not live'}`
      + ` · focus skipping: ${skipping.length ? skipping.join(', ') : 'nothing'}`);
  }, 5 * 60_000));

  // Daily summary at 00:00 UTC.
  timers.push(setInterval(() => {
    const d = new Date();
    if (d.getUTCHours() === 0 && d.getUTCMinutes() === 0) void notifier.alert(executor.summaryText());
  }, 60_000));

  const shutdown = async () => {
    log.info('shutting down');
    executor.stop();
    timers.forEach(clearInterval);
    await telegram?.stop();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  await executor.run();
}

main().catch(e => {
  log.error('fatal', { error: e instanceof Error ? e.message : String(e) });
  process.exit(1);
});
