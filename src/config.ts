import { existsSync, readFileSync } from 'node:fs';
import { Keypair, PublicKey } from '@solana/web3.js';

export const LAMPORTS_PER_SOL = 1_000_000_000n;

export type Mode = 'shadow' | 'live';

export interface Caps {
  /** Most SOL the hot wallet may hold. Above this the agent pauses until funds are moved out. */
  walletCapLamports: bigint;
  /** Most the agent may lose in one UTC day (failed races, fees) before it pauses itself. */
  dailyLossCapLamports: bigint;
  /** Most a single job may spend on fees + tips. Jobs above it are skipped; a breach after sending pauses. */
  perJobSpendCapLamports: bigint;
  /** A job is only sent if it nets at least this much after every fee. */
  minProfitLamports: bigint;
  /** Simulated reward above (documented reward × this) is treated as a possible bug, never executed. */
  anomalyMultiple: number;
}

export interface Config {
  mode: Mode;
  /** Env kill switch: when true nothing is ever sent, whatever Telegram says. */
  envPaused: boolean;
  rpcUrl: string;
  heliusApiKey?: string;
  agentPubkey: PublicKey;
  agentKeypair?: Keypair;
  dbPath: string;
  caps: Caps;
  pollIntervalMs: number;
  telegram?: { token: string; chatId: string };
  sweep: {
    enabled: boolean;
    /** SOL kept in the wallet to pay fees; anything above it is swapped to USDC. */
    solFloatLamports: bigint;
    /** Don't bother swapping less than this (swap fees would eat it). */
    minSweepLamports: bigint;
    /** Optional cold wallet that swept USDC is sent to. */
    coldWallet?: PublicKey;
    jupiterApiUrl: string;
  };
  discovery: {
    /** Claude API key; discovery is off without it. */
    anthropicApiKey?: string;
    intervalHours: number;
    /** Also scan programs deployed/upgraded recently, not just the manual list. */
    includeRecentDeploys: boolean;
    /** Most to spend on Claude per UTC day; discovery pauses until tomorrow when reached. */
    dailyBudgetUsd: number;
  };
  dashboard: {
    /** Public dashboard base URL, e.g. https://crumbs.vercel.app. Snapshots are pushed there every minute. */
    url?: string;
    /** Shared secret; the same value goes in the dashboard's CRUMBS_PUSH_SECRET. */
    secret?: string;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

function sol(v: string | undefined, fallback: string): bigint {
  const s = (v ?? fallback).trim();
  if (!/^\d+(\.\d{1,9})?$/.test(s)) throw new Error(`invalid SOL amount: ${s}`);
  const [whole, frac = ''] = s.split('.');
  return BigInt(whole) * LAMPORTS_PER_SOL + BigInt(frac.padEnd(9, '0'));
}

function bool(v: string | undefined, fallback = false): boolean {
  if (v === undefined || v === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(v.toLowerCase());
}

function loadKeypair(env: NodeJS.ProcessEnv): Keypair | undefined {
  const raw = env.AGENT_SECRET_KEY
    ?? (env.AGENT_KEYPAIR_PATH && existsSync(env.AGENT_KEYPAIR_PATH)
      ? readFileSync(env.AGENT_KEYPAIR_PATH, 'utf8')
      : undefined);
  if (!raw) return undefined;
  return parseSecretKey(raw);
}

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function base58Decode(s: string): Uint8Array {
  let n = 0n;
  for (const ch of s) {
    const v = B58.indexOf(ch);
    if (v < 0) throw new Error('not base58');
    n = n * 58n + BigInt(v);
  }
  const bytes: number[] = [];
  while (n > 0n) { bytes.unshift(Number(n % 256n)); n /= 256n; }
  for (const ch of s) { if (ch !== '1') break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}

/**
 * The wallet key, however it was pasted: the JSON array from keys/agent.json (with or without its
 * [ ] brackets, line breaks or spaces), or the base58 string `npm run export-key` prints.
 * Never echoes the key in an error.
 */
export function parseSecretKey(raw: string): Keypair {
  const text = raw.trim();
  let bytes: Uint8Array | undefined;
  if (/^\[?[\d,\s]+\]?$/.test(text)) {
    const nums = text.replace(/[\[\]\s]/g, '').split(',').filter(Boolean).map(Number);
    if (nums.every(n => Number.isInteger(n) && n >= 0 && n <= 255)) bytes = Uint8Array.from(nums);
  } else if (/^[1-9A-HJ-NP-Za-km-z]+$/.test(text)) {
    bytes = base58Decode(text);
  }
  if (!bytes || bytes.length !== 64) {
    throw new Error(`The wallet key isn't in a format Crumbs can read (got ${bytes?.length ?? 0} bytes, need 64). `
      + 'Paste the whole contents of keys/agent.json, from [ to ], or the private key from `npm run export-key`.');
  }
  return Keypair.fromSecretKey(bytes);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env === process.env && existsSync('.env')) process.loadEnvFile('.env');

  const agentKeypair = loadKeypair(env);
  const pubkeyStr = env.AGENT_PUBKEY ?? agentKeypair?.publicKey.toBase58();
  if (!pubkeyStr) throw new Error('Set AGENT_PUBKEY (shadow mode) or AGENT_KEYPAIR_PATH / AGENT_SECRET_KEY (live).');
  const agentPubkey = new PublicKey(pubkeyStr);
  if (agentKeypair && !agentKeypair.publicKey.equals(agentPubkey)) {
    throw new Error('AGENT_PUBKEY does not match the loaded keypair.');
  }

  const requestedMode = (env.CRUMBS_MODE ?? 'shadow') as Mode;
  if (requestedMode !== 'shadow' && requestedMode !== 'live') throw new Error(`CRUMBS_MODE must be shadow or live`);
  if (requestedMode === 'live' && !agentKeypair) throw new Error('Live mode needs the agent keypair.');

  const heliusApiKey = env.HELIUS_API_KEY || undefined;
  const rpcUrl = env.RPC_URL
    || (heliusApiKey ? `https://mainnet.helius-rpc.com/?api-key=${heliusApiKey}` : 'https://api.mainnet-beta.solana.com');

  const caps: Caps = {
    walletCapLamports: sol(env.WALLET_CAP_SOL, '0.5'),
    dailyLossCapLamports: sol(env.DAILY_LOSS_CAP_SOL, '0.02'),
    perJobSpendCapLamports: sol(env.PER_JOB_SPEND_CAP_SOL, '0.0002'),
    minProfitLamports: BigInt(env.MIN_PROFIT_LAMPORTS ?? '2000'),
    anomalyMultiple: Number(env.ANOMALY_MULTIPLE ?? '1.5'),
  };

  const telegram = env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID
    ? { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID }
    : undefined;

  return {
    mode: requestedMode,
    envPaused: bool(env.CRUMBS_PAUSED),
    rpcUrl,
    heliusApiKey,
    agentPubkey,
    agentKeypair,
    dbPath: env.DB_PATH ?? 'data/crumbs.db',
    caps,
    pollIntervalMs: Number(env.POLL_INTERVAL_MS ?? '1000'),
    telegram,
    sweep: {
      enabled: bool(env.SWEEP_TO_USDC, true),
      solFloatLamports: sol(env.SOL_FLOAT_SOL, '0.05'),
      minSweepLamports: sol(env.MIN_SWEEP_SOL, '0.02'),
      coldWallet: env.COLD_WALLET ? new PublicKey(env.COLD_WALLET) : undefined,
      jupiterApiUrl: env.JUPITER_API_URL ?? 'https://lite-api.jup.ag/swap/v1',
    },
    discovery: {
      anthropicApiKey: env.ANTHROPIC_API_KEY || undefined,
      intervalHours: Number(env.DISCOVERY_INTERVAL_HOURS ?? '6'),
      includeRecentDeploys: bool(env.DISCOVERY_RECENT_DEPLOYS, true),
      dailyBudgetUsd: Number(env.DISCOVERY_DAILY_BUDGET_USD ?? '0.25'),
    },
    dashboard: { url: env.DASHBOARD_URL || undefined, secret: env.DASHBOARD_SECRET || undefined },
    logLevel: (env.LOG_LEVEL ?? 'info') as Config['logLevel'],
  };
}

export function formatSol(lamports: bigint): string {
  const neg = lamports < 0n;
  const abs = neg ? -lamports : lamports;
  const whole = abs / LAMPORTS_PER_SOL;
  const frac = (abs % LAMPORTS_PER_SOL).toString().padStart(9, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? '.' + frac : ''} SOL`;
}
