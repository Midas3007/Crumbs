import assert from 'node:assert/strict';
import { test } from 'node:test';
import { base58Encode } from '../src/core/base58.js';
import { Ledger } from '../src/core/ledger.js';
import { groupPaid, newGroups, paidCalls, paidScanText } from '../src/discovery/paidScan.js';

const CRANK = 'Crank1111111111111111111111111111111111111';
const disc = base58Encode(Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9]));

function tx(o: { net: number; payer?: string; program?: string; tokens?: [bigint, bigint]; err?: unknown; sig?: string }) {
  const payer = o.payer ?? 'Payer11111111111111111111111111111111111111';
  return {
    meta: {
      err: o.err ?? null, fee: 5000, preBalances: [1_000_000, 0], postBalances: [1_000_000 + o.net, 0],
      preTokenBalances: o.tokens ? [{ accountIndex: 1, owner: payer, uiTokenAmount: { amount: String(o.tokens[0]) } }] : [],
      postTokenBalances: o.tokens ? [{ accountIndex: 1, owner: payer, uiTokenAmount: { amount: String(o.tokens[1]) } }] : [],
      logMessages: ['Program log: Instruction: Crank'],
    },
    transaction: { signatures: [o.sig ?? 'sig'], message: { accountKeys: [payer, o.program ?? CRANK], instructions: [{ programIdIndex: 1, data: disc }] } },
  };
}

test('paid scan: keeps signers paid more than their fee; drops losses, failures, sales and trading programs', () => {
  const calls = paidCalls([
    tx({ net: 10_000 }),
    tx({ net: -5_000 }), // paid to call: not a chore
    tx({ net: 10_000, err: { x: 1 } }),
    tx({ net: 50_000, tokens: [100n, 0n] }), // sold a token for SOL
    tx({ net: 50_000, program: 'pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA' }), // PumpSwap
  ] as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].program, CRANK);
  assert.equal(calls[0].discriminator, '0102030405060708');
  assert.equal(calls[0].name, 'Crank');
});

test('paid scan: groups by program and instruction, reports only new patterns, once', () => {
  const calls = paidCalls([tx({ net: 10_000, payer: 'A1111111111111111111111111111111111111111111' }), tx({ net: 12_000, payer: 'B1111111111111111111111111111111111111111111' }), tx({ net: 8_000 })] as never);
  const groups = groupPaid(calls);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].calls, 3);
  assert.equal(groups[0].payers, 3);
  assert.equal(groups[0].medianNetLamports, 10_000);
  const ledger = new Ledger(':memory:');
  assert.equal(newGroups(ledger, groups).length, 1);
  assert.equal(newGroups(ledger, groups).length, 0);
  assert.match(paidScanText(100, groups, 1), /Crank on Crank111…: 3 calls by 3 wallets, median \+10,000 lamports/);
  assert.match(paidScanText(100, [], 4), /nothing new/);
});

test('paid scan: an instruction Crumbs already runs is not news', () => {
  const ore = 'oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv';
  const t = (sig: string) => ({ ...tx({ net: 10_000, program: ore, sig }), meta: { ...tx({ net: 10_000 }).meta, logMessages: ['Program log: Instruction: Checkpoint'] } });
  assert.equal(groupPaid(paidCalls([t('a'), t('b')] as never)).length, 0);
});
