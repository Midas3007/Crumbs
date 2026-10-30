import {
  type AccountMeta,
  type AddressLookupTableAccount,
  type Connection,
  Ed25519Program,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  TransactionInstruction,
} from '@solana/web3.js';
import { log } from '../../core/logger.js';
import { type BuiltJob, type Candidate, type Job, JobGone } from '../../core/types.js';
import {
  decodeTask, decodeTaskHeader, decodeTaskQueue, encodeRunTaskV0, nextAvailableTaskIds,
  type Task, TASK_DISCRIMINATOR, TASK_HEADER_LEN, type TaskHeader, type TaskQueue, taskAddress, TUKTUK_PROGRAM_ID,
} from './layout.js';

export interface TuktukOptions {
  /** Skip tasks whose reward can't cover the base fee plus this margin — saves RPC calls. */
  minRewardLamports: bigint;
  /** How often to re-read the full task schedule. */
  scheduleRefreshMs?: number;
  /** Most candidates handed to the executor per tick. */
  maxPerTick?: number;
  /** Hand over tasks this many seconds before they're due, so we can be on time. */
  leadSec?: number;
  /** Queues to ignore (e.g. test queues). */
  denyQueues?: string[];
  now?: () => number;
}

interface ScheduledTask { address: PublicKey; header: TaskHeader }

/**
 * Helium TukTuk: a permissionless crank queue. `run_task_v0` pays the task's `crank_reward`
 * (lamports) to whoever signs as `crank_turner` — see run_task_v0.rs, "Paying out reward".
 */
export class TuktukJob implements Job {
  readonly type = 'tuktuk.run_task';
  readonly protocol = 'Helium TukTuk';
  readonly description = 'Run due tasks on TukTuk crank queues; each pays its crank_reward in SOL to the caller.';
  readonly rewardSource = 'github.com/helium/tuktuk solana-programs/programs/tuktuk/src/instructions/run_task_v0.rs (crank_turner_info.add_lamports(task_fee))';

  private schedule: ScheduledTask[] = [];
  private scheduleAt = 0;
  private queues = new Map<string, { queue: TaskQueue; luts: AddressLookupTableAccount[]; at: number }>();
  private readonly now: () => number;

  constructor(private conn: Connection, private opts: TuktukOptions) {
    this.now = opts.now ?? Date.now;
  }

  private async refreshSchedule(): Promise<void> {
    const accounts = await this.conn.getProgramAccounts(TUKTUK_PROGRAM_ID, {
      commitment: 'confirmed',
      filters: [{ memcmp: { offset: 0, bytes: TASK_DISCRIMINATOR.toString('base64'), encoding: 'base64' } }],
      dataSlice: { offset: 0, length: TASK_HEADER_LEN },
    });
    const deny = new Set(this.opts.denyQueues ?? []);
    this.schedule = accounts.flatMap(({ pubkey, account }) => {
      try {
        const header = decodeTaskHeader(account.data);
        if (deny.has(header.taskQueue.toBase58())) return [];
        return [{ address: pubkey, header }];
      } catch {
        return [];
      }
    });
    this.scheduleAt = this.now();
    log.debug('tuktuk schedule refreshed', { tasks: this.schedule.length });
  }

  async detect(): Promise<Candidate[]> {
    if (this.now() - this.scheduleAt > (this.opts.scheduleRefreshMs ?? 60_000)) await this.refreshSchedule();
    const horizon = Math.floor(this.now() / 1000) + (this.opts.leadSec ?? 2);
    const due = this.schedule
      .filter(t => t.header.crankReward >= this.opts.minRewardLamports)
      .filter(t => t.header.trigger.kind === 'now' || t.header.trigger.ts <= horizon)
      .sort((a, b) => dueAt(a.header) - dueAt(b.header))
      .slice(0, this.opts.maxPerTick ?? 25);
    return due.map(t => ({
      id: `${t.address.toBase58()}:${dueAt(t.header)}`,
      jobType: this.type,
      description: `TukTuk task ${t.header.id} (reward ${t.header.crankReward} lamports)`,
      dueAt: dueAt(t.header),
      data: { task: t.address.toBase58() },
    }));
  }

  /** Remove a task from the local schedule once it's been handled or found gone. */
  forget(taskAddress: string): void {
    this.schedule = this.schedule.filter(t => t.address.toBase58() !== taskAddress);
  }

