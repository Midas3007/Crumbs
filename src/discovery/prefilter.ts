import type { IdlInstruction } from './idl.js';

/**
 * Cheap deterministic screen before any AI call: drop instructions that can't be permissionless.
 * A chore anyone can do has exactly one signer — the caller who pays the fee — and nothing in the
 * instruction is constrained to *be* that signer's property (a `has_one` on the signer means it
 * must be a specific account: an admin, an owner, a user).
 */

const CALLER_NAMES = /^(payer|caller|cranker|crank_?turner|keeper|liquidator|filler|signer|executor|relayer|operator|fee_?payer|crank|bot)$/i;
const PRIVILEGED_NAMES = /(admin|authority|owner|governance|guardian|manager|upgrade|lending_?market_?owner|user|depositor|borrower|trader|withdraw)/i;
const CHORE_WORDS = /(crank|keep|liquidat|settle|refresh|update|sync|poke|harvest|distribut|claim|process|consume|expire|close|clean|trigger|fill|rebalance|accrue|compound|run_?task|execute|requeue|payout|distribute|reward)/i;

export interface ScreenedInstruction {
  ix: IdlInstruction;
  caller: string;
  /** 0..1 — how much this looks like a paid chore before the AI looks at it. */
  score: number;
  reasons: string[];
}

export function screenInstruction(ix: IdlInstruction): ScreenedInstruction | undefined {
  const signers = ix.accounts.filter(a => a.signer && !a.optional);
  if (signers.length !== 1) return undefined;
  const caller = signers[0];
  if (caller.address || caller.pda) return undefined;
  const constrained = ix.accounts.some(a => a.relations.includes(caller.name));
  if (constrained) return undefined;

  const reasons: string[] = [`single signer "${caller.name}"`];
  let score = 0.3;
  const leaf = caller.name.split('.').pop() ?? caller.name;
  if (CALLER_NAMES.test(leaf)) { score += 0.3; reasons.push('signer named like a caller/payer'); }
  if (PRIVILEGED_NAMES.test(leaf)) { score -= 0.25; reasons.push('signer named like a privileged role'); }
  if (CHORE_WORDS.test(ix.name)) { score += 0.3; reasons.push('instruction named like a chore'); }
  if (ix.docs.some(d => /permissionless|anyone|keeper|crank|reward|incentiv/i.test(d))) { score += 0.2; reasons.push('docs mention permissionless/keeper/reward'); }
  return { ix, caller: caller.name, score: Math.max(0, Math.min(1, score)), reasons };
}

/** Keep instructions worth asking the AI about, best first. */
export function screenProgram(instructions: IdlInstruction[], minScore = 0.3, max = 25): ScreenedInstruction[] {
  return instructions
    .map(screenInstruction)
    .filter((s): s is ScreenedInstruction => s !== undefined && s.score >= minScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, max);
}
