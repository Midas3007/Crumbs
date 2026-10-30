import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Ledger } from '../src/core/ledger.js';
import { ModeSwitch } from '../src/core/mode.js';
import { testConfig } from './helpers.js';

const notPaused = { paused: false, locked: false };

test('/live then restart: the saved mode wins over CRUMBS_MODE', () => {
  const ledger = new Ledger(':memory:');
  const cfg = testConfig({ mode: 'shadow' });
  new ModeSwitch(cfg, ledger).setLive();
  assert.equal(cfg.mode, 'live');
  const restarted = testConfig({ mode: 'shadow' });
  new ModeSwitch(restarted, ledger);
  assert.equal(restarted.mode, 'live');
});

test('/shadow persists too', () => {
  const ledger = new Ledger(':memory:');
  const cfg = testConfig({ mode: 'live' });
  new ModeSwitch(cfg, ledger).setShadow();
  const restarted = testConfig({ mode: 'live' });
  new ModeSwitch(restarted, ledger);
  assert.equal(restarted.mode, 'shadow');
});

test('cannot go live without the wallet key', () => {
  const ledger = new Ledger(':memory:');
  const cfg = testConfig({ mode: 'shadow', agentKeypair: undefined });
  const m = new ModeSwitch(cfg, ledger);
  assert.equal(m.canGoLive(m.checklist(50_000_000n, notPaused)), false);
  assert.throws(() => m.setLive());
});

test('checklist blocks on an empty or over-cap wallet and on the env kill switch', () => {
  const m = new ModeSwitch(testConfig(), new Ledger(':memory:'));
  assert.equal(m.canGoLive(m.checklist(50_000_000n, notPaused)), true); // 0.05 SOL: fine
  assert.equal(m.canGoLive(m.checklist(1_000n, notPaused)), false); // can't pay fees
  assert.equal(m.canGoLive(m.checklist(900_000_000n, notPaused)), false); // above the 0.5 SOL cap
  assert.equal(m.canGoLive(m.checklist(50_000_000n, { paused: true, locked: true })), false); // CRUMBS_PAUSED
  // A Telegram pause or no approved job types are warnings, not blockers.
  assert.equal(m.canGoLive(m.checklist(50_000_000n, { paused: true, locked: false, reason: 'x' })), true);
});
