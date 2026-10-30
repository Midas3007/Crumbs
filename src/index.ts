import { Connection } from '@solana/web3.js';
import { TuktukJob } from './adapters/tuktuk/adapter.js';
import { formatSol, loadConfig } from './config.js';
import { Guardrails } from './core/caps.js';
import { Executor } from './core/executor.js';
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

async function main() {
  const cfg = loadConfig();
  setLogLevel(cfg.logLevel);
  const ledger = new Ledger(cfg.dbPath);
  const guard = new Guardrails(ledger, cfg.caps, cfg.envPaused);
  let notifier: Notifier = new LogNotifier();
  // Alerts when the Claude API or the RPC provider runs out of credits.
  const credits = new CreditWatch(t => notifier.alert(t));
  const conn = new Connection(cfg.rpcUrl, { commitment: 'confirmed', fetch: creditWatchingFetch(credits) });

  const jobs: Job[] = [
    new TuktukJob(conn, { minRewardLamports: BASE_FEE_PER_SIGNATURE + cfg.caps.minProfitLamports }),
  ];

  let summary = () => '';
  let telegram: TelegramNotifier | undefined;
  const tgProblem = cfg.telegram && telegramConfigProblem(cfg.telegram.token, cfg.telegram.chatId);
  if (tgProblem) {
    log.error(`TELEGRAM_CHAT_ID looks wrong: ${tgProblem}. Run \`npm run telegram-setup\` to find the right one. Alerts go to the log until then.`);
  } else if (cfg.telegram) {
    telegram = new TelegramNotifier(cfg.telegram.token, cfg.telegram.chatId, ledger, guard, () => summary());
    notifier = telegram;
    telegram.start();
  } else {
    log.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not set: alerts go to the log, approve with `npm run approve -- <type>`');
  }

  const executor = new Executor(conn, cfg, ledger, guard, notifier, jobs);
  summary = () => executor.summaryText();

  const balance = BigInt(await conn.getBalance(cfg.agentPubkey));
  log.info('starting', { mode: cfg.mode, wallet: cfg.agentPubkey.toBase58(), balance: formatSol(balance), paused: guard.state() });
  if (balance === 0n) log.warn('agent wallet is empty: simulations need a fee payer with some SOL (0.01 SOL is plenty for shadow mode)');
  await notifier.alert(`🍞 Crumbs started in ${cfg.mode} mode\nWallet ${cfg.agentPubkey.toBase58()} · ${formatSol(balance)}`);
  await executor.registerJobTypes();

  const timers: NodeJS.Timeout[] = [];
  if (cfg.mode === 'live' && cfg.sweep.enabled && cfg.agentKeypair) {
    const sweeper = new Sweeper(conn, cfg, cfg.agentKeypair, t => notifier.alert(t));
    timers.push(setInterval(() => {
      if (guard.state().paused) return;
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
        executor.addJob(new ReplayJob(conn, spec));
        log.info('discovered job is live', { type: jt.type, program: spec.candidate.programName, instruction: spec.candidate.instruction });
      }
    }
  };
  loadApprovedDiscoveries();
  timers.push(setInterval(loadApprovedDiscoveries, 60_000));

  if (cfg.discovery.anthropicApiKey) {
    const engine = new DiscoveryEngine(conn, cfg, ledger, notifier, new ClaudeClassifier(cfg.discovery.anthropicApiKey), { credits });
    const discover = async () => {
      const programs = [...manualPrograms(), ...(cfg.discovery.includeRecentDeploys ? await recentlyDeployedPrograms(conn) : [])];
      await engine.run([...new Set(programs)]);
    };
    setTimeout(() => void discover().catch(e => log.warn('discovery failed', { error: String(e) })), 60_000);
    timers.push(setInterval(() => void discover().catch(e => log.warn('discovery failed', { error: String(e) })), cfg.discovery.intervalHours * 3_600_000));
  } else {
    log.warn('ANTHROPIC_API_KEY not set: discovery is off');
  }

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
