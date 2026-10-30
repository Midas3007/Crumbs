// Debug one TukTuk task: build it and print the simulation logs.
//   AGENT_PUBKEY=<funded pubkey> npm run simulate-task -- <task address>
import { Connection } from '@solana/web3.js';
import { TuktukJob } from '../src/adapters/tuktuk/adapter.js';
import { loadConfig } from '../src/config.js';
import { measureUnits } from '../src/core/simulate.js';

const cfg = loadConfig();
const conn = new Connection(cfg.rpcUrl);
const task = process.argv[2];
if (!task) throw new Error('usage: simulate-task <task address>');
const job = new TuktukJob(conn, { minRewardLamports: 0n });
const built = await job.build({ id: task, jobType: job.type, description: '', data: { task } }, cfg.agentPubkey);
const { blockhash } = await conn.getLatestBlockhash();
const r = await measureUnits(conn, cfg.agentPubkey, built, blockhash);
console.log({ err: r.err, units: r.units, expectedReward: built.expectedRewardLamports });
console.log(r.logs.join('\n'));
