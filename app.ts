// app.ts — Forge: a GitHub-compatible git forge in one file.
//
// Node 22, standard library only, no dependencies, no git binary, no disk
// store: every repository lives in memory for the life of the process. One
// process serves four surfaces the suite drives:
//
//   git smart HTTP  /{owner}/{repo}.git  (upload-pack v2, receive-pack v0)
//   REST v3         /api/v3
//   GraphQL v4      /api/graphql
//   MCP             /mcp
//
// plus a small read-only web UI at / and GET /healthz.
//
// Identity: the suite's bearer token names the viewer "adaiversen" (id 1000).
// Every repository created through POST /user/repos belongs to that login;
// the same name under any other owner is a 404, and a request with no token
// (or a wrong one, when MAKEFUN_SHOP_TOKEN is set) is a 401.
//
// Determinism: nothing here reads the wall clock or an unseeded random
// source. Commit timestamps come from a fixed epoch plus a counter, request
// ids from a counter, so two runs fed the same requests leave the same state.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
export const FORGE_VERSION = '1.0.0';
export const DEFAULT_BRANCH = 'main';
export const ZERO_OID = '0000000000000000000000000000000000000000';

/** The bearer token the suite presents, when the trial sets one. */
const SHOP_TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

/** Fixed commit epoch; every forge-made commit adds the counter below it. */
const COMMIT_EPOCH = 1700000000;
let commitCounter = 0;
/** Request ids are a plain counter: deterministic and never empty. */
let requestCounter = 0;
/** Numeric ids for repos/issues/pulls/comments, stable across reads. */
let nextDatabaseId = 1;
let nextGlobalId = 1;

// -------------------------------------------------------------------------------------------
// small utilities

export function sha1Hex(data: Buffer): string {
  return createHash('sha1').update(data).digest('hex');
}

export function isSha40(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

export function b64encode(text: string | Buffer): string {
  return Buffer.isBuffer(text) ? text.toString('base64') : Buffer.from(text, 'utf8').toString('base64');
}

export function b64decodeLoose(text: string): Buffer {
  return Buffer.from(text.replace(/[\r\n\t ]+/g, ''), 'base64');
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

export function b64urlDecode(text: string): string {
  return Buffer.from(text, 'base64url').toString('utf8');
}

export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Sort git tree entries the way git does: directories compare as name + '/'. */
export function gitEntryKey(name: string, isDir: boolean): string {
  return isDir ? `${name}/` : name;
}

/** Count the lines of a text the way a diff summary does. */
export function lineCount(text: string): number {
  if (text === '') return 0;
  const parts = text.split('\n');
  return text.endsWith('\n') ? parts.length - 1 : parts.length;
}

// -------------------------------------------------------------------------------------------
// pkt-lines (the git smart-HTTP framing)

/** Encode one pkt-line; '0000' is a flush, '0001' a delim. */
export function pktLine(data: string | Buffer): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = body.length + 4;
  const head = Buffer.alloc(4);
  head.write(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');

export type PktKind = 'flush' | 'delim' | 'response-end' | 'data';

export interface Pkt {
  kind: PktKind;
  /** The payload of a data packet (without its 4-byte length header). */
  payload: Buffer;
}

/**
 * Decode pkt-lines up to the first flush packet. A receive-pack request
 * carries a binary pack after that flush, so the decoder must stop there
 * instead of trying to read the pack as pkt-lines. Returns the packets and
 * the number of bytes they consumed.
 */
export function decodePktLines(buffer: Buffer): { packets: Pkt[]; consumed: number } {
  const out: Pkt[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error('pkt-line: truncated length header');
    const head = buffer.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(head)) throw new Error(`pkt-line: bad length header ${JSON.stringify(head)}`);
    const length = parseInt(head, 16);
    if (length === 0) {
      out.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets: out, consumed: offset };
    }
    if (length === 1) {
      out.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      out.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buffer.length) throw new Error('pkt-line: bad length');
    out.push({ kind: 'data', payload: buffer.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets: out, consumed: offset };
}

/** The text of a data packet, or null for a control packet. */
export function pktText(packet: Pkt): string | null {
  return packet.kind === 'data' ? packet.payload.toString('utf8') : null;
}

/** One sideband packet: band byte 1 (pack data), 2 (progress) or 3 (error). */
export function sidebandPacket(band: 1 | 2 | 3, data: Buffer): Buffer {
  return pktLine(Buffer.concat([Buffer.from([band]), data]));
}

/** Split pack bytes into sideband packets of at most 65500 payload bytes. */
export function sidebandPack(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65500;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    out.push(sidebandPacket(1, pack.subarray(offset, Math.min(pack.length, offset + CHUNK))));
  }
  if (pack.length === 0) out.push(sidebandPacket(1, Buffer.alloc(0)));
  return out;
}

// -------------------------------------------------------------------------------------------
// git objects

export type ObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjectType;
  data: Buffer;
}

export function hashObject(type: ObjectType, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return sha1Hex(Buffer.concat([head, data]));
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** The canonical ident line the forge writes on its own commits. */
export function forgeIdent(): string {
  const epoch = COMMIT_EPOCH + commitCounter;
  commitCounter += 1;
  return `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epoch} +0000`;
}

export function buildCommit(info: CommitInfo): Buffer {
  const lines: string[] = [`tree ${info.tree}`];
  for (const parent of info.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${info.author}`);
  lines.push(`committer ${info.committer}`);
  lines.push('');
  lines.push(info.message);
  return Buffer.from(lines.join('\n'), 'utf8');
}

/** Parse a commit's bytes. Throws on a malformed commit. */
export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  if (blank < 0) throw new Error('commit: no blank line after the header');
  const header = text.slice(0, blank);
  const message = text.slice(blank + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  if (tree === '') throw new Error('commit: no tree line');
  return { tree, parents, author, committer, message };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = gitEntryKey(a.name, a.mode === '40000');
    const kb = gitEntryKey(b.name, b.mode === '40000');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Parse a tree's bytes into entries. */
export function parseTree(data: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('tree: bad entry (no space)');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('tree: bad entry (no NUL/oid)');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    offset = nul + 21;
  }
  return out;
}

const OBJECT_TYPE_CODES: Record<number, ObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
const OBJECT_TYPE_NUMBERS: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a pack v2 holding only whole objects (never deltas). */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  parts.push(version);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(count);
  for (const object of objects) {
    const typeNumber = OBJECT_TYPE_NUMBERS[object.type];
    const size = object.data.length;
    const head: number[] = [];
    let remaining = size;
    // varint: low 4 bits of size in the first byte, then 7 bits per byte.
    let byte = (typeNumber << 4) | (remaining & 0x0f);
    remaining >>= 4;
    while (remaining > 0) {
      head.push(byte | 0x80);
      byte = remaining & 0x7f;
      remaining >>= 7;
    }
    head.push(byte);
    parts.push(Buffer.from(head));
    parts.push(deflateSync(object.data));
  }
  const trailer = sha1Hex(Buffer.concat(parts));
  parts.push(Buffer.from(trailer, 'hex'));
  return Buffer.concat(parts);
}

/** Apply a git delta to its base object. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= delta.length) throw new Error('delta: truncated varint');
      const byte = delta[offset];
      offset += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) break;
    }
    return value;
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta: base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if ((op & 0x80) !== 0) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if ((op & (1 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta: truncated copy offset');
          copyOffset |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if ((op & (0x10 << bit)) !== 0) {
          if (offset >= delta.length) throw new Error('delta: truncated copy size');
          copySize |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      if (copyOffset + copySize > base.length) throw new Error('delta: copy out of range');
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      produced += copySize;
    } else if (op !== 0) {
      if (offset + op > delta.length) throw new Error('delta: truncated insert');
      out.push(delta.subarray(offset, offset + op));
      offset += op;
      produced += op;
    } else {
      throw new Error('delta: opcode 0');
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== targetSize || produced !== targetSize) throw new Error('delta: target size mismatch');
  return result;
}

/** Read a pack v2 (whole objects and OFS/REF deltas) into a map by oid. */
export function readPack(buffer: Buffer): Map<string, GitObject> {
  if (buffer.length < 12 || buffer.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('pack: bad signature');
  }
  const version = buffer.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack: unsupported version ${version}`);
  const count = buffer.readUInt32BE(8);
  const trailer = buffer.subarray(buffer.length - 20).toString('hex');
  const expectTrailer = sha1Hex(buffer.subarray(0, buffer.length - 20));
  if (trailer !== expectTrailer) throw new Error('pack: trailer checksum mismatch');
  const out = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const start = offset;
    if (offset >= buffer.length - 20) throw new Error('pack: truncated entry');
    let byte = buffer[offset];
    offset += 1;
    const typeNumber = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= buffer.length - 20) throw new Error('pack: truncated size');
      byte = buffer[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let baseOid: string | null = null;
    let baseOffset = -1;
    if (typeNumber === 6) {
      // OFS_DELTA: the base is a negative offset from this entry's start.
      if (offset >= buffer.length - 20) throw new Error('pack: truncated ofs-delta');
      byte = buffer[offset];
      offset += 1;
      let value = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= buffer.length - 20) throw new Error('pack: truncated ofs-delta');
        byte = buffer[offset];
        offset += 1;
        value = ((value + 1) << 7) | (byte & 0x7f);
      }
      baseOffset = start - value;
    } else if (typeNumber === 7) {
      if (offset + 20 > buffer.length - 20) throw new Error('pack: truncated ref-delta');
      baseOid = buffer.subarray(offset, offset + 20).toString('hex');
      offset += 20;
    }
    const inflated = inflateSync(buffer.subarray(offset));
    // inflateSync consumes the whole remaining buffer, so re-derive the used
    // length by deflating nothing: instead, inflate incrementally via the
    // zlib length trick — the deflated stream's end is found by trying the
    // shortest prefix that inflates to `size` bytes. The suite's client
    // writes plain objects, so fall back to a bounded search.
    const used = findDeflateLength(buffer.subarray(offset), size);
    offset += used;
    if (inflated.length !== size) throw new Error('pack: inflated size mismatch');
    if (typeNumber === 6 || typeNumber === 7) {
      const base = baseOid !== null ? out.get(baseOid) : byOffset.get(baseOffset);
      if (base === undefined) throw new Error('pack: delta base missing');
      const data = applyDelta(base.data, inflated);
      const oid = hashObject(base.type, data);
      const object: GitObject = { type: base.type, data };
      out.set(oid, object);
      byOffset.set(start, object);
    } else {
      const type = OBJECT_TYPE_CODES[typeNumber];
      if (type === undefined) throw new Error(`pack: unknown object type ${typeNumber}`);
      const oid = hashObject(type, inflated);
      const object: GitObject = { type, data: inflated };
      out.set(oid, object);
      byOffset.set(start, object);
    }
  }
  return out;
}

/** Find how many bytes of `input` the zlib stream at its start occupies. */
export function findDeflateLength(input: Buffer, wantSize: number): number {
  // Binary-search the shortest prefix that inflates to exactly wantSize.
  let low = 1;
  let high = input.length;
  const tryPrefix = (length: number): boolean => {
    try {
      return inflateSync(input.subarray(0, length)).length === wantSize;
    } catch {
      return false;
    }
  };
  if (tryPrefix(input.length)) {
    // The whole rest inflates to wantSize only when this is the last entry;
    // still, a shorter prefix may be the true end. Search for it.
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (tryPrefix(mid)) high = mid;
      else low = mid + 1;
    }
    return low;
  }
  // The stream does not end at the buffer's end (corrupt pack): report all.
  return input.length;
}

// -------------------------------------------------------------------------------------------
// git graph helpers (all over one repository's object map)

/** All commit oids reachable from `oid`, including `oid` itself. */
export function ancestorsOf(objects: Map<string, GitObject>, oid: string): Set<string> {
  const out = new Set<string>();
  const queue = [oid];
  while (queue.length > 0) {
    const current = queue.pop() as string;
    if (out.has(current)) continue;
    const object = objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    out.add(current);
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return out;
}

/** Whether `ancestor` is an ancestor of (or equal to) `oid`. */
export function isAncestor(objects: Map<string, GitObject>, ancestor: string, oid: string): boolean {
  if (ancestor === oid) return true;
  return ancestorsOf(objects, oid).has(ancestor);
}

/** The first common ancestor of `a` and `b` (breadth-first from `b`). */
export function mergeBaseOf(objects: Map<string, GitObject>, a: string, b: string): string | null {
  const aAncestors = ancestorsOf(objects, a);
  const queue = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift() as string;
    if (seen.has(current)) continue;
    seen.add(current);
    if (aAncestors.has(current)) return current;
    const object = objects.get(current);
    if (object === undefined || object.type !== 'commit') continue;
    for (const parent of parseCommit(object.data).parents) queue.push(parent);
  }
  return null;
}

/** The target of an annotated tag object. */
export function parseTagTarget(data: Buffer): string | null {
  const text = data.toString('utf8');
  const match = /^object ([0-9a-f]{40})$/m.exec(text);
  return match === null ? null : match[1];
}

/** Add a tree and everything under it to `out` (trees and blobs that exist). */
export function collectTreeObjects(objects: Map<string, GitObject>, treeOid: string, out: Map<string, GitObject>): void {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  if (out.has(treeOid)) return;
  out.set(treeOid, tree);
  for (const entry of parseTree(tree.data)) {
    if (entry.mode === '40000') {
      collectTreeObjects(objects, entry.oid, out);
    } else {
      const blob = objects.get(entry.oid);
      if (blob !== undefined && !out.has(entry.oid)) out.set(entry.oid, blob);
    }
  }
}

