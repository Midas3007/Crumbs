import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateProfit } from '../src/core/profitGuard.js';
import { USDC_MINT } from '../src/core/sweeper.js';
import { builtJob, sim, testConfig } from './helpers.js';

const caps = testConfig().caps; // min profit 2000, per-job cap 0.0002 SOL, anomaly 1.5x

test('real mainnet TukTuk run: +4850 net is profitable', () => {
  const d = evaluateProfit(sim(), builtJob(), caps);
  assert.equal(d.verdict, 'profitable');
  assert.equal(d.netLamports, 4_850n);
  assert.equal(d.grossRewardLamports, 15_000n); // net + fee = the documented reward
  assert.equal(d.costLamports, 10_150n);
});

test('fees and tips are counted: a tip that eats the profit is rejected', () => {
  // Same reward, but a 3000 lamport Jito tip inside the tx leaves 1850 < 2000 minimum.
  const d = evaluateProfit(sim({ lamportsPost: 64_272_811n + 1_850n, tipLamports: 3_000n }), builtJob(), caps);
  assert.equal(d.verdict, 'below_min_profit');
  assert.equal(d.netLamports, 1_850n);
  assert.equal(d.grossRewardLamports, 15_000n);
});

test('a job that loses money is rejected', () => {
  const d = evaluateProfit(sim({ lamportsPost: 64_272_811n - 5_000n, feeLamports: 5_000n }), builtJob(1n), caps);
  assert.equal(d.verdict, 'below_min_profit');
  assert.equal(d.netLamports, -5_000n);
});

test('a failed simulation is never sent', () => {
  const d = evaluateProfit(sim({ err: { InstructionError: [1, { Custom: 3012 }] } }), builtJob(), caps);
  assert.equal(d.verdict, 'simulation_failed');
  assert.equal(d.ok, false);
});

test('anomaly: paying far more than documented is flagged, not executed', () => {
  const d = evaluateProfit(sim({ lamportsPost: 64_272_811n + 1_000_000n }), builtJob(15_000n), caps);
  assert.equal(d.verdict, 'anomaly');
  assert.equal(d.ok, false);
});

test('anomaly threshold: exactly 1.5x documented is fine, a lamport more is not', () => {
  const at = evaluateProfit(sim({ lamportsPost: 64_272_811n + 22_500n - 10_150n }), builtJob(15_000n), caps);
  assert.equal(at.verdict, 'profitable');
  const over = evaluateProfit(sim({ lamportsPost: 64_272_811n + 22_501n - 10_150n }), builtJob(15_000n), caps);
  assert.equal(over.verdict, 'anomaly');
});

test('unknown balance effects are rejected', () => {
  const d = evaluateProfit(sim({ tokenDeltas: [{ mint: 'SomeMint1111111111111111111111111111111111', decimals: 6, pre: 0n, post: 5n }] }), builtJob(), caps);
  assert.equal(d.verdict, 'unknown_balance_effect');
});

test('token rewards are valued with the price book (e.g. a USDC reward)', () => {
  // 0.50 USDC reward, SOL wallet only paid the 5000 fee. USDC priced at 5,000,000 lamports (SOL = $200).
  const prices = new Map([[USDC_MINT, 5_000_000]]);
  const d = evaluateProfit(sim({
    lamportsPost: 64_272_811n - 5_000n, feeLamports: 5_000n,
    tokenDeltas: [{ mint: USDC_MINT, decimals: 6, pre: 1_000_000n, post: 1_500_000n }],
  }), builtJob(2_500_000n), caps, prices);
  assert.equal(d.verdict, 'profitable');
  assert.equal(d.netLamports, 2_495_000n);
});

test('per-job spend cap: a job whose fees exceed the cap is skipped', () => {
  const d = evaluateProfit(sim({ feeLamports: 300_000n, lamportsPost: 64_272_811n + 100_000n }), builtJob(400_000n), caps);
  assert.equal(d.verdict, 'over_job_spend_cap');
});
