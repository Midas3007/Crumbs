import assert from 'node:assert/strict';
import { test } from 'node:test';
import Anthropic from '@anthropic-ai/sdk';
import { CreditWatch, creditWatchingFetch, isClaudeCreditError } from '../src/core/creditWatch.js';

const LOW_CREDIT = 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.';

test('Claude: "credit balance is too low" is recognised; other errors are not', () => {
  assert.equal(isClaudeCreditError(new Anthropic.BadRequestError(400, undefined, LOW_CREDIT, new Headers())), true);
  assert.equal(isClaudeCreditError(new Anthropic.BadRequestError(400, undefined, 'messages: field required', new Headers())), false);
  assert.equal(isClaudeCreditError(new Anthropic.RateLimitError(429, undefined, 'rate limited', new Headers())), false);
  assert.equal(isClaudeCreditError(new Error('credit balance')), false);
});

test('one alert per service per cooldown, then a recovery message', async () => {
  const sent: string[] = [];
  let now = 0;
  const w = new CreditWatch(async t => { sent.push(t); }, 1000, () => now);
  await w.report('claude', LOW_CREDIT);
  await w.report('claude', LOW_CREDIT);
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Claude API credits/);
  assert.match(sent[0], /console\.anthropic\.com/);
  now = 2000;
  await w.report('claude', LOW_CREDIT);
  assert.equal(sent.length, 2);
  await w.recovered('claude');
  assert.match(sent[2], /working again/);
  await w.recovered('claude'); // already fine: no extra message
  assert.equal(sent.length, 3);
});

const respond = (status: number, body: string) => (async () => new Response(body, { status })) as unknown as typeof fetch;

test('RPC: quota responses alert, plain rate limits do not', async () => {
  const sent: string[] = [];
  const w = new CreditWatch(async t => { sent.push(t); });
  await creditWatchingFetch(w, respond(429, '{"error":"Too many requests"}'))('https://rpc');
  assert.equal(sent.length, 0);
  await creditWatchingFetch(w, respond(429, '{"error":"max usage reached, upgrade your plan"}'))('https://rpc');
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /RPC \(Helius\)/);
});

test('RPC: 401/402/403 alert; the response is still returned to web3.js intact', async () => {
  const sent: string[] = [];
  const w = new CreditWatch(async t => { sent.push(t); });
  const res = await creditWatchingFetch(w, respond(403, 'credits exhausted'))('https://rpc');
  assert.equal(await res.text(), 'credits exhausted');
  await new Promise(r => setImmediate(r));
  assert.equal(sent.length, 1);
  await creditWatchingFetch(w, respond(200, '{}'))('https://rpc');
  await new Promise(r => setImmediate(r));
  assert.match(sent[1], /working again/);
});
