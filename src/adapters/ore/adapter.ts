import { type Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import { log } from '../../core/logger.js';
import { type BuiltJob, type Candidate, type Job, JobGone } from '../../core/types.js';

/**
 * ORE v3 checkpoint bounties (github.com/regolith-labs/ore, program/src/checkpoint.rs).
 *
 * Every miner pre-pays a 10,000-lamport `checkpoint_fee`. If a miner hasn't settled ("checkpointed") a
 * round by the last 12 hours before that round's results expire, *anyone* may checkpoint it and collect
 * the fee: "If the round expires in less than 12h, anyone may checkpoint this account and collect the bot
 * fee." The same call pays the miner their own winnings, so it helps them too.
 *
 * Measured Oct 31: ~35k miners, ~90 unsettled at any time, 3 claimable and 3 already expired unclaimed
 * (little competition). Simulated with our wallet: 3 checkpoints in one transaction netted +25,000
 * lamports after the fee (67k compute units, 692 bytes), so several are packed per transaction.
 */
export const ORE_PROGRAM_ID = new PublicKey('oreV3EG1i9BEgiAJ8b177Z2S2rMarzak4NMv1kULvWv');
export const ORE_BOARD = new PublicKey('BrcSxdp1nXFzou1YyDnQJcPNBNHgoypZmTsyKBSLLXzi');
export const ORE_TREASURY = new PublicKey('45db2FSR4mcXdSVVZbKbwojU6uYDpMyhpEi7cC8nHaWG');
const CHECKPOINT_IX = 2;
/** Steel account discriminators: first byte of 8. */
const MINER_DISC = Buffer.from([103, 0, 0, 0, 0, 0, 0, 0]);
/** Miner: disc 8 | authority 32 | auto_return 8 | checkpoint_id 8 @48 | checkpoint_fee 8 @56 | deployed, mass, cumulative 3×200 | round_id 8 @664. */
const MINER_CHECKPOINT_AT = 48;
const MINER_ROUND_AT = 664;
/** Round: disc 8 | id 8 | deployed, mass, count 3×200 | slot_hash 32 | expires_at 8 @648. */
const ROUND_EXPIRES_AT = 648;
const TWELVE_HOURS_SLOTS = 12n * 60n * 200n;
/** Checkpoints per transaction (5 fits comfortably in 1,232 bytes and ~110k compute units). */
export const ORE_BATCH = 5;
/** Stop claiming this close to expiry (a round closing mid-flight just pays nothing). */
const EXPIRY_MARGIN_SLOTS = 150n;
/**
 * Claim as soon as a bounty is claimable, up to 5 per transaction (one base fee and tip for all).
 * Waiting to fill a batch was tried first, but bounties turned out scarce (often 1 claimable at a time)
 * and claimable ones disappeared within 2 h (Oct 31): a single claim nets ~4,000, a lost one 0.
 */
export function batches<T extends { expiresAt: bigint }>(ready: T[], _slot: bigint, size = ORE_BATCH): T[][] {
  const sorted = [...ready].sort((a, b) => (a.expiresAt < b.expiresAt ? -1 : a.expiresAt > b.expiresAt ? 1 : 0));
  const out: T[][] = [];
  for (let i = 0; i < sorted.length; i += size) out.push(sorted.slice(i, i + size));
  return out;
}

export interface OreMiner { miner: string; authority?: string; round: bigint; fee: bigint }

export function roundAddress(id: bigint): PublicKey {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from('round'), b], ORE_PROGRAM_ID)[0];
}

export function automationAddress(authority: PublicKey): PublicKey {
  return PublicKey.findProgramAddressSync([Buffer.from('automation'), authority.toBuffer()], ORE_PROGRAM_ID)[0];
}

/** Is this miner's bounty claimable at `slot`? (in the last 12 h before expiry, not settled) */
export function claimable(m: Pick<OreMiner, 'fee'>, expiresAt: bigint | null | undefined, slot: bigint): boolean {
  if (m.fee <= 0n || expiresAt === null || expiresAt === undefined) return false;
  return slot >= expiresAt - TWELVE_HOURS_SLOTS && slot < expiresAt - EXPIRY_MARGIN_SLOTS;
}

