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

test('detect: only due tasks that pay enough, earliest first', async () => {
  const latest = Math.max(...tasks.map(t => (t.task.trigger.kind === 'timestamp' ? t.task.trigger.ts : 0)));
  const job = new TuktukJob(fakeConn(), { minRewardLamports: 0n, leadSec: 0, now: () => (latest + 1) * 1000 });
  const all = await job.detect();
  assert.equal(all.length, 3);
  assert.ok(all.every((c, i) => i === 0 || (all[i - 1].dueAt ?? 0) <= (c.dueAt ?? 0)));

  const before = new TuktukJob(fakeConn(), { minRewardLamports: 0n, leadSec: 0, now: () => 0 });
  assert.equal((await before.detect()).length, 0);

  const rich = new TuktukJob(fakeConn(), { minRewardLamports: 1_000_000n, now: () => (latest + 1) * 1000 });
  assert.equal((await rich.detect()).length, 0);
});

test('nextAvailableTaskIds skips used ids and respects capacity', () => {
  const bitmap = Buffer.from([0b1111_0111, 0xff, 0b0000_0001]);
  assert.deepEqual(nextAvailableTaskIds(bitmap, 1, 24, 0), [3]);
  assert.deepEqual(nextAvailableTaskIds(bitmap, 3, 24, 0), [3, 17, 18]);
  assert.throws(() => nextAvailableTaskIds(bitmap, 3, 18, 0));
  assert.deepEqual(nextAvailableTaskIds(bitmap, 0, 24), []);
});
