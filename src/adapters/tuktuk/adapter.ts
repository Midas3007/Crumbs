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
  /**
   * Speed: build transactions this many seconds before tasks are due (needs `agent`), so at the due
   * second only the final simulation and the send are left.
   */
  prepareSec?: number;
  agent?: PublicKey;
  /** Queues to ignore (e.g. test queues). */
  denyQueues?: string[];
  now?: () => number;
}

export interface ScheduledTask { address: PublicKey; header: TaskHeader }

/** A task this far past due that's still on-chain is stuck (its instructions keep failing). */
const OVERDUE_SEC = 60;
/** Stuck tasks are rechecked this often until they're about to turn stale. */
const RECHECK_SEC = 600;
/** Aim at the stale moment from this long before it until this long after. */
const STALE_AIM_WINDOW_SEC = 120;
/** Queues with absurd stale ages (e.g. u32::MAX) never turn stale in practice. */
const MAX_STALE_AGE_SEC = 30 * 86_400;

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
  private prepared = new Map<string, { at: number; job: Promise<BuiltJob> }>();
  private refreshing?: Promise<void>;
  private staleAge = new Map<string, number>();
  private lastRecheck = new Map<string, number>();
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
    // Each queue's stale age tells us when a stuck task becomes claimable without running.
    const queueKeys = [...new Set(this.schedule.map(t => t.header.taskQueue.toBase58()))].map(k => new PublicKey(k));
    for (let i = 0; i < queueKeys.length; i += 100) {
      const infos = await this.conn.getMultipleAccountsInfo(queueKeys.slice(i, i + 100), 'confirmed');
      infos.forEach((info, j) => {
        if (!info) return;
        try {
          this.staleAge.set(queueKeys[i + j].toBase58(), decodeTaskQueue(info.data).staleTaskAge);
        } catch { /* not a queue we can read: no stale timing for it */ }
      });
    }
    this.scheduleAt = this.now();
    log.debug('tuktuk schedule refreshed', { tasks: this.schedule.length, queues: queueKeys.length });
  }

  /**
   * When to try a task, in unix seconds, or undefined for "not now".
   * - Fresh tasks: at their due time (racing the incumbent crank turner).
   * - Stuck tasks (overdue and still there, so their inner instructions fail): at the moment they turn
   *   stale, when run_task_v0 pays the reward without running them. Nobody races for these much.
   * - In between, a slow recheck every 10 minutes in case they start working again.
   */
  fireAt(t: ScheduledTask, nowSec: number): { at: number; kind: 'due' | 'stale' | 'recheck' } | undefined {
    if (t.header.trigger.kind === 'now') return { at: nowSec, kind: 'due' };
    const due = t.header.trigger.ts;
    if (due >= nowSec - OVERDUE_SEC) return { at: due, kind: 'due' };
    const age = this.staleAge.get(t.header.taskQueue.toBase58());
    const staleAt = age !== undefined && age < MAX_STALE_AGE_SEC ? due + age + 1 : undefined;
    // From shortly before it turns stale until a while after, aim at the stale moment.
    if (staleAt !== undefined && nowSec >= staleAt - STALE_AIM_WINDOW_SEC && nowSec <= staleAt + STALE_AIM_WINDOW_SEC) return { at: staleAt, kind: 'stale' };
    const key = t.address.toBase58();
    const last = this.lastRecheck.get(key) ?? 0;
    if (nowSec - last < RECHECK_SEC) return undefined;
    return { at: nowSec, kind: 'recheck' };
  }

  async detect(): Promise<Candidate[]> {
    if (this.now() - this.scheduleAt > (this.opts.scheduleRefreshMs ?? 60_000)) {
      // Only the very first load blocks; after that the (1-2s) refresh runs in the background.
      const refresh = this.refreshing ??= this.refreshSchedule().finally(() => { this.refreshing = undefined; });
      if (this.scheduleAt === 0) await refresh;
      else refresh.catch(e => log.warn('tuktuk schedule refresh failed', { error: String(e) }));
    }
    const nowSec = Math.floor(this.now() / 1000);
    const lead = this.opts.leadSec ?? 2;
    const prepHorizon = nowSec + lead + (this.opts.prepareSec ?? 10);

    const planned = this.schedule
      .filter(t => t.header.crankReward >= this.opts.minRewardLamports)
      .flatMap(t => {
        const f = this.fireAt(t, nowSec);
        if (!f) return [];
        const c: Candidate = {
          id: `${t.address.toBase58()}:${f.kind}:${f.kind === 'recheck' ? Math.floor(nowSec / RECHECK_SEC) : f.at}`,
          jobType: this.type,
          description: `TukTuk task ${t.header.id} (reward ${t.header.crankReward} lamports, ${f.kind})`,
          // Rechecks have no due time, so the executor treats them as ordinary (not time-critical) retries.
          dueAt: f.kind === 'recheck' ? undefined : f.at,
          data: { task: t.address.toBase58() },
        };
        return [{ t, f, c }];
      });

    // Build upcoming due and stale tasks ahead of time, so only the final simulation and send remain at the moment.
    if (this.opts.agent) {
      for (const { f, c } of planned) {
        if (f.kind === 'recheck' || f.at <= nowSec || f.at > prepHorizon || this.prepared.has(c.id)) continue;
        const job = this.buildNow(c, this.opts.agent);
        job.catch(() => undefined); // a failed prebuild just means we build again at the moment
        this.prepared.set(c.id, { at: this.now(), job });
      }
      for (const [id, p] of this.prepared) if (this.now() - p.at > 60_000) this.prepared.delete(id);
    }

    const ready = planned
      .filter(({ f }) => f.at <= nowSec + lead)
      .sort((a, b) => a.f.at - b.f.at)
      .slice(0, this.opts.maxPerTick ?? 25);
    for (const { t, f } of ready) if (f.kind === 'recheck') this.lastRecheck.set(t.address.toBase58(), nowSec);
    return ready.map(({ c }) => c);
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
    const ready = this.prepared.get(candidate.id);
    if (ready) {
      this.prepared.delete(candidate.id); // use a prebuilt transaction once; retries rebuild from fresh state
      try {
        return await ready.job;
      } catch {
        /* fall through to a fresh build */
      }
    }
    return this.buildNow(candidate, agent);
  }

  private async buildNow(candidate: Candidate, agent: PublicKey): Promise<BuiltJob> {
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
    // Tasks from the same queue running the same programs use about the same compute.
    const compiled = task.transaction.kind === 'compiled' ? task.transaction.tx : undefined;
    const programs = compiled ? [...new Set(compiled.instructions.map(ix => compiled.accounts[ix.programIdIndex]?.toBase58()))].join(',') : 'remote';
    return { instructions, lookupTables: luts, expectedRewardLamports: task.crankReward, cuKey: `tuktuk:${task.taskQueue.toBase58()}:${programs}:${task.freeTasks}` };
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
