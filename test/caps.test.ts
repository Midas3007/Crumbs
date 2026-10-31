import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Guardrails } from '../src/core/caps.js';
import { Ledger } from '../src/core/ledger.js';
import { addOwed, sweepAmount } from '../src/core/sweeper.js';
import { testConfig } from './helpers.js';

const caps = testConfig().caps; // wallet 0.5 SOL, daily loss 0.02 SOL, per-job 0.0002 SOL

function lose(ledger: Ledger, lamports: bigint) {
  const id = ledger.recordAttempt({ jobType: 't', candidateId: `c${Math.random()}`, mode: 'live', outcome: 'sent', simCostLamports: lamports });
  ledger.settleAttempt(id, 'failed', -lamports);
}

test('running normally: nothing blocks a send', () => {
  const g = new Guardrails(new Ledger(':memory:'), caps, false);
  assert.equal(g.checkBeforeSend(100_000_000n), undefined);
});

test('wallet cap: holding more than the cap pauses the agent', () => {
  const ledger = new Ledger(':memory:');
  const g = new Guardrails(ledger, caps, false);
  const reason = g.checkBeforeSend(600_000_000n);
  assert.match(reason ?? '', /cap/);
  assert.equal(g.state().paused, true);
});

test('daily loss cap: losses add up across the day and pause the agent', () => {
  const ledger = new Ledger(':memory:');
  const g = new Guardrails(ledger, caps, false);
  for (let i = 0; i < 3; i++) lose(ledger, 5_000_000n);
  assert.equal(g.checkAfterSend(-5_000_000n, 5_000n), undefined); // 0.015 lost: under the cap
  lose(ledger, 5_000_000n);
  assert.match(g.checkAfterSend(-5_000_000n, 5_000n) ?? '', /daily loss cap/); // 0.02 lost: cap hit
  assert.equal(g.state().paused, true);
  assert.match(g.checkBeforeSend(1_000_000n) ?? '', /paused/);
});

test('daily loss cap resets on a new UTC day', () => {
  let now = Date.parse('2026-11-01T23:59:00Z');
  const ledger = new Ledger(':memory:', () => now);
  const g = new Guardrails(ledger, caps, false);
  for (let i = 0; i < 4; i++) lose(ledger, 5_000_000n);
  assert.ok(g.checkBeforeSend(1_000_000n));
  g.resume();
  now = Date.parse('2026-11-02T00:01:00Z');
  assert.equal(g.checkBeforeSend(1_000_000n), undefined);
});

test('profits do not offset the loss cap: only losses count', () => {
  const ledger = new Ledger(':memory:');
  const g = new Guardrails(ledger, caps, false);
  const win = ledger.recordAttempt({ jobType: 't', candidateId: 'w', mode: 'live', outcome: 'sent' });
  ledger.settleAttempt(win, 'landed', 50_000_000n);
  for (let i = 0; i < 4; i++) lose(ledger, 5_000_000n);
  assert.match(g.checkBeforeSend(1_000_000n) ?? '', /daily loss cap/);
});

test('per-job spend cap: a job that actually spent more than the cap pauses', () => {
  const g = new Guardrails(new Ledger(':memory:'), caps, false);
  assert.match(g.checkAfterSend(-250_000n, 250_000n) ?? '', /per-job/);
  assert.equal(g.state().paused, true);
});

test('kill switch: /pause stops sends and /resume restarts them', () => {
  const g = new Guardrails(new Ledger(':memory:'), caps, false);
  g.pause('paused from Telegram');
  assert.match(g.checkBeforeSend(1n) ?? '', /paused from Telegram/);
  assert.equal(g.resume(), true);
  assert.equal(g.checkBeforeSend(1n), undefined);
});

test('kill switch: the env flag cannot be lifted from Telegram', () => {
  const g = new Guardrails(new Ledger(':memory:'), caps, true);
  assert.equal(g.state().locked, true);
  assert.equal(g.resume(), false);
  assert.match(g.checkBeforeSend(1n) ?? '', /CRUMBS_PAUSED/);
});

test('sweep: ¾ of earnings is owed to USDC; the float stays; dust waits', () => {
  // Earned 4,000,000 → 3,000,000 owed.
  assert.equal(addOwed(0n, 4_000_000n, 0.75), 3_000_000n);
  // A loss reduces what's owed, never below zero.
  assert.equal(addOwed(3_000_000n, -1_000_000n, 0.75), 2_250_000n);
  assert.equal(addOwed(100n, -1_000_000n, 0.75), 0n);
  // Owed 3,000,000, wallet 25,000,000, float 10,000,000, minimum 1,000,000 → swap all 3,000,000.
  assert.equal(sweepAmount(3_000_000n, 25_000_000n, 10_000_000n, 1_000_000n), 3_000_000n);
  // Not enough owed yet: wait.
  assert.equal(sweepAmount(900_000n, 25_000_000n, 10_000_000n, 1_000_000n), 0n);
  // The float caps it.
  assert.equal(sweepAmount(30_000_000n, 25_000_000n, 10_000_000n, 1_000_000n), 15_000_000n);
  assert.equal(sweepAmount(3_000_000n, 10_500_000n, 10_000_000n, 1_000_000n), 0n);
});
