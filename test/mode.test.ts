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

test('wallet key is read however it was pasted, and errors never echo it', async () => {
  const { Keypair } = await import('@solana/web3.js');
  const { parseSecretKey } = await import('../src/config.js');
  const kp = Keypair.generate();
  const arr = [...kp.secretKey];
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n = BigInt('0x' + Buffer.from(kp.secretKey).toString('hex')), b58 = '';
  while (n > 0n) { b58 = B58[Number(n % 58n)] + b58; n /= 58n; }
  for (const form of [JSON.stringify(arr), arr.join(','), `[${arr.join(', ')}]\n`, ` ${arr.join(',\n')} `, b58]) {
    assert.ok(parseSecretKey(form).publicKey.equals(kp.publicKey), form.slice(0, 12));
  }
  assert.throws(() => parseSecretKey(arr.slice(0, 40).join(',')), (e: Error) => /need 64/.test(e.message) && !e.message.includes(String(arr[0]) + ','));
  assert.throws(() => parseSecretKey('not a key!'), /format Crumbs can read/);
});
