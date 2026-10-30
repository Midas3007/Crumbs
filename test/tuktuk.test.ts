import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { type Connection, Ed25519Program, PublicKey, SystemProgram, SYSVAR_INSTRUCTIONS_PUBKEY } from '@solana/web3.js';
import { TuktukJob } from '../src/adapters/tuktuk/adapter.js';
import {
  decodeTask, decodeTaskHeader, decodeTaskQueue, nextAvailableTaskIds, RUN_TASK_V0_DISCRIMINATOR, TASK_HEADER_LEN, taskAddress, TUKTUK_PROGRAM_ID,
} from '../src/adapters/tuktuk/layout.js';
import { JobGone } from '../src/core/types.js';
import { AGENT } from './helpers.js';

const fx = JSON.parse(readFileSync(new URL('./fixtures/tuktuk-accounts.json', import.meta.url), 'utf8')) as {
  tasks: { address: string; data: string }[]; queues: { address: string; data: string }[];
};
const accounts = new Map<string, Buffer>([...fx.tasks, ...fx.queues].map(a => [a.address, Buffer.from(a.data, 'base64')]));
const tasks = fx.tasks.map(t => ({ address: new PublicKey(t.address), task: decodeTask(accounts.get(t.address)!) }));

/** A Connection that only knows the recorded accounts. */
function fakeConn(overrides: Partial<Record<keyof Connection, unknown>> = {}): Connection {
  return {
    getAccountInfo: async (k: PublicKey) => {
      const data = accounts.get(k.toBase58());
      return data ? { data, lamports: 1, owner: TUKTUK_PROGRAM_ID, executable: false } : null;
    },
    getAddressLookupTable: async () => ({ value: null }),
    getMultipleAccountsInfo: async (ks: PublicKey[]) => ks.map(k => {
      const data = accounts.get(k.toBase58());
      return data ? { data, lamports: 1, owner: TUKTUK_PROGRAM_ID, executable: false } : null;
    }),
    getProgramAccounts: async () => tasks.map(t => ({ pubkey: t.address, account: { data: accounts.get(t.address.toBase58())!.subarray(0, TASK_HEADER_LEN) } })),
    ...overrides,
  } as unknown as Connection;
}

test('decodes recorded mainnet tasks and queues', () => {
  assert.equal(tasks.length, 3);
  for (const { task } of tasks) {
    assert.ok(task.crankReward > 0n);
    assert.equal(task.trigger.kind, 'timestamp');
  }
  const compiled = tasks.filter(t => t.task.transaction.kind === 'compiled');
  assert.equal(compiled.length, 2);
  assert.ok(tasks.some(t => t.task.transaction.kind === 'remote'));
  const q = decodeTaskQueue(Buffer.from(fx.queues[0].data, 'base64'));
  assert.equal(q.taskBitmap.length, Math.ceil(q.capacity / 8));
  assert.ok(q.name.length > 0);
});

test('task PDA derivation matches the recorded addresses', () => {
  for (const { address, task } of tasks) assert.ok(taskAddress(task.taskQueue, task.id).equals(address));
});

test('header decoding works on the polling slice alone', () => {
  for (const { address, task } of tasks) {
    const h = decodeTaskHeader(accounts.get(address.toBase58())!.subarray(0, TASK_HEADER_LEN));
    assert.equal(h.crankReward, task.crankReward);
    assert.deepEqual(h.trigger, task.trigger);
  }
});

