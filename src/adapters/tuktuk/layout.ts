import { createHash } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/**
 * Hand-rolled Borsh decoding for the TukTuk accounts we need, so the agent doesn't pull in
 * Anchor + the Helium SDK (it has to run on a phone). Layouts from
 * helium/tuktuk solana-programs/programs/tuktuk/src/state.rs.
 */

export const TUKTUK_PROGRAM_ID = new PublicKey('tuktukUrfhXT6ZT77QTU8RQtvgL967uRuVagWF57zVA');

export const accountDiscriminator = (name: string) => createHash('sha256').update(`account:${name}`).digest().subarray(0, 8);
export const TASK_DISCRIMINATOR = accountDiscriminator('TaskV0');
export const TASK_QUEUE_DISCRIMINATOR = accountDiscriminator('TaskQueueV0');
/** From the on-chain IDL: run_task_v0 */
export const RUN_TASK_V0_DISCRIMINATOR = Buffer.from([52, 184, 39, 129, 126, 245, 176, 237]);

/** Bytes needed to read a task's header (through the trigger) — used for cheap polling. */
export const TASK_HEADER_LEN = 8 + 32 + 8 + 8 + 2 + 9;

class Reader {
  o = 0;
  constructor(private b: Buffer) {}
  u8() { return this.b.readUInt8(this.o++); }
  u16() { const v = this.b.readUInt16LE(this.o); this.o += 2; return v; }
  u32() { const v = this.b.readUInt32LE(this.o); this.o += 4; return v; }
  u64() { const v = this.b.readBigUInt64LE(this.o); this.o += 8; return v; }
  i64() { const v = this.b.readBigInt64LE(this.o); this.o += 8; return v; }
  bytes(n: number) { const v = this.b.subarray(this.o, this.o + n); this.o += n; return Buffer.from(v); }
  pubkey() { return new PublicKey(this.bytes(32)); }
  vecU8() { return this.bytes(this.u32()); }
  string() { return this.vecU8().toString('utf8'); }
  vec<T>(f: () => T): T[] { const n = this.u32(); const out: T[] = []; for (let i = 0; i < n; i++) out.push(f()); return out; }
  skip(n: number) { this.o += n; }
}

export type Trigger = { kind: 'now' } | { kind: 'timestamp'; ts: number };

export interface CompiledInstructionV0 { programIdIndex: number; accounts: number[]; data: Buffer }
export interface CompiledTransactionV0 {
  numRwSigners: number;
  numRoSigners: number;
  numRw: number;
  accounts: PublicKey[];
  instructions: CompiledInstructionV0[];
  signerSeeds: Buffer[][];
}
export type TransactionSource =
  | { kind: 'compiled'; tx: CompiledTransactionV0 }
  | { kind: 'remote'; url: string; signer: PublicKey };

export interface TaskHeader {
  taskQueue: PublicKey;
  rentAmount: bigint;
  crankReward: bigint;
  id: number;
  trigger: Trigger;
}

export interface Task extends TaskHeader {
  rentRefund: PublicKey;
  transaction: TransactionSource;
  queuedAt: bigint;
  bumpSeed: number;
  freeTasks: number;
  description: string;
}

export interface TaskQueue {
  tuktukConfig: PublicKey;
  id: number;
  updateAuthority: PublicKey;
  minCrankReward: bigint;
  uncollectedProtocolFees: bigint;
  capacity: number;
  createdAt: bigint;
  updatedAt: bigint;
  bumpSeed: number;
  taskBitmap: Buffer;
  name: string;
  lookupTables: PublicKey[];
  numQueueAuthorities: number;
  staleTaskAge: number;
}

function expectDiscriminator(data: Buffer, disc: Buffer, what: string) {
  if (data.length < 8 || !data.subarray(0, 8).equals(disc)) throw new Error(`not a ${what} account`);
}

function readHeader(r: Reader): TaskHeader {
  const taskQueue = r.pubkey();
  const rentAmount = r.u64();
  const crankReward = r.u64();
  const id = r.u16();
  const tag = r.u8();
  let trigger: Trigger;
  if (tag === 0) trigger = { kind: 'now' };
  else if (tag === 1) trigger = { kind: 'timestamp', ts: Number(r.i64()) };
  else throw new Error(`unknown trigger variant ${tag}`);
  return { taskQueue, rentAmount, crankReward, id, trigger };
}

