import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/core/ledger.js';
import { decodePythPrice, priceBook } from '../src/core/prices.js';
import { USDC_MINT } from '../src/core/tokens.js';
import { buildSnapshot, shareText } from '../src/dashboard/snapshot.js';

// Pyth SOL/USD PriceUpdateV2 account (7UVimffx…), recorded from mainnet on Oct 30, 2026.
const PYTH_SOL_USD = 'IvEjY51+9M1gMUcENA3t3zcf1CRyFI8kjp0abRpesqw6zYt/1dayQwHvDYtv2izrpB2hXUCV0do5Kg0vjtDGx7wPTPrIwoC1beysvTMCAAAAYwFDAAAAAAD4////hPTkagAAAACD9ORqAAAAAPhD4DECAAAAssJJAAAAAACSDZ8bAAAAAAA=';

test('Pyth: decodes the real SOL/USD account', () => {
  const p = decodePythPrice(Buffer.from(PYTH_SOL_USD, 'base64'));
  assert.equal(p.feedId, 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d');
  assert.ok(p.usd > 10 && p.usd < 10_000, `price ${p.usd}`);
  assert.ok(p.publishTime > 1_790_000_000);
});

test('price book values 1 USDC in lamports from the SOL price', () => {
  assert.equal(priceBook(100).get(USDC_MINT), 10_000_000);
});

function ledgerWithActivity() {
  let now = Date.parse('2026-11-02T10:00:00Z');
  const l = new Ledger(':memory:', () => now);
  l.registerJobType('tuktuk.run_task', 'Helium TukTuk', 'x', 'y');
  l.setJobTypeStatus('tuktuk.run_task', 'approved');
  now = Date.parse('2026-11-01T10:00:00Z');
  l.recordAttempt({ jobType: 'tuktuk.run_task', candidateId: 'a', mode: 'shadow', outcome: 'shadow', verdict: 'profitable', simNetLamports: 5_000n });
  now = Date.parse('2026-11-02T10:00:00Z');
  for (const [net, outcome] of [[4_850n, 'landed'], [4_850n, 'landed'], [-10_150n, 'failed']] as const) {
    const id = l.recordAttempt({ jobType: 'tuktuk.run_task', candidateId: String(net) + outcome, mode: 'live', outcome: 'sent', simCostLamports: 10_150n, signature: 'sig' + net });
    l.settleAttempt(id, outcome, net);
  }
  l.recordAttempt({ jobType: 'tuktuk.run_task', candidateId: 'r', mode: 'live', outcome: 'rejected', verdict: 'below_min_profit', simNetLamports: 100n });
  return { l, now: new Date(now) };
}

test('snapshot: totals, win rate, daily series, job types and recent activity', () => {
  const { l, now } = ledgerWithActivity();
  const s = buildSnapshot(l, { mode: 'live', paused: { paused: false }, wallet: 'G3ZwBYGoMXGgt4wunRjWSNkyB3J9sgUPxNq8CFRxeKbV', solLamports: 25_000_000n, usdc: 1.5, solUsd: 94.32, now });
  assert.equal(s.totals.crumbs, 2);
  assert.equal(s.totals.losses, 1);
  assert.equal(s.totals.winRate, 2 / 3);
  assert.equal(s.totals.realizedNetLamports, String(4_850 * 2 - 10_150));
  assert.equal(s.totals.feesPaidLamports, String(3 * 10_150));
  assert.equal(s.totals.shadowNetLamports, '5000');
  assert.deepEqual(s.daily.map(d => d.day), ['2026-11-01', '2026-11-02']);
  assert.equal(s.jobTypes[0].crumbs, 2);
  assert.equal(s.recent.length, 4); // rejections are left out
  assert.ok(JSON.stringify(s)); // plain JSON: no bigints left
});

test('share text: tiny amounts keep every lamport; dollars shown when they mean something', () => {
  const { l, now } = ledgerWithActivity();
  const live = buildSnapshot(l, { mode: 'live', paused: { paused: false }, wallet: 'w', solLamports: 0n, usdc: 0, solUsd: 100, now });
  assert.equal(shareText(live), '🍞 Crumbs ate 2 crumbs today: -0.00000045 SOL, 1 losses.');
  const big = buildSnapshot(l, { mode: 'live', paused: { paused: false }, wallet: 'w', solLamports: 0n, usdc: 0, solUsd: 100_000, now });
  assert.match(shareText(big), /-0\.00000045 SOL \(~-\$0\.04\)/);
  // "Today" comes from the ledger's clock (Nov 2), which had no shadow finds; zero must not print as "+0".
  const shadow = buildSnapshot(l, { mode: 'shadow', paused: { paused: false }, wallet: 'w', solLamports: 0n, usdc: 0, solUsd: null, now });
  assert.equal(shareText(shadow), '🍞 Crumbs found 0 profitable crumbs today (shadow mode): would have earned 0 SOL.');
});