/** Flatten a tree to path -> {mode, oid}, recursively. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string | null, prefix: string, out: Map<string, { mode: string; oid: string }>): void {
  if (treeOid === null) return;
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== 'tree') return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(objects, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

export interface TreeDiff {
  path: string;
  status: 'added' | 'removed' | 'modified';
  oldOid: string | null;
  newOid: string | null;
  additions: number;
  deletions: number;
}

/** Diff two trees (null = an empty tree). */
export function diffTrees(objects: Map<string, GitObject>, baseTreeOid: string | null, headTreeOid: string | null): TreeDiff[] {
  const base = new Map<string, { mode: string; oid: string }>();
  const head = new Map<string, { mode: string; oid: string }>();
  flattenTree(objects, baseTreeOid, '', base);
  flattenTree(objects, headTreeOid, '', head);
  const out: TreeDiff[] = [];
  const paths = new Set([...base.keys(), ...head.keys()]);
  for (const path of [...paths].sort()) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const content = objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
      out.push({ path, status: 'added', oldOid: null, newOid: newEntry.oid, additions: lineCount(content), deletions: 0 });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const content = objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
      out.push({ path, status: 'removed', oldOid: oldEntry.oid, newOid: null, additions: 0, deletions: lineCount(content) });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldContent = objects.get(oldEntry.oid)?.data.toString('utf8') ?? '';
      const newContent = objects.get(newEntry.oid)?.data.toString('utf8') ?? '';
      const oldLines = oldContent === '' ? [] : oldContent.split('\n');
      const newLines = newContent === '' ? [] : newContent.split('\n');
      const oldFreq = new Map<string, number>();
      for (const line of oldLines) oldFreq.set(line, (oldFreq.get(line) ?? 0) + 1);
      let additions = 0;
      for (const line of newLines) {
        const left = oldFreq.get(line) ?? 0;
        if (left > 0) oldFreq.set(line, left - 1);
        else additions += 1;
      }
      let deletions = 0;
      for (const left of oldFreq.values()) deletions += left;
      out.push({ path, status: 'modified', oldOid: oldEntry.oid, newOid: newEntry.oid, additions, deletions });
    }
  }
  return out;
}

export interface FetchPlan {
  /** The objects to send, sorted by oid for a stable pack. */
  objects: GitObject[];
  /** Commits the client must now treat as shallow boundaries. */
  shallow: string[];
  /** Formerly shallow commits whose history is now complete. */
  unshallow: string[];
}

/**
 * Plan a fetch: the closure of `wants` minus the closure of `haves`, cut at
 * `depth` generations when given. A commit is shallow when it sits on the
 * depth boundary, or when one of its parents is neither sent nor held.
 */
export function planFetch(
  objects: Map<string, GitObject>,
  wants: readonly string[],
  haves: readonly string[],
  depth: number | undefined,
  oldShallow: readonly string[],
): FetchPlan {
  const haveClosure = new Set<string>();
  const shallowSet = new Set(oldShallow);
  for (const have of haves) {
    // The client holds a have itself plus its tree — and, for a have that is
    // not a shallow boundary, its whole ancestry. A shallow boundary is
    // held WITHOUT its parents (that is what makes it a boundary), so the
    // ancestor walk stops there: a deepen fetch must be able to deliver the
    // parent of a held shallow tip.
    const stack = [have];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const oid = stack.pop() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const object = objects.get(oid);
      if (object === undefined || object.type !== 'commit') {
        if (oid !== ZERO_OID && objects.has(oid)) haveClosure.add(oid);
        continue;
      }
      haveClosure.add(oid);
      const found = new Map<string, GitObject>();
      collectTreeObjects(objects, parseCommit(object.data).tree, found);
      for (const treeOid of found.keys()) haveClosure.add(treeOid);
      if (shallowSet.has(oid)) continue;
      for (const parent of parseCommit(object.data).parents) stack.push(parent);
    }
  }
  // Walk from the wants, cut at `depth` generations when given. The walk
  // passes THROUGH commits the client already holds: a deepen fetch asks for
  // the history below a held tip, so held commits are waypoints, not a wall.
  // What the client holds only decides what is SENT, not how far the walk
  // goes.
  const walked = new Map<string, number>();
  const queue: Array<[string, number]> = [];
  const tagTargets: string[] = [];
  for (const want of wants) {
    const object = objects.get(want);
    if (object !== undefined && object.type === 'tag') {
      tagTargets.push(want);
      const target = parseTagTarget(object.data);
      if (target !== null) queue.push([target, 0]);
    } else {
      queue.push([want, 0]);
    }
  }
  for (let head = 0; head < queue.length; head += 1) {
    const [oid, distance] = queue[head] as [string, number];
    if (walked.has(oid)) continue;
    if (depth !== undefined && distance >= depth) continue;
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    walked.set(oid, distance);
    for (const parent of parseCommit(object.data).parents) queue.push([parent, distance + 1]);
  }
  // The commits actually sent: walked, minus what the client holds.
  const sent = new Set<string>();
  for (const oid of walked.keys()) {
    if (!haveClosure.has(oid)) sent.add(oid);
  }
  const shallow: string[] = [];
  for (const oid of sent) {
    const object = objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    if (info.parents.length === 0) continue;
    const distance = walked.get(oid) as number;
    const atBoundary = depth !== undefined && distance === depth - 1;
    const parentMissing = info.parents.some((parent) => !sent.has(parent) && !haveClosure.has(parent));
    if (atBoundary || parentMissing) shallow.push(oid);
  }
  // An old shallow boundary the walk has passed is no longer shallow.
  const unshallow = oldShallow.filter((oid) => walked.has(oid) && !shallow.includes(oid));
  const out = new Map<string, GitObject>();
  for (const oid of sent) {
    const commit = objects.get(oid);
    if (commit === undefined) continue;
    out.set(oid, commit);
    const found = new Map<string, GitObject>();
    collectTreeObjects(objects, parseCommit(commit.data).tree, found);
    for (const [treeOid, treeObject] of found) {
      if (!haveClosure.has(treeOid)) out.set(treeOid, treeObject);
    }
  }
  for (const tagOid of tagTargets) {
    const tag = objects.get(tagOid);
    if (tag !== undefined) out.set(tagOid, tag);
  }
  for (const want of wants) {
    const object = objects.get(want);
    if (object !== undefined && object.type !== 'commit' && object.type !== 'tag' && !out.has(want)) out.set(want, object);
  }
  const sorted = [...out.values()].sort((a, b) => {
    const ao = hashObject(a.type, a.data);
    const bo = hashObject(b.type, b.data);
    return ao < bo ? -1 : ao > bo ? 1 : 0;
  });
  return { objects: sorted, shallow: shallow.sort(), unshallow: unshallow.sort() };
}

// -------------------------------------------------------------------------------------------
// the store

export interface ForgeLabel {
  name: string;
  color: string;
}

export interface ForgeComment {
  id: number;
  body: string;
}

export interface ForgeIssue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: ForgeLabel[];
  comments: ForgeComment[];
  createdSeq: number;
}

export interface ForgePull {
  id: number;
  number: number;
  title: string;
  body: string;
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdSeq: number;
}

