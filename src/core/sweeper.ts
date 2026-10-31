import {
  type Connection, type Keypair, PublicKey, TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import { type Config, formatSol } from '../config.js';
import type { Ledger } from './ledger.js';
import { log } from './logger.js';

import { ATA_PROGRAM_ID, associatedTokenAddress, TOKEN_PROGRAM_ID, USDC_MINT, WSOL_MINT } from './tokens.js';

export { USDC_MINT, WSOL_MINT };

/**
 * How much SOL to convert to USDC now: what's owed (a share of earnings, carried over between
 * sweeps), as long as the wallet keeps `solFloat` for fees and the amount is worth a swap. Pure.
 */
export function sweepAmount(owed: bigint, balance: bigint, solFloat: bigint, minSweep: bigint): bigint {
  const room = balance - solFloat;
  const amount = owed < room ? owed : room;
  return amount >= minSweep ? amount : 0n;
}

/** Add `fraction` of new earnings to what's owed; losses reduce it, never below zero. */
export function addOwed(owed: bigint, earned: bigint, fraction: number): bigint {
  const next = owed + (earned * BigInt(Math.round(fraction * 10_000))) / 10_000n;
  return next > 0n ? next : 0n;
}

/**
 * Earnings arrive in SOL; the owner wants most of them in USDC so they don't swing with SOL's price.
 * `fraction` (¾ by default) of every lamport earned is owed to USDC; once enough has built up to be
 * worth a swap's fee, it's swapped via Jupiter. The other ¼ stays SOL to pay fees. Live mode only.
 * USDC stays in the agent's wallet unless COLD_WALLET is set.
 */
export class Sweeper {
  constructor(private conn: Connection, private cfg: Config, private signer: Keypair, private alert: (t: string) => Promise<void>, private ledger?: Ledger) {}

  /** Bring what's owed up to date with earnings since the last check. */
  owed(now = Date.now()): bigint {
    if (!this.ledger) return 0n;
    const since = Number(this.ledger.getState('sweep_checked_at') ?? now);
    const owed = addOwed(BigInt(this.ledger.getState('sweep_owed') ?? '0'), this.ledger.realizedSince(since, now), this.cfg.sweep.fraction);
    this.ledger.setState('sweep_checked_at', String(now));
    this.ledger.setState('sweep_owed', owed.toString());
    return owed;
  }

  async maybeSweep(): Promise<string | undefined> {
    const { solFloatLamports, minSweepLamports, jupiterApiUrl } = this.cfg.sweep;
    const owed = this.owed();
    const balance = BigInt(await this.conn.getBalance(this.signer.publicKey, 'confirmed'));
    const amount = sweepAmount(owed, balance, solFloatLamports, minSweepLamports);
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
    this.ledger?.setState('sweep_owed', (owed - amount).toString());

    if (this.cfg.sweep.coldWallet) await this.sendUsdcToCold();
    await this.alert(`💵 Converted ${formatSol(amount)} of earnings (${Math.round(this.cfg.sweep.fraction * 100)}% share) → ~${usdc} USDC${this.cfg.sweep.coldWallet ? ' (sent to cold wallet)' : ''}\n${sig}`);
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
