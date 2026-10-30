// Run one discovery pass now and print what was found.
//   npm run discover                      (manual list in discovery/programs.json)
//   npm run discover -- <programId> ...    (just these)
//   add --recent to include recently deployed programs, --force to re-classify unchanged IDLs,
//   --no-ai to skip Claude and test the signer screen + on-chain validation only
import { Connection } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { Ledger } from '../src/core/ledger.js';
import { LogNotifier } from '../src/core/notifier.js';
import { ClaudeClassifier, HeuristicClassifier } from '../src/discovery/classify.js';
import { DiscoveryEngine } from '../src/discovery/engine.js';
import { manualPrograms, recentlyDeployedPrograms } from '../src/discovery/programs.js';
import { TelegramNotifier } from '../src/telegram/bot.js';
import { Guardrails } from '../src/core/caps.js';
import { CreditWatch } from '../src/core/creditWatch.js';

const args = process.argv.slice(2);
const cfg = loadConfig();
const noAi = args.includes('--no-ai');
if (!noAi && !cfg.discovery.anthropicApiKey) throw new Error('Set ANTHROPIC_API_KEY in .env (or pass --no-ai for a heuristic-only pass)');
const conn = new Connection(cfg.rpcUrl);
const ledger = new Ledger(cfg.dbPath);
const notifier = cfg.telegram
  ? new TelegramNotifier(cfg.telegram.token, cfg.telegram.chatId, ledger, new Guardrails(ledger, cfg.caps, cfg.envPaused), () => '')
  : new LogNotifier();

const explicit = args.filter(a => !a.startsWith('--'));
const programs = explicit.length ? explicit : [...manualPrograms(), ...(args.includes('--recent') ? await recentlyDeployedPrograms(conn) : [])];
const engine = new DiscoveryEngine(conn, cfg, ledger, notifier, noAi ? new HeuristicClassifier() : new ClaudeClassifier(cfg.discovery.anthropicApiKey), { force: args.includes('--force') || noAi, credits: new CreditWatch(t => notifier.alert(t)), dailyBudgetUsd: cfg.discovery.dailyBudgetUsd });
const r = await engine.run([...new Set(programs)]);

console.log(`\nScanned ${r.programsScanned} programs, classified ${r.classified} instructions.`);
for (const s of r.skipped) console.log(`  skipped ${s.program}: ${s.why}`);
for (const v of r.validated) console.log(`✅ VALIDATED  disc.${v.id}  ${v.candidate.programName}::${v.candidate.instruction} — ${v.result.summary}`);
for (const p of r.proposals) console.log(`🔎 PROPOSAL   ${p.candidate.programName}::${p.candidate.instruction} — ${p.result.summary}`);
for (const a of r.anomalies) console.log(`🚨 ANOMALY    ${a.candidate.programName}::${a.candidate.instruction} — ${a.result.summary} → ${a.disclosurePath}`);
for (const x of r.rejected) console.log(`   ${x.status.padEnd(18)} ${x.candidate.programName}::${x.candidate.instruction} — ${x.summary}`);
