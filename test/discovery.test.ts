import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { Keypair, PublicKey, SystemProgram, type Connection } from '@solana/web3.js';
import { Ledger } from '../src/core/ledger.js';
import { CreditWatch } from '../src/core/creditWatch.js';
import { TOKEN_PROGRAM_ID } from '../src/core/tokens.js';
import { type Classifier, type JobCandidate, parseCandidates, worthValidating } from '../src/discovery/classify.js';
import { draftDisclosure } from '../src/discovery/disclosure.js';
import { DiscoveryEngine, replaySpecFromLedger } from '../src/discovery/engine.js';
import { legacyDiscriminator, parseIdl } from '../src/discovery/idl.js';
import { screenInstruction, screenProgram } from '../src/discovery/prefilter.js';
import { fetchTxOrSkip, rewriteForAgent, thirdPartyMovements, type RecordedCall, type ValidationResult } from '../src/discovery/validate.js';
import { AGENT, Recorder, testConfig } from './helpers.js';

const PROGRAM = 'tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA';

// Shaped like the real TukTuk IDL (0.30+ spec) and a legacy one, trimmed.
const NEW_IDL = JSON.stringify({
  metadata: { name: 'tuktuk', spec: '0.1.0' },
  instructions: [
    { name: 'run_task_v0', discriminator: [52, 184, 39, 129, 126, 245, 176, 237], args: [{ name: 'args', type: 'bytes' }],
      accounts: [{ name: 'crank_turner', writable: true, signer: true }, { name: 'rent_refund', writable: true }, { name: 'task_queue', writable: true },
        { name: 'task', writable: true, relations: ['task_queue', 'rent_refund'] }, { name: 'system_program', address: '11111111111111111111111111111111' }] },
    { name: 'update_task_queue_v0', discriminator: [1, 2, 3, 4, 5, 6, 7, 8], args: [],
      accounts: [{ name: 'payer', writable: true, signer: true }, { name: 'update_authority', signer: true }, { name: 'task_queue', writable: true, relations: ['update_authority'] }] },
    { name: 'close_task_queue_v0', discriminator: [9, 9, 9, 9, 9, 9, 9, 9], args: [],
      accounts: [{ name: 'update_authority', signer: true }, { name: 'task_queue', writable: true, relations: ['update_authority'] }] },
  ],
});
const LEGACY_IDL = JSON.stringify({
  name: 'kamino_lending',
  instructions: [
    { name: 'refreshReserve', args: [], accounts: [{ name: 'reserve', isMut: true, isSigner: false }, { name: 'lendingMarket', isMut: false, isSigner: false }] },
    { name: 'liquidateObligation', args: [], accounts: [{ name: 'liquidator', isMut: false, isSigner: true }, { name: 'group', accounts: [{ name: 'obligation', isMut: true, isSigner: false }] }] },
  ],
});

test('IDL: both Anchor formats normalize, legacy discriminators are derived', () => {
  const n = parseIdl(PROGRAM, NEW_IDL);
  assert.equal(n.name, 'tuktuk');
  assert.deepEqual([...n.instructions[0].discriminator], [52, 184, 39, 129, 126, 245, 176, 237]);
  assert.equal(n.instructions[0].accounts[0].signer, true);

  const l = parseIdl('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', LEGACY_IDL);
  assert.equal(l.name, 'kamino_lending');
  assert.ok(l.instructions[1].discriminator.equals(legacyDiscriminator('liquidateObligation')));
  assert.deepEqual(l.instructions[1].accounts.map(a => a.name), ['liquidator', 'group.obligation']);
  // Anchor's global namespace uses snake_case: sha256("global:liquidate_obligation")
  assert.ok(legacyDiscriminator('liquidateObligation').equals(legacyDiscriminator('liquidate_obligation')));
});

test('screen: single unconstrained signer passes; admin-gated and multi-signer instructions are dropped', () => {
  const idl = parseIdl(PROGRAM, NEW_IDL);
  const run = screenInstruction(idl.instructions[0]);
  assert.ok(run && run.caller === 'crank_turner' && run.score >= 0.6);
  assert.equal(screenInstruction(idl.instructions[1]), undefined); // two signers
  assert.equal(screenInstruction(idl.instructions[2]), undefined); // signer is has_one-constrained
  const legacy = parseIdl('KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD', LEGACY_IDL);
  assert.equal(screenInstruction(legacy.instructions[0]), undefined); // no signer at all
  assert.deepEqual(screenProgram(legacy.instructions).map(s => s.ix.name), ['liquidateObligation']);
});

