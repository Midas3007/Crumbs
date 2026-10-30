import { Keypair, PublicKey, SystemProgram } from '@solana/web3.js';
import { type Config, loadConfig } from '../src/config.js';
import type { ApprovalRequest, Notifier } from '../src/core/notifier.js';
import type { BuiltJob, SimOutcome } from '../src/core/types.js';

export const AGENT = Keypair.generate();

export function testConfig(overrides: Partial<Config> = {}, env: Record<string, string> = {}): Config {
  const cfg = loadConfig({
    AGENT_SECRET_KEY: JSON.stringify([...AGENT.secretKey]),
    RPC_URL: 'http://localhost:0',
    DB_PATH: ':memory:',
    ...env,
  });
  return { ...cfg, ...overrides };
}

export function builtJob(expectedRewardLamports = 15_000n): BuiltJob {
  return {
    instructions: [SystemProgram.transfer({ fromPubkey: AGENT.publicKey, toPubkey: PublicKey.default, lamports: 0 })],
    lookupTables: [],
    expectedRewardLamports,
  };
}

/**
 * Real numbers from a mainnet TukTuk run_task (hpl-crons, reward 15000): fee 10150, payer delta +4850.
 * Override any field to build the other fixture cases.
 */
export function sim(overrides: Partial<SimOutcome> = {}): SimOutcome {
  return {
    err: null,
    logs: ['Program log: Paying out reward 15000'],
    unitsConsumed: 64_770,
    lamportsPre: 64_272_811n,
    lamportsPost: 64_272_811n + 4_850n,
    feeLamports: 10_150n,
    tipLamports: 0n,
    tokenDeltas: [],
    ...overrides,
  };
}

export class Recorder implements Notifier {
  alerts: string[] = [];
  approvals: ApprovalRequest[] = [];
  documents: { filename: string; content: string }[] = [];
  async alert(t: string) { this.alerts.push(t); }
  async requestApproval(r: ApprovalRequest) { this.approvals.push(r); }
  async sendDocument(filename: string, content: string) { this.documents.push({ filename, content }); }
}