  private async loadQueue(address: PublicKey, fresh: boolean): Promise<{ queue: TaskQueue; luts: AddressLookupTableAccount[] }> {
    const key = address.toBase58();
    const cached = this.queues.get(key);
    if (cached && !fresh && this.now() - cached.at < 300_000) return cached;
    const info = await this.conn.getAccountInfo(address, 'processed');
    if (!info) throw new JobGone(`task queue ${key} no longer exists`);
    const queue = decodeTaskQueue(info.data);
    let luts = cached?.luts;
    if (!luts || this.now() - (cached?.at ?? 0) >= 300_000) {
      luts = (await Promise.all(queue.lookupTables.map(k => this.conn.getAddressLookupTable(k))))
        .flatMap(r => (r.value ? [r.value] : []));
    }
    const entry = { queue, luts, at: this.now() };
    this.queues.set(key, entry);
    return entry;
  }

  async build(candidate: Candidate, agent: PublicKey): Promise<BuiltJob> {
    const taskKey = new PublicKey((candidate.data as { task: string }).task);
    const info = await this.conn.getAccountInfo(taskKey, 'processed');
    if (!info) {
      this.forget(taskKey.toBase58());
      throw new JobGone('task already run');
    }
    const task = decodeTask(info.data);
    const { queue, luts } = await this.loadQueue(task.taskQueue, task.freeTasks > 0);
    const freeIds = nextAvailableTaskIds(queue.taskBitmap, task.freeTasks, queue.capacity);
    const freeTaskAccounts: AccountMeta[] = freeIds.map(id => ({ pubkey: taskAddress(task.taskQueue, id), isWritable: true, isSigner: false }));

    const instructions: TransactionInstruction[] = [];
    let remaining: AccountMeta[];
    if (task.transaction.kind === 'compiled') {
      remaining = compiledRemainingAccounts(task.transaction.tx);
    } else {
      const remote = await fetchRemoteTask(taskKey, task);
      instructions.push(Ed25519Program.createInstructionWithPublicKey({
        publicKey: task.transaction.signer.toBytes(),
        message: remote.transaction,
        signature: remote.signature,
      }));
      remaining = remote.remainingAccounts;
    }

    instructions.push(runTaskInstruction(agent, task, taskKey, [...remaining, ...freeTaskAccounts], freeIds));
    return { instructions, lookupTables: luts, expectedRewardLamports: task.crankReward };
  }
}

function dueAt(h: TaskHeader): number {
  return h.trigger.kind === 'timestamp' ? h.trigger.ts : 0;
}

export function compiledRemainingAccounts(tx: { numRwSigners: number; numRoSigners: number; numRw: number; accounts: PublicKey[] }): AccountMeta[] {
  const { numRwSigners, numRoSigners, numRw } = tx;
  return tx.accounts.map((pubkey, i) => ({
    pubkey,
    isWritable: i < numRwSigners || (i >= numRwSigners + numRoSigners && i < numRwSigners + numRoSigners + numRw),
    isSigner: false,
  }));
}

export function runTaskInstruction(agent: PublicKey, task: Task, taskKey: PublicKey, remaining: AccountMeta[], freeIds: number[]): TransactionInstruction {
  return new TransactionInstruction({
    programId: TUKTUK_PROGRAM_ID,
    keys: [
      { pubkey: agent, isWritable: true, isSigner: true },
      { pubkey: task.rentRefund, isWritable: true, isSigner: false },
      { pubkey: task.taskQueue, isWritable: true, isSigner: false },
      { pubkey: taskKey, isWritable: true, isSigner: false },
      { pubkey: SystemProgram.programId, isWritable: false, isSigner: false },
      { pubkey: SYSVAR_INSTRUCTIONS_PUBKEY, isWritable: false, isSigner: false },
      ...remaining,
    ],
    data: encodeRunTaskV0(freeIds),
  });
}

/** Remote tasks keep their instructions off-chain; the queue owner's server signs them on request. */
async function fetchRemoteTask(taskKey: PublicKey, task: Task): Promise<{ transaction: Buffer; signature: Buffer; remainingAccounts: AccountMeta[] }> {
  if (task.transaction.kind !== 'remote') throw new Error('not a remote task');
  const url = new URL(task.transaction.url);
  if (url.protocol !== 'https:') throw new JobGone(`refusing non-https remote task url ${url.origin}`);
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ task: taskKey.toBase58(), task_queued_at: task.queuedAt.toString(), task_queue: task.taskQueue.toBase58() }),
    signal: AbortSignal.timeout(5000),
  });
  if (!res.ok) throw new JobGone(`remote task server returned ${res.status}`);
  const body = await res.json() as { transaction: string; signature: string; remaining_accounts: { pubkey: string; is_writable: boolean }[] };
  return {
    transaction: Buffer.from(body.transaction, 'base64'),
    signature: Buffer.from(body.signature, 'base64'),
    // Never forward signer privilege from a remote server.
    remainingAccounts: body.remaining_accounts.map(a => ({ pubkey: new PublicKey(a.pubkey), isWritable: a.is_writable, isSigner: false })),
  };
}