export interface ForgeRepo {
  id: number;
  name: string;
  owner: string;
  description: string;
  private: boolean;
  defaultBranch: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: ForgeIssue[];
  pulls: ForgePull[];
  labels: ForgeLabel[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  createdSeq: number;
}

const repos = new Map<string, ForgeRepo>();
let storeSeq = 0;

export function repoKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

export function getRepo(owner: string, name: string): ForgeRepo | undefined {
  return repos.get(repoKey(owner, name));
}

export function listRepos(): ForgeRepo[] {
  return [...repos.values()].sort((a, b) => a.createdSeq - b.createdSeq);
}

export function createRepoRecord(name: string, isPrivate: boolean, description: string, defaultBranch = DEFAULT_BRANCH): ForgeRepo {
  const repo: ForgeRepo = {
    id: nextDatabaseId,
    name,
    owner: VIEWER_LOGIN,
    description,
    private: isPrivate,
    defaultBranch,
    objects: new Map<string, GitObject>(),
    refs: new Map<string, string>(),
    issues: [],
    pulls: [],
    labels: [],
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
    createdSeq: storeSeq,
  };
  nextDatabaseId += 1;
  storeSeq += 1;
  repos.set(repoKey(VIEWER_LOGIN, name), repo);
  return repo;
}

export function deleteRepoRecord(repo: ForgeRepo): void {
  repos.delete(repoKey(repo.owner, repo.name));
}

/** Resolve a ref name, a short branch name or a 40-hex oid to a commit oid. */
export function resolveRef(repo: ForgeRepo, ref: string): string | undefined {
  if (isSha40(ref)) return repo.objects.has(ref) ? ref : undefined;
  if (ref.startsWith('refs/')) return repo.refs.get(ref);
  const branch = repo.refs.get(`refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = repo.refs.get(`refs/tags/${ref}`);
  if (tag !== undefined) return tag;
  return undefined;
}

export function refTip(repo: ForgeRepo, branch: string): string | undefined {
  return repo.refs.get(`refs/heads/${branch}`);
}

export function storeObject(repo: ForgeRepo, type: ObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function makeCommit(repo: ForgeRepo, treeOid: string, parents: readonly string[], message: string): string {
  const ident = forgeIdent();
  const data = buildCommit({ tree: treeOid, parents: [...parents], author: ident, committer: ident, message });
  return storeObject(repo, 'commit', data);
}

/**
 * Set (or delete, with blobOid null) one path in a tree, rebuilding the trees
 * above it; returns the new tree oid. Empty directories are dropped.
 */
export function setTreePath(repo: ForgeRepo, treeOid: string | null, segments: readonly string[], blobOid: string | null): string {
  const head = segments[0] as string;
  const rest = segments.slice(1);
  const entries = treeOid === null ? [] : parseTree(repo.objects.get(treeOid)?.data ?? Buffer.alloc(0));
  const kept = entries.filter((entry) => entry.name !== head);
  if (rest.length === 0) {
    if (blobOid !== null) kept.push({ mode: '100644', name: head, oid: blobOid });
  } else {
    const existing = entries.find((entry) => entry.name === head && entry.mode === '40000');
    const childOid = setTreePath(repo, existing?.oid ?? null, rest, blobOid);
    const child = repo.objects.get(childOid);
    const childEntries = child === undefined ? [] : parseTree(child.data);
    if (childEntries.length > 0) kept.push({ mode: '40000', name: head, oid: childOid });
  }
  const data = buildTree(kept);
  return storeObject(repo, 'tree', data);
}

/** Commit one file's new content on a branch (creating the branch if needed). */
export function commitFileOnBranch(repo: ForgeRepo, branch: string, segments: readonly string[], content: Buffer, message: string): { commitSha: string; contentSha: string } {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const contentSha = storeObject(repo, 'blob', content);
  const treeOid = setTreePath(repo, parentTree, segments, contentSha);
  const commitSha = makeCommit(repo, treeOid, tip === undefined ? [] : [tip], message);
  repo.refs.set(ref, commitSha);
  return { commitSha, contentSha };
}

/** Remove one file on a branch; null when the file is not there. */
export function deleteFileOnBranch(repo: ForgeRepo, branch: string, segments: readonly string[], message: string): string | null {
  const ref = `refs/heads/${branch}`;
  const tip = repo.refs.get(ref);
  if (tip === undefined) return null;
  const parentTree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
  const flat = new Map<string, { mode: string; oid: string }>();
  flattenTree(repo.objects, parentTree, '', flat);
  if (!flat.has(segments.join('/'))) return null;
  const treeOid = setTreePath(repo, parentTree, segments, null);
  const commitSha = makeCommit(repo, treeOid, [tip], message);
  repo.refs.set(ref, commitSha);
  return commitSha;
}

/** The blob oid at a path in a tree, or null when the path is absent/not a file. */
export function blobAtPath(repo: ForgeRepo, treeOid: string | null, segments: readonly string[]): string | null {
  const flat = new Map<string, { mode: string; oid: string }>();
  flattenTree(repo.objects, treeOid, '', flat);
  return flat.get(segments.join('/'))?.oid ?? null;
}

/** Whether merging `pull` would conflict (both sides changed a path, differently). */
export function pullConflicts(repo: ForgeRepo, pull: ForgePull): boolean {
  const headTip = refTip(repo, pull.head);
  const baseTip = refTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return true;
  const base = mergeBaseOf(repo.objects, headTip, baseTip);
  const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
  const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const newBaseTree = parseCommit(repo.objects.get(baseTip)?.data ?? Buffer.alloc(0)).tree;
  const headChanges = new Map(diffTrees(repo.objects, baseTree, headTree).map((d) => [d.path, d]));
  const baseChanges = new Map(diffTrees(repo.objects, baseTree, newBaseTree).map((d) => [d.path, d]));
  for (const [path, headDiff] of headChanges) {
    const baseDiff = baseChanges.get(path);
    if (baseDiff !== undefined && headDiff.newOid !== baseDiff.newOid) return true;
  }
  return false;
}

/**
 * Squash-merge a pull request onto its base branch. Returns the merge commit
 * sha, or null when the pull cannot merge (unknown refs or a conflict).
 */
export function squashMerge(repo: ForgeRepo, pull: ForgePull): string | null {
  const headTip = refTip(repo, pull.head);
  const baseTip = refTip(repo, pull.base);
  if (headTip === undefined || baseTip === undefined) return null;
  if (pullConflicts(repo, pull)) return null;
  const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
  const message = `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`;
  const mergeSha = makeCommit(repo, headTree, [baseTip], message);
  repo.refs.set(`refs/heads/${pull.base}`, mergeSha);
  return mergeSha;
}

/** The ISO timestamp of a forge-made commit's epoch (deterministic). */
export function mergedAtIso(): string {
  return new Date((COMMIT_EPOCH + commitCounter) * 1000).toISOString();
}

// -------------------------------------------------------------------------------------------
// HTTP plumbing

export interface RouteContext {
  req: IncomingMessage;
  res: ServerResponse;
  /** Path segments, decoded, without empty pieces. */
  segments: string[];
  /** The raw pathname (decoded, no trailing slash except for "/"). */
  path: string;
  query: URLSearchParams;
  body: Buffer;
  requestId: string;
}

export function nextRequestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export function sendJson(ctx: RouteContext, status: number, body: unknown, extraHeaders: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const headers: Record<string, string> = {
    'content-type': 'application/json; charset=utf-8',
    'x-github-request-id': ctx.requestId,
    ...extraHeaders,
  };
  if (status !== 204) headers['content-length'] = String(Buffer.byteLength(text));
  ctx.res.writeHead(status, headers);
  ctx.res.end(text);
}

export function sendText(ctx: RouteContext, status: number, body: string, contentType: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

export function sendBytes(ctx: RouteContext, status: number, body: Buffer, contentType: string, extraHeaders: Record<string, string> = {}): void {
  const headers: Record<string, string> = {
    'content-type': contentType,
    'content-length': String(body.length),
    ...extraHeaders,
  };
  ctx.res.writeHead(status, headers);
  ctx.res.end(body);
}

export function jsonError(ctx: RouteContext, status: number, message: string): void {
  sendJson(ctx, status, { message });
}

/** Read the whole request body (cap 32 MiB). */
export function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body; null when the body is empty, throws on malformed JSON. */
export function parseJsonBody(body: Buffer): unknown {
  const text = body.toString('utf8').trim();
  if (text === '') return null;
  return JSON.parse(text) as unknown;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function strField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

export function boolField(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === 'boolean' ? value : undefined;
}

/** The bearer token the request presents, or null. */
export function bearerToken(req: IncomingMessage): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer (.+)$/.exec(header.trim());
  return match === null ? null : match[1] as string;
}

/** Whether the request is authenticated (the suite's token, or any token locally). */
export function isAuthenticated(req: IncomingMessage): boolean {
  const token = bearerToken(req);
  if (token === null || token === '') return false;
  if (SHOP_TOKEN !== '') return token === SHOP_TOKEN;
  return true;
}

// -------------------------------------------------------------------------------------------
// git smart HTTP

const UPLOAD_PACK_CAPS_V0 = 'side-band-64k thin-pack ofs-delta shallow deepen multi_ack_detailed symref=HEAD:refs/heads/main agent=forge/1.0';
const RECEIVE_PACK_CAPS_V0 = 'report-status side-band-64k delete-refs ofs-delta agent=forge/1.0';

/** All refs of a repo, sorted: heads then tags, each as [refname, oid]. */
export function listRefs(repo: ForgeRepo): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [ref, oid] of [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) out.push([ref, oid]);
  return out;
}

/** The peeled commit of a ref (for annotated tags), or null. */
export function peelRef(repo: ForgeRepo, oid: string): string | null {
  const object = repo.objects.get(oid);
  if (object === undefined || object.type !== 'tag') return null;
  return parseTagTarget(object.data);
}

/** A v0 advertisement: service line, flush, ref lines, flush. */
export function advertisementV0(service: string, repo: ForgeRepo, caps: string): Buffer {
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), PKT_FLUSH];
  const refs = listRefs(repo);
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    let first = true;
    for (const [ref, oid] of refs) {
      parts.push(pktLine(first ? `${oid} ${ref}\0${caps}\n` : `${oid} ${ref}\n`));
      first = false;
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v2 advertisement: "version 2", the capabilities, flush. */
export function advertisementV2(): Buffer {
  const parts: Buffer[] = [
    pktLine('version 2\n'),
    pktLine('agent=forge/1.0\n'),
    pktLine('ls-refs=unborn symrefs peel ref-prefix\n'),
    pktLine('fetch=shallow filter\n'),
    pktLine('object-format=sha1\n'),
    PKT_FLUSH,
  ];
  return Buffer.concat(parts);
}

/** Handle GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(ctx: RouteContext, owner: string, repoName: string): void {
  const repo = getRepo(owner, repoName);
  if (owner !== VIEWER_LOGIN || repo === undefined) {
    sendText(ctx, 404, 'repository not found\n', 'text/plain; charset=utf-8');
    return;
  }
  const service = ctx.query.get('service') ?? '';
  if (service === 'git-upload-pack') {
    const protocol = ctx.req.headers['git-protocol'];
    if (protocol === 'version=2') {
      sendBytes(ctx, 200, advertisementV2(), 'application/x-git-upload-pack-advertisement');
    } else {
      sendBytes(ctx, 200, advertisementV0('git-upload-pack', repo, UPLOAD_PACK_CAPS_V0), 'application/x-git-upload-pack-advertisement');
    }
    return;
  }
  if (service === 'git-receive-pack') {
    sendBytes(ctx, 200, advertisementV0('git-receive-pack', repo, RECEIVE_PACK_CAPS_V0), 'application/x-git-receive-pack-advertisement');
    return;
  }
  sendText(ctx, 400, 'missing service parameter\n', 'text/plain; charset=utf-8');
}

interface LsRefsArgs {
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
  prefixes: string[];
}

/** Answer a v2 ls-refs command. */
export function handleLsRefs(ctx: RouteContext, repo: ForgeRepo, args: LsRefsArgs): void {
  const lines: Buffer[] = [];
  const refs = listRefs(repo);
  const wanted = refs.filter(([ref]) => args.prefixes.length === 0 || args.prefixes.some((prefix) => ref.startsWith(prefix)));
  const headTarget = `refs/heads/${repo.defaultBranch}`;
  const headOid = repo.refs.get(headTarget);
  const includeHead = args.prefixes.length === 0 || args.prefixes.some((prefix) => 'HEAD'.startsWith(prefix));
  if (includeHead) {
    if (headOid === undefined) {
      if (args.unborn) lines.push(pktLine(`unborn HEAD symref-target:${headTarget}\n`));
    } else if (args.symrefs) {
      lines.push(pktLine(`${headOid} HEAD symref-target:${headTarget}\n`));
    }
  }
  for (const [ref, oid] of wanted) {
    let line = `${oid} ${ref}`;
    if (args.peel) {
      const peeled = peelRef(repo, oid);
      if (peeled !== null) line += ` peeled:${peeled}`;
    }
    lines.push(pktLine(`${line}\n`));
  }
  lines.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(lines), 'application/x-git-upload-pack-result');
}

export interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  /** Whether the client sent `done` (no more haves will follow). */
  done: boolean;
}

/** Parse a v2 fetch command's pkt-lines. */
export function parseFetchV2(packets: Pkt[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const packet of packets) {
    const text = pktText(packet);
    if (text === null) continue;
    const line = text.replace(/\n$/, '');
    if (line.startsWith('want ')) out.wants.push(line.slice(5).trim());
    else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line === 'done') out.done = true;
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) out.depth = depth;
    }
  }
  return out;
}

/** Parse a v0 fetch request's pkt-lines (want/have/shallow/deepen/done). */
export function parseFetchV0(packets: Pkt[]): FetchRequest {
  const out: FetchRequest = { wants: [], haves: [], shallow: [], depth: undefined, done: false };
  for (const packet of packets) {
    const text = pktText(packet);
    if (text === null) continue;
    const line = text.replace(/\n$/, '');
    if (line.startsWith('want ')) {
      const rest = line.slice(5).trim();
      out.wants.push(rest.split(' ')[0] as string);
    } else if (line.startsWith('have ')) out.haves.push(line.slice(5).trim());
    else if (line.startsWith('shallow ')) out.shallow.push(line.slice(8).trim());
    else if (line === 'done') out.done = true;
    else if (line.startsWith('deepen ')) {
      const depth = Number(line.slice(7).trim());
      if (Number.isInteger(depth) && depth > 0) out.depth = depth;
    }
  }
  return out;
}

/** The newest have that is an ancestor of any want (the common commit), or null. */
export function findCommonCommit(
  objects: Map<string, GitObject>,
  wants: readonly string[],
  haves: readonly string[],
): string | null {
  for (const have of haves) {
    for (const want of wants) {
      if (isAncestor(objects, have, want)) return have;
    }
  }
  return null;
}

/** Answer a v2 fetch: acknowledgments, shallow-info, packfile sections. */
export function handleFetchV2(ctx: RouteContext, repo: ForgeRepo, request: FetchRequest): void {
  const plan = planFetch(repo.objects, request.wants, request.haves, request.depth, request.shallow);
  const pack = writePack(plan.objects);
  // Protocol v2, as git's fetch-pack reads it:
  // - A request that sent `done` goes straight to the packfile: the client
  //   skips the acknowledgments section entirely, so none is sent.
  // - A request with haves but no `done` is a negotiation round, and the
  //   client DOES read the acknowledgments section. When a common commit
  //   exists the section is ACK + a `ready` line of its own, closed with a
  //   DELIM, and the packfile follows in this response. When there is no
  //   common commit the section is NAK closed with a FLUSH and the response
  //   ends there — the client follows up with more haves (or `done`).
  // - A request with no haves never gets an acknowledgments section.
  const parts: Buffer[] = [];
  if (request.haves.length > 0 && !request.done) {
    const common = findCommonCommit(repo.objects, request.wants, request.haves);
    parts.push(pktLine('acknowledgments\n'));
    if (common !== null) {
      parts.push(pktLine(`ACK ${common}\n`), pktLine('ready\n'), PKT_DELIM);
    } else {
      parts.push(pktLine('NAK\n'));
      sendBytes(ctx, 200, Buffer.concat([...parts, PKT_FLUSH]), 'application/x-git-upload-pack-result');
      return;
    }
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  parts.push(pktLine('packfile\n'));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** Answer a v0 fetch: NAK, shallow lines, then the sideband pack. */
export function handleFetchV0(ctx: RouteContext, repo: ForgeRepo, request: FetchRequest): void {
  const plan = planFetch(repo.objects, request.wants, request.haves, request.depth, request.shallow);
  const pack = writePack(plan.objects);
  const parts: Buffer[] = [pktLine('NAK\n')];
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  for (const packet of sidebandPack(pack)) parts.push(packet);
  parts.push(PKT_FLUSH);
  sendBytes(ctx, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

/** Handle POST /{owner}/{repo}.git/git-upload-pack (v2 ls-refs/fetch, v0 fetch). */
export function handleUploadPack(ctx: RouteContext, owner: string, repoName: string): void {
  const repo = getRepo(owner, repoName);
  if (owner !== VIEWER_LOGIN || repo === undefined) {
    sendText(ctx, 404, 'repository not found\n', 'text/plain; charset=utf-8');
    return;
  }
  let packets: Pkt[];
  try {
    packets = decodePktLines(ctx.body).packets;
  } catch {
    sendText(ctx, 400, 'malformed pkt-line stream\n', 'text/plain; charset=utf-8');
    return;
  }
  const first = packets.find((packet) => packet.kind === 'data');
  const firstText = first === undefined ? '' : (pktText(first) ?? '');
  if (firstText.startsWith('command=ls-refs')) {
    const args: LsRefsArgs = { peel: false, symrefs: false, unborn: false, prefixes: [] };
    for (const packet of packets) {
      const text = pktText(packet);
      if (text === null) continue;
      const line = text.replace(/\n$/, '');
      if (line === 'peel') args.peel = true;
      else if (line === 'symrefs') args.symrefs = true;
      else if (line === 'unborn') args.unborn = true;
      else if (line.startsWith('ref-prefix ')) args.prefixes.push(line.slice(11));
    }
    handleLsRefs(ctx, repo, args);
    return;
  }
  if (firstText.startsWith('command=fetch')) {
    handleFetchV2(ctx, repo, parseFetchV2(packets));
    return;
  }
  if (firstText.startsWith('want ')) {
    handleFetchV0(ctx, repo, parseFetchV0(packets));
    return;
  }
  sendText(ctx, 400, 'unknown git-upload-pack command\n', 'text/plain; charset=utf-8');
}

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Handle POST /{owner}/{repo}.git/git-receive-pack (v0, report-status). */
export function handleReceivePack(ctx: RouteContext, owner: string, repoName: string): void {
  const repo = getRepo(owner, repoName);
  if (owner !== VIEWER_LOGIN || repo === undefined) {
    sendText(ctx, 404, 'repository not found\n', 'text/plain; charset=utf-8');
    return;
  }
  let packets: Pkt[];
  let packStart: number;
  try {
    const decoded = decodePktLines(ctx.body);
    packets = decoded.packets;
    packStart = decoded.consumed;
  } catch {
    sendText(ctx, 400, 'malformed pkt-line stream\n', 'text/plain; charset=utf-8');
    return;
  }
  // The command list ends at the first flush; everything after it is the pack.
  const commands: PushCommand[] = [];
  for (const packet of packets) {
    const text = pktText(packet);
    if (text !== null) {
      const line = text.replace(/\n$/, '');
      const nul = line.indexOf('\0');
      const bare = nul >= 0 ? line.slice(0, nul) : line;
      const parts = bare.split(' ');
      if (parts.length >= 3) {
        commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
      }
    }
  }
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = '';
  const packBytes = ctx.body.subarray(packStart);
  if (packBytes.length > 0) {
    try {
      const objects = readPack(packBytes);
      for (const [oid, object] of objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : String(err);
    }
  }
  // Judge every command against the refs as they stood before this push.
  const before = new Map(repo.refs);
  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  for (const command of commands) {
    if (!unpackOk) {
      results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
      continue;
    }
    const current = before.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
      else if (command.oldOid !== ZERO_OID && command.oldOid !== current) results.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
      else {
        repo.refs.delete(command.ref);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        results.push({ ref: command.ref, ok: false, reason: 'already exists' });
      } else if (!repo.objects.has(command.newOid)) {
        results.push({ ref: command.ref, ok: false, reason: 'object not found' });
      } else {
        repo.refs.set(command.ref, command.newOid);
        results.push({ ref: command.ref, ok: true, reason: '' });
      }
      continue;
    }
    if (current === undefined) {
      results.push({ ref: command.ref, ok: false, reason: 'no such ref' });
    } else if (command.oldOid !== current) {
      results.push({ ref: command.ref, ok: false, reason: 'old oid mismatch' });
    } else if (command.newOid === current) {
      results.push({ ref: command.ref, ok: true, reason: '' });
    } else if (!repo.objects.has(command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'object not found' });
    } else if (!isAncestor(repo.objects, current, command.newOid)) {
      results.push({ ref: command.ref, ok: false, reason: 'non-fast-forward' });
    } else {
      repo.refs.set(command.ref, command.newOid);
      results.push({ ref: command.ref, ok: true, reason: '' });
    }
  }
  if (unpackOk) reportLines.push('unpack ok\n');
  else reportLines.push(`unpack ${unpackDetail}\n`);
  for (const result of results) {
    reportLines.push(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`);
  }
  const inner = Buffer.concat([...reportLines.map((line) => pktLine(line)), PKT_FLUSH]);
  const outer = Buffer.concat([sidebandPacket(1, inner), PKT_FLUSH]);
  sendBytes(ctx, 200, outer, 'application/x-git-receive-pack-result');
}

// -------------------------------------------------------------------------------------------
// REST v3

const FIXED_DATE = '2026-11-14T06:30:00.000Z';

export function repoJson(ctx: RouteContext, repo: ForgeRepo): Record<string, unknown> {
  const origin = `http://${ctx.req.headers.host ?? '127.0.0.1'}`;
  return {
    id: repo.id,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `${origin}/${repo.owner}/${repo.name}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    has_issues: true,
    has_pull_requests: true,
  };
}

export function issueJson(ctx: RouteContext, repo: ForgeRepo, issue: ForgeIssue): Record<string, unknown> {
  const origin = `http://${ctx.req.headers.host ?? '127.0.0.1'}`;
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((label) => ({ name: label.name, color: label.color })),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    comments: issue.comments.length,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `${origin}/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}

export function pullJson(ctx: RouteContext, repo: ForgeRepo, pull: ForgePull): Record<string, unknown> {
  const origin = `http://${ctx.req.headers.host ?? '127.0.0.1'}`;
  return {
    id: pull.id,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}` },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}` },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    created_at: FIXED_DATE,
    updated_at: FIXED_DATE,
    html_url: `${origin}/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `${origin}/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}