/** Decode just the header; works on a dataSlice of TASK_HEADER_LEN bytes. */
export function decodeTaskHeader(data: Buffer): TaskHeader {
  expectDiscriminator(data, TASK_DISCRIMINATOR, 'TaskV0');
  const r = new Reader(data);
  r.skip(8);
  return readHeader(r);
}

export function decodeTask(data: Buffer): Task {
  expectDiscriminator(data, TASK_DISCRIMINATOR, 'TaskV0');
  const r = new Reader(data);
  r.skip(8);
  const header = readHeader(r);
  const rentRefund = r.pubkey();
  const srcTag = r.u8();
  let transaction: TransactionSource;
  if (srcTag === 0) {
    const numRwSigners = r.u8();
    const numRoSigners = r.u8();
    const numRw = r.u8();
    const accounts = r.vec(() => r.pubkey());
    const instructions = r.vec(() => ({ programIdIndex: r.u8(), accounts: [...r.vecU8()], data: r.vecU8() }));
    const signerSeeds = r.vec(() => r.vec(() => r.vecU8()));
    transaction = { kind: 'compiled', tx: { numRwSigners, numRoSigners, numRw, accounts, instructions, signerSeeds } };
  } else if (srcTag === 1) {
    const url = r.string();
    const signer = r.pubkey();
    transaction = { kind: 'remote', url, signer };
  } else {
    throw new Error(`unknown transaction source variant ${srcTag}`);
  }
  const queuedAt = r.i64();
  const bumpSeed = r.u8();
  const freeTasks = r.u8();
  const description = r.string();
  return { ...header, rentRefund, transaction, queuedAt, bumpSeed, freeTasks, description };
}

export function decodeTaskQueue(data: Buffer): TaskQueue {
  expectDiscriminator(data, TASK_QUEUE_DISCRIMINATOR, 'TaskQueueV0');
  const r = new Reader(data);
  r.skip(8);
  const tuktukConfig = r.pubkey();
  const id = r.u32();
  const updateAuthority = r.pubkey();
  r.skip(32); // reserved
  const minCrankReward = r.u64();
  const uncollectedProtocolFees = r.u64();
  const capacity = r.u16();
  const createdAt = r.i64();
  const updatedAt = r.i64();
  const bumpSeed = r.u8();
  const taskBitmap = r.vecU8();
  const name = r.string();
  const lookupTables = r.vec(() => r.pubkey());
  const numQueueAuthorities = r.u16();
  const staleTaskAge = r.u32();
  return {
    tuktukConfig, id, updateAuthority, minCrankReward, uncollectedProtocolFees, capacity,
    createdAt, updatedAt, bumpSeed, taskBitmap, name, lookupTables, numQueueAuthorities, staleTaskAge,
  };
}

export function taskAddress(taskQueue: PublicKey, id: number): PublicKey {
  const idBytes = Buffer.alloc(2);
  idBytes.writeUInt16LE(id);
  return PublicKey.findProgramAddressSync([Buffer.from('task'), taskQueue.toBuffer(), idBytes], TUKTUK_PROGRAM_ID)[0];
}

/** Free task ids for tasks that queue follow-up tasks. Mirrors nextAvailableTaskIds in the Helium SDK. */
export function nextAvailableTaskIds(bitmap: Buffer, n: number, capacity: number, startByte = Math.floor(Math.random() * Math.max(1, bitmap.length))): number[] {
  if (n === 0) return [];
  const out: number[] = [];
  for (let off = 0; off < bitmap.length; off++) {
    const byteIdx = (off + startByte) % bitmap.length;
    const byte = bitmap[byteIdx];
    if (byte === 0xff) continue;
    for (let bit = 0; bit < 8; bit++) {
      const id = byteIdx * 8 + bit;
      if (id < capacity && (byte & (1 << bit)) === 0) {
        out.push(id);
        if (out.length === n) return out;
      }
    }
  }
  throw new Error(`task queue has ${out.length} free ids, ${n} needed`);
}

export function encodeRunTaskV0(freeTaskIds: number[]): Buffer {
  const b = Buffer.alloc(8 + 4 + 2 * freeTaskIds.length);
  RUN_TASK_V0_DISCRIMINATOR.copy(b, 0);
  b.writeUInt32LE(freeTaskIds.length, 8);
  freeTaskIds.forEach((id, i) => b.writeUInt16LE(id, 12 + 2 * i));
  return b;
}
