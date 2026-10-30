import {
  type Connection, type Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { type Config, formatSol } from '../config.js';
import { log } from './logger.js';

export const WSOL_MINT = 'So11111111111111111111111111111111111111112';
export const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');

/**
 * How much SOL to convert to USDC. Keeps `solFloat` for fees; skips tiny sweeps where the swap
 * fee would eat the value. Pure, so it's easy to test.
 */
export function sweepAmount(balance: bigint, solFloat: bigint, minSweep: bigint): bigint {
  const excess = balance - solFloat;
  return excess >= minSweep ? excess : 0n;
}

export function associatedTokenAddress(owner: PublicKey, mint: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID)[0];
}

/**
 * Earnings arrive in SOL; the owner wants USDC so they aren't exposed to SOL's price.
 * Swaps everything above the operating float to USDC via Jupiter, then (optionally) sends the
 * USDC to a cold wallet so the hot wallet stays small. Live mode only.
 */
export class Sweeper {
  constructor(private conn: Connection, private cfg: Config, private signer: Keypair, private alert: (t: string) => Promise<void>) {}

  async maybeSweep(): Promise<string | undefined> {
    const { solFloatLamports, minSweepLamports, jupiterApiUrl } = this.cfg.sweep;
    const balance = BigInt(await this.conn.getBalance(this.signer.publicKey, 'confirmed'));
    const amount = sweepAmount(balance, solFloatLamports, minSweepLamports);
    if (amount === 0n) return undefined;

    const quoteUrl = `${jupiterApiUrl}/quote?inputMint=${WSOL_MINT}&outputMint=${USDC_MINT}&amount=${amount}&slippageBps=50&restrictIntermediateTokens=true`;
    const quote = await (await fetch(quoteUrl, { signal: AbortSignal.timeout(10_000) })).json() as { outAmount?: string; error?: string };
    if (!quote.outAmount) throw new Error(`jupiter quote failed: ${quote.error ?? 'no route'}`);

    const swapRes = await fetch(`${jupiterApiUrl}/swap`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: this.signer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
      signal: AbortSignal.timeout(10_000),
    });
    const { swapTransaction } = await swapRes.json() as { swapTransaction?: string };
    if (!swapTransaction) throw new Error('jupiter swap build failed');

    const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
    const sim = await this.conn.simulateTransaction(tx, { sigVerify: false, commitment: 'processed' });
    if (sim.value.err) throw new Error(`swap simulation failed: ${JSON.stringify(sim.value.err)}`);
    tx.sign([this.signer]);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    const latest = await this.conn.getLatestBlockhash('confirmed');
    await this.conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    const usdc = (Number(quote.outAmount) / 1e6).toFixed(2);
    log.info('swept SOL to USDC', { sol: amount, usdc, signature: sig });

    if (this.cfg.sweep.coldWallet) await this.sendUsdcToCold();
    await this.alert(`💵 Swept ${formatSol(amount)} → ~${usdc} USDC${this.cfg.sweep.coldWallet ? ' (sent to cold wallet)' : ''}\n${sig}`);
    return sig;
  }

  private async sendUsdcToCold(): Promise<void> {
    const cold = this.cfg.sweep.coldWallet!;
    const mint = new PublicKey(USDC_MINT);
    const from = associatedTokenAddress(this.signer.publicKey, mint);
    const to = associatedTokenAddress(cold, mint);
    const bal = await this.conn.getTokenAccountBalance(from, 'confirmed');
    const amount = BigInt(bal.value.amount);
    if (amount === 0n) return;

    // Create the cold wallet's USDC account if needed (idempotent), then transfer_checked.
    const createAta = new TransactionInstruction({
      programId: ATA_PROGRAM_ID,
      keys: [
        { pubkey: this.signer.publicKey, isSigner: true, isWritable: true },
        { pubkey: to, isSigner: false, isWritable: true },
        { pubkey: cold, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('11111111111111111111111111111111'), isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      data: Buffer.from([1]),
    });
    const data = Buffer.alloc(10);
    data.writeUInt8(12, 0); // TransferChecked
    data.writeBigUInt64LE(amount, 1);
    data.writeUInt8(6, 9);
    const transfer = new TransactionInstruction({
      programId: TOKEN_PROGRAM_ID,
      keys: [
        { pubkey: from, isSigner: false, isWritable: true },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: to, isSigner: false, isWritable: true },
        { pubkey: this.signer.publicKey, isSigner: true, isWritable: false },
      ],
      data,
    });
    const latest = await this.conn.getLatestBlockhash('confirmed');
    const tx = new VersionedTransaction(new TransactionMessage({
      payerKey: this.signer.publicKey, recentBlockhash: latest.blockhash, instructions: [createAta, transfer],
    }).compileToV0Message());
    tx.sign([this.signer]);
    const sig = await this.conn.sendRawTransaction(tx.serialize(), { maxRetries: 3 });
    await this.conn.confirmTransaction({ signature: sig, ...latest }, 'confirmed');
    log.info('sent USDC to cold wallet', { amount, signature: sig });
  }
}