/** Parse per_page/page and slice a list, with a Link header when paged. */
export function paginate<T>(ctx: RouteContext, items: readonly T[], defaultPerPage = 30): { page: T[]; link: string | null } {
  const perPageRaw = Number(ctx.query.get('per_page') ?? '');
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(100, Math.floor(perPageRaw)) : defaultPerPage;
  const pageRaw = Number(ctx.query.get('page') ?? '');
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? Math.floor(pageRaw) : 1;
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  if (pages <= 1) return { page: [...slice], link: null };
  const origin = `http://${ctx.req.headers.host ?? '127.0.0.1'}`;
  const base = `${origin}${ctx.path}`;
  const params = new URLSearchParams(ctx.query);
  const linkFor = (p: number): string => {
    params.set('per_page', String(perPage));
    params.set('page', String(p));
    return `<${base}?${params.toString()}>`;
  };
  const parts: string[] = [];
  if (page < pages) parts.push(`${linkFor(page + 1)}; rel="next"`);
  if (page > 1) parts.push(`${linkFor(page - 1)}; rel="prev"`);
  parts.push(`${linkFor(1)}; rel="first"`);
  parts.push(`${linkFor(pages)}; rel="last"`);
  return { page: [...slice], link: parts.join(', ') };
}

export function sendPage<T>(ctx: RouteContext, items: readonly T[], toJson: (item: T) => unknown, defaultPerPage = 30): void {
  const { page, link } = paginate(ctx, items, defaultPerPage);
  const headers: Record<string, string> = {};
  if (link !== null) headers.link = link;
  sendJson(ctx, 200, page.map(toJson), headers);
}

/** Load a repository for a REST route: 404 when the owner is foreign or absent. */
export function loadRepo(ctx: RouteContext, owner: string, name: string): ForgeRepo | null {
  if (owner !== VIEWER_LOGIN) return null;
  return getRepo(owner, name) ?? null;
}

export function repoNotFound(ctx: RouteContext): void {
  jsonError(ctx, 404, 'Not Found');
}

/** The commit list of a ref, newest first, walking parents. */
export function listCommits(repo: ForgeRepo, tip: string): Array<{ sha: string; message: string; parents: string[] }> {
  const out: Array<{ sha: string; message: string; parents: string[] }> = [];
  const seen = new Set<string>();
  const queue = [tip];
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== 'commit') continue;
    const info = parseCommit(object.data);
    out.push({ sha: oid, message: info.message, parents: info.parents });
    for (const parent of info.parents) queue.push(parent);
  }
  return out;
}

export function handleRest(ctx: RouteContext): void {
  if (!isAuthenticated(ctx.req)) {
    jsonError(ctx, 401, 'Requires authentication');
    return;
  }
  const method = (ctx.req.method ?? 'GET').toUpperCase();
  const s = ctx.segments;

  // GET /api/v3/ — the root (segments: ['api','v3']).
  if (s.length === 2 && method === 'GET') {
    const origin = `http://${ctx.req.headers.host ?? '127.0.0.1'}`;
    sendJson(ctx, 200, {
      current_user_url: `${origin}/api/v3/user`,
      repository_url: `${origin}/api/v3/repos/{owner}/{repo}`,
      user_repositories_url: `${origin}/api/v3/user/repos`,
    }, { 'x-oauth-scopes': 'repo, user' });
    return;
  }
  // GET /api/v3/meta
  if (s.length === 3 && s[2] === 'meta' && method === 'GET') {
    sendJson(ctx, 200, { installed_version: FORGE_VERSION });
    return;
  }
  // GET /api/v3/user
  if (s.length === 3 && s[2] === 'user' && method === 'GET') {
    sendJson(ctx, 200, { login: VIEWER_LOGIN, id: VIEWER_ID, name: VIEWER_NAME, email: VIEWER_EMAIL, type: 'User' });
    return;
  }
  // /api/v3/user/repos
  if (s.length === 4 && s[2] === 'user' && s[3] === 'repos') {
    if (method === 'GET') {
      sendPage(ctx, listRepos(), (repo) => repoJson(ctx, repo));
      return;
    }
    if (method === 'POST') {
      let body: unknown;
      try {
        body = parseJsonBody(ctx.body);
      } catch {
        jsonError(ctx, 400, 'malformed JSON body');
        return;
      }
      if (!isRecord(body)) {
        jsonError(ctx, 400, 'the request body must be a JSON object');
        return;
      }
      const name = strField(body, 'name');
      if (name === undefined || name === '') {
        jsonError(ctx, 422, 'name is required');
        return;
      }
      if (getRepo(VIEWER_LOGIN, name) !== undefined) {
        jsonError(ctx, 422, 'Repository creation failed: name already exists on this account');
        return;
      }
      const repo = createRepoRecord(name, boolField(body, 'private') ?? false, strField(body, 'description') ?? '', strField(body, 'default_branch') ?? DEFAULT_BRANCH);
      sendJson(ctx, 201, repoJson(ctx, repo));
      return;
    }
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (s.length >= 4 && s[2] === 'repos') {
    const owner = s[3] as string;
    const name = s[4] as string;
    const repo = loadRepo(ctx, owner, name);
    if (repo === null) {
      repoNotFound(ctx);
      return;
    }
    const rest = s.slice(5);
    // /api/v3/repos/{o}/{r}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(ctx, 200, repoJson(ctx, repo));
        return;
      }
      if (method === 'PATCH') {
        let body: unknown;
        try {
          body = parseJsonBody(ctx.body);
        } catch {
          jsonError(ctx, 400, 'malformed JSON body');
          return;
        }
        if (isRecord(body)) {
          const description = strField(body, 'description');
          if (description !== undefined) repo.description = description;
          const isPrivate = boolField(body, 'private');
          if (isPrivate !== undefined) repo.private = isPrivate;
        }
        sendJson(ctx, 200, repoJson(ctx, repo));
        return;
      }
      if (method === 'DELETE') {
        deleteRepoRecord(repo);
        ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
        ctx.res.end();
        return;
      }
    }
    // GET /branches and GET /branches/{branch}
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const branches = listRefs(repo)
          .filter(([ref]) => ref.startsWith('refs/heads/'))
          .map(([ref, oid]) => ({ name: ref.slice('refs/heads/'.length), commit: { sha: oid } }))
          .sort((a, b) => (a.name < b.name ? -1 : 1));
        sendJson(ctx, 200, branches);
        return;
      }
      if (rest.length >= 2 && method === 'GET') {
        const branch = rest.slice(1).join('/');
        const tip = refTip(repo, branch);
        if (tip === undefined) {
          repoNotFound(ctx);
          return;
        }
        sendJson(ctx, 200, { name: branch, commit: { sha: tip } });
        return;
      }
    }
    // GET /commits[?sha=]
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const shaParam = ctx.query.get('sha');
      const tip = shaParam === null ? refTip(repo, repo.defaultBranch) : resolveRef(repo, shaParam);
      if (tip === undefined) {
        repoNotFound(ctx);
        return;
      }
      const commits = listCommits(repo, tip).map((entry) => ({
        sha: entry.sha,
        commit: { message: entry.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, committer: { name: VIEWER_NAME, email: VIEWER_EMAIL } },
        parents: entry.parents.map((parent) => ({ sha: parent })),
      }));
      sendJson(ctx, 200, commits);
      return;
    }
    // POST /git/refs and GET /git/refs/heads/{branch}
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (rest.length === 2 && method === 'POST') {
        let body: unknown;
        try {
          body = parseJsonBody(ctx.body);
        } catch {
          jsonError(ctx, 400, 'malformed JSON body');
          return;
        }
        if (!isRecord(body)) {
          jsonError(ctx, 400, 'the request body must be a JSON object');
          return;
        }
        const ref = strField(body, 'ref');
        const sha = strField(body, 'sha');
        if (ref === undefined || sha === undefined || (!ref.startsWith('refs/heads/') && !ref.startsWith('refs/tags/'))) {
          jsonError(ctx, 422, 'ref and sha are required');
          return;
        }
        if (!repo.objects.has(sha)) {
          jsonError(ctx, 422, 'the sha does not exist in this repository');
          return;
        }
        if (repo.refs.has(ref)) {
          jsonError(ctx, 422, 'Reference already exists');
          return;
        }
        repo.refs.set(ref, sha);
        const object = repo.objects.get(sha);
        sendJson(ctx, 201, { ref, object: { sha, type: object?.type ?? 'commit' } });
        return;
      }
      if (rest.length >= 4 && rest[2] === 'heads' && method === 'GET') {
        const branch = rest.slice(3).join('/');
        const tip = refTip(repo, branch);
        if (tip === undefined) {
          repoNotFound(ctx);
          return;
        }
        sendJson(ctx, 200, { ref: `refs/heads/${branch}`, object: { sha: tip, type: 'commit' } });
        return;
      }
    }
    // /contents/{path...}
    if (rest[0] === 'contents') {
      const path = rest.slice(1).join('/');
      const segments = path === '' ? [] : path.split('/');
      const refParam = ctx.query.get('ref');
      const branch = refParam ?? repo.defaultBranch;
      if (method === 'GET') {
        const tip = refTip(repo, branch);
        if (tip === undefined) {
          repoNotFound(ctx);
          return;
        }
        const treeOid = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        const flat = new Map<string, { mode: string; oid: string }>();
        flattenTree(repo.objects, treeOid, '', flat);
        const blobOid = flat.get(path)?.oid;
        if (blobOid !== undefined) {
          const blob = repo.objects.get(blobOid);
          const data = blob?.data ?? Buffer.alloc(0);
          sendJson(ctx, 200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: segments[segments.length - 1] ?? '',
            path,
            sha: blobOid,
            content: b64encode(data),
          });
          return;
        }
        // A directory: list its direct children.
        const prefix = path === '' ? '' : `${path}/`;
        const children = new Map<string, { type: 'file' | 'dir'; name: string; path: string; sha: string }>();
        for (const [filePath, entry] of flat) {
          if (!filePath.startsWith(prefix)) continue;
          const rest2 = filePath.slice(prefix.length);
          const slash = rest2.indexOf('/');
          if (slash === -1) {
            children.set(rest2, { type: 'file', name: rest2, path: filePath, sha: entry.oid });
          } else {
            const dirName = rest2.slice(0, slash);
            if (!children.has(dirName)) {
              const dirTree = dirTreeOid(repo, treeOid, prefix + dirName);
              children.set(dirName, { type: 'dir', name: dirName, path: `${prefix}${dirName}`, sha: dirTree ?? '' });
            }
          }
        }
        if (children.size === 0) {
          repoNotFound(ctx);
          return;
        }
        sendJson(ctx, 200, [...children.values()].sort((a, b) => (a.name < b.name ? -1 : 1)));
        return;
      }
      if (method === 'PUT') {
        let body: unknown;
        try {
          body = parseJsonBody(ctx.body);
        } catch {
          jsonError(ctx, 400, 'malformed JSON body');
          return;
        }
        if (!isRecord(body)) {
          jsonError(ctx, 400, 'the request body must be a JSON object');
          return;
        }
        const message = strField(body, 'message') ?? `Update ${path}`;
        const contentB64 = strField(body, 'content');
        if (contentB64 === undefined) {
          jsonError(ctx, 422, 'content is required');
          return;
        }
        const putBranch = strField(body, 'branch') ?? repo.defaultBranch;
        let tip = refTip(repo, putBranch);
        if (tip === undefined) {
          // A new branch starts from the default branch tip (or from nothing
          // on an unborn repository).
          const defaultTip = refTip(repo, repo.defaultBranch);
          if (defaultTip !== undefined) repo.refs.set(`refs/heads/${putBranch}`, defaultTip);
          tip = refTip(repo, putBranch);
        }
        const parentTree = tip === undefined ? null : parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        const currentBlob = blobAtPath(repo, parentTree, segments);
        const wantSha = strField(body, 'sha');
        if (currentBlob !== null) {
          if (wantSha === undefined || wantSha.toLowerCase() !== currentBlob.toLowerCase()) {
            jsonError(ctx, 409, 'the sha does not match the current file');
            return;
          }
        }
        const content = b64decodeLoose(contentB64);
        const { commitSha, contentSha } = commitFileOnBranch(repo, putBranch, segments, content, message);
        sendJson(ctx, currentBlob === null ? 201 : 200, {
          content: { name: segments[segments.length - 1] ?? '', path, sha: contentSha, size: content.length, type: 'file', encoding: 'base64' },
          commit: { sha: commitSha, message },
        });
        return;
      }
      if (method === 'DELETE') {
        let body: unknown;
        try {
          body = parseJsonBody(ctx.body);
        } catch {
          jsonError(ctx, 400, 'malformed JSON body');
          return;
        }
        const message = isRecord(body) ? strField(body, 'message') ?? `Delete ${path}` : `Delete ${path}`;
        const wantSha = isRecord(body) ? strField(body, 'sha') : undefined;
        const tip = refTip(repo, branch);
        if (tip === undefined) {
          repoNotFound(ctx);
          return;
        }
        const parentTree = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        const currentBlob = blobAtPath(repo, parentTree, segments);
        if (currentBlob === null) {
          repoNotFound(ctx);
          return;
        }
        if (wantSha !== undefined && wantSha.toLowerCase() !== currentBlob.toLowerCase()) {
          jsonError(ctx, 409, 'the sha does not match the current file');
          return;
        }
        const commitSha = deleteFileOnBranch(repo, branch, segments, message);
        if (commitSha === null) {
          repoNotFound(ctx);
          return;
        }
        sendJson(ctx, 200, { commit: { sha: commitSha, message } });
        return;
      }
    }
    // /labels
    if (rest[0] === 'labels') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(ctx, 200, repo.labels.map((label) => ({ name: label.name, color: label.color })));
        return;
      }
      if (rest.length === 1 && method === 'POST') {
        let body: unknown;
        try {
          body = parseJsonBody(ctx.body);
        } catch {
          jsonError(ctx, 400, 'malformed JSON body');
          return;
        }
        if (!isRecord(body)) {
          jsonError(ctx, 400, 'the request body must be a JSON object');
          return;
        }
        const name = strField(body, 'name');
        if (name === undefined || name === '') {
          jsonError(ctx, 422, 'name is required');
          return;
        }
        const color = strField(body, 'color') ?? 'ededed';
        const existing = repo.labels.find((label) => label.name === name);
        if (existing !== undefined) {
          sendJson(ctx, 201, { name: existing.name, color: existing.color });
          return;
        }
        repo.labels.push({ name, color });
        sendJson(ctx, 201, { name, color });
        return;
      }
    }
    // /issues[/{n}[/comments]]
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const direction = ctx.query.get('direction') ?? 'desc';
          let list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
          list = [...list].sort((a, b) => (direction === 'asc' ? a.createdSeq - b.createdSeq : b.createdSeq - a.createdSeq));
          sendPage(ctx, list, (issue) => issueJson(ctx, repo, issue));
          return;
        }
        if (method === 'POST') {
          let body: unknown;
          try {
            body = parseJsonBody(ctx.body);
          } catch {
            jsonError(ctx, 400, 'malformed JSON body');
            return;
          }
          if (!isRecord(body)) {
            jsonError(ctx, 400, 'the request body must be a JSON object');
            return;
          }
          const title = strField(body, 'title');
          if (title === undefined || title === '') {
            jsonError(ctx, 422, 'title is required');
            return;
          }
          const labelNames = Array.isArray(body.labels) ? (body.labels as unknown[]).filter((v): v is string => typeof v === 'string') : [];
          const labels: ForgeLabel[] = [];
          for (const labelName of labelNames) {
            const found = repo.labels.find((label) => label.name === labelName);
            if (found === undefined) {
              jsonError(ctx, 422, `Label does not exist: ${labelName}`);
              return;
            }
            labels.push(found);
          }
          const issue: ForgeIssue = {
            id: nextGlobalId,
            number: repo.nextIssue,
            title,
            body: strField(body, 'body') ?? '',
            state: 'open',
            labels,
            comments: [],
            createdSeq: storeSeq,
          };
          nextGlobalId += 1;
          repo.nextIssue += 1;
          storeSeq += 1;
          repo.issues.push(issue);
          sendJson(ctx, 201, issueJson(ctx, repo, issue));
          return;
        }
      }
      const number = Number(rest[1]);
      const issue = Number.isInteger(number) ? repo.issues.find((entry) => entry.number === number) : undefined;
      if (issue === undefined) {
        repoNotFound(ctx);
        return;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(ctx, 200, issueJson(ctx, repo, issue));
          return;
        }
        if (method === 'PATCH') {
          let body: unknown;
          try {
            body = parseJsonBody(ctx.body);
          } catch {
            jsonError(ctx, 400, 'malformed JSON body');
            return;
          }
          if (isRecord(body)) {
            const state = strField(body, 'state');
            if (state === 'open' || state === 'closed') issue.state = state;
            const title = strField(body, 'title');
            if (title !== undefined) issue.title = title;
            const bodyText = strField(body, 'body');
            if (bodyText !== undefined) issue.body = bodyText;
          }
          sendJson(ctx, 200, issueJson(ctx, repo, issue));
          return;
        }
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendJson(ctx, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body })));
          return;
        }
        if (method === 'POST') {
          let body: unknown;
          try {
            body = parseJsonBody(ctx.body);
          } catch {
            jsonError(ctx, 400, 'malformed JSON body');
            return;
          }
          const text = isRecord(body) ? strField(body, 'body') : undefined;
          if (text === undefined) {
            jsonError(ctx, 422, 'body is required');
            return;
          }
          const comment: ForgeComment = { id: repo.nextComment, body: text };
          repo.nextComment += 1;
          issue.comments.push(comment);
          sendJson(ctx, 201, { id: comment.id, body: comment.body });
          return;
        }
      }
    }
    // /pulls[/{n}[/files|/merge]]
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = ctx.query.get('state') ?? 'open';
          const list = repo.pulls.filter((pull) => state === 'all' || pull.state === state);
          sendPage(ctx, list, (pull) => pullJson(ctx, repo, pull));
          return;
        }
        if (method === 'POST') {
          let body: unknown;
          try {
            body = parseJsonBody(ctx.body);
          } catch {
            jsonError(ctx, 400, 'malformed JSON body');
            return;
          }
          if (!isRecord(body)) {
            jsonError(ctx, 400, 'the request body must be a JSON object');
            return;
          }
          const head = strField(body, 'head');
          const base = strField(body, 'base');
          const title = strField(body, 'title');
          if (head === undefined || base === undefined || title === undefined) {
            jsonError(ctx, 422, 'head, base and title are required');
            return;
          }
          const headSha = refTip(repo, head);
          const baseSha = refTip(repo, base);
          if (headSha === undefined || baseSha === undefined) {
            jsonError(ctx, 422, 'head or base branch does not exist');
            return;
          }
          const duplicate = repo.pulls.find((pull) => pull.head === head && pull.base === base && pull.state === 'open');
          if (duplicate !== undefined) {
            jsonError(ctx, 422, 'A pull request already exists for these branches');
            return;
          }
          const pull: ForgePull = {
            id: nextGlobalId,
            number: repo.nextPull,
            title,
            body: strField(body, 'body') ?? '',
            head,
            base,
            headSha,
            baseSha,
            state: 'open',
            merged: false,
            mergedAt: null,
            mergeCommitSha: null,
            createdSeq: storeSeq,
          };
          nextGlobalId += 1;
          repo.nextPull += 1;
          storeSeq += 1;
          repo.pulls.push(pull);
          sendJson(ctx, 201, pullJson(ctx, repo, pull));
          return;
        }
      }
      const number = Number(rest[1]);
      const pull = Number.isInteger(number) ? repo.pulls.find((entry) => entry.number === number) : undefined;
      if (pull === undefined) {
        repoNotFound(ctx);
        return;
      }
      if (rest.length === 2 && method === 'GET') {
        sendJson(ctx, 200, pullJson(ctx, repo, pull));
        return;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const headTip = refTip(repo, pull.head);
        const baseTip = refTip(repo, pull.base);
        if (headTip === undefined || baseTip === undefined) {
          repoNotFound(ctx);
          return;
        }
        const base = mergeBaseOf(repo.objects, headTip, baseTip);
        const baseTree = base === null ? null : parseCommit(repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
        const headTree = parseCommit(repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
        const files = diffTrees(repo.objects, baseTree, headTree).map((diff) => ({
          filename: diff.path,
          status: diff.status,
          additions: diff.additions,
          deletions: diff.deletions,
          changes: diff.additions + diff.deletions,
        }));
        sendJson(ctx, 200, files);
        return;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (pull.state !== 'open' || pull.merged) {
          jsonError(ctx, 405, 'Pull request is already merged or closed');
          return;
        }
        const mergeSha = squashMerge(repo, pull);
        if (mergeSha === null) {
          jsonError(ctx, 405, 'Merge conflict: the head branch conflicts with the base branch');
          return;
        }
        pull.state = 'closed';
        pull.merged = true;
        pull.mergedAt = mergedAtIso();
        pull.mergeCommitSha = mergeSha;
        sendJson(ctx, 200, { sha: mergeSha, merged: true, message: 'Pull request successfully merged' });
        return;
      }
    }
  }

  jsonError(ctx, 404, 'Not Found');
}

