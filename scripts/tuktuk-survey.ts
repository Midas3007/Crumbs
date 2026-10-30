// Snapshot of the TukTuk market: queues, rewards, how much work comes due, task types.
//   npm run survey
import { Connection } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import {
  decodeTask, decodeTaskQueue, TASK_DISCRIMINATOR, TASK_QUEUE_DISCRIMINATOR, TUKTUK_PROGRAM_ID,
} from '../src/adapters/tuktuk/layout.js';

const conn = new Connection(loadConfig().rpcUrl);
const filter = (d: Buffer) => [{ memcmp: { offset: 0, bytes: d.toString('base64'), encoding: 'base64' as const } }];

const queues = await conn.getProgramAccounts(TUKTUK_PROGRAM_ID, { filters: filter(TASK_QUEUE_DISCRIMINATOR) });
const queueNames = new Map<string, string>();
console.log('Queues:');
for (const q of queues) {
  const d = decodeTaskQueue(q.account.data);
  queueNames.set(q.pubkey.toBase58(), d.name);
  console.log(`  ${d.name.padEnd(20)} min reward ${d.minCrankReward} lamports · capacity ${d.capacity} · stale after ${d.staleTaskAge}s`);
}

const tasks = await conn.getProgramAccounts(TUKTUK_PROGRAM_ID, { filters: filter(TASK_DISCRIMINATOR) });
const now = Date.now() / 1000;
const buckets: Record<string, number> = {};
const kinds: Record<string, number> = {};
const remoteHosts: Record<string, number> = {};
const rewards: Record<string, number> = {};
const perQueue: Record<string, number> = {};
for (const a of tasks) {
  const t = decodeTask(a.account.data);
  const due = t.trigger.kind === 'timestamp' ? t.trigger.ts - now : -1;
  const b = due < 0 ? 'overdue' : due < 3600 ? '<1h' : due < 86400 ? '<24h' : due < 7 * 86400 ? '<7d' : '>7d';
  buckets[b] = (buckets[b] ?? 0) + 1;
  kinds[t.transaction.kind] = (kinds[t.transaction.kind] ?? 0) + 1;
  if (t.transaction.kind === 'remote') {
    const host = new URL(t.transaction.url).host;
    remoteHosts[host] = (remoteHosts[host] ?? 0) + 1;
  }
  rewards[t.crankReward.toString()] = (rewards[t.crankReward.toString()] ?? 0) + 1;
  const qn = queueNames.get(t.taskQueue.toBase58()) ?? t.taskQueue.toBase58();
  perQueue[qn] = (perQueue[qn] ?? 0) + 1;
}
console.log(`\nTasks: ${tasks.length}`);
console.log('  due:', buckets);
console.log('  source:', kinds, 'remote hosts:', remoteHosts);
console.log('  reward (lamports) → count:', rewards);
console.log('  per queue:', perQueue);
