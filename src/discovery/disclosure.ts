import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { JobCandidate } from './classify.js';
import type { ValidationResult } from './validate.js';

const big = (v: unknown) => (typeof v === 'bigint' ? v.toString() : v);

const FIXES: Record<NonNullable<ValidationResult['anomaly']>['kind'], string> = {
  third_party_funds:
    'An account owned by a third-party wallet lost value when an arbitrary caller invoked this instruction. '
    + 'Check that every account debited is constrained to the signer or to a protocol PDA (Anchor `has_one`, '
    + '`constraint = x.owner == signer.key()`, or PDA seeds that include the signer), and that the instruction '
    + 'cannot be pointed at another user\'s accounts.',
  pays_more_than_history:
    'An arbitrary caller is paid far more than recent callers. Check how the reward is computed: cap it '
    + '(e.g. at a fixed keeper fee or a share of the actual work done), verify it uses up-to-date state '
    + '(stale oracle or accumulator values), and make sure the same reward can\'t be claimed twice.',
};

/**
 * A responsible-disclosure draft for a too-good-to-be-true simulation. Crumbs never executes these;
 * the owner reviews the draft and sends it to the protocol's bug bounty program.
 */
export function draftDisclosure(c: JobCandidate, v: ValidationResult, agent: string, now = new Date()): { filename: string; markdown: string } {
  if (!v.anomaly) throw new Error('no anomaly to disclose');
  const a = v.anomaly;
  const attempt = v.attempts.find(x => x.replayedSignature === a.replayedSignature) ?? v.attempts.at(-1);
  const md = `# Possible vulnerability: \`${c.programName}::${c.instruction}\`

*Draft prepared by Crumbs on ${now.toISOString()} for responsible disclosure. **This transaction was only simulated; it was never sent on mainnet.***

| | |
|---|---|
| Program | \`${c.program}\` (${c.programName}) |
| Instruction | \`${c.instruction}\` |
| Finding | ${a.kind === 'third_party_funds' ? 'Calling it moves funds belonging to third-party wallets' : 'Calling it pays the caller far more than recent callers received'} |
| Detail | ${a.detail} |
| Reference transaction | [\`${a.replayedSignature}\`](https://solscan.io/tx/${a.replayedSignature}) — a real call, replayed with a different caller |

## What we observed

A recent successful call of \`${c.instruction}\` was replayed in simulation with a fresh wallet (\`${agent}\`) as the only signer.

- Simulated result for the caller: ${attempt ? `${attempt.decision.reason} (gross ${big(attempt.decision.grossRewardLamports)} lamports, fees ${big(attempt.decision.costLamports)})` : 'n/a'}
- What recent real callers earned (lamports, gross of fees): ${v.historicalGrossLamports.map(big).join(', ') || 'n/a'}
${attempt?.thirdPartyMovements.length ? `- Third-party accounts that lost value:\n${attempt.thirdPartyMovements.map(m => `  - \`${m.account}\` (${m.kind}, owner \`${m.owner}\`): ${big(m.delta)}`).join('\n')}` : ''}

What the protocol appears to intend (from its IDL, as read by our classifier): reward source "${c.rewardSource}"${c.documentedReward ? `, documented reward "${c.documentedReward}"` : ''}; trigger "${c.trigger}".

### Simulation logs (tail)

\`\`\`
${attempt?.logs.join('\n') ?? ''}
\`\`\`

## How to reproduce on a local fork

1. Clone the program and the accounts touched by the reference transaction into a local validator:
   \`\`\`bash
   solana-test-validator --url mainnet-beta --clone-upgradeable-program ${c.program} \\
     $(solana confirm -v ${a.replayedSignature} --url mainnet-beta | awk '/Account [0-9]+:/{print "--clone " $NF}') --reset
   \`\`\`
2. Rebuild the reference transaction's instructions, replacing the original signer with a new keypair (and its token accounts with the new keypair's associated token accounts).
3. Send it to the local validator and compare the new signer's balance change${a.kind === 'third_party_funds' ? ' and the third-party accounts listed above' : ' with the reward recent callers received'}.

## Suggested fix

${FIXES[a.kind]}

## Notes

- Found by an automated scan; it may be a false positive (for example, an intended reward that varies a lot with market conditions). Please treat it as a lead.
- We did not execute this on mainnet and will not.
`;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  return { filename: `${stamp}-${c.programName}-${c.instruction}.md`.replace(/[^\w.-]/g, '_'), markdown: md };
}

export function saveDisclosure(dir: string, d: { filename: string; markdown: string }): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, d.filename);
  writeFileSync(path, d.markdown);
  return path;
}
