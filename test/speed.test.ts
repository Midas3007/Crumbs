import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { TuktukJob } from '../src/adapters/tuktuk/adapter.js';
import { decodeTaskHeader, TASK_DISCRIMINATOR } from '../src/adapters/tuktuk/layout.js';
import { Guardrails } from '../src/core/caps.js';
import { ChainClock, decodeClock } from '../src/core/chainClock.js';
import { Executor, FEATURE } from '../src/core/executor.js';
import { Features } from '../src/core/features.js';
import type { JitoClient } from '../src/core/jito.js';
import { Ledger } from '../src/core/ledger.js';
import { TipTuner } from '../src/core/tipTuner.js';
import type { Candidate, Job, SimOutcome } from '../src/core/types.js';
import { AGENT, builtJob, Recorder, testConfig } from './helpers.js';

const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';
const NOT_READY = { InstructionError: [1, { Custom: 6005 }] };

test('chain clock: decodes the Clock sysvar and fires on the first slot at the due second', async () => {
  const data = Buffer.alloc(40);
  data.writeBigUInt64LE(463527684n, 0);
  data.writeBigInt64LE(1793415260n, 32);
  assert.deepEqual(decodeClock(data), { slot: 463527684, unixTimestamp: 1793415260 });

  let now = 1793415260_500;
  const clock = new ChainClock({} as Connection, () => now);
  assert.equal(await clock.waitFor(1793415261), false); // not live yet: caller falls back to its own clock
  clock.update({ slot: 1, unixTimestamp: 1793415260 });
  assert.equal(clock.lagMs, 500);
  const fired = clock.waitFor(1793415261, 5_000);
  clock.update({ slot: 2, unixTimestamp: 1793415260 }); // same second: keep waiting
  now += 400;
  clock.update({ slot: 3, unixTimestamp: 1793415261 }); // due
  assert.equal(await fired, true);
});

test('adaptive tip: up when outbid, a little up when out-raced, down when winning; capped by the margin', () => {
  const t = new TipTuner(new Ledger(':memory:'), 1_000n);
  t.learn('x', 'not_included');
  assert.equal(t.tip('x'), 1_500n);
  t.learn('x', 'lost_race');
  assert.equal(t.tip('x'), 1_875n);
  t.learn('x', 'landed');
  assert.equal(t.tip('x'), 1_687n);
  for (let i = 0; i < 30; i++) t.learn('x', 'landed');
  assert.equal(t.tip('x'), 1_000n); // never below Jito's minimum
  for (let i = 0; i < 30; i++) t.learn('x', 'not_included');
  // Reward 15,000, base fee 5,000, minimum profit 2,000: at most 8,000 may go to the tip.
  assert.equal(t.tipFor('x', 15_000n, 5_000n, 2_000n), 8_000n);
  // A remote task (two signatures) has room for only 3,000.
  assert.equal(t.tipFor('x', 15_000n, 10_000n, 2_000n), 3_000n);
});

/** A chain where the first `notReady` simulations fail with TaskNotReady, then the job pays. */
function chain(opts: { notReady?: number; status?: 'landed' | 'never'; sims?: { n: number } } = {}) {
  const pre = 10_000_000;
  let left = opts.notReady ?? 0;
  return {
    rpcEndpoint: 'http://fake',
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    simulateTransaction: async () => {
      if (opts.sims) opts.sims.n++;
      if (left > 0) { left--; return { value: { err: NOT_READY, logs: [], unitsConsumed: 1_000, accounts: [{ lamports: pre, data: ['', 'base64'] }] } }; }
      return { value: { err: null, logs: [], unitsConsumed: 50_000, accounts: [{ lamports: pre + 9_000, data: ['', 'base64'] }] } };
    },
    getMultipleAccountsInfo: async () => [{ lamports: pre, data: Buffer.alloc(0) }],
    getBalance: async () => pre,
    getSignatureStatuses: async () => ({ value: [opts.status === 'landed' ? { confirmationStatus: 'confirmed', err: null, slot: 9 } : null] }),
    getBlockHeight: async () => 50, // blockhash still valid: only early release can end the wait
    getBlockTime: async () => null,
    getTransaction: async () => ({
      meta: { preBalances: [pre], postBalances: [pre + 9_000], fee: 5_000, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { getAccountKeys: () => ({ staticAccountKeys: [AGENT.publicKey], get: () => AGENT.publicKey }) } },
    }),
  } as unknown as Connection;
}

const jito = {
  tipInstruction: async (from: PublicKey, lamports: bigint) => SystemProgram.transfer({ fromPubkey: from, toPubkey: PublicKey.default, lamports: Number(lamports) }),
  sendBundle: async () => 'bundle',
} as unknown as JitoClient;

