import { PublicKey } from '@solana/web3.js';

// Addresses verified against mainnet (Oct 30): owners/executable flags checked with getAccountInfo.
export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
export const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
export const TOKEN_2022_PROGRAM_ID = new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb');
export const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey, tokenProgram = TOKEN_PROGRAM_ID): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), tokenProgram.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
}

export const isTokenProgram = (owner: PublicKey) => owner.equals(TOKEN_PROGRAM_ID) || owner.equals(TOKEN_2022_PROGRAM_ID);

/** SPL token account fields we care about: mint (0..32), owner/authority (32..64), amount (64..72). */
export function readTokenAccount(data: Buffer): { mint: PublicKey; authority: PublicKey; amount: bigint } | undefined {
  if (data.length < 165) return undefined;
  return { mint: new PublicKey(data.subarray(0, 32)), authority: new PublicKey(data.subarray(32, 64)), amount: data.readBigUInt64LE(64) };
}