export function checkpointInstruction(signer: PublicKey, authority: PublicKey, miner: PublicKey, round: bigint): TransactionInstruction {
  return new TransactionInstruction({
    programId: ORE_PROGRAM_ID,
    data: Buffer.from([CHECKPOINT_IX]),
    keys: [
      { pubkey: signer, isSigner: true, isWritable: true },
      { pubkey: authority, isSigner: false, isWritable: true },
      { pubkey: automationAddress(authority), isSigner: false, isWritable: true },
      { pubkey: ORE_BOARD, isSigner: false, isWritable: false },
      { pubkey: miner, isSigner: false, isWritable: true },
      { pubkey: roundAddress(round), isSigner: false, isWritable: true },
      { pubkey: ORE_TREASURY, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
  });
}

type Rpc = (method: string, params: unknown[]) => Promise<any>;

export class OreCheckpointJob implements Job {
  readonly type = 'ore.checkpoint';
  readonly feature = 'adapter:ore.checkpoint';
  readonly protocol = 'ORE v3';
  readonly description = 'Checkpoint ORE miners who left a round unsettled; each pays its 10,000-lamport checkpoint fee to whoever does it in the last 12 h.';
  readonly rewardSource = 'github.com/regolith-labs/ore program/src/checkpoint.rs ("anyone may checkpoint this account and collect the bot fee")';

  private unsettled: OreMiner[] = [];
  private expiries = new Map<bigint, bigint | null>();
  private scannedAt = 0;
  private scanning?: Promise<void>;
  private readonly rpc: Rpc;

  /**
   * `listingUrl` serves the big miner listing (~35k accounts, a few MB): the public RPC by default, to
   * save Helius credits. `conn` does everything else.
   */
  constructor(private conn: Connection, listingUrl: string, private opts: { scanMs?: number; now?: () => number } = {}) {
    this.rpc = async (method, params) => {
      const res = await fetch(listingUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout(60_000) });
      const j = await res.json() as { result?: unknown; error?: { message: string } };
      if (j.error) throw new Error(j.error.message);
      return j.result;
    };
  }

  private now() { return (this.opts.now ?? Date.now)(); }

  /** Miners with a checkpoint fee who haven't settled their last round. Two small slices, parsed by hand. */
  private async scan(): Promise<void> {
    const gpa = (offset: number, length: number) => this.rpc('getProgramAccounts', [ORE_PROGRAM_ID.toBase58(), {
      encoding: 'base64', dataSlice: { offset, length }, filters: [{ memcmp: { offset: 0, bytes: MINER_DISC.toString('base64'), encoding: 'base64' } }],
    }]) as Promise<{ pubkey: string; account: { data: [string, string] } }[]>;
    const fees = await gpa(MINER_CHECKPOINT_AT, 16);
    const rounds = new Map((await gpa(MINER_ROUND_AT, 8)).map(x => [x.pubkey, Buffer.from(x.account.data[0], 'base64').readBigUInt64LE(0)]));
    const board = await this.conn.getAccountInfo(ORE_BOARD, 'confirmed');
    const current = board ? board.data.readBigUInt64LE(8) : 0n;
    const out: OreMiner[] = [];
    for (const x of fees) {
      const d = Buffer.from(x.account.data[0], 'base64');
      const checkpointId = d.readBigUInt64LE(0);
      const fee = d.readBigUInt64LE(8);
      const round = rounds.get(x.pubkey);
      if (round === undefined || fee === 0n || checkpointId === round || round >= current) continue;
      out.push({ miner: x.pubkey, round, fee });
    }
    // Expiry slot of each round we haven't seen (round accounts are tiny reads).
    const need = [...new Set(out.map(m => m.round))].filter(r => !this.expiries.has(r));
    for (let i = 0; i < need.length; i += 100) {
      const chunk = need.slice(i, i + 100);
      const infos = await this.conn.getMultipleAccountsInfo(chunk.map(roundAddress), 'confirmed');
      infos.forEach((info, j) => this.expiries.set(chunk[j], info && info.data.length >= ROUND_EXPIRES_AT + 8 ? info.data.readBigUInt64LE(ROUND_EXPIRES_AT) : null));
    }
    this.unsettled = out;
    this.scannedAt = this.now();
    log.info('ore: scanned miners', { miners: fees.length, unsettled: out.length });
  }

  async detect(): Promise<Candidate[]> {
    if (this.now() - this.scannedAt > (this.opts.scanMs ?? 5 * 60_000)) {
      const s = this.scanning ??= this.scan().finally(() => { this.scanning = undefined; });
      if (this.scannedAt === 0) await s;
      else s.catch(e => log.warn('ore scan failed', { error: String(e) }));
    }
    const slot = BigInt(await this.conn.getSlot('confirmed'));
    const ready = this.unsettled.filter(m => claimable(m, this.expiries.get(m.round), slot))
      .map(m => ({ ...m, expiresAt: this.expiries.get(m.round)! }));
    // One candidate per batch of up to ORE_BATCH miners: one base fee and one tip for all of them.
    const out: Candidate[] = [];
    for (const batch of batches(ready, slot)) {
      out.push({
        id: `ore:${batch.map(m => `${m.miner}@${m.round}`).join(',')}`,
        jobType: this.type,
        description: `ORE checkpoint × ${batch.length} (${batch.reduce((n, m) => n + m.fee, 0n)} lamports in fees)`,
        data: batch.map(m => ({ miner: m.miner, round: m.round.toString(), fee: m.fee.toString() })),
      });
    }
    return out;
  }

  async build(c: Candidate, agent: PublicKey): Promise<BuiltJob> {
    const batch = c.data as { miner: string; round: string; fee: string }[];
    // Fresh read: drop miners settled since the scan, and get each authority.
    const infos = await this.conn.getMultipleAccountsInfo(batch.map(b => new PublicKey(b.miner)), 'processed');
    const live = batch.flatMap((b, i) => {
      const d = infos[i]?.data;
      if (!d || d.length < MINER_ROUND_AT + 8) return [];
      const fee = d.readBigUInt64LE(MINER_CHECKPOINT_AT + 8);
      if (d.readBigUInt64LE(MINER_CHECKPOINT_AT) === BigInt(b.round) || fee === 0n || d.readBigUInt64LE(MINER_ROUND_AT) !== BigInt(b.round)) return [];
      return [{ ...b, fee, authority: new PublicKey(d.subarray(8, 40)) }];
    });
    const settled = new Set(batch.map(b => b.miner).filter(m => !live.some(l => l.miner === m)));
    this.unsettled = this.unsettled.filter(m => !settled.has(m.miner));
    if (!live.length) throw new JobGone('all miners in this batch were settled meanwhile');
    return {
      instructions: live.map(l => checkpointInstruction(agent, l.authority, new PublicKey(l.miner), BigInt(l.round))),
      lookupTables: [],
      expectedRewardLamports: live.reduce((n, l) => n + l.fee, 0n),
      cuKey: `ore:checkpoint:${live.length}`,
    };
  }

  /** After a send, forget the miners in it (settled by us, or by someone else). */
  learn(c: Candidate): void {
    const done = new Set((c.data as { miner: string }[]).map(b => b.miner));
    this.unsettled = this.unsettled.filter(m => !done.has(m.miner));
  }
}