test('build: compiled task with follow-up tasks', async () => {
  const { address, task } = tasks.find(t => t.task.transaction.kind === 'compiled' && t.task.freeTasks > 0)!;
  const job = new TuktukJob(fakeConn(), { minRewardLamports: 0n });
  const built = await job.build({ id: 'x', jobType: job.type, description: '', data: { task: address.toBase58() } }, AGENT.publicKey);

  assert.equal(built.expectedRewardLamports, task.crankReward);
  assert.equal(built.instructions.length, 1);
  const ix = built.instructions[0];
  assert.ok(ix.programId.equals(TUKTUK_PROGRAM_ID));
  // Fixed accounts in IDL order.
  const fixed = ix.keys.slice(0, 6);
  assert.ok(fixed[0].pubkey.equals(AGENT.publicKey) && fixed[0].isSigner && fixed[0].isWritable);
  assert.ok(fixed[1].pubkey.equals(task.rentRefund) && fixed[1].isWritable && !fixed[1].isSigner);
  assert.ok(fixed[2].pubkey.equals(task.taskQueue) && fixed[2].isWritable);
  assert.ok(fixed[3].pubkey.equals(address) && fixed[3].isWritable);
  assert.ok(fixed[4].pubkey.equals(SystemProgram.programId));
  assert.ok(fixed[5].pubkey.equals(SYSVAR_INSTRUCTIONS_PUBKEY));
  // Only the crank turner signs; nothing in the task can borrow our signature.
  assert.equal(ix.keys.filter(k => k.isSigner).length, 1);

  if (task.transaction.kind !== 'compiled') throw new Error('unreachable');
  const inner = task.transaction.tx.accounts.length;
  assert.equal(ix.keys.length, 6 + inner + task.freeTasks);
  // Data: discriminator + vec<u16> of free task ids, all of them unused in the queue bitmap.
  assert.ok(ix.data.subarray(0, 8).equals(RUN_TASK_V0_DISCRIMINATOR));
  assert.equal(ix.data.readUInt32LE(8), task.freeTasks);
  const q = decodeTaskQueue(accounts.get(task.taskQueue.toBase58())!);
  for (let i = 0; i < task.freeTasks; i++) {
    const id = ix.data.readUInt16LE(12 + 2 * i);
    assert.equal(q.taskBitmap[id >> 3] & (1 << (id & 7)), 0, `free id ${id} is unused`);
    assert.ok(ix.keys[6 + inner + i].pubkey.equals(taskAddress(task.taskQueue, id)));
  }
});

test('build: compiled task writable flags follow the compiled header', async () => {
  const { address, task } = tasks.find(t => t.task.transaction.kind === 'compiled' && t.task.freeTasks === 0)!;
  const job = new TuktukJob(fakeConn(), { minRewardLamports: 0n });
  const built = await job.build({ id: 'x', jobType: job.type, description: '', data: { task: address.toBase58() } }, AGENT.publicKey);
  if (task.transaction.kind !== 'compiled') throw new Error('unreachable');
  const { numRwSigners, numRoSigners, numRw } = task.transaction.tx;
  built.instructions[0].keys.slice(6).forEach((k, i) => {
    const writable = i < numRwSigners || (i >= numRwSigners + numRoSigners && i < numRwSigners + numRoSigners + numRw);
    assert.equal(k.isWritable, writable);
    assert.equal(k.isSigner, false);
  });
});

test('build: remote task adds the ed25519 proof and never grants signer from the server', async () => {
  const { address, task } = tasks.find(t => t.task.transaction.kind === 'remote')!;
  const original = globalThis.fetch;
  const remoteKey = PublicKey.unique();
  globalThis.fetch = (async () => new Response(JSON.stringify({
    transaction: Buffer.from('remote-tx').toString('base64'),
    signature: Buffer.alloc(64, 7).toString('base64'),
    remaining_accounts: [{ pubkey: remoteKey.toBase58(), is_writable: true, is_signer: true }],
  }))) as typeof fetch;
  try {
    const job = new TuktukJob(fakeConn(), { minRewardLamports: 0n });
    const built = await job.build({ id: 'x', jobType: job.type, description: '', data: { task: address.toBase58() } }, AGENT.publicKey);
    assert.equal(built.instructions.length, 2);
    assert.ok(built.instructions[0].programId.equals(Ed25519Program.programId));
    const run = built.instructions[1];
    const k = run.keys.find(x => x.pubkey.equals(remoteKey))!;
    assert.equal(k.isWritable, true);
    assert.equal(k.isSigner, false);
  } finally {
    globalThis.fetch = original;
  }
});

test('build: a task someone else already ran is "gone", not an error', async () => {
  const job = new TuktukJob(fakeConn({ getAccountInfo: async () => null }), { minRewardLamports: 0n });
  await assert.rejects(job.build({ id: 'x', jobType: job.type, description: '', data: { task: tasks[0].address.toBase58() } }, AGENT.publicKey), JobGone);
});

