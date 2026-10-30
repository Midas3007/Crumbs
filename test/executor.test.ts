import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import type { JitoClient } from '../src/core/jito.js';
import type { Config } from '../src/config.js';
import { Guardrails } from '../src/core/caps.js';
import { Executor } from '../src/core/executor.js';
import { Ledger } from '../src/core/ledger.js';
import type { Candidate, Job } from '../src/core/types.js';
import { AGENT, builtJob, Recorder, testConfig } from './helpers.js';

const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

/** A fake chain: every simulation pays `delta` lamports to the agent; records what was sent. */
function fakeChain(delta: bigint, opts: { simErr?: unknown; balance?: number } = {}) {
  const sent: Uint8Array[] = [];
  const pre = 10_000_000;
  const conn = {
    rpcEndpoint: 'http://fake',
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: opts.simErr ?? null, logs: [], unitsConsumed: 50_000, accounts: [{ lamports: pre + Number(delta), data: ['', 'base64'] }] } }),
    getMultipleAccountsInfo: async () => [{ lamports: pre, data: Buffer.alloc(0) }],
    getFeeForMessage: async () => ({ value: 5_000 }),
    getRecentPrioritizationFees: async () => [],
    getBalance: async () => opts.balance ?? pre,
    sendRawTransaction: async (raw: Uint8Array) => { sent.push(raw); return 'SIG' + sent.length; },
    confirmTransaction: async () => ({ value: { err: null } }),
    getTransaction: async () => ({
      meta: { preBalances: [pre], postBalances: [pre + Number(delta)], fee: 5_000, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { getAccountKeys: () => ({ staticAccountKeys: [AGENT.publicKey], get: () => AGENT.publicKey }) } },
    }),
  } as unknown as Connection;
  return { conn, sent };
}

class FakeJob implements Job {
  type = 'fake.job'; protocol = 'Fake'; description = 'test'; rewardSource = 'test';
  constructor(private reward = 15_000n) {}
  async detect(): Promise<Candidate[]> { return [{ id: `c${Math.random()}`, jobType: this.type, description: 'fake' }]; }
  async build(_c: Candidate, _a: PublicKey) { return builtJob(this.reward); }
}


function setup(cfg: Config, delta: bigint, opts: Parameters<typeof fakeChain>[1] & { approve?: boolean; reward?: bigint } = {}) {
  const { conn, sent } = fakeChain(delta, opts);
  const ledger = new Ledger(':memory:');
  const guard = new Guardrails(ledger, cfg.caps, cfg.envPaused);
  const notifier = new Recorder();
  const job = new FakeJob(opts.reward);
  const ex = new Executor(conn, cfg, ledger, guard, notifier, [job]);
  return { ex, sent, ledger, guard, notifier, job };
}

test('new job types ask for approval', async () => {
  const { ex, notifier } = setup(testConfig({ mode: 'live' }), 10_000n);
  await ex.registerJobTypes();
  assert.equal(notifier.approvals.length, 1);
  assert.equal(notifier.approvals[0].jobType, 'fake.job');
});

test('shadow mode never sends, but records what it would have earned', async () => {
  const { ex, sent, ledger } = setup(testConfig({ mode: 'shadow' }), 10_000n);
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'shadow');
  assert.equal(sent.length, 0);
  assert.equal(ledger.daySummary().shadowNetLamports, 10_000n);
});

test('live mode: unapproved job types only run in shadow', async () => {
  const { ex, sent } = setup(testConfig({ mode: 'live' }), 10_000n);
  await ex.registerJobTypes();
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'shadow');
  assert.equal(sent.length, 0);
});

test('live mode: approved + profitable gets sent and the realized P&L is booked', async () => {
  const { ex, sent, ledger } = setup(testConfig({ mode: 'live' }), 10_000n);
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'landed');
  assert.equal(sent.length, 1);
  const d = ledger.daySummary();
  assert.equal(d.landed, 1);
  assert.equal(d.realizedNetLamports, 10_000n);
});

test('live mode: unprofitable jobs are not sent', async () => {
  const { ex, sent, ledger } = setup(testConfig({ mode: 'live' }), 500n);
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'rejected');
  assert.equal(sent.length, 0);
});

test('kill switch: /pause blocks sends and alerts once', async () => {
  const { ex, sent, ledger, guard, notifier } = setup(testConfig({ mode: 'live' }), 10_000n);
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  guard.pause('paused from Telegram');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'blocked');
  assert.equal(sent.length, 0);
  assert.equal(notifier.alerts.length, 0); // already paused by the owner: no extra alert
});

test('kill switch: env flag blocks sends', async () => {
  const { ex, sent, ledger } = setup(testConfig({ mode: 'live', envPaused: true }), 10_000n);
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'blocked');
  assert.equal(sent.length, 0);
});

test('wallet over cap: blocks and alerts', async () => {
  const { ex, sent, ledger, notifier } = setup(testConfig({ mode: 'live' }), 10_000n, { balance: 2_000_000_000 });
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'blocked');
  assert.equal(sent.length, 0);
  assert.match(notifier.alerts[0], /cap/);
});

