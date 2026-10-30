// Print the agent's private key as a base58 string, the format Phantom / Solflare / Backpack
// accept under "Import private key". Use it once to make an offline backup, then clear the screen.
//   npm run export-key
import { readFileSync } from 'node:fs';
import { Keypair } from '@solana/web3.js';

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58(bytes: Uint8Array): string {
  let n = BigInt('0x' + Buffer.from(bytes).toString('hex'));
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 58n)] + out;
    n /= 58n;
  }
  for (const b of bytes) {
    if (b !== 0) break;
    out = '1' + out;
  }
  return out;
}

const path = process.argv[2] ?? 'keys/agent.json';
const kp = Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(path, 'utf8')) as number[]));
console.log(`Address:     ${kp.publicKey.toBase58()}`);
console.log(`Private key: ${base58(kp.secretKey)}`);
console.log('\nAnyone with the private key controls this wallet. Write it down or store it in a password manager,');
console.log('never in a screenshot, chat or cloud note. Then run `clear`.');
