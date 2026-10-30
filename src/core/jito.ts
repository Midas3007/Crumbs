import { PublicKey, SystemProgram, type TransactionInstruction, type VersionedTransaction } from '@solana/web3.js';
import { log } from './logger.js';

/** Jito's tip accounts as returned by getTipAccounts on Oct 30, 2026; used if the API can't be reached. */
const KNOWN_TIP_ACCOUNTS = [
  'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh', 'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
  '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT', 'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
  'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe', 'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
  '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5', 'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
];

/**
 * Sends transactions as Jito bundles. A bundle only lands if its transaction succeeds, so losing a race
 * (someone else ran the task first) costs nothing — no fee for a failed transaction. We pay only when we win:
 * the normal fee plus a small tip, which the profit guard counts like any other cost.
 */
export class JitoClient {
  private tips?: { list: PublicKey[]; at: number };

  constructor(private url = 'https://mainnet.block-engine.jito.wtf/api/v1', private fetchFn: typeof fetch = fetch) {}

  private async rpc<T>(path: string, method: string, params: unknown[]): Promise<T> {
    const res = await this.fetchFn(`${this.url}/${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(8_000),
    });
    const body = await res.json() as { result?: T; error?: { message: string } };
    if (body.error || body.result === undefined) throw new Error(`jito ${method}: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  }

  async tipAccount(): Promise<PublicKey> {
    if (!this.tips || Date.now() - this.tips.at > 3_600_000) {
      try {
        const list = await this.rpc<string[]>('getTipAccounts', 'getTipAccounts', []);
        this.tips = { list: list.map(a => new PublicKey(a)), at: Date.now() };
      } catch (e) {
        log.debug('jito tip accounts unavailable; using the known list', { error: String(e) });
        this.tips = { list: KNOWN_TIP_ACCOUNTS.map(a => new PublicKey(a)), at: Date.now() };
      }
    }
    // Spread tips across accounts, as Jito recommends.
    return this.tips.list[Math.floor(Math.random() * this.tips.list.length)];
  }

  async tipInstruction(from: PublicKey, lamports: bigint): Promise<TransactionInstruction> {
    return SystemProgram.transfer({ fromPubkey: from, toPubkey: await this.tipAccount(), lamports: Number(lamports) });
  }

  /** Submit a signed transaction as a one-transaction bundle; returns the bundle id. */
  async sendBundle(tx: VersionedTransaction): Promise<string> {
    return this.rpc<string>('bundles', 'sendBundle', [[Buffer.from(tx.serialize()).toString('base64')], { encoding: 'base64' }]);
  }
}
