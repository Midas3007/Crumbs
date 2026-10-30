import { createHash } from 'node:crypto';
import { gunzipSync, inflateSync } from 'node:zlib';
import { base58Decode } from '../core/base58.js';
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

/** Fetch a program's IDL: the legacy Anchor IDL account first, then the Program Metadata program (newer Anchor). */
export async function fetchIdl(conn: Connection, programId: PublicKey): Promise<ProgramIdl | undefined> {
  const json = (await legacyIdlJson(conn, programId)) ?? (await programMetadataIdlJson(conn, programId));
  return json ? parseIdl(programId.toBase58(), json) : undefined;
}

async function legacyIdlJson(conn: Connection, programId: PublicKey): Promise<string | undefined> {
  const info = await conn.getAccountInfo(await idlAddress(programId));
  if (!info || info.data.length < 44) return undefined;
  // Layout: 8 discriminator, 32 authority, u32 length, zlib-compressed JSON.
  const len = info.data.readUInt32LE(40);
  return inflateSync(info.data.subarray(44, 44 + len)).toString('utf8');
}

export const PROGRAM_METADATA_ID = new PublicKey('ProgM6JCCvbYkfKqJYHePx4xxSUSqJp7rh8Lyv7nk7S');

/** The canonical "idl" metadata account: PDA of [program, "idl" padded to 16 bytes] under the Program Metadata program. */
export function metadataIdlAddress(programId: PublicKey): PublicKey {
  const seed = Buffer.alloc(16);
  seed.write('idl', 'utf8');
  return PublicKey.findProgramAddressSync([programId.toBuffer(), seed], PROGRAM_METADATA_ID)[0];
}

/**
 * Decode a Program Metadata account (solana-program/program-metadata, state/header.rs): a 96-byte header
 * — discriminator(1)=2, program(32), authority(32), mutable, canonical, seed(16), encoding, compression,
 * format, data_source, data_length(u32), padding(5) — then the data. Returns the IDL JSON, or the URL to fetch it from.
 */
export function decodeProgramMetadata(data: Buffer): { json?: string; url?: string } | undefined {
  if (data.length < 96 || data[0] !== 2) return undefined;
  // seed occupies bytes 67..83, so the four enums sit at 83..86 and the length at 87 (verified on mainnet accounts).
  const [encoding, compression, format, source] = [data[83], data[84], data[85], data[86]];
  const length = data.readUInt32LE(87);
  const body = data.subarray(96, 96 + length);
  if (source === 1) return { url: body.toString('utf8') };
  if (source !== 0 || (format !== 1 && format !== 0)) return undefined; // external accounts / YAML / TOML: not supported
  // Stored as encode(compress(json)): undo the text encoding, then the compression.
  let bytes: Buffer = encoding === 2 ? Buffer.from(base58Decode(body.toString('utf8')))
    : encoding === 3 ? Buffer.from(body.toString('utf8'), 'base64') : Buffer.from(body);
  if (compression === 1) bytes = gunzipSync(bytes);
  else if (compression === 2) bytes = inflateSync(bytes);
  return { json: bytes.toString('utf8') };
}

async function programMetadataIdlJson(conn: Connection, programId: PublicKey): Promise<string | undefined> {
  const info = await conn.getAccountInfo(metadataIdlAddress(programId));
  if (!info || !info.owner.equals(PROGRAM_METADATA_ID)) return undefined;
  const m = decodeProgramMetadata(info.data);
  if (m?.json) return m.json;
  if (m?.url?.startsWith('https://')) {
    const res = await fetch(m.url, { signal: AbortSignal.timeout(10_000) });
    const text = res.ok ? await res.text() : '';
    return text.length > 0 && text.length < 5_000_000 ? text : undefined;
  }
  return undefined;
}
