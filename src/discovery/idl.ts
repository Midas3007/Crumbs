import { createHash } from 'node:crypto';
import { inflateSync } from 'node:zlib';
import { type Connection, PublicKey } from '@solana/web3.js';

/** One account slot of an instruction, normalized across Anchor IDL formats. */
export interface IdlAccount {
  name: string;
  signer: boolean;
  writable: boolean;
  optional: boolean;
  /** Fixed address, if the IDL pins one (system program, sysvars...). */
  address?: string;
  /** True if the IDL says the account is a PDA. */
  pda: boolean;
  /** Other accounts this one is constrained against (`has_one`). */
  relations: string[];
  docs: string[];
}

export interface IdlInstruction {
  name: string;
  discriminator: Buffer;
  accounts: IdlAccount[];
  args: { name: string; type: unknown }[];
  docs: string[];
}

export interface ProgramIdl {
  programId: string;
  name: string;
  instructions: IdlInstruction[];
  /** sha256 of the raw IDL JSON — lets us skip programs we already classified. */
  hash: string;
}

const snake = (s: string) => s.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toLowerCase();
export const legacyDiscriminator = (ixName: string) =>
  createHash('sha256').update(`global:${snake(ixName)}`).digest().subarray(0, 8);

type RawAccount = Record<string, unknown> & { name: string; accounts?: RawAccount[] };

/** Legacy IDLs nest account groups; flatten them in order (that's how they're laid out on the wire). */
function flatten(accounts: RawAccount[], prefix = ''): IdlAccount[] {
  return accounts.flatMap(a => {
    if (Array.isArray(a.accounts)) return flatten(a.accounts, `${prefix}${a.name}.`);
    return [{
      name: prefix + a.name,
      signer: Boolean(a.signer ?? a.isSigner),
      writable: Boolean(a.writable ?? a.isMut),
      optional: Boolean(a.optional ?? a.isOptional),
      address: typeof a.address === 'string' ? a.address : undefined,
      pda: a.pda !== undefined,
      relations: Array.isArray(a.relations) ? (a.relations as string[]) : [],
      docs: Array.isArray(a.docs) ? (a.docs as string[]) : [],
    }];
  });
}

/** Normalize an Anchor IDL (0.30+ spec or legacy) into the shape discovery needs. */
export function parseIdl(programId: string, json: string): ProgramIdl {
  const raw = JSON.parse(json) as {
    name?: string; metadata?: { name?: string };
    instructions: { name: string; discriminator?: number[]; accounts: RawAccount[]; args?: { name: string; type: unknown }[]; docs?: string[] }[];
  };
  return {
    programId,
    name: raw.metadata?.name ?? raw.name ?? 'unknown',
    hash: createHash('sha256').update(json).digest('hex'),
    instructions: raw.instructions.map(ix => ({
      name: ix.name,
      discriminator: ix.discriminator ? Buffer.from(ix.discriminator) : legacyDiscriminator(ix.name),
      accounts: flatten(ix.accounts ?? []),
      args: ix.args ?? [],
      docs: ix.docs ?? [],
    })),
  };
}

/** Address of the on-chain Anchor IDL account: createWithSeed(PDA([], program), "anchor:idl", program). */
export async function idlAddress(programId: PublicKey): Promise<PublicKey> {
  const base = PublicKey.findProgramAddressSync([], programId)[0];
  return PublicKey.createWithSeed(base, 'anchor:idl', programId);
}

/** Fetch and decode a program's on-chain Anchor IDL. Returns undefined if it didn't publish one. */
export async function fetchIdl(conn: Connection, programId: PublicKey): Promise<ProgramIdl | undefined> {
  const info = await conn.getAccountInfo(await idlAddress(programId));
  if (!info || info.data.length < 44) return undefined;
  // Layout: 8 discriminator, 32 authority, u32 length, zlib-compressed JSON.
  const len = info.data.readUInt32LE(40);
  const json = inflateSync(info.data.subarray(44, 44 + len)).toString('utf8');
  return parseIdl(programId.toBase58(), json);
}