const candidate = (over: Partial<JobCandidate> = {}): JobCandidate => ({
  program: PROGRAM, programName: 'tuktuk', instruction: 'run_task_v0', permissionless: true, callerAccount: 'crank_turner',
  paysCaller: true, rewardSource: 'task crank_reward', documentedReward: null, trigger: 'task due', accountDerivationHints: [],
  harmsUsers: false, confidence: 0.9, evidence: ['Paying out reward'], ...over,
});

test('classifier output: unknown instruction names are dropped, confidence clamped', () => {
  const idl = parseIdl(PROGRAM, NEW_IDL);
  const text = JSON.stringify({ candidates: [
    { ...candidate(), confidence: 1.7, program: undefined, programName: undefined },
    { ...candidate({ instruction: 'drain_everything' }) },
  ] });
  const out = parseCandidates(idl, text);
  assert.equal(out.length, 1);
  assert.equal(out[0].confidence, 1);
  assert.equal(out[0].programName, 'tuktuk');
});

test('only permissionless, paying, harmless, confident candidates get validated', () => {
  assert.equal(worthValidating(candidate()), true);
  assert.equal(worthValidating(candidate({ harmsUsers: true })), false);
  assert.equal(worthValidating(candidate({ permissionless: false })), false);
  assert.equal(worthValidating(candidate({ paysCaller: false })), false);
  assert.equal(worthValidating(candidate({ confidence: 0.3 })), false);
});

test('replay rewrite: caller and caller token accounts become ours; signer flag only on our wallet', () => {
  const caller = Keypair.generate().publicKey;
  const callerUsdc = PublicKey.unique();
  const mint = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const other = PublicKey.unique();
  const call: RecordedCall = {
    signature: 'sig', slot: 1, caller, callerGrossLamports: 15_000n,
    callerTokenGains: [{ mint: mint.toBase58(), amount: 10n, decimals: 6 }],
    callerTokenAccounts: new Map([[callerUsdc.toBase58(), { mint, tokenProgram: TOKEN_PROGRAM_ID }]]),
    instructions: [{ programId: new PublicKey(PROGRAM), data: Buffer.from([1]), keys: [
      { pubkey: caller, isSigner: true, isWritable: true },
      { pubkey: callerUsdc, isSigner: false, isWritable: true },
      { pubkey: other, isSigner: false, isWritable: true },
    ] }],
  };
  const job = rewriteForAgent(call, AGENT.publicKey, 15_000n);
  const keys = job.instructions[0].keys;
  assert.ok(keys[0].pubkey.equals(AGENT.publicKey) && keys[0].isSigner);
  assert.ok(!keys[1].pubkey.equals(callerUsdc) && !keys[1].isSigner);
  assert.ok(keys[2].pubkey.equals(other) && !keys[2].isSigner);
  assert.equal(job.watchedTokenAccounts?.[0].mint, mint.toBase58());
  assert.equal(job.expectedRewardLamports, 15_000n);
});

function tokenData(authority: PublicKey, amount: bigint): Buffer {
  const b = Buffer.alloc(165);
  PublicKey.unique().toBuffer().copy(b, 0);
  authority.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(amount, 64);
  return b;
}

test('third-party guard: user wallets and user token accounts losing value are flagged; protocol vaults are not', () => {
  const user = Keypair.generate().publicKey; // on-curve: a real person
  const vaultAuthority = PublicKey.findProgramAddressSync([Buffer.from('vault')], new PublicKey(PROGRAM))[0]; // off-curve PDA
  const [wallet, userToken, vault, state] = [PublicKey.unique(), PublicKey.unique(), PublicKey.unique(), PublicKey.unique()];
  const pre = [
    { lamports: 5_000_000, owner: SystemProgram.programId, data: Buffer.alloc(0) },
    { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(user, 1_000n) },
    { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID, data: tokenData(vaultAuthority, 1_000n) },
    { lamports: 9_000_000, owner: new PublicKey(PROGRAM), data: Buffer.alloc(8) },
  ];
  const post = [
    { lamports: 4_000_000, owner: SystemProgram.programId.toBase58(), data: ['', 'base64'] },
    { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID.toBase58(), data: [tokenData(user, 400n).toString('base64'), 'base64'] },
    { lamports: 2_039_280, owner: TOKEN_PROGRAM_ID.toBase58(), data: [tokenData(vaultAuthority, 0n).toString('base64'), 'base64'] },
    { lamports: 0, owner: PROGRAM, data: ['', 'base64'] },
  ];
  const moves = thirdPartyMovements([wallet, userToken, vault, state], pre, post, AGENT.publicKey, new Set());
  assert.deepEqual(moves.map(m => [m.account, m.kind, m.delta]), [
    [wallet.toBase58(), 'wallet_lamports', -1_000_000n],
    [userToken.toBase58(), 'user_tokens', -600n],
  ]);
});