const FRESH = '1XHGp1Ku1ruEUi35UwRhcib9TM4xaaE2Rn2cdxJq7mg';   // hpl-crons task, due 1793403900
const STUCK = 'dNnUREsv5wvDPVrpc6ruuAP9ncnMGTXjd1SD8Xo2Aw7';   // fanout claim that keeps failing, due 1793328060
const STUCK_STALE_AT = 1793328060 + 172800 + 1;               // fanout-queue stale_task_age is 48h

test('detect: fresh tasks at their due time, stuck tasks rechecked every 10 minutes (not every tick)', async () => {
  let now = (1793403900 + 1) * 1000;
  const job = new TuktukJob(fakeConn(), { minRewardLamports: 0n, leadSec: 0, now: () => now });
  const first = await job.detect();
  const kinds = Object.fromEntries(first.map(c => [c.id.split(':')[0], c.id.split(':')[1]]));
  assert.equal(kinds[FRESH], 'due');
  assert.equal(kinds[STUCK], 'recheck');
  assert.equal(first.find(c => c.id.startsWith(STUCK))!.dueAt, undefined);
  // Next second: the stuck ones are not offered again until 10 minutes have passed.
  now += 1000;
  assert.deepEqual((await job.detect()).map(c => c.id.split(':')[1]), ['due']);
  now += 600_000;
  assert.ok((await job.detect()).some(c => c.id.startsWith(`${STUCK}:recheck`)));
});

test('detect: a stuck task is aimed at the exact second it turns stale', async () => {
  let now = (STUCK_STALE_AT - 100) * 1000;
  const job = new TuktukJob(fakeConn(), { minRewardLamports: 0n, leadSec: 2, now: () => now });
  assert.ok(!(await job.detect()).some(c => c.id.startsWith(STUCK))); // aimed, but not ready yet
  now = (STUCK_STALE_AT - 1) * 1000;
  const c = (await job.detect()).find(x => x.id.startsWith(STUCK))!;
  assert.equal(c.id, `${STUCK}:stale:${STUCK_STALE_AT}`);
  assert.equal(c.dueAt, STUCK_STALE_AT);
});

test('detect: nothing before anything is due; low rewards are skipped', async () => {
  const before = new TuktukJob(fakeConn(), { minRewardLamports: 0n, leadSec: 0, now: () => 0 });
  assert.equal((await before.detect()).length, 0);
  const rich = new TuktukJob(fakeConn(), { minRewardLamports: 1_000_000n, now: () => (1793403900 + 1) * 1000 });
  assert.equal((await rich.detect()).length, 0);
});

test('prepare ahead: the transaction is built before the due time, so build() at the moment makes no RPC calls', async () => {
  let calls = 0;
  const conn = fakeConn();
  const getAccountInfo = conn.getAccountInfo.bind(conn);
  (conn as unknown as { getAccountInfo: unknown }).getAccountInfo = async (k: PublicKey) => { calls++; return getAccountInfo(k); };
  let now = (1793403900 - 8) * 1000; // 8s before the fresh task is due
  const job = new TuktukJob(conn, { minRewardLamports: 0n, leadSec: 2, prepareSec: 10, agent: AGENT.publicKey, now: () => now });
  await job.detect();
  await new Promise(r => setTimeout(r, 10)); // let the background build finish
  const prepCalls = calls;
  assert.ok(prepCalls > 0, 'built in the background');
  now = 1793403900 * 1000;
  const c = (await job.detect()).find(x => x.id.startsWith(FRESH))!;
  const built = await job.build(c, AGENT.publicKey);
  assert.equal(calls, prepCalls, 'no extra RPC at the due second');
  assert.ok(built.cuKey?.startsWith('tuktuk:'));
  // Used once: a retry builds from fresh state.
  await job.build(c, AGENT.publicKey);
  assert.ok(calls > prepCalls);
});

test('nextAvailableTaskIds skips used ids and respects capacity', () => {
  const bitmap = Buffer.from([0b1111_0111, 0xff, 0b0000_0001]);
  assert.deepEqual(nextAvailableTaskIds(bitmap, 1, 24, 0), [3]);
  assert.deepEqual(nextAvailableTaskIds(bitmap, 3, 24, 0), [3, 17, 18]);
  assert.throws(() => nextAvailableTaskIds(bitmap, 3, 18, 0));
  assert.deepEqual(nextAvailableTaskIds(bitmap, 0, 24), []);
});