class DueJob implements Job {
  type = 'fake.job'; protocol = 'Fake'; description = 'test'; rewardSource = 'test';
  constructor(private n = 1, private stillThere = true) {}
  async detect(): Promise<Candidate[]> {
    const due = Math.floor(Date.now() / 1000);
    return Array.from({ length: this.n }, (_, i) => ({ id: `c${i}-${Math.random()}`, jobType: this.type, description: 'fake', dueAt: due }));
  }
  async build() { return builtJob(15_000n); }
  failureReason(sim: SimOutcome) { return JSON.stringify(sim.err).includes('6005') ? 'not_ready' as const : undefined; }
  async stillAvailable() { return this.stillThere; }
}

function setup(on: string[], conn: Connection, job: Job) {
  const cfg = testConfig({ mode: 'live' });
  const ledger = new Ledger(':memory:');
  const features = new Features(ledger, Object.values(FEATURE).map(name => ({ name, description: '', defaultOn: on.includes(name) })), () => {});
  const ex = new Executor(conn, cfg, ledger, new Guardrails(ledger, cfg.caps, false), new Recorder(), [job],
    { jito: { client: jito, tipLamports: 1_000n }, jitoPollMs: 0, features, tipTuner: new TipTuner(ledger, 1_000n) });
  return { ex, ledger, features };
}

test('fast retry: "not ready" at the due second is retried within the same try, and the send counts for the feature', async () => {
  const off = setup([], chain({ notReady: 2, status: 'landed' }), new DueJob());
  await off.ex.registerJobTypes();
  off.ledger.setJobTypeStatus('fake.job', 'approved');
  assert.equal((await off.ex.tick())[0].reason, 'not_ready');

  const sims = { n: 0 };
  const on = setup([FEATURE.fastRetry], chain({ notReady: 2, status: 'landed', sims }), new DueJob());
  await on.ex.registerJobTypes();
  on.ledger.setJobTypeStatus('fake.job', 'approved');
  const t0 = Date.now();
  const [a] = await on.ex.tick();
  assert.equal(a.outcome, 'landed');
  assert.ok(Date.now() - t0 >= 300, 'two 150 ms waits');
  assert.equal(on.features.status().find(f => f.name === FEATURE.fastRetry)?.sends, 1);
});

test('jito slots: once the job is gone, an unseen bundle is released as a lost race without waiting for expiry', async () => {
  const { ex, ledger } = setup([FEATURE.jitoSlots], chain({ status: 'never' }), new DueJob(1, false));
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'dropped');
  assert.deepEqual(ledger.funnel().map(r => r.reason), ['lost_race']);
});

test('parallel jobs: four jobs due together are worked on at once', async () => {
  let inSim = 0;
  let peak = 0;
  const conn = chain({ status: 'landed' });
  const sim = conn.simulateTransaction.bind(conn);
  (conn as unknown as { simulateTransaction: unknown }).simulateTransaction = async (...x: unknown[]) => {
    inSim++; peak = Math.max(peak, inSim);
    await new Promise(r => setTimeout(r, 20));
    try { return await (sim as (...y: unknown[]) => unknown)(...x); } finally { inSim--; }
  };
  const { ex, ledger } = setup([FEATURE.parallelJobs, FEATURE.jitoSlots], conn, new DueJob(4));
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const res = await ex.tick();
  assert.equal(res.length, 4);
  assert.ok(peak >= 3, `peak concurrency ${peak}`);
  assert.equal(res.filter(r => r.outcome === 'landed').length, 4);
});

test('adaptive tip: the learned tip goes into the transaction and the profit guard sees it', async () => {
  const { ex, ledger } = setup([FEATURE.adaptiveTip], chain({ status: 'landed' }), new DueJob());
  ledger.setState('tip:fake.job', '4000');
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.decision?.costLamports, 5_000n + 4_000n);
  assert.equal(ledger.getState('tip:fake.job'), '3600'); // a win lets it drift down
});

test('live tasks: a task arriving over the websocket joins the schedule', async () => {
  const job = new TuktukJob({} as Connection, { minRewardLamports: 0n });
  const header = Buffer.alloc(8 + 32 + 8 + 8 + 2 + 9);
  const queue = PublicKey.unique();
  TASK_DISCRIMINATOR.copy(header, 0);
  queue.toBuffer().copy(header, 8);
  header.writeBigUInt64LE(15_000n, 48); // crank reward
  header[58] = 1; // trigger: timestamp
  header.writeBigInt64LE(BigInt(Math.floor(Date.now() / 1000)), 59);
  const h = decodeTaskHeader(header);
  const addr = PublicKey.unique();
  job.upsert(addr, h);
  job.upsert(addr, h); // updates replace, never duplicate
  assert.equal((job as unknown as { schedule: unknown[] }).schedule.length, 1);
});