const validation = (status: ValidationResult['status'], extra: Partial<ValidationResult> = {}): ValidationResult => ({
  status, summary: `${status} summary`, historicalGrossLamports: [15_000n],
  attempts: [{ replayedSignature: '5abc', unitsConsumed: 60_000, logs: ['Program log: ok'], thirdPartyMovements: [],
    decision: { verdict: status === 'validated' ? 'profitable' : 'simulation_failed', ok: status === 'validated', netLamports: 4_850n, grossRewardLamports: 15_000n, costLamports: 10_150n, reason: 'net +4850 lamports' } }],
  ...extra,
});

test('disclosure draft names the finding, the evidence, fork steps and a fix — and says it was never executed', () => {
  const v = validation('anomaly', { anomaly: { kind: 'pays_more_than_history', replayedSignature: '5abc', detail: 'paid 5 SOL vs 15000 lamports' } });
  const d = draftDisclosure(candidate(), v, AGENT.publicKey.toBase58(), new Date('2026-11-01T00:00:00Z'));
  assert.match(d.markdown, /never sent on mainnet/);
  assert.match(d.markdown, /solana-test-validator/);
  assert.match(d.markdown, /## Suggested fix/);
  assert.match(d.markdown, /paid 5 SOL vs 15000 lamports/);
  assert.match(d.filename, /^2026-11-01.*tuktuk-run_task_v0\.md$/);
});

class StubClassifier implements Classifier {
  calls = 0;
  constructor(private out: JobCandidate[], private error?: Error) {}
  async classify() { this.calls++; if (this.error) throw this.error; return this.out; }
}

function engineWith(status: ValidationResult['status'], extra: Partial<ValidationResult> = {}, classifier = new StubClassifier([candidate()])) {
  const ledger = new Ledger(':memory:');
  const notifier = new Recorder();
  const dir = mkdtempSync(join(tmpdir(), 'crumbs-'));
  const sent: string[] = [];
  const engine = new DiscoveryEngine({} as Connection, testConfig(), ledger, notifier, classifier, {
    disclosureDir: dir,
    fetch: async () => parseIdl(PROGRAM, NEW_IDL),
    validate: async () => validation(status, extra),
    credits: new CreditWatch(async t => { sent.push(t); }),
  });
  return { engine, ledger, notifier, classifier, sent };
}

test('engine: a validated discovery asks for approval and can be rebuilt as a live job', async () => {
  const { engine, ledger, notifier } = engineWith('validated');
  const r = await engine.run([PROGRAM]);
  assert.equal(r.validated.length, 1);
  const type = `disc.${r.validated[0].id}`;
  assert.equal(ledger.jobTypeStatus(type), 'pending');
  assert.equal(notifier.approvals[0].jobType, type);
  assert.match(notifier.approvals[0].evidence ?? '', /Recent callers earned/);
  const spec = replaySpecFromLedger(ledger, r.validated[0].id)!;
  assert.equal(spec.callerIndex, 0);
  assert.deepEqual([...spec.discriminator], [52, 184, 39, 129, 126, 245, 176, 237]);
});

test('engine: an unchanged IDL is not classified twice (saves API credits)', async () => {
  const { engine, classifier } = engineWith('validated');
  await engine.run([PROGRAM]);
  await engine.run([PROGRAM]);
  assert.equal(classifier.calls, 1);
});

test('engine: paid-but-one-shot jobs become adapter proposals, not approvals', async () => {
  const { engine, notifier } = engineWith('paid_not_replayable');
  const r = await engine.run([PROGRAM]);
  assert.equal(r.proposals.length, 1);
  assert.equal(notifier.approvals.length, 0);
  assert.match(notifier.alerts[0], /needs a dedicated adapter/);
});

test('engine: an anomaly is never approved; a disclosure draft is saved and sent', async () => {
  const { engine, ledger, notifier } = engineWith('anomaly', { anomaly: { kind: 'third_party_funds', replayedSignature: '5abc', detail: 'user wallet -1 SOL' } });
  const r = await engine.run([PROGRAM]);
  assert.equal(r.anomalies.length, 1);
  assert.equal(notifier.approvals.length, 0);
  assert.equal(ledger.listJobTypes().length, 0);
  assert.match(notifier.alerts[0], /Anomaly guard/);
  assert.equal(notifier.documents.length, 1);
  assert.match(readFileSync(r.anomalies[0].disclosurePath, 'utf8'), /user wallet -1 SOL/);
});

test('engine: Claude out of credits stops the pass and alerts once', async () => {
  const err = new Anthropic.BadRequestError(400, undefined, 'Your credit balance is too low to access the Anthropic API.', new Headers());
  const { engine, sent } = engineWith('validated', {}, new StubClassifier([], err));
  const r = await engine.run([PROGRAM, 'KLend2g3cP87fffoy8q1mQqGKjrxjC8boSyAYavgmjD']);
  assert.equal(r.skipped.length, 1);
  assert.match(r.skipped[0].why, /out of credits/);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude API credits/);
});

