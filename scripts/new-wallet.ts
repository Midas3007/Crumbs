// Create the agent's hot wallet on THIS device. The secret never leaves it.
//   npm run new-wallet            -> keys/agent.json (git-ignored), prints the public address
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

const path = process.argv[2] ?? 'keys/agent.json';
if (existsSync(path)) {
  console.error(`${path} already exists — refusing to overwrite a wallet.`);
  process.exit(1);
}
mkdirSync('keys', { recursive: true });
const kp = Keypair.generate();
writeFileSync(path, JSON.stringify([...kp.secretKey]), { mode: 0o600 });
console.log(`Saved ${path}`);
console.log(`Public address: ${kp.publicKey.toBase58()}`);
console.log('Put AGENT_KEYPAIR_PATH=' + path + ' in .env. Never share or commit this file.');
