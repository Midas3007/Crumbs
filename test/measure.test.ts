import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { type Connection, PublicKey, SystemProgram } from '@solana/web3.js';
import { tuktukFailureReason } from '../src/adapters/tuktuk/adapter.js';
import { Guardrails } from '../src/core/caps.js';
import { Executor, genericFailureReason } from '../src/core/executor.js';
import type { JitoClient } from '../src/core/jito.js';
import { Ledger } from '../src/core/ledger.js';
import type { Candidate, Job, RaceWinner } from '../src/core/types.js';
import { funnelStages, latencyStats, median } from '../src/dashboard/snapshot.js';
import { AGENT, builtJob, Recorder, sim, testConfig } from './helpers.js';

const TUKTUK = 'tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA';

// Log lines from real mainnet simulations (Oct 31).
test('tuktuk reasons: not due yet, stuck task, someone else ran it', () => {
  assert.equal(tuktukFailureReason({
    err: { InstructionError: [1, { Custom: 6005 }] },
    logs: [`Program ${TUKTUK} invoke [1]`, 'Program log: AnchorError caused by account: task. Error Code: TaskNotReady. Error Number: 6005.', `Program ${TUKTUK} failed: custom program error: 0x1775`],
  }), 'not_ready');
  // A stuck fanout task: the inner program fails with 3012 and TukTuk passes the same code on.
  assert.equal(tuktukFailureReason({
    err: { InstructionError: [1, { Custom: 3012 }] },
    logs: [`Program ${TUKTUK} invoke [1]`, 'Program fanCjX4iwbn41FSuZSvoSdro2XjUKuWyZFbegnqtmTX invoke [2]',
      'Program fanCjX4iwbn41FSuZSvoSdro2XjUKuWyZFbegnqtmTX failed: custom program error: 0xbc4', `Program ${TUKTUK} failed: custom program error: 0xbc4`],
  }), 'task_failing');
  // TukTuk itself finds the task account closed: the task was already run.
  assert.equal(tuktukFailureReason({
    err: { InstructionError: [1, { Custom: 3012 }] },
    logs: [`Program ${TUKTUK} invoke [1]`, 'Program log: AnchorError caused by account: task. Error Code: AccountNotInitialized.', `Program ${TUKTUK} failed: custom program error: 0xbc4`],
  }), 'taken_by_others');
  assert.equal(genericFailureReason(sim({ err: { InstructionError: [0, { Custom: 1 }] }, logs: [] })), 'sim_failed_other');
});

const BLOCKHASH = 'GHtXQBsoZHVnNFa9YevAzFr17DJjgHXk3ycTKD5xD3Zi';

function chain(delta: bigint, status: 'landed' | 'never' = 'never') {
  const pre = 10_000_000;
  return {
    rpcEndpoint: 'http://fake',
    getLatestBlockhash: async () => ({ blockhash: BLOCKHASH, lastValidBlockHeight: 100 }),
    simulateTransaction: async () => ({ value: { err: null, logs: [], unitsConsumed: 50_000, accounts: [{ lamports: pre + Number(delta), data: ['', 'base64'] }] } }),
    getMultipleAccountsInfo: async () => [{ lamports: pre, data: Buffer.alloc(0) }],
    getBalance: async () => pre,
    getSignatureStatuses: async () => ({ value: [status === 'never' ? null : { confirmationStatus: 'confirmed', err: null, slot: 777 }] }),
    getBlockHeight: async () => 1_000,
    getBlockTime: async () => 1_800_000_000,
    getTransaction: async () => ({
      meta: { preBalances: [pre], postBalances: [pre + Number(delta)], fee: 5_000, loadedAddresses: { writable: [], readonly: [] }, preTokenBalances: [], postTokenBalances: [] },
      transaction: { message: { getAccountKeys: () => ({ staticAccountKeys: [AGENT.publicKey], get: () => AGENT.publicKey }) } },
    }),
  } as unknown as Connection;
}

const jito = {
  tipInstruction: async (from: PublicKey, lamports: bigint) => SystemProgram.transfer({ fromPubkey: from, toPubkey: PublicKey.default, lamports: Number(lamports) }),
  sendBundle: async () => 'bundle',
} as unknown as JitoClient;

class TimedJob implements Job {
  type = 'fake.job'; protocol = 'Fake'; description = 'test'; rewardSource = 'test';
  winnerLookups = 0;
  stillAvailable?: () => Promise<boolean>;
  constructor(stillThere?: boolean, private dueAt = Math.floor(Date.now() / 1000)) {
    if (stillThere !== undefined) this.stillAvailable = async () => stillThere;
  }
  async detect(): Promise<Candidate[]> { return [{ id: `c${Math.random()}`, jobType: this.type, description: 'fake', dueAt: this.dueAt }]; }
  async build() { return builtJob(15_000n); }
  async whoTookIt(): Promise<RaceWinner> { this.winnerLookups++; return { signature: 'W', signer: 'Winner111', slot: 5, blockTimeMs: Date.now() }; }
}