test('engine: if validation fails mid-scan, the next run reuses the paid-for classification', async () => {
  const ledger = new Ledger(':memory:');
  const classifier = new StubClassifier([candidate()]);
  let fail = true;
  const engine = new DiscoveryEngine({} as Connection, testConfig(), ledger, new Recorder(), classifier, {
    fetch: async () => parseIdl(PROGRAM, NEW_IDL),
    validate: async () => { if (fail) throw new Error('rpc hiccup'); return validation('validated'); },
  });
  const first = await engine.run([PROGRAM]);
  assert.match(first.skipped[0].why, /rpc hiccup/);
  fail = false;
  const second = await engine.run([PROGRAM]);
  assert.equal(second.validated.length, 1);
  assert.equal(classifier.calls, 1); // Claude was asked once, not twice
});

test('fetchTxOrSkip: an undecodable (version 1) transaction is skipped, other errors still surface', async () => {
  const v1 = { getTransaction: async () => { throw new Error('failed to get transaction: Transaction version (1) is not supported by the requesting client'); } } as unknown as Connection;
  assert.equal(await fetchTxOrSkip(v1, 'sig'), null);
  const down = { getTransaction: async () => { throw new Error('fetch failed'); } } as unknown as Connection;
  await assert.rejects(fetchTxOrSkip(down, 'sig'), /fetch failed/);
});

test('Claude cost: computed from real token usage at Sonnet 5.5 prices', async () => {
  const { costUsd } = await import('../src/discovery/classify.js');
  // 10k input + 5k output + 2k cache read = 0.02 + 0.05 + 0.0004
  assert.equal(costUsd({ input_tokens: 10_000, output_tokens: 5_000, cache_read_input_tokens: 2_000, cache_creation_input_tokens: 0 }).toFixed(4), '0.0704');
});

test('engine: the daily Claude budget stops discovery for the day (classifications already paid for are free)', async () => {
  const ledger = new Ledger(':memory:');
  const classifier = new StubClassifier([candidate()]);
  (classifier as unknown as { lastCostUsd: number }).lastCostUsd = 0.2;
  const other = Keypair.generate().publicKey.toBase58();
  const engine = new DiscoveryEngine({} as Connection, testConfig(), ledger, new Recorder(), classifier, {
    dailyBudgetUsd: 0.25,
    fetch: async p => parseIdl(p.toBase58(), NEW_IDL),
    validate: async () => validation('unprofitable'),
  });
  const r = await engine.run([PROGRAM, other, Keypair.generate().publicKey.toBase58()]);
  assert.equal(classifier.calls, 2); // $0.20 spent after the first; the second fits under $0.25; then stop
  assert.match(r.skipped.at(-1)!.why, /daily Claude budget/);
  assert.equal(engine.spentTodayUsd().toFixed(2), '0.40');
});