test('anomaly: a too-good-to-be-true payout is never sent and is reported', async () => {
  const { ex, sent, ledger, notifier } = setup(testConfig({ mode: 'live' }), 5_000_000n);
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'anomaly');
  assert.equal(sent.length, 0);
  assert.match(notifier.alerts.at(-1)!, /Anomaly guard/);
});

test('failed simulations are never sent', async () => {
  const { ex, sent, ledger } = setup(testConfig({ mode: 'live' }), 10_000n, { simErr: { InstructionError: [1, { Custom: 3012 }] } });
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'rejected');
  assert.equal(sent.length, 0);
});

test('mode switch at runtime: /live makes the next tick send, /shadow stops it', async () => {
  const cfg = testConfig({ mode: 'shadow' });
  const { ex, sent, ledger } = setup(cfg, 10_000n);
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  assert.equal((await ex.tick())[0].outcome, 'shadow');
  cfg.mode = 'live';
  assert.equal((await ex.tick())[0].outcome, 'landed');
  cfg.mode = 'shadow';
  assert.equal((await ex.tick())[0].outcome, 'shadow');
  assert.equal(sent.length, 1);
});

test('speed: a remembered compute measurement skips the measuring simulation', async () => {
  const cfg = testConfig({ mode: 'shadow' });
  const { conn } = fakeChain(10_000n);
  let sims = 0;
  const simulate = conn.simulateTransaction.bind(conn);
  (conn as unknown as { simulateTransaction: unknown }).simulateTransaction = async (...a: unknown[]) => { sims++; return (simulate as (...x: unknown[]) => unknown)(...a); };
  const ledger = new Ledger(':memory:');
  const job = new FakeJob();
  job.build = async () => ({ ...builtJob(15_000n), cuKey: 'same-kind' });
  const ex = new Executor(conn, cfg, ledger, new Guardrails(ledger, cfg.caps, false), new Recorder(), [job]);
  await ex.tick();
  assert.equal(sims, 2); // measure + final
  await ex.tick();
  assert.equal(sims, 3); // final only
});

test('speed: with background confirmation, a send returns immediately as "sent" and settles later', async () => {
  const cfg = testConfig({ mode: 'live' });
  const { conn, sent } = fakeChain(10_000n);
  const ledger = new Ledger(':memory:');
  const ex = new Executor(conn, cfg, ledger, new Guardrails(ledger, cfg.caps, false), new Recorder(), [new FakeJob()], { backgroundSettle: true });
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  assert.equal(a.outcome, 'sent');
  assert.equal(sent.length, 1);
  await new Promise(r => setTimeout(r, 20));
  assert.equal(ledger.daySummary().landed, 1); // booked once the chain confirmed
  assert.match(ex.heartbeat(), /ms per job/);
});

function jitoChain(status: 'landed' | 'failed' | 'never') {
  const bundles: unknown[] = [];
  const { conn } = fakeChain(10_000n - 1_000n);
  Object.assign(conn, {
    getSignatureStatuses: async () => ({ value: [status === 'never' ? null : { confirmationStatus: 'confirmed', err: status === 'failed' ? { InstructionError: [0, 'x'] } : null }] }),
    getBlockHeight: async () => 1_000, // past lastValidBlockHeight (100): an unseen bundle can never land
  });
  const client = {
    tipInstruction: async (from: PublicKey, lamports: bigint) => SystemProgram.transfer({ fromPubkey: from, toPubkey: PublicKey.default, lamports: Number(lamports) }),
    sendBundle: async (tx: unknown) => { bundles.push(tx); return 'bundle-id'; },
  } as unknown as JitoClient;
  return { conn, bundles, client };
}

for (const [status, outcome, net, landed] of [['landed', 'landed', 9_000n, 1], ['never', 'dropped', 0n, 0], ['failed', 'failed', 9_000n, 0]] as const) {
  test(`jito: ${status === 'never' ? 'a lost race is dropped at no cost' : status === 'landed' ? 'a won race lands and pays (tip counted)' : 'a landed-but-failed tx is booked as a loss'}`, async () => {
    const cfg = testConfig({ mode: 'live' });
    const { conn, bundles, client } = jitoChain(status);
    const ledger = new Ledger(':memory:');
    const ex = new Executor(conn, cfg, ledger, new Guardrails(ledger, cfg.caps, false), new Recorder(), [new FakeJob()], { jito: { client, tipLamports: 1_000n }, jitoPollMs: 0 });
    await ex.registerJobTypes();
    ledger.setJobTypeStatus('fake.job', 'approved');
    const [a] = await ex.tick();
    assert.equal(bundles.length, 1);
    assert.equal(a.outcome, outcome);
    assert.equal(a.decision?.costLamports, 5_000n + 1_000n); // base fee + tip, no priority fee
    const d = ledger.daySummary();
    assert.equal(d.landed, landed);
    if (status === 'never') assert.equal(d.realizedLossLamports, 0n);
    else assert.equal(d.realizedNetLamports, net);
  });
}
