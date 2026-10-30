import Anthropic from '@anthropic-ai/sdk';
import type { ProgramIdl } from './idl.js';
import type { ScreenedInstruction } from './prefilter.js';

/** What the AI thinks an instruction is. Only a hypothesis: validate.ts proves or disproves it. */
export interface JobCandidate {
  program: string;
  programName: string;
  instruction: string;
  permissionless: boolean;
  /** Name of the IDL account the caller signs as. */
  callerAccount: string;
  paysCaller: boolean;
  /** Where the reward comes from, e.g. "task account lamports (crank_reward)". */
  rewardSource: string;
  /** The reward as documented in the IDL/docs, if stated, e.g. "15000 lamports per task". */
  documentedReward: string | null;
  /** What makes the instruction callable, e.g. "task trigger timestamp has passed". */
  trigger: string;
  accountDerivationHints: string[];
  /** Could calling this harm users (front-running, moving their funds)? Then it's never a job. */
  harmsUsers: boolean;
  confidence: number;
  evidence: string[];
}

export interface Classifier {
  classify(idl: ProgramIdl, screened: ScreenedInstruction[], docs?: string): Promise<JobCandidate[]>;
}

export const DISCOVERY_MODEL = 'claude-sonnet-5-5';

const SYSTEM = `You audit Solana programs for paid, permissionless chores ("keeper jobs").

A keeper job is an instruction the protocol DESIGNED for anyone to call, that pays the caller for doing it:
crank incentives, keeper fees, liquidation bonuses, settlement rewards, filler rewards, or rent refunds that go to the caller by design.

You receive one program's Anchor IDL instructions (pre-screened to those with a single signer) and optional docs.
For each instruction decide:
- permissionless: can any wallet be the signer? (false if the signer must be an admin, owner, user, or is checked against stored state)
- paysCaller: does executing it transfer value to the signer (or to an account the signer controls)? Base this on the IDL: account names, docs, args, and well-known protocol mechanics. If nothing suggests a payment, say false.
- harmsUsers: would calling it act against users — front-running, sandwiching, moving a user's funds outside a documented keeper/liquidation flow, or closing accounts whose rent should go to their owner? Liquidations of unhealthy positions done through the protocol's own liquidation instruction are NOT harmful.
- trigger: the on-chain condition that makes the call succeed.
- rewardSource / documentedReward: where the payment comes from, and the amount only if the IDL or docs state it (else null).
- accountDerivationHints: how a bot would find the accounts (PDA seeds, which program-owned accounts to scan, what to watch).
- confidence: 0..1 that this is a real paid keeper job. Be conservative; most instructions are not.
- evidence: short quotes or facts from the input that support the verdict.

Return every instruction you were given, including the ones that are not jobs. Never invent accounts or rewards not supported by the input.`;

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['candidates'],
  properties: {
    candidates: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['instruction', 'permissionless', 'callerAccount', 'paysCaller', 'rewardSource', 'documentedReward', 'trigger', 'accountDerivationHints', 'harmsUsers', 'confidence', 'evidence'],
        properties: {
          instruction: { type: 'string' },
          permissionless: { type: 'boolean' },
          callerAccount: { type: 'string' },
          paysCaller: { type: 'boolean' },
          rewardSource: { type: 'string' },
          documentedReward: { type: ['string', 'null'] },
          trigger: { type: 'string' },
          accountDerivationHints: { type: 'array', items: { type: 'string' } },
          harmsUsers: { type: 'boolean' },
          confidence: { type: 'number' },
          evidence: { type: 'array', items: { type: 'string' } },
        },
      },
    },
  },
} as const;

/** Compact view of the screened instructions; the full IDL can be huge. */
export function describeForModel(idl: ProgramIdl, screened: ScreenedInstruction[], docs?: string): string {
  const ixs = screened.map(s => ({
    name: s.ix.name,
    docs: s.ix.docs,
    signer: s.caller,
    accounts: s.ix.accounts.map(a => ({
      name: a.name,
      ...(a.signer ? { signer: true } : {}),
      ...(a.writable ? { writable: true } : {}),
      ...(a.pda ? { pda: true } : {}),
      ...(a.address ? { address: a.address } : {}),
      ...(a.relations.length ? { has_one: a.relations } : {}),
      ...(a.docs.length ? { docs: a.docs } : {}),
    })),
    args: s.ix.args,
  }));
  return [
    `Program: ${idl.name} (${idl.programId})`,
    `Instructions (${screened.length} of ${idl.instructions.length}, pre-screened to a single signer):`,
    JSON.stringify(ixs),
    docs ? `\nProtocol docs:\n${docs}` : '',
  ].join('\n');
}

/** Claude-backed classifier. Never in the execution path — it only proposes candidates. */
export class ClaudeClassifier implements Classifier {
  private client: Anthropic;

  constructor(apiKey?: string, private model = DISCOVERY_MODEL) {
    this.client = new Anthropic(apiKey ? { apiKey } : {});
  }

  async classify(idl: ProgramIdl, screened: ScreenedInstruction[], docs?: string): Promise<JobCandidate[]> {
    if (screened.length === 0) return [];
    const response = await this.client.beta.messages.create({
      model: this.model,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
      messages: [{ role: 'user', content: describeForModel(idl, screened, docs) }],
    });
    if (response.stop_reason === 'refusal') throw new Error(`classifier refused: ${response.stop_details?.explanation ?? 'no detail'}`);
    if (response.stop_reason === 'max_tokens') throw new Error('classifier output truncated');
    const text = response.content.flatMap(b => (b.type === 'text' ? [b.text] : [])).join('');
    return parseCandidates(idl, text);
  }
}

export function parseCandidates(idl: ProgramIdl, text: string): JobCandidate[] {
  const parsed = JSON.parse(text) as { candidates: Omit<JobCandidate, 'program' | 'programName'>[] };
  const known = new Set(idl.instructions.map(i => i.name));
  return parsed.candidates
    .filter(c => known.has(c.instruction)) // never trust an instruction name the IDL doesn't have
    .map(c => ({ ...c, program: idl.programId, programName: idl.name, confidence: Math.max(0, Math.min(1, c.confidence)) }));
}

/** The AI's hypothesis is worth testing on-chain. */
export const worthValidating = (c: JobCandidate, minConfidence = 0.5) =>
  c.permissionless && c.paysCaller && !c.harmsUsers && c.confidence >= minConfidence;

/**
 * No-AI fallback: treat well-scoring screened instructions as hypotheses and let on-chain validation
 * decide. Useful without an API key and for testing; much noisier than the Claude classifier.
 */
export class HeuristicClassifier implements Classifier {
  constructor(private minScore = 0.6) {}

  async classify(idl: ProgramIdl, screened: ScreenedInstruction[]): Promise<JobCandidate[]> {
    return screened.filter(s => s.score >= this.minScore).map(s => ({
      program: idl.programId,
      programName: idl.name,
      instruction: s.ix.name,
      permissionless: true,
      callerAccount: s.caller,
      paysCaller: true,
      rewardSource: 'unknown (heuristic: not read by AI)',
      documentedReward: null,
      trigger: 'unknown',
      accountDerivationHints: [],
      harmsUsers: false,
      confidence: s.score,
      evidence: s.reasons,
    }));
  }
}
