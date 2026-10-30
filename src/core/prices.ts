import { type Connection, PublicKey } from '@solana/web3.js';
import { USDC_MINT } from './tokens.js';

/**
 * SOL/USD straight from Pyth's on-chain price account, read over the RPC we already use —
 * no extra service, and anyone can verify the number. Verified Oct 30: owned by the Pyth receiver,
 * feed id ef0d8b6f… is SOL/USD.
 */
export const PYTH_SOL_USD_ACCOUNT = new PublicKey('7UVimffxr9ow1uXYxsr4LHAcV58mLzhmwaeKvJ1pjLiE');
const PYTH_RECEIVER = new PublicKey('rec5EKMGg6MxZYaMdyBfgwp4d5rB9T1VQH5pJv5LtFJ');
const SOL_USD_FEED = 'ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d';

export interface Price {
  usd: number;
  publishTime: number;
}

/** Decode a Pyth PriceUpdateV2 account (discriminator, write authority, verification level, price message). */
export function decodePythPrice(data: Buffer): { feedId: string; usd: number; publishTime: number } {
  let o = 8 + 32;
  const level = data[o++];
  if (level === 0) o++; // Partial { num_signatures: u8 }
  const feedId = data.subarray(o, o + 32).toString('hex');
  o += 32;
  const price = data.readBigInt64LE(o);
  const exponent = data.readInt32LE(o + 16);
  const publishTime = Number(data.readBigInt64LE(o + 20));
  return { feedId, usd: Number(price) * 10 ** exponent, publishTime };
}

export async function solUsd(conn: Connection): Promise<Price | undefined> {
  const info = await conn.getAccountInfo(PYTH_SOL_USD_ACCOUNT);
  if (!info || !info.owner.equals(PYTH_RECEIVER)) return undefined;
  const p = decodePythPrice(info.data);
  if (p.feedId !== SOL_USD_FEED || !(p.usd > 0)) return undefined;
  return { usd: p.usd, publishTime: p.publishTime };
}

/** Price book for the profit guard: lamports per whole token. USDC is pegged at $1. */
export function priceBook(solUsdPrice: number): Map<string, number> {
  return new Map([[USDC_MINT, 1e9 / solUsdPrice]]);
}
