// Record real TukTuk accounts from mainnet into test/fixtures so adapter tests run offline.
//   npm run record-fixtures
import { writeFileSync } from 'node:fs';
import { Connection } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { decodeTask, TASK_DISCRIMINATOR, TUKTUK_PROGRAM_ID } from '../src/adapters/tuktuk/layout.js';

const conn = new Connection(loadConfig().rpcUrl);
const tasks = await conn.getProgramAccounts(TUKTUK_PROGRAM_ID, {
  filters: [{ memcmp: { offset: 0, bytes: TASK_DISCRIMINATOR.toString('base64'), encoding: 'base64' } }],
});
const decoded = tasks.map(t => ({ t, d: decodeTask(t.account.data) }));
const pick = [
  decoded.find(x => x.d.transaction.kind === 'compiled' && x.d.freeTasks > 0),
  decoded.find(x => x.d.transaction.kind === 'compiled' && x.d.freeTasks === 0),
  decoded.find(x => x.d.transaction.kind === 'remote'),
].filter(x => x !== undefined);

const queueKeys = [...new Set(pick.map(x => x.d.taskQueue.toBase58()))];
const queueInfos = await conn.getMultipleAccountsInfo(queueKeys.map(k => pick.find(x => x.d.taskQueue.toBase58() === k)!.d.taskQueue));

const fixture = {
  recordedAt: new Date().toISOString(),
  tasks: pick.map(x => ({ address: x.t.pubkey.toBase58(), data: x.t.account.data.toString('base64') })),
  queues: queueKeys.map((k, i) => ({ address: k, data: queueInfos[i]!.data.toString('base64') })),
};
writeFileSync('test/fixtures/tuktuk-accounts.json', JSON.stringify(fixture, null, 2) + '\n');
console.log(`recorded ${fixture.tasks.length} tasks, ${fixture.queues.length} queues`);
