import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Focus } from '../src/core/focus.js';

test('focus: keeps trying until it has lost 20 with no win; then only a probe every 30 min', () => {
  let now = 0;
  const f = new Focus(20, 86_400_000, 30 * 60_000, () => now);
  for (let i = 0; i < 19; i++) { assert.equal(f.worthTrying('q:compiled:due'), true); f.record('q:compiled:due', false); now += 1000; }
  f.record('q:compiled:due', false);
  assert.equal(f.worthTrying('q:compiled:due'), true); // the first probe
  assert.equal(f.worthTrying('q:compiled:due'), false);
  now += 30 * 60_000;
  assert.equal(f.worthTrying('q:compiled:due'), true); // next probe
  assert.deepEqual(f.summary(), [{ kind: 'q:compiled:due', won: 0, lost: 20, skipping: true }]);
});

test('focus: one win switches a kind back on; kinds we win are never skipped; losses age out after a day', () => {
  let now = 0;
  const f = new Focus(20, 86_400_000, 30 * 60_000, () => now);
  for (let i = 0; i < 30; i++) f.record('q:remote:due', false);
  f.record('q:remote:due', true);
  assert.equal(f.worthTrying('q:remote:due'), true);
  assert.equal(f.worthTrying('q:remote:due'), true);
  for (let i = 0; i < 25; i++) f.record('q:compiled:due', false);
  f.worthTrying('q:compiled:due'); // probe used
  assert.equal(f.worthTrying('q:compiled:due'), false);
  now += 86_400_001;
  assert.equal(f.worthTrying('q:compiled:due'), true);
});