/** The tree oid of a directory inside a tree, or null. */
export function dirTreeOid(repo: ForgeRepo, treeOid: string, dirPath: string): string | null {
  const segments = dirPath.split('/').filter((part) => part !== '');
  let current: string | null = treeOid;
  for (const segment of segments) {
    if (current === null) return null;
    const tree = repo.objects.get(current);
    if (tree === undefined || tree.type !== 'tree') return null;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === segment && candidate.mode === '40000');
    if (entry === undefined) return null;
    current = entry.oid;
  }
  return current;
}

// -------------------------------------------------------------------------------------------
// GraphQL — a small recursive-descent parser plus an executor for the shapes the suite uses.

export type GqlValue =
  | string
  | number
  | boolean
  | null
  | { enum: string }
  | { variable: string }
  | GqlValue[]
  | { [key: string]: GqlValue };

export interface GqlField {
  name: string;
  alias: string | null;
  args: Record<string, GqlValue>;
  children: GqlField[] | null;
}

export interface GqlOperation {
  type: 'query' | 'mutation';
  name: string | null;
  fields: GqlField[];
}

interface GqlToken {
  kind: 'punct' | 'name' | 'string' | 'int' | 'float';
  value: string;
}

export function tokenizeGraphQL(source: string): GqlToken[] {
  const tokens: GqlToken[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i] as string;
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '.' && source.slice(i, i + 3) === '...') {
      tokens.push({ kind: 'punct', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():!=$@[]'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1] as string;
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc === 'u' ? '' : esc;
          j += 2;
        } else {
          value += source[j] as string;
          j += 1;
        }
      }
      if (j >= source.length) throw new Error('Unterminated string in GraphQL document');
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      if (source[j] === '-') j += 1;
      while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      let isFloat = false;
      if (source[j] === '.') {
        isFloat = true;
        j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      if (source[j] === 'e' || source[j] === 'E') {
        isFloat = true;
        j += 1;
        if (source[j] === '+' || source[j] === '-') j += 1;
        while (j < source.length && /[0-9]/.test(source[j] as string)) j += 1;
      }
      tokens.push({ kind: isFloat ? 'float' : 'int', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j] as string)) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    throw new Error(`Unexpected character ${JSON.stringify(ch)} in GraphQL document`);
  }
  return tokens;
}

export class GqlParser {
  private tokens: GqlToken[];
  private pos = 0;
  private fragments = new Map<string, GqlField[]>();

  constructor(source: string) {
    this.tokens = tokenizeGraphQL(source);
  }

  private peek(): GqlToken | undefined {
    return this.tokens[this.pos];
  }

  private next(): GqlToken {
    const token = this.tokens[this.pos];
    if (token === undefined) throw new Error('Unexpected end of GraphQL document');
    this.pos += 1;
    return token;
  }

  private expectPunct(value: string): void {
    const token = this.next();
    if (token.kind !== 'punct' || token.value !== value) throw new Error(`Expected "${value}" in GraphQL document, got "${token.value}"`);
  }

