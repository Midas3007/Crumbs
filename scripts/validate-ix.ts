// Validate one instruction on mainnet without AI: replay recent real calls with our wallet as the caller.
//   AGENT_PUBKEY=<funded pubkey> npm run validate-ix -- <programId> <instructionName>
import { Connection, PublicKey } from '@solana/web3.js';
import { loadConfig } from '../src/config.js';
import { fetchIdl } from '../src/discovery/idl.js';
import { validateCandidate } from '../src/discovery/validate.js';

const [programArg, ixName] = process.argv.slice(2);
if (!programArg || !ixName) throw new Error('usage: validate-ix <programId> <instruction>');
const cfg = loadConfig();
const conn = new Connection(cfg.rpcUrl);
const program = new PublicKey(programArg);
const idl = await fetchIdl(conn, program);
if (!idl) throw new Error('program has no on-chain Anchor IDL');
const ix = idl.instructions.find(i => i.name === ixName);
if (!ix) throw new Error(`no instruction ${ixName}; have: ${idl.instructions.map(i => i.name).join(', ')}`);
const callerIndex = ix.accounts.findIndex(a => a.signer);
const result = await validateCandidate(conn, cfg.agentPubkey, program, ix.discriminator, callerIndex, cfg.caps, new Map(), { scan: 60, want: 3, delayMs: 250 });
console.log(JSON.stringify(result, (_k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
