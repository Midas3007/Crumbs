import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Features } from '../src/core/features.js';
import { Ledger } from '../src/core/ledger.js';

function setup(startMs = 1_000_000) {
  let now = startMs;
  const ledger = new Ledger(':memory:', () => now);
  const alerts: string[] = [];
  const f = new Features(ledger, [
    { name: 'batching', description: 'pack tasks', defaultOn: true },
    { name: 'new_sender', description: 'experimental', defaultOn: false },
  ], t => { alerts.push(t); }, { thresholdLamports: 20_000n }, () => now);
  return { f, ledger, alerts, tick: (ms: number) => { now += ms; } };
}

test('features: defaults, owner switches, and the switch survives a restart', () => {
  const { f, ledger } = setup();
  assert.equal(f.enabled('batching'), true);
  assert.equal(f.enabled('new_sender'), false);
  f.set('batching', false);
  const again = new Features(ledger, [{ name: 'batching', description: '', defaultOn: true }], () => {});
  assert.equal(again.enabled('batching'), false);
  assert.equal(again.status()[0].offReason, 'switched off by the owner');
});

test('circuit breaker: small wins and losses keep it on', async () => {
  const { f, alerts, tick } = setup();
  for (let i = 0; i < 60; i++) { await f.record('batching', i % 2 ? 9_000n : -6_000n); tick(1000); }
  assert.equal(f.enabled('batching'), true);
  assert.equal(alerts.length, 0);
  assert.equal(f.status()[0].sends, 60);
});

test('circuit breaker: losing more than the threshold over the first sends switches only that feature off and alerts', async () => {
  const { f, alerts, tick } = setup();
  for (let i = 0; i < 4; i++) { await f.record('batching', -6_000n); tick(1000); } // -24,000
  assert.equal(f.enabled('batching'), false);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /first 4 sends lost 24000/);
  assert.match(f.status()[0].offReason ?? '', /circuit breaker/);
  // Further sends don't alert again while it's off.
  await f.record('batching', -6_000n);
  assert.equal(alerts.length, 1);
});

test('circuit breaker: after the first 50, a losing hour trips it; old losses age out', async () => {
  const { f, alerts, tick } = setup();
  for (let i = 0; i < 50; i++) { await f.record('batching', 10_000n); tick(1000); }
  tick(3_600_000); // the profitable sends are now older than an hour
  await f.record('batching', -15_000n);
  assert.equal(f.enabled('batching'), true); // -15,000 < threshold
  tick(60_000);
  await f.record('batching', -15_000n); // -30,000 in the last hour
  assert.equal(f.enabled('batching'), false);
  assert.match(alerts[0], /last hour across 2 sends/);
});

test('circuit breaker: switching back on starts a fresh judgement', async () => {
  const { f, tick } = setup();
  for (let i = 0; i < 4; i++) { await f.record('batching', -6_000n); tick(1000); }
  assert.equal(f.enabled('batching'), false);
  tick(10_000);
  f.set('batching', true);
  await f.record('batching', -6_000n); // the earlier losses no longer count
  assert.equal(f.enabled('batching'), true);
});