  parseDocument(): GqlOperation[] {
    const operations: GqlOperation[] = [];
    while (this.pos < this.tokens.length) {
      const token = this.peek() as GqlToken;
      if (token.kind === 'punct' && token.value === '{') {
        operations.push({ type: 'query', name: null, fields: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation')) {
        const type = this.next().value as 'query' | 'mutation';
        let name: string | null = null;
        const maybeName = this.peek();
        if (maybeName !== undefined && maybeName.kind === 'name') name = this.next().value;
        if (this.peek()?.value === '(') this.skipVariableDefinitions();
        operations.push({ type, name, fields: this.parseSelectionSet() });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        const on = this.next();
        if (on.value !== 'on') throw new Error('Expected "on" after a fragment name');
        this.next();
        this.fragments.set(fragName, this.parseSelectionSet());
      } else {
        throw new Error(`Unexpected token "${token.value}" in GraphQL document`);
      }
    }
    return operations;
  }

  private skipVariableDefinitions(): void {
    let depth = 0;
    while (this.pos < this.tokens.length) {
      const token = this.next();
      if (token.value === '(') depth += 1;
      else if (token.value === ')') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
  }

  private parseSelectionSet(): GqlField[] {
    this.expectPunct('{');
    const fields: GqlField[] = [];
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('Unterminated selection set in GraphQL document');
      if (token.kind === 'punct' && token.value === '}') break;
      fields.push(...this.parseSelection());
    }
    this.expectPunct('}');
    return fields;
  }

  private parseSelection(): GqlField[] {
    const token = this.peek() as GqlToken;
    if (token.kind === 'punct' && token.value === '...') {
      this.next();
      const nextToken = this.peek();
      if (nextToken !== undefined && nextToken.kind === 'name' && nextToken.value === 'on') {
        this.next();
        this.next();
        return this.parseSelectionSet();
      }
      if (nextToken !== undefined && nextToken.kind === 'name') {
        const fragName = this.next().value;
        const spread = this.fragments.get(fragName);
        if (spread === undefined) throw new Error(`Unknown fragment "${fragName}"`);
        return [...spread];
      }
      return this.parseSelectionSet();
    }
    let name = this.next().value;
    let alias: string | null = null;
    if (this.peek()?.value === ':') {
      this.next();
      alias = name;
      name = this.next().value;
    }
    const args = this.peek()?.value === '(' ? this.parseArguments() : {};
    const children = this.peek()?.value === '{' ? this.parseSelectionSet() : null;
    return [{ name, alias, args, children }];
  }

  private parseArguments(): Record<string, GqlValue> {
    this.expectPunct('(');
    const args: Record<string, GqlValue> = {};
    while (true) {
      const token = this.peek();
      if (token === undefined) throw new Error('Unterminated argument list in GraphQL document');
      if (token.kind === 'punct' && token.value === ')') break;
      const argName = this.next().value;
      this.expectPunct(':');
      args[argName] = this.parseValue();
    }
    this.expectPunct(')');
    return args;
  }

  private parseValue(): GqlValue {
    const token = this.next();
    if (token.kind === 'punct' && token.value === '$') return { variable: this.next().value };
    if (token.kind === 'punct' && token.value === '[') {
      const items: GqlValue[] = [];
      while (this.peek()?.value !== ']') items.push(this.parseValue());
      this.next();
      return items;
    }
    if (token.kind === 'punct' && token.value === '{') {
      const obj: Record<string, GqlValue> = {};
      while (this.peek()?.value !== '}') {
        const key = this.next().value;
        this.expectPunct(':');
        obj[key] = this.parseValue();
      }
      this.next();
      return obj;
    }
    if (token.kind === 'string') return token.value;
    if (token.kind === 'int') return parseInt(token.value, 10);
    if (token.kind === 'float') return parseFloat(token.value);
    if (token.kind === 'name') {
      if (token.value === 'true') return true;
      if (token.value === 'false') return false;
      if (token.value === 'null') return null;
      return { enum: token.value };
    }
    throw new Error(`Unexpected value token "${token.value}" in GraphQL document`);
  }
}

// -------------------------------------------------------------------------------------------
// GraphQL execution

export type GqlNode =
  | { kind: 'query' }
  | { kind: 'mutationRoot' }
  | { kind: 'viewer' }
  | { kind: 'user' }
  | { kind: 'repository'; repo: ForgeRepo }
  | { kind: 'issue'; repo: ForgeRepo; issue: ForgeIssue }
  | { kind: 'pull'; repo: ForgeRepo; pull: ForgePull }
  | { kind: 'issueConnection'; repo: ForgeRepo; issues: ForgeIssue[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'pullConnection'; repo: ForgeRepo; pulls: ForgePull[]; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'pageInfo'; hasNextPage: boolean; endCursor: string | null }
  | { kind: 'branchRef'; name: string }
  | { kind: 'file'; path: string }
  | { kind: 'fileConnection'; files: string[] }
  | { kind: 'comment'; id: string; body: string }
  | { kind: 'commentEdge'; comment: { id: string; body: string } }
  | { kind: 'type'; name: string }
  | { kind: 'typeField'; name: string }
  | { kind: 'enumValue'; name: string }
  | { kind: 'createIssuePayload'; issue: ForgeIssue; repo: ForgeRepo }
  | { kind: 'closeIssuePayload'; issue: ForgeIssue; repo: ForgeRepo }
  | { kind: 'createPullPayload'; pull: ForgePull; repo: ForgeRepo }
  | { kind: 'mergePullPayload'; pull: ForgePull; repo: ForgeRepo }
  | { kind: 'addCommentPayload'; comment: { id: string; body: string } };

export const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
  User: ['login', 'id'],
  Query: ['viewer', 'repository', 'node', 'search', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
};

export const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

/** An opaque, stable global id for a node. */
export function globalId(...parts: Array<string | number>): string {
  return b64urlEncode(parts.join(':'));
}

export function decodeGlobalId(id: string): string[] | null {
  try {
    const text = Buffer.from(id.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parts = text.split(':');
    if (parts.length < 2) return null;
    return parts;
  } catch {
    return null;
  }
}

export function resolveArgValue(value: GqlValue, variables: Record<string, unknown>): unknown {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    if ('variable' in value) return variables[(value as { variable: string }).variable] ?? null;
    if ('enum' in value) return (value as { enum: string }).enum;
    const out: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, GqlValue>)) out[key] = resolveArgValue(entry, variables);
    return out;
  }
  if (Array.isArray(value)) return value.map((entry) => resolveArgValue(entry, variables));
  return value;
}

export function argString(field: GqlField, name: string, variables: Record<string, unknown>): string | undefined {
  const value = resolveArgValue(field.args[name] as GqlValue, variables);
  return typeof value === 'string' ? value : undefined;
}

export function argInt(field: GqlField, name: string, variables: Record<string, unknown>): number | undefined {
  const value = resolveArgValue(field.args[name] as GqlValue, variables);
  return typeof value === 'number' ? value : undefined;
}

export function argRecord(field: GqlField, name: string, variables: Record<string, unknown>): Record<string, unknown> | undefined {
  const value = resolveArgValue(field.args[name] as GqlValue, variables);
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export const UNRESOLVED = Symbol('unresolved');

export function typeNameOf(node: GqlNode): string {
  switch (node.kind) {
    case 'query':
      return 'Query';
    case 'mutationRoot':
      return 'Mutation';
    case 'viewer':
      return 'Viewer';
    case 'user':
      return 'User';
    case 'repository':
      return 'Repository';
    case 'issue':
      return 'Issue';
    case 'pull':
      return 'PullRequest';
    case 'issueConnection':
      return 'IssueConnection';
    case 'pullConnection':
      return 'PullRequestConnection';
    case 'pageInfo':
      return 'PageInfo';
    case 'branchRef':
      return 'Ref';
    case 'file':
      return 'PullRequestChangedFile';
    case 'fileConnection':
      return 'PullRequestChangedFileConnection';
    case 'comment':
      return 'IssueComment';
    case 'commentEdge':
      return 'IssueCommentEdge';
    case 'type':
      return '__Type';
    case 'typeField':
      return '__Field';
    case 'enumValue':
      return '__EnumValue';
    default:
      return 'Object';
  }
}

export function invalidFieldError(node: GqlNode, field: GqlField): { message: string } {
  return { message: `noSuchFieldOn${typeNameOf(node)}: Cannot query field "${field.name}" on type "${typeNameOf(node)}".` };
}

/** Paginate a list of issues the way the suite expects: first + after cursor. */
export function paginateIssues(repo: ForgeRepo, issues: ForgeIssue[], first: number | undefined, after: string | undefined): { page: ForgeIssue[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (after !== undefined && after !== null) {
    const parts = decodeGlobalId(after);
    if (parts !== null && parts[0] === 'issue') {
      const index = issues.findIndex((issue) => issue.number === Number(parts[2]));
      if (index >= 0) start = index + 1;
    }
  }
  const size = first === undefined ? issues.length : Math.max(0, first);
  const page = issues.slice(start, start + size);
  const hasNextPage = start + page.length < issues.length;
  const endCursor = page.length === 0 ? null : globalId('issue', repo.id, page[page.length - 1]?.number ?? 0);
  return { page, hasNextPage, endCursor };
}

export function sortIssues(issues: ForgeIssue[], orderBy: Record<string, unknown> | undefined, states: string[] | undefined): ForgeIssue[] {
  let list = [...issues];
  if (states !== undefined && states.length > 0) {
    const wanted = new Set(states.map((state) => (state === 'OPEN' ? 'open' : state === 'CLOSED' ? 'closed' : state.toLowerCase())));
    list = list.filter((issue) => wanted.has(issue.state));
  }
  const field = typeof orderBy?.field === 'string' ? orderBy.field : 'CREATED_AT';
  const direction = typeof orderBy?.direction === 'string' ? orderBy.direction : 'ASC';
  if (field === 'CREATED_AT') {
    list.sort((a, b) => (direction === 'DESC' ? b.createdSeq - a.createdSeq : a.createdSeq - b.createdSeq));
  }
  return list;
}

export function resolveField(node: GqlNode, field: GqlField, variables: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  if (field.name === '__typename') return typeNameOf(node);
  const children = field.children;
  const resolveChildren = (child: GqlNode): unknown => (children === null ? null : resolveFields(child, children, variables, errors));

  switch (node.kind) {
    case 'query': {
      if (field.name === 'viewer') return resolveChildren({ kind: 'viewer' });
      if (field.name === 'repository') {
        const owner = argString(field, 'owner', variables);
        const name = argString(field, 'name', variables);
        const repo = owner !== undefined && name !== undefined ? loadRepoByName(owner, name) : undefined;
        if (repo === undefined) return null;
        return resolveChildren({ kind: 'repository', repo });
      }
      if (field.name === 'node') {
        const id = argString(field, 'id', variables);
        if (id === undefined) return null;
        const parts = decodeGlobalId(id);
        if (parts === null || parts[0] !== 'repo') return null;
        const repo = [...repos.values()].find((candidate) => candidate.id === Number(parts[1]));
        if (repo === undefined) return null;
        return resolveChildren({ kind: 'repository', repo });
      }
      if (field.name === '__type') {
        const name = argString(field, 'name', variables);
        if (name === undefined) return null;
        if (GQL_TYPE_FIELDS[name] === undefined && GQL_TYPE_ENUMS[name] === undefined) return null;
        return resolveChildren({ kind: 'type', name });
      }
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'mutationRoot': {
      return resolveMutationField(field, variables, errors);
    }
    case 'viewer':
    case 'user': {
      if (field.name === 'login') return VIEWER_LOGIN;
      if (node.kind === 'user' && field.name === 'id') return String(VIEWER_ID);
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'repository': {
      const repo = node.repo;
      switch (field.name) {
        case 'id':
          return globalId('repo', repo.id);
        case 'databaseId':
          return repo.id;
        case 'name':
          return repo.name;
        case 'nameWithOwner':
          return `${repo.owner}/${repo.name}`;
        case 'owner':
          return resolveChildren({ kind: 'user' });
        case 'defaultBranchRef': {
          return resolveChildren({ kind: 'branchRef', name: repo.defaultBranch });
        }
        case 'viewerPermission':
          return 'ADMIN';
        case 'hasIssuesEnabled':
          return true;
        case 'issue': {
          const number = argInt(field, 'number', variables);
          const issue = number === undefined ? undefined : repo.issues.find((entry) => entry.number === number);
          if (issue === undefined) return null;
          return resolveChildren({ kind: 'issue', repo, issue });
        }
        case 'issues': {
          const first = argInt(field, 'first', variables);
          const after = argString(field, 'after', variables);
          const statesRaw = resolveArgValue(field.args.states as GqlValue, variables);
          const states = Array.isArray(statesRaw) ? (statesRaw as unknown[]).filter((v): v is string => typeof v === 'string') : undefined;
          const orderBy = argRecord(field, 'orderBy', variables);
          const sorted = sortIssues(repo.issues, orderBy, states);
          const { page, hasNextPage, endCursor } = paginateIssues(repo, sorted, first, after);
          return resolveChildren({ kind: 'issueConnection', repo, issues: page, hasNextPage, endCursor });
        }
        case 'pullRequests': {
          const first = argInt(field, 'first', variables);
          const list = first === undefined ? repo.pulls : repo.pulls.slice(0, first);
          return resolveChildren({ kind: 'pullConnection', repo, pulls: list, hasNextPage: first !== undefined && repo.pulls.length > first, endCursor: null });
        }
        case 'pullRequest': {
          const number = argInt(field, 'number', variables);
          const pull = number === undefined ? undefined : repo.pulls.find((entry) => entry.number === number);
          if (pull === undefined) return null;
          return resolveChildren({ kind: 'pull', repo, pull });
        }
        default:
          errors.push(invalidFieldError(node, field));
          return UNRESOLVED;
      }
    }
    case 'issue': {
      switch (field.name) {
        case 'id':
          return globalId('issue', node.repo.id, node.issue.number);
        case 'number':
          return node.issue.number;
        case 'title':
          return node.issue.title;
        case 'state':
          return node.issue.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'body':
          return node.issue.body;
        default:
          errors.push(invalidFieldError(node, field));
          return UNRESOLVED;
      }
    }
    case 'pull': {
      const pull = node.pull;
      switch (field.name) {
        case 'id':
          return globalId('pull', node.repo.id, pull.number);
        case 'number':
          return pull.number;
        case 'state':
          return pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED';
        case 'merged':
          return pull.merged;
        case 'headRefName':
          return pull.head;
        case 'baseRefName':
          return pull.base;
        case 'mergeable': {
          if (pull.state !== 'open') return 'UNKNOWN';
          const conflicts = pullConflicts(node.repo, pull);
          if (conflicts === null) return 'UNKNOWN';
          return conflicts ? 'CONFLICTING' : 'MERGEABLE';
        }
        case 'files': {
          const headTip = refTip(node.repo, pull.head);
          const baseTip = refTip(node.repo, pull.base);
          if (headTip === undefined || baseTip === undefined) return resolveChildren({ kind: 'fileConnection', files: [] });
          const base = mergeBaseOf(node.repo.objects, headTip, baseTip);
          const baseTree = base === null ? null : parseCommit(node.repo.objects.get(base)?.data ?? Buffer.alloc(0)).tree;
          const headTree = parseCommit(node.repo.objects.get(headTip)?.data ?? Buffer.alloc(0)).tree;
          const files = diffTrees(node.repo.objects, baseTree, headTree).map((diff) => diff.path);
          const first = argInt(field, 'first', variables);
          const page = first === undefined ? files : files.slice(0, first);
          return resolveChildren({ kind: 'fileConnection', files: page });
        }
        default:
          errors.push(invalidFieldError(node, field));
          return UNRESOLVED;
      }
    }
    case 'issueConnection': {
      if (field.name === 'nodes') {
        if (children === null) return node.issues.map(() => null);
        return node.issues.map((issue) => resolveFields({ kind: 'issue', repo: node.repo, issue }, children, variables, errors));
      }
      if (field.name === 'pageInfo') return resolveChildren({ kind: 'pageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor });
      if (field.name === 'totalCount') return node.issues.length;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'pullConnection': {
      if (field.name === 'nodes') {
        if (children === null) return node.pulls.map(() => null);
        return node.pulls.map((pull) => resolveFields({ kind: 'pull', repo: node.repo, pull }, children, variables, errors));
      }
      if (field.name === 'pageInfo') return resolveChildren({ kind: 'pageInfo', hasNextPage: node.hasNextPage, endCursor: node.endCursor });
      if (field.name === 'totalCount') return node.pulls.length;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'pageInfo': {
      if (field.name === 'hasNextPage') return node.hasNextPage;
      if (field.name === 'endCursor') return node.endCursor;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'branchRef': {
      if (field.name === 'name') return node.name;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'file': {
      if (field.name === 'path') return node.path;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'fileConnection': {
      if (field.name === 'nodes') {
        if (children === null) return node.files.map(() => null);
        return node.files.map((path) => resolveFields({ kind: 'file', path }, children, variables, errors));
      }
      if (field.name === 'totalCount') return node.files.length;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'comment': {
      if (field.name === 'id') return node.id;
      if (field.name === 'body') return node.body;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'commentEdge': {
      if (field.name === 'node') return resolveChildren({ kind: 'comment', id: node.comment.id, body: node.comment.body });
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'type': {
      if (field.name === 'name') return node.name;
      if (field.name === 'fields') {
        const names = GQL_TYPE_FIELDS[node.name] ?? [];
        if (children === null) return names.map(() => null);
        return names.map((name) => resolveFields({ kind: 'typeField', name }, children, variables, errors));
      }
      if (field.name === 'enumValues') {
        const names = GQL_TYPE_ENUMS[node.name] ?? [];
        if (children === null) return names.map(() => null);
        return names.map((name) => resolveFields({ kind: 'enumValue', name }, children, variables, errors));
      }
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'typeField':
    case 'enumValue': {
      if (field.name === 'name') return node.name;
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'createIssuePayload':
    case 'closeIssuePayload': {
      if (field.name === 'issue') return resolveChildren({ kind: 'issue', repo: node.repo, issue: node.issue });
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'createPullPayload':
    case 'mergePullPayload': {
      if (field.name === 'pullRequest') return resolveChildren({ kind: 'pull', repo: node.repo, pull: node.pull });
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    case 'addCommentPayload': {
      if (field.name === 'commentEdge') return resolveChildren({ kind: 'commentEdge', comment: node.comment });
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
    }
    default:
      errors.push(invalidFieldError(node, field));
      return UNRESOLVED;
  }
}

export function resolveFields(node: GqlNode, fields: GqlField[], variables: Record<string, unknown>, errors: Array<{ message: string }>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of fields) {
    const key = field.alias ?? field.name;
    const value = resolveField(node, field, variables, errors);
    out[key] = value === UNRESOLVED ? null : value;
  }
  return out;
}

/** A repository looked up by owner+name for GraphQL (viewer-owned only). */
export function loadRepoByName(owner: string, name: string): ForgeRepo | undefined {
  if (owner !== VIEWER_LOGIN) return undefined;
  return getRepo(owner, name);
}

export function resolveMutationField(field: GqlField, variables: Record<string, unknown>, errors: Array<{ message: string }>): unknown {
  const children = field.children;
  const input = argRecord(field, 'input', variables) ?? {};
  const resolveChildren = (child: GqlNode): unknown => (children === null ? null : resolveFields(child, children, variables, errors));

  if (field.name === 'createIssue') {
    const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = repoId !== null && repoId[0] === 'repo' ? [...repos.values()].find((candidate) => candidate.id === Number(repoId[1])) : undefined;
    const title = typeof input.title === 'string' ? input.title : undefined;
    if (repo === undefined || title === undefined || title === '') {
      errors.push({ message: 'createIssue: a valid repositoryId and title are required' });
      return UNRESOLVED;
    }
    const issue: ForgeIssue = {
      id: nextGlobalId,
      number: repo.nextIssue,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdSeq: storeSeq,
    };
    nextGlobalId += 1;
    repo.nextIssue += 1;
    storeSeq += 1;
    repo.issues.push(issue);
    return resolveChildren({ kind: 'createIssuePayload', issue, repo });
  }
  if (field.name === 'closeIssue') {
    const issueId = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
    const repo = issueId !== null && issueId[0] === 'issue' ? [...repos.values()].find((candidate) => candidate.id === Number(issueId[1])) : undefined;
    const issue = repo === undefined || issueId === null ? undefined : repo.issues.find((entry) => entry.number === Number(issueId[2]));
    if (repo === undefined || issue === undefined) {
      errors.push({ message: 'closeIssue: the issue does not exist' });
      return UNRESOLVED;
    }
    issue.state = 'closed';
    return resolveChildren({ kind: 'closeIssuePayload', issue, repo });
  }
  if (field.name === 'createPullRequest') {
    const repoId = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
    const repo = repoId !== null && repoId[0] === 'repo' ? [...repos.values()].find((candidate) => candidate.id === Number(repoId[1])) : undefined;
    const head = typeof input.headRefName === 'string' ? input.headRefName : undefined;
    const base = typeof input.baseRefName === 'string' ? input.baseRefName : undefined;
    const title = typeof input.title === 'string' ? input.title : undefined;
    const headSha = head !== undefined && repo !== undefined ? refTip(repo, head) : undefined;
    const baseSha = base !== undefined && repo !== undefined ? refTip(repo, base) : undefined;
    if (repo === undefined || head === undefined || base === undefined || title === undefined || headSha === undefined || baseSha === undefined) {
      errors.push({ message: 'createPullRequest: a valid repositoryId, headRefName, baseRefName and title are required' });
      return UNRESOLVED;
    }
    const pull: ForgePull = {
      id: nextGlobalId,
      number: repo.nextPull,
      title,
      body: typeof input.body === 'string' ? input.body : '',
      head,
      base,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: storeSeq,
    };
    nextGlobalId += 1;
    repo.nextPull += 1;
    storeSeq += 1;
    repo.pulls.push(pull);
    return resolveChildren({ kind: 'createPullPayload', pull, repo });
  }
  if (field.name === 'mergePullRequest') {
    const pullId = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
    const repo = pullId !== null && pullId[0] === 'pull' ? [...repos.values()].find((candidate) => candidate.id === Number(pullId[1])) : undefined;
    const pull = repo === undefined || pullId === null ? undefined : repo.pulls.find((entry) => entry.number === Number(pullId[2]));
    if (repo === undefined || pull === undefined) {
      errors.push({ message: 'mergePullRequest: the pull request does not exist' });
      return UNRESOLVED;
    }
    if (pull.state !== 'open' || pull.merged) {
      errors.push({ message: 'mergePullRequest: the pull request is already merged or closed' });
      return UNRESOLVED;
    }
    const mergeSha = squashMerge(repo, pull);
    if (mergeSha === null) {
      errors.push({ message: 'mergePullRequest: the pull request conflicts with the base branch' });
      return UNRESOLVED;
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = mergedAtIso();
    pull.mergeCommitSha = mergeSha;
    return resolveChildren({ kind: 'mergePullPayload', pull, repo });
  }
  if (field.name === 'addComment') {
    const subjectId = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
    const repo = subjectId !== null && subjectId[0] === 'issue' ? [...repos.values()].find((candidate) => candidate.id === Number(subjectId[1])) : undefined;
    const issue = repo === undefined || subjectId === null ? undefined : repo.issues.find((entry) => entry.number === Number(subjectId[2]));
    const body = typeof input.body === 'string' ? input.body : undefined;
    if (repo === undefined || issue === undefined || body === undefined) {
      errors.push({ message: 'addComment: a valid subjectId and body are required' });
      return UNRESOLVED;
    }
    const comment: ForgeComment = { id: repo.nextComment, body };
    repo.nextComment += 1;
    issue.comments.push(comment);
    const commentId = globalId('comment', repo.id, issue.number, comment.id);
    return resolveChildren({ kind: 'addCommentPayload', comment: { id: commentId, body } });
  }
  errors.push({ message: `noSuchFieldOnMutation: Cannot query field "${field.name}" on type "Mutation".` });
  return UNRESOLVED;
}

/** Execute one GraphQL operation object ({query, variables, operationName}). */
export function executeGraphQL(body: Record<string, unknown>): Record<string, unknown> {
  const query = typeof body.query === 'string' ? body.query : '';
  const variables = isRecord(body.variables) ? (body.variables as Record<string, unknown>) : {};
  const operationName = typeof body.operationName === 'string' ? body.operationName : undefined;
  let operations: GqlOperation[];
  try {
    operations = new GqlParser(query).parseDocument();
  } catch (err) {
    return { data: null, errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (operations.length === 0) return { data: null, errors: [{ message: 'The GraphQL document contains no operations' }] };
  const operation = operationName !== undefined
    ? operations.find((candidate) => candidate.name === operationName)
    : operations[0];
  if (operation === undefined) return { data: null, errors: [{ message: `Unknown operation named "${operationName}"` }] };
  const errors: Array<{ message: string }> = [];
  const root: GqlNode = operation.type === 'mutation' ? { kind: 'mutationRoot' } : { kind: 'query' };
  const data = resolveFields(root, operation.fields, variables, errors);
  const response: Record<string, unknown> = { data };
  if (errors.length > 0) response.errors = errors;
  return response;
}

export function handleGraphQL(ctx: RouteContext): void {
  if (!isAuthenticated(ctx.req)) {
    jsonError(ctx, 401, 'Requires authentication');
    return;
  }
  let body: unknown;
  try {
    body = parseJsonBody(ctx.body);
  } catch {
    jsonError(ctx, 400, 'malformed JSON body');
    return;
  }
  if (Array.isArray(body)) {
    const responses = body.map((entry) => (isRecord(entry) ? executeGraphQL(entry) : { data: null, errors: [{ message: 'Each batched operation must be an object' }] }));
    sendJson(ctx, 200, responses);
    return;
  }
  if (!isRecord(body)) {
    jsonError(ctx, 400, 'the request body must be a JSON object');
    return;
  }
  sendJson(ctx, 200, executeGraphQL(body));
}

// -------------------------------------------------------------------------------------------
// MCP — JSON-RPC 2.0 Streamable HTTP (legacy era: initialize + tools/list + tools/call).

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, { type: string; description: string }>;
    required: string[];
  };
}

export const MCP_TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository to create.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List the issues of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Filter by issue state: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request between two branches of a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The name of the branch with the changes.' },
        base: { type: 'string', description: 'The name of the branch to merge into.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash merge.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The login of the repository owner.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The number of the pull request to merge.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

export function mcpError(ctx: RouteContext, id: unknown, code: number, message: string, status = 200): void {
  sendJson(ctx, status, { jsonrpc: '2.0', id: id ?? null, error: { code, message } });
}

export function mcpResult(ctx: RouteContext, id: unknown, result: unknown, extraHeaders: Record<string, string> = {}): void {
  sendJson(ctx, 200, { jsonrpc: '2.0', id: id ?? null, result }, extraHeaders);
}

export function mcpToolResult(ctx: RouteContext, id: unknown, text: string, structured: unknown, isError = false): void {
  const result: Record<string, unknown> = {
    content: [{ type: 'text', text }],
    structuredContent: structured,
  };
  if (isError) result.isError = true;
  mcpResult(ctx, id, result);
}

export function mcpMissingArg(ctx: RouteContext, id: unknown, name: string): void {
  mcpToolResult(ctx, id, `Missing required argument: ${name}`, { error: `Missing required argument: ${name}` }, true);
}

/** Find a repo for an MCP tool call; sends an isError result and returns null when absent. */
export function mcpLoadRepo(ctx: RouteContext, id: unknown, args: Record<string, unknown>): ForgeRepo | null {
  const owner = typeof args.owner === 'string' ? args.owner : '';
  const repoName = typeof args.repo === 'string' ? args.repo : '';
  const repo = owner === VIEWER_LOGIN ? getRepo(owner, repoName) : undefined;
  if (repo === undefined) {
    mcpToolResult(ctx, id, `Repository not found: ${owner}/${repoName}`, { error: 'Repository not found' }, true);
    return null;
  }
  return repo;
}

export function handleMcpCall(ctx: RouteContext, id: unknown, name: string, args: Record<string, unknown>): void {
  const tool = MCP_TOOLS.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    mcpError(ctx, id, -32602, `Unknown tool: ${name}`);
    return;
  }
  for (const required of tool.inputSchema.required) {
    if (args[required] === undefined || args[required] === null || args[required] === '') {
      mcpMissingArg(ctx, id, required);
      return;
    }
  }
  if (name === 'create_repo') {
    const repoName = args.name as string;
    if (getRepo(VIEWER_LOGIN, repoName) !== undefined) {
      mcpToolResult(ctx, id, `Repository already exists: ${repoName}`, { error: 'Repository already exists' }, true);
      return;
    }
    const repo = createRepoRecord(repoName, args.private === true, typeof args.description === 'string' ? args.description : '', DEFAULT_BRANCH);
    const text = JSON.stringify({ name: repo.name, private: repo.private, default_branch: repo.defaultBranch });
    mcpToolResult(ctx, id, text, { name: repo.name, private: repo.private, default_branch: repo.defaultBranch });
    return;
  }
  if (name === 'get_repo') {
    const repo = mcpLoadRepo(ctx, id, args);
    if (repo === null) return;
    const text = JSON.stringify({ name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, default_branch: repo.defaultBranch });
    mcpToolResult(ctx, id, text, { name: repo.name, full_name: `${repo.owner}/${repo.name}`, private: repo.private, default_branch: repo.defaultBranch });
    return;
  }
  if (name === 'create_issue') {
    const repo = mcpLoadRepo(ctx, id, args);
    if (repo === null) return;
    const issue: ForgeIssue = {
      id: nextGlobalId,
      number: repo.nextIssue,
      title: args.title as string,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      comments: [],
      createdSeq: storeSeq,
    };
    nextGlobalId += 1;
    repo.nextIssue += 1;
    storeSeq += 1;
    repo.issues.push(issue);
    const text = JSON.stringify({ number: issue.number, title: issue.title, state: issue.state });
    mcpToolResult(ctx, id, text, { number: issue.number, title: issue.title, state: issue.state });
    return;
  }
  if (name === 'list_issues') {
    const repo = mcpLoadRepo(ctx, id, args);
    if (repo === null) return;
    const state = typeof args.state === 'string' ? args.state : 'open';
    const list = repo.issues.filter((issue) => state === 'all' || issue.state === state);
    const items = list.map((issue) => ({ number: issue.number, title: issue.title, state: issue.state }));
    mcpToolResult(ctx, id, JSON.stringify(items), { issues: items });
    return;
  }
  if (name === 'create_pull_request') {
    const repo = mcpLoadRepo(ctx, id, args);
    if (repo === null) return;
    const head = args.head as string;
    const base = args.base as string;
    const headSha = refTip(repo, head);
    const baseSha = refTip(repo, base);
    if (headSha === undefined || baseSha === undefined) {
      mcpToolResult(ctx, id, `head or base branch does not exist: ${head} -> ${base}`, { error: 'head or base branch does not exist' }, true);
      return;
    }
    const pull: ForgePull = {
      id: nextGlobalId,
      number: repo.nextPull,
      title: args.title as string,
      body: '',
      head,
      base,
      headSha,
      baseSha,
      state: 'open',
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdSeq: storeSeq,
    };
    nextGlobalId += 1;
    repo.nextPull += 1;
    storeSeq += 1;
    repo.pulls.push(pull);
    const text = JSON.stringify({ number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.state });
    mcpToolResult(ctx, id, text, { number: pull.number, title: pull.title, head: pull.head, base: pull.base, state: pull.state });
    return;
  }
  if (name === 'merge_pull_request') {
    const repo = mcpLoadRepo(ctx, id, args);
    if (repo === null) return;
    const number = args.pull_number as number;
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) {
      mcpToolResult(ctx, id, `Pull request not found: ${number}`, { error: 'Pull request not found' }, true);
      return;
    }
    if (pull.state !== 'open' || pull.merged) {
      mcpToolResult(ctx, id, `Pull request ${number} is already merged or closed`, { error: 'Pull request is already merged or closed' }, true);
      return;
    }
    const mergeSha = squashMerge(repo, pull);
    if (mergeSha === null) {
      mcpToolResult(ctx, id, `Pull request ${number} conflicts with the base branch`, { error: 'Merge conflict' }, true);
      return;
    }
    pull.state = 'closed';
    pull.merged = true;
    pull.mergedAt = mergedAtIso();
    pull.mergeCommitSha = mergeSha;
    const text = JSON.stringify({ number: pull.number, merged: true, sha: mergeSha });
    mcpToolResult(ctx, id, text, { number: pull.number, merged: true, sha: mergeSha });
    return;
  }
}

export function handleMcp(ctx: RouteContext): void {
  const method = (ctx.req.method ?? 'GET').toUpperCase();
  if (method === 'DELETE') {
    ctx.res.writeHead(204, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  if (method === 'GET') {
    jsonError(ctx, 405, 'The MCP endpoint accepts POST requests');
    return;
  }
  let body: unknown;
  try {
    body = parseJsonBody(ctx.body);
  } catch {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(body)) {
    sendJson(ctx, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const id = body.id ?? null;
  // Notifications (no id) get a bare 202 and no body.
  if (id === null && body.method === 'notifications/initialized') {
    ctx.res.writeHead(202, { 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  if (!isAuthenticated(ctx.req)) {
    mcpError(ctx, id, -32001, 'Unauthorized', 401);
    return;
  }
  const rpcMethod = typeof body.method === 'string' ? body.method : '';
  if (rpcMethod === 'server/discover') {
    mcpError(ctx, id, -32601, 'Method not found');
    return;
  }
  if (rpcMethod === 'initialize') {
    const params = isRecord(body.params) ? body.params : {};
    const protocolVersion = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    mcpResult(ctx, id, {
      protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'forge', version: FORGE_VERSION },
    }, { 'mcp-session-id': 'forge-session-1' });
    return;
  }
  if (rpcMethod === 'ping') {
    mcpResult(ctx, id, {});
    return;
  }
  if (rpcMethod === 'tools/list') {
    mcpResult(ctx, id, { tools: MCP_TOOLS });
    return;
  }
  if (rpcMethod === 'tools/call') {
    const params = isRecord(body.params) ? body.params : {};
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    handleMcpCall(ctx, id, name, args);
    return;
  }
  mcpError(ctx, id, -32601, 'Method not found');
}

// -------------------------------------------------------------------------------------------
// Small web UI — browse repositories, issues and pull requests as HTML pages.

export function htmlPage(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>${escapeHtml(title)} · Forge</title>
<style>body{font-family:system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#1f2328}h1{font-size:1.5rem}a{color:#0969da;text-decoration:none}a:hover{text-decoration:underline}table{border-collapse:collapse;width:100%}td,th{border:1px solid #d0d7de;padding:.4rem .6rem;text-align:left}code{background:#f6f8fa;padding:.1rem .3rem;border-radius:4px}.pill{display:inline-block;padding:.1rem .5rem;border-radius:999px;font-size:.8rem}.open{background:#dafbe1}.closed{background:#ffebe9}.merged{background:#ddf4ff}form{margin:1rem 0}input{padding:.4rem;border:1px solid #d0d7de;border-radius:6px}</style>
</head>
<body>
${body}
</body>
</html>
`;
}

export function handleUi(ctx: RouteContext): void {
  const method = (ctx.req.method ?? 'GET').toUpperCase();
  const s = ctx.segments;
  // POST / — create a repository from the home-page form.
  if (s.length === 0 && method === 'POST') {
    const form = new URLSearchParams(ctx.body.toString('utf8'));
    const name = (form.get('name') ?? '').trim();
    if (name === '') {
      sendText(ctx, 400, 'Repository name is required', 'text/html; charset=utf-8');
      return;
    }
    if (getRepo(VIEWER_LOGIN, name) !== undefined) {
      ctx.res.writeHead(303, { location: `/${VIEWER_LOGIN}/${encodeURIComponent(name)}`, 'x-github-request-id': ctx.requestId });
      ctx.res.end();
      return;
    }
    createRepoRecord(name, false, '', DEFAULT_BRANCH);
    ctx.res.writeHead(303, { location: `/${VIEWER_LOGIN}/${encodeURIComponent(name)}`, 'x-github-request-id': ctx.requestId });
    ctx.res.end();
    return;
  }
  // GET / — the forge home: every repository.
  if (s.length === 0 && method === 'GET') {
    const rows = listRepos()
      .map((repo) => `<tr><td><a href="/${escapeHtml(repo.owner)}/${escapeHtml(repo.name)}">${escapeHtml(repo.name)}</a></td><td>${escapeHtml(repo.description)}</td><td>${escapeHtml(repo.defaultBranch)}</td></tr>`)
      .join('\n');
    const body = `<h1>Forge</h1>
<p>A small GitHub-compatible git forge. Signed in as <strong>${escapeHtml(VIEWER_LOGIN)}</strong>.</p>
<form method="post" action="/"><input name="name" placeholder="new repository name" required> <button type="submit">Create repository</button></form>
<h2>Repositories</h2>
<table><tr><th>Name</th><th>Description</th><th>Default branch</th></tr>
${rows}
</table>`;
    sendText(ctx, 200, htmlPage('Forge', body), 'text/html; charset=utf-8');
    return;
  }
  if (s.length >= 2) {
    const owner = s[0] as string;
    const name = s[1] as string;
    const repo = owner === VIEWER_LOGIN ? getRepo(owner, name) : undefined;
    if (repo === undefined) {
      sendText(ctx, 404, htmlPage('Not found', '<h1>Not found</h1><p>That repository does not exist.</p>'), 'text/html; charset=utf-8');
      return;
    }
    const rest = s.slice(2);
    // GET /{o}/{r} — repository page with the default branch tree.
    if (rest.length === 0 && method === 'GET') {
      const tip = refTip(repo, repo.defaultBranch);
      const flat = new Map<string, { mode: string; oid: string }>();
      if (tip !== undefined) {
        const treeOid = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
        flattenTree(repo.objects, treeOid, '', flat);
      }
      const files = [...flat.keys()].sort().map((path) => `<tr><td><a href="/${escapeHtml(owner)}/${escapeHtml(name)}/blob/${escapeHtml(repo.defaultBranch)}/${path.split('/').map(encodeURIComponent).join('/')}">${escapeHtml(path)}</a></td></tr>`).join('\n');
      const body = `<h1><a href="/${escapeHtml(owner)}/${escapeHtml(name)}">${escapeHtml(owner)}/${escapeHtml(name)}</a></h1>
<p>${escapeHtml(repo.description)}</p>
<p>Default branch: <code>${escapeHtml(repo.defaultBranch)}</code> · <a href="/${escapeHtml(owner)}/${escapeHtml(name)}/issues">Issues (${repo.issues.length})</a> · <a href="/${escapeHtml(owner)}/${escapeHtml(name)}/pulls">Pull requests (${repo.pulls.length})</a></p>
<h2>Files</h2>
<table><tr><th>Path</th></tr>
${files === '' ? '<tr><td><em>Empty repository</em></td></tr>' : files}
</table>`;
      sendText(ctx, 200, htmlPage(`${owner}/${name}`, body), 'text/html; charset=utf-8');
      return;
    }
    // GET /{o}/{r}/issues — the issue list.
    if (rest[0] === 'issues' && rest.length === 1 && method === 'GET') {
      const rows = repo.issues.map((issue) => `<tr><td>#${issue.number}</td><td><a href="/${escapeHtml(owner)}/${escapeHtml(name)}/issues/${issue.number}">${escapeHtml(issue.title)}</a></td><td><span class="pill ${issue.state}">${issue.state}</span></td></tr>`).join('\n');
      const body = `<h1><a href="/${escapeHtml(owner)}/${escapeHtml(name)}">${escapeHtml(owner)}/${escapeHtml(name)}</a> — Issues</h1>
<table><tr><th>#</th><th>Title</th><th>State</th></tr>
${rows === '' ? '<tr><td colspan="3"><em>No issues</em></td></tr>' : rows}
</table>`;
      sendText(ctx, 200, htmlPage(`${name} issues`, body), 'text/html; charset=utf-8');
      return;
    }
    // GET /{o}/{r}/issues/{n} — one issue with its comments.
    if (rest[0] === 'issues' && rest.length === 2 && method === 'GET') {
      const issue = repo.issues.find((entry) => entry.number === Number(rest[1]));
      if (issue === undefined) {
        sendText(ctx, 404, htmlPage('Not found', '<h1>Not found</h1><p>That issue does not exist.</p>'), 'text/html; charset=utf-8');
        return;
      }
      const comments = issue.comments.map((comment) => `<li>${escapeHtml(comment.body)}</li>`).join('\n');
      const body = `<h1>#${issue.number} ${escapeHtml(issue.title)}</h1>
<p><span class="pill ${issue.state}">${issue.state}</span></p>
<p>${escapeHtml(issue.body)}</p>
<h2>Comments</h2>
<ul>${comments === '' ? '<li><em>No comments</em></li>' : comments}</ul>`;
      sendText(ctx, 200, htmlPage(`#${issue.number} ${issue.title}`, body), 'text/html; charset=utf-8');
      return;
    }
    // GET /{o}/{r}/pulls — the pull request list.
    if (rest[0] === 'pulls' && rest.length === 1 && method === 'GET') {
      const rows = repo.pulls.map((pull) => `<tr><td>#${pull.number}</td><td><a href="/${escapeHtml(owner)}/${escapeHtml(name)}/pulls/${pull.number}">${escapeHtml(pull.title)}</a></td><td>${escapeHtml(pull.head)} → ${escapeHtml(pull.base)}</td><td><span class="pill ${pull.merged ? 'merged' : pull.state}">${pull.merged ? 'merged' : pull.state}</span></td></tr>`).join('\n');
      const body = `<h1><a href="/${escapeHtml(owner)}/${escapeHtml(name)}">${escapeHtml(owner)}/${escapeHtml(name)}</a> — Pull requests</h1>
<table><tr><th>#</th><th>Title</th><th>Branches</th><th>State</th></tr>
${rows === '' ? '<tr><td colspan="4"><em>No pull requests</em></td></tr>' : rows}
</table>`;
      sendText(ctx, 200, htmlPage(`${name} pull requests`, body), 'text/html; charset=utf-8');
      return;
    }
    // GET /{o}/{r}/pulls/{n} — one pull request.
    if (rest[0] === 'pulls' && rest.length === 2 && method === 'GET') {
      const pull = repo.pulls.find((entry) => entry.number === Number(rest[1]));
      if (pull === undefined) {
        sendText(ctx, 404, htmlPage('Not found', '<h1>Not found</h1><p>That pull request does not exist.</p>'), 'text/html; charset=utf-8');
        return;
      }
      const body = `<h1>#${pull.number} ${escapeHtml(pull.title)}</h1>
<p><span class="pill ${pull.merged ? 'merged' : pull.state}">${pull.merged ? 'merged' : pull.state}</span></p>
<p>${escapeHtml(pull.head)} → ${escapeHtml(pull.base)}</p>
<p>${escapeHtml(pull.body)}</p>`;
      sendText(ctx, 200, htmlPage(`#${pull.number} ${pull.title}`, body), 'text/html; charset=utf-8');
      return;
    }
    // GET /{o}/{r}/blob/{branch}/{path...} — one file, raw.
    if (rest[0] === 'blob' && rest.length >= 3 && method === 'GET') {
      const branch = rest[1] as string;
      const path = rest.slice(2).join('/');
      const tip = refTip(repo, branch);
      if (tip === undefined) {
        sendText(ctx, 404, htmlPage('Not found', '<h1>Not found</h1><p>That branch does not exist.</p>'), 'text/html; charset=utf-8');
        return;
      }
      const treeOid = parseCommit(repo.objects.get(tip)?.data ?? Buffer.alloc(0)).tree;
      const blobOid = blobAtPath(repo, treeOid, path.split('/'));
      if (blobOid === null) {
        sendText(ctx, 404, htmlPage('Not found', '<h1>Not found</h1><p>That file does not exist.</p>'), 'text/html; charset=utf-8');
        return;
      }
      const data = repo.objects.get(blobOid)?.data ?? Buffer.alloc(0);
      const isText = data.length === 0 || !data.includes(0);
      sendBytes(ctx, 200, data, isText ? 'text/plain; charset=utf-8' : 'application/octet-stream');
      return;
    }
  }
  sendText(ctx, 404, 'Not found\n', 'text/plain; charset=utf-8');
}

// -------------------------------------------------------------------------------------------
// Routing + server

export async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const rawUrl = req.url ?? '/';
  let url: URL;
  try {
    url = new URL(rawUrl, 'http://127.0.0.1');
  } catch {
    res.writeHead(400, { 'content-type': 'text/plain' });
    res.end('bad request\n');
    return;
  }
  const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => {
    try {
      return decodeURIComponent(part);
    } catch {
      return part;
    }
  });
  const path = segments.length === 0 ? '/' : `/${segments.join('/')}`;
  const ctx: RouteContext = {
    req,
    res,
    segments,
    path,
    query: url.searchParams,
    body: Buffer.alloc(0),
    requestId: nextRequestId(),
  };
  try {
    const method = (req.method ?? 'GET').toUpperCase();
    if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) {
      ctx.body = await readBody(req);
    }
    // Health check: no auth, always available.
    if (path === '/healthz' && method === 'GET') {
      sendText(ctx, 200, 'ok\n', 'text/plain; charset=utf-8');
      return;
    }
    // MCP.
    if (segments[0] === 'mcp') {
      handleMcp(ctx);
      return;
    }
    // GraphQL.
    if (path === '/api/graphql' && method === 'POST') {
      handleGraphQL(ctx);
      return;
    }
    // REST v3.
    if (segments[0] === 'api' && segments[1] === 'v3') {
      handleRest(ctx);
      return;
    }
    // git smart HTTP: /{owner}/{repo}.git/...
    if (segments.length >= 2 && segments[1] !== undefined && segments[1].endsWith('.git')) {
      const owner = segments[0] as string;
      const repoName = (segments[1] as string).slice(0, -4);
      if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
        handleInfoRefs(ctx, owner, repoName);
        return;
      }
      if (segments.length === 3 && segments[2] === 'git-upload-pack' && method === 'POST') {
        handleUploadPack(ctx, owner, repoName);
        return;
      }
      if (segments.length === 3 && segments[2] === 'git-receive-pack' && method === 'POST') {
        handleReceivePack(ctx, owner, repoName);
        return;
      }
      sendText(ctx, 404, 'repository not found\n', 'text/plain; charset=utf-8');
      return;
    }
    // Web UI.
    handleUi(ctx);
  } catch (err) {
    if (!res.writableEnded) {
      sendJson(ctx, 500, { message: err instanceof Error ? err.message : String(err) });
    }
  }
}

/**
 * Start the forge on a port (0 = an ephemeral port); resolves with the bound
 * port and the listening server, the shape main.ts expects.
 */
export function startForge(options: { port: number }): Promise<{ port: number; server: Server }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      void handleRequest(req, res);
    });
    server.on('error', reject);
    server.listen(options.port, '127.0.0.1', () => {
      const address = server.address();
      const bound = typeof address === 'object' && address !== null ? address.port : options.port;
      resolve({ port: bound, server });
    });
  });
}
