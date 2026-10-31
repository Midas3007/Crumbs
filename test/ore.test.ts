import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ComputeBudgetProgram, type Connection, PublicKey, SystemProgram, TransactionMessage, VersionedTransaction } from '@solana/web3.js';
import { batches, checkpointInstruction, claimable, ORE_BATCH, ORE_PROGRAM_ID, OreCheckpointJob, roundAddress } from '../src/adapters/ore/adapter.js';
import { JobGone } from '../src/core/types.js';

const AGENT = new PublicKey('G3ZwBYGoMXGgt4wunRjWSNkyB3J9sgUPxNq8CFRxeKbV');
const TWELVE_H = 144_000n;

test('ore: a bounty is claimable only in the last 12 h before the round expires', () => {
  const exp = 1_000_000n;
  assert.equal(claimable({ fee: 10_000n }, exp, exp - TWELVE_H - 1n), false); // too early: only the miner may
  assert.equal(claimable({ fee: 10_000n }, exp, exp - TWELVE_H), true);
  assert.equal(claimable({ fee: 10_000n }, exp, exp - 1_000n), true);
  assert.equal(claimable({ fee: 10_000n }, exp, exp - 100n), false); // too close to expiry
  assert.equal(claimable({ fee: 0n }, exp, exp - 1_000n), false); // fee already taken
  assert.equal(claimable({ fee: 10_000n }, null, 5n), false); // round closed
});

test('ore: checkpoint instruction matches the program (discriminator 2, 8 accounts, round PDA)', () => {
  const authority = PublicKey.unique();
  const ix = checkpointInstruction(AGENT, authority, PublicKey.unique(), 458_719n);
  assert.deepEqual([...ix.data], [2]);
  assert.equal(ix.keys.length, 8);
  assert.ok(ix.keys[0].isSigner && ix.keys[0].pubkey.equals(AGENT));
  assert.ok(ix.keys.slice(1).every(k => !k.isSigner));
  assert.ok(ix.keys[5].pubkey.equals(roundAddress(458_719n)));
  assert.ok(ix.programId.equals(ORE_PROGRAM_ID));
});

test(`ore: a full batch of ${ORE_BATCH} plus the Jito tip fits in one transaction`, () => {
  const ixs = Array.from({ length: ORE_BATCH }, (_, i) => checkpointInstruction(AGENT, PublicKey.unique(), PublicKey.unique(), 458_000n + BigInt(i)));
  const msg = new TransactionMessage({ payerKey: AGENT, recentBlockhash: '11111111111111111111111111111111', instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }), ...ixs,
    SystemProgram.transfer({ fromPubkey: AGENT, toPubkey: PublicKey.unique(), lamports: 1000 }),
  ] }).compileToV0Message();
  const bytes = new VersionedTransaction(msg).serialize().length;
  assert.ok(bytes <= 1232, `${bytes} bytes`);
});

function minerData(authority: PublicKey, checkpointId: bigint, fee: bigint, round: bigint): Buffer {
  const d = Buffer.alloc(672 + 64);
  d[0] = 103;
  authority.toBuffer().copy(d, 8);
  d.writeBigUInt64LE(checkpointId, 48);
  d.writeBigUInt64LE(fee, 56);
  d.writeBigUInt64LE(round, 664);
  return d;
}

test('ore: build re-reads miners, drops the ones settled meanwhile, and expects their fees as the reward', async () => {
  const a = PublicKey.unique(), b = PublicKey.unique();
  const datas = [minerData(a, 1n, 10_000n, 5n), minerData(b, 5n, 10_000n, 5n)]; // b already checkpointed round 5
  const conn = { getMultipleAccountsInfo: async () => datas.map(data => ({ data })) } as unknown as Connection;
  const job = new OreCheckpointJob(conn, 'http://unused');
  const c = { id: 'x', jobType: job.type, description: '', data: [{ miner: PublicKey.unique().toBase58(), round: '5', fee: '10000' }, { miner: PublicKey.unique().toBase58(), round: '5', fee: '10000' }] };
  const built = await job.build(c, AGENT);
  assert.equal(built.instructions.length, 1);
  assert.ok(built.instructions[0].keys[1].pubkey.equals(a));
  assert.equal(built.expectedRewardLamports, 10_000n);

  const allDone = { getMultipleAccountsInfo: async () => [{ data: minerData(a, 5n, 10_000n, 5n) }] } as unknown as Connection;
  await assert.rejects(new OreCheckpointJob(allDone, 'x').build({ ...c, data: [c.data[0]] }, AGENT), JobGone);
});

test('ore: patient by default (full batches, or within 4 h of expiry); greedy claims everything at once', () => {
  const slot = 1_000_000n;
  const far = (n: number) => Array.from({ length: n }, (_, i) => ({ id: i, expiresAt: slot + 100_000n + BigInt(i) }));
  assert.deepEqual(batches(far(3), slot, 5, false).map(b => b.length), []); // wait for more
  assert.deepEqual(batches(far(7), slot, 5, false).map(b => b.length), [5]); // full batch goes, 2 wait
  const soon = [...far(2), { id: 99, expiresAt: slot + 30_000n }]; // ~3.3 h left
  const [b] = batches(soon, slot, 5, false);
  assert.equal(b.length, 3);
  assert.equal(b[0].id, 99);
  assert.deepEqual(batches(far(1), slot, 5, true).map(b => b.length), [1]);
  assert.deepEqual(batches(far(7), slot, 5, true).map(b => b.length), [5, 2]);
});

test('ore: a held bounty claimed by someone else switches to claiming at once for 24 h', () => {
  let now = 0;
  const job = new OreCheckpointJob({} as Connection, 'x', { now: () => now });
  const m = (miner: string) => ({ miner, round: 5n, fee: 10_000n });
  job.noteScan([m('a'), m('b')]);
  (job as unknown as { held: Map<string, bigint> }).held.set('a', 5n);
  (job as unknown as { held: Map<string, bigint> }).held.set('b', 5n);
  job.noteScan([m('b')]); // 'a' vanished while we held it
  assert.equal(job.lostWhileHolding, 1);
  assert.equal(job.greedy, true);
  now += 24 * 3_600_000 + 1;
  assert.equal(job.greedy, false);
});

test('ore: our own claims of held bounties are not counted as lost', async () => {
  let now = 0;
  const conn = { getSlot: async () => 1_000_000 } as unknown as Connection;
  const job = new OreCheckpointJob(conn, 'x', { now: () => now, scanMs: 1e12 });
  const priv = job as unknown as { scannedAt: number; expiries: Map<bigint, bigint | null> };
  const miners = ['a', 'b', 'c', 'd', 'e', 'f'].map(miner => ({ miner, round: 5n, fee: 10_000n }));
  job.noteScan(miners);
  priv.expiries.set(5n, 1_000_000n + 100_000n);
  const [batch] = await job.detect(); // 5 go now, 1 is held
  assert.equal((batch.data as unknown[]).length, 5);
  job.noteScan([miners[5]]); // the 5 we claimed are gone; the held one is still there
  assert.equal(job.lostWhileHolding, 0);
  assert.equal(job.greedy, false);
});