async function run(delta: bigint, opts: { status?: 'landed' | 'never'; stillThere?: boolean; mode?: 'live' | 'shadow' } = {}) {
  const cfg = testConfig({ mode: opts.mode ?? 'live' });
  const ledger = new Ledger(':memory:');
  const job = new TimedJob(opts.stillThere);
  const ex = new Executor(chain(delta, opts.status), cfg, ledger, new Guardrails(ledger, cfg.caps, false), new Recorder(), [job],
    { jito: { client: jito, tipLamports: 1_000n }, jitoPollMs: 0, raceAnalysis: true });
  await ex.registerJobTypes();
  ledger.setJobTypeStatus('fake.job', 'approved');
  const [a] = await ex.tick();
  await new Promise(r => setTimeout(r, 10)); // let the winner lookup finish
  return { a, ledger, job };
}

test('funnel: a lost race (job gone) and an outbid bundle (job still open) are told apart', async () => {
  const lost = await run(9_000n, { stillThere: false });
  assert.equal(lost.a.outcome, 'dropped');
  assert.deepEqual(lost.ledger.funnel().map(r => r.reason), ['lost_race']);
  assert.equal(lost.job.winnerLookups, 1);
  assert.equal(lost.ledger.timings()[0].winnerSigner, 'Winner111');

  const outbid = await run(9_000n, { stillThere: true });
  assert.deepEqual(outbid.ledger.funnel().map(r => r.reason), ['not_included']);
  assert.equal(outbid.job.winnerLookups, 0);
});

test('funnel: a landed send is counted with its gross and cost, and timed end to end', async () => {
  const { ledger } = await run(9_000n, { status: 'landed' });
  const [row] = ledger.funnel();
  assert.equal(row.reason, 'landed');
  assert.equal(row.grossLamports, 15_000n); // net 9000 + base fee 5000 + tip 1000
  assert.equal(row.costLamports, 6_000n);
  const [t] = ledger.timings();
  assert.ok(t.detectedMs !== null && t.simulatedMs !== null && t.sentMs !== null && t.visibleMs !== null);
  assert.ok(t.simulatedMs! >= t.detectedMs! && t.sentMs! >= t.simulatedMs!);
  assert.equal(t.landedMs, 1_800_000_000_000);
});

test('funnel: unprofitable jobs record their shortfall; batching potential counts the ones sharing would rescue', async () => {
  // Net 1500 < minimum 2000: 500 short. Shared base fee + tip (6000) would make it 7500.
  const { a, ledger } = await run(1_500n);
  assert.equal(a.reason, 'unprofitable');
  const [row] = ledger.funnel();
  assert.equal(row.shortfallLamports, 500n);
  assert.deepEqual(ledger.batchingPotential(6_000n, 2_000n), { unprofitable: 1, rescuable: 1 });
  assert.deepEqual(ledger.batchingPotential(0n, 2_000n), { unprofitable: 1, rescuable: 0 });
});

test('funnel: shadow and unapproved are their own reasons', async () => {
  const { a } = await run(9_000n, { mode: 'shadow' });
  assert.equal(a.reason, 'shadow');
});

test('funnel stages add up from reason counts', () => {
  const st = funnelStages([
    { reason: 'gone_before_sim', n: 400 }, { reason: 'not_ready', n: 300 }, { reason: 'task_failing', n: 100 },
    { reason: 'unprofitable', n: 50 }, { reason: 'in_flight_limit', n: 6 }, { reason: 'lost_race', n: 3 }, { reason: 'landed', n: 4 },
  ]);
  assert.deepEqual(st, { looked: 863, simulated: 463, simOk: 63, profitable: 13, sent: 7, landed: 4 });
});

test('latency: medians per step, and who wins', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([1, 2, 3, 4]), 3); // rounds 2.5 up
  assert.equal(median([]), null);
  const row = (v: number, s: number, w: string | null) => ({ reasonCode: 'landed', visibleMs: v, detectedMs: v + 100, simulatedMs: v + 150, sentMs: s, landedMs: null, winnerMs: w ? v + 400 : null, winnerSigner: w });
  const l = latencyStats([row(0, 200, 'A'), row(1000, 1300, 'A'), row(5000, 5250, 'B')]);
  assert.equal(l.detectAfterVisible, 100);
  assert.equal(l.sentAfterVisible, 250);
  assert.equal(l.winnerAfterVisible, 400);
  assert.deepEqual(l.winners, [{ signer: 'A', n: 2 }, { signer: 'B', n: 1 }]);
});

test('ledger: an existing database from before Milestone 0 gains the new columns and keeps its rows', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'crumbs-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE attempts (id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, day TEXT NOT NULL, job_type TEXT NOT NULL,
    candidate_id TEXT NOT NULL, mode TEXT NOT NULL, outcome TEXT NOT NULL, verdict TEXT, reason TEXT, sim_net INTEGER, sim_gross INTEGER,
    sim_cost INTEGER, expected_reward INTEGER, units INTEGER, signature TEXT, realized_net INTEGER)`);
  old.exec(`INSERT INTO attempts (ts, day, job_type, candidate_id, mode, outcome, realized_net) VALUES (1, '2026-10-30', 'tuktuk.run_task', 'x', 'live', 'landed', 9000)`);
  old.close();
  const ledger = new Ledger(path);
  assert.equal(ledger.totals().landed, 1);
  const id = ledger.recordAttempt({ jobType: 'tuktuk.run_task', candidateId: 'y', mode: 'live', outcome: 'sent', reasonCode: 'landed', timing: { detectedMs: 5 } });
  ledger.setWinner(id, { signature: 's', signer: 'w', slot: 1 });
  assert.equal(ledger.timings()[0].winnerSigner, 'w');
});
