// github-core-clone-01 — a GitHub-compatible git forge (Node stdlib only).
//
// Surfaces: git smart HTTP (upload-pack v2 + v0, receive-pack v0), REST v3 under
// /api/v3, GraphQL v4 at /api/graphql, MCP (streamable HTTP, 2026-07-28 era with
// legacy initialize fallback) at /mcp. One process, in-memory store, no deps.
//
// The suite's scenario (viewer login etc.) is fixed public data from the kit:
// the token owner is the scenario viewer, `adaiversen` (wire.ts buildScenario()).
// Auth: when MAKEFUN_SHOP_TOKEN is set, a Bearer token must equal it; otherwise
// any non-empty Bearer token is accepted (local practice runs). No token -> 401.

import { createHash } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const VIEWER_LOGIN = 'adaiversen';
export const VIEWER_ID = 1000;
export const VIEWER_NAME = 'ada iversen';
export const VIEWER_EMAIL = 'adaiversen@example.invalid';
const IDENTITY = `${VIEWER_NAME} <${VIEWER_EMAIL}>`;
const COMMIT_TS = 1700000000;
const FIXED_ISO = '2025-01-01T00:00:00Z';
const ZERO_OID = '0'.repeat(40);
const AGENT = 'github-core-clone-01/1.0';
const SERVER_NAME = 'github-core-clone-01';
const SERVER_VERSION = '1.0.0';

const expectedToken = (): string => process.env.MAKEFUN_SHOP_TOKEN ?? '';

function authed(req: IncomingMessage): boolean {
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Bearer ')) return false;
  const tok = h.slice(7).trim();
  if (tok === '') return false;
  const expected = expectedToken();
  if (expected !== '') return tok === expected;
  return true;
}

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------

const HEX40 = /^[0-9a-f]{40}$/;
const isOid = (v: string): boolean => HEX40.test(v);
let reqCounter = 0;
const nextReqId = (): string => `req-${++reqCounter}-${Date.now().toString(36)}`;
const b64 = (s: string): string => Buffer.from(s, 'utf8').toString('base64');
const b64url = (s: string): string => b64(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s: string): string => {
  try {
    return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
  } catch {
    return '';
  }
};
const esc = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = status === 204 ? '' : `${JSON.stringify(body)}\n`;
  const h: Record<string, string> = { 'x-github-request-id': nextReqId(), ...headers };
  if (status !== 204) {
    h['content-type'] = 'application/json; charset=utf-8';
    h['content-length'] = String(Buffer.byteLength(text));
  }
  res.writeHead(status, h);
  res.end(text);
}
function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, {
    'content-type': contentType,
    'content-length': String(body.length),
    'x-github-request-id': nextReqId(),
  });
  res.end(body);
}
const notFound = (res: ServerResponse): void => sendJson(res, 404, { message: 'Not Found' });
const unauthorized = (res: ServerResponse): void => sendJson(res, 401, { message: 'Requires authentication' });

function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}
function queryOf(req: IncomingMessage): URLSearchParams {
  try {
    return new URL(req.url ?? '/', 'http://entry').searchParams;
  } catch {
    return new URLSearchParams();
  }
}
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function parseJsonBody(buf: Buffer): { ok: true; value: unknown } | { ok: false } {
  if (buf.length === 0) return { ok: true, value: {} };
  try {
    return { ok: true, value: JSON.parse(buf.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ---------------------------------------------------------------------------
// git object model
// ---------------------------------------------------------------------------

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';
export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}
const TYPE_CODE: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPE: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export function hashObject(type: GitObjectType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(Buffer.from(`${type} ${data.length}\0`, 'utf8'));
  h.update(data);
  return h.digest('hex');
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let off = 0;
  while (off < data.length) {
    const sp = data.indexOf(0x20, off);
    const nul = data.indexOf(0x00, sp + 1);
    entries.push({
      mode: data.subarray(off, sp).toString('ascii'),
      name: data.subarray(sp + 1, nul).toString('utf8'),
      oid: data.subarray(nul + 1, nul + 21).toString('hex'),
    });
    off = nul + 21;
  }
  return entries;
}
function compareTreeNames(a: TreeEntry, b: TreeEntry): number {
  const l = Buffer.from(a.mode === '40000' ? `${a.name}/` : a.name, 'utf8');
  const r = Buffer.from(b.mode === '40000' ? `${b.name}/` : b.name, 'utf8');
  return Buffer.compare(l, r);
}
export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeNames);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}
export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
export function parseCommit(data: Buffer): CommitView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const message = blank < 0 ? '' : data.subarray(blank + 2).toString('utf8');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    const k = sp < 0 ? line : line.slice(0, sp);
    const v = sp < 0 ? '' : line.slice(sp + 1);
    if (k === 'tree') tree = v;
    else if (k === 'parent') parents.push(v);
    else if (k === 'author') author = v;
    else if (k === 'committer') committer = v;
  }
  return { tree, parents, author, committer, message };
}
export function buildCommit(tree: string, parents: readonly string[], message: string): Buffer {
  const lines = [`tree ${tree}`];
  for (const p of parents) lines.push(`parent ${p}`);
  lines.push(`author ${IDENTITY} ${COMMIT_TS} +0000`, `committer ${IDENTITY} ${COMMIT_TS} +0000`, '');
  return Buffer.from(`${lines.join('\n')}\n${message.endsWith('\n') ? message : `${message}\n`}`, 'utf8');
}
export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}
export function parseTag(data: Buffer): TagView {
  const blank = data.indexOf('\n\n');
  const head = blank < 0 ? data.toString('utf8') : data.subarray(0, blank).toString('utf8');
  const m = new Map<string, string>();
  for (const line of head.split('\n')) {
    const sp = line.indexOf(' ');
    if (sp > 0) m.set(line.slice(0, sp), line.slice(sp + 1));
  }
  return {
    object: m.get('object') ?? '',
    type: m.get('type') ?? '',
    tag: m.get('tag') ?? '',
    tagger: m.get('tagger') ?? '',
    message: blank < 0 ? '' : data.subarray(blank + 2).toString('utf8'),
  };
}

// ---------------------------------------------------------------------------
// pkt-line
// ---------------------------------------------------------------------------

const PKT_MAX = 65520;
export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const h = Buffer.alloc(4);
  h.write((data.length + 4).toString(16).padStart(4, '0'), 0, 4, 'ascii');
  return Buffer.concat([h, data]);
}
const pktFlush = (): Buffer => Buffer.from('0000', 'ascii');
const pktDelim = (): Buffer => Buffer.from('0001', 'ascii');
export function pktLines(items: readonly (string | Buffer | 'flush' | 'delim')[]): Buffer {
  const parts: Buffer[] = [];
  for (const it of items) {
    if (it === 'flush') parts.push(pktFlush());
    else if (it === 'delim') parts.push(pktDelim());
    else parts.push(pktLine(it));
  }
  return Buffer.concat(parts);
}

export type Pkt = { kind: 'data'; payload: Buffer } | { kind: 'flush' } | { kind: 'delim' } | { kind: 'response-end' };

/** Decode pkt-lines from the front of `buf`; returns packets and bytes consumed. */
export function decodePkts(buf: Buffer): { packets: Pkt[]; consumed: number } {
  const packets: Pkt[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const h = buf.subarray(off, off + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(h)) break;
    const len = parseInt(h, 16);
    if (len === 0) {
      packets.push({ kind: 'flush' });
      off += 4;
    } else if (len === 1) {
      packets.push({ kind: 'delim' });
      off += 4;
    } else if (len === 2) {
      packets.push({ kind: 'response-end' });
      off += 4;
    } else if (len < 4 || len > PKT_MAX || off + len > buf.length) {
      break;
    } else {
      packets.push({ kind: 'data', payload: buf.subarray(off + 4, off + len) });
      off += len;
    }
  }
  return { packets, consumed: off };
}

// ---------------------------------------------------------------------------
// packfile read/write (no deltas on write; deltas resolved on read)
// ---------------------------------------------------------------------------

function readVarint(buf: Buffer, start: number): { size: number; next: number; first: number } {
  let byte = buf[start]!;
  const first = byte;
  let size = byte & 0x0f;
  let shift = 4;
  let off = start + 1;
  while (byte & 0x80) {
    byte = buf[off++]!;
    size += (byte & 0x7f) * 2 ** shift;
    shift += 7;
  }
  return { size, next: off, first };
}
function readOfsBase(buf: Buffer, start: number): { baseOffset: number; next: number } {
  let byte = buf[start]!;
  let off = start + 1;
  let value = byte & 0x7f;
  while (byte & 0x80) {
    byte = buf[off++]!;
    value = (value + 1) * 128 + (byte & 0x7f);
  }
  return { baseOffset: value, next: off };
}
function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const res = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: res.buffer, next: offset + res.engine.bytesWritten };
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let off = 0;
  const readSize = (): number => {
    let v = 0;
    let shift = 0;
    for (;;) {
      const b = delta[off++]!;
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(b & 0x80)) break;
    }
    return v;
  };
  const srcSize = readSize();
  const tgtSize = readSize();
  if (srcSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(tgtSize);
  let written = 0;
  while (off < delta.length) {
    const op = delta[off++]!;
    if (op & 0x80) {
      let co = 0;
      let cs = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit++) {
        if (op & (1 << bit)) co += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit++) {
        if (op & (1 << bit)) cs += delta[off++]! * 2 ** shift;
        shift += 8;
      }
      if (cs === 0) cs = 0x10000;
      base.copy(out, written, co, co + cs);
      written += cs;
    } else if (op !== 0) {
      const n = op & 0x7f;
      delta.copy(out, written, off, off + n);
      off += n;
      written += n;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== tgtSize) throw new Error('delta size mismatch');
  return out;
}

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}
export function readPack(pack: Buffer): PackRead {
  if (pack.length < 32 || pack.subarray(0, 4).toString('ascii') !== 'PACK') throw new Error('bad pack header');
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailerStart = pack.length - 20;
  interface Raw {
    offset: number;
    typeCode: number;
    size: number;
    data: Buffer;
    baseOffset?: number;
    baseOid?: string;
  }
  const raw: Raw[] = [];
  const byOffset = new Map<number, Raw>();
  let off = 12;
  for (let i = 0; i < count; i++) {
    const entryOffset = off;
    const h = readVarint(pack, off);
    off = h.next;
    const typeCode = (h.first >> 4) & 0x07;
    const entry: Raw = { offset: entryOffset, typeCode, size: h.size, data: Buffer.alloc(0) };
    if (typeCode === 6) {
      const b = readOfsBase(pack, off);
      off = b.next;
      entry.baseOffset = entryOffset - b.baseOffset;
    } else if (typeCode === 7) {
      entry.baseOid = pack.subarray(off, off + 20).toString('hex');
      off += 20;
    } else if (!CODE_TYPE[typeCode]) {
      throw new Error(`unknown pack type ${typeCode}`);
    }
    const inf = inflateAt(pack.subarray(0, trailerStart), off);
    if (inf.data.length !== h.size) throw new Error('pack entry size mismatch');
    entry.data = inf.data;
    off = inf.next;
    raw.push(entry);
    byOffset.set(entryOffset, entry);
  }
  if (off !== trailerStart) throw new Error('pack trailing bytes');
  const objects = new Map<string, GitObject>();
  const resolved = new Map<string, GitObject>();
  let deltaCount = 0;
  const resolving = new Set<number>();
  const resolve = (e: Raw): GitObject => {
    const byOid = e.baseOid ? resolved.get(e.baseOid) : undefined;
    if (e.typeCode === 6 || e.typeCode === 7) {
      deltaCount += 1;
      if (resolving.has(e.offset)) throw new Error('delta cycle');
      resolving.add(e.offset);
      let base: GitObject | undefined;
      if (e.typeCode === 6) {
        const be = byOffset.get(e.baseOffset!);
        if (!be) throw new Error('ofs-delta base missing');
        base = resolve(be);
      } else {
        base = byOid;
        if (!base) throw new Error('ref-delta base missing');
      }
      const data = applyDelta(base.data, e.data);
      const obj: GitObject = { type: base.type, data };
      resolving.delete(e.offset);
      const oid = hashObject(obj.type, obj.data);
      resolved.set(oid, obj);
      return obj;
    }
    const obj: GitObject = { type: CODE_TYPE[e.typeCode]!, data: e.data };
    const oid = hashObject(obj.type, obj.data);
    resolved.set(oid, obj);
    return obj;
  };
  for (const e of raw) {
    const obj = resolve(e);
    objects.set(hashObject(obj.type, obj.data), obj);
  }
  return { objects, deltaCount };
}

function packObjectHeader(type: GitObjectType, size: number): Buffer {
  const code = TYPE_CODE[type];
  const bytes: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    bytes.push(b);
  }
  return Buffer.from(bytes);
}
export function writePack(objects: Iterable<GitObject>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [Buffer.from('PACK'), Buffer.alloc(4), Buffer.alloc(4)];
  parts[1]!.writeUInt32BE(2, 0);
  parts[2]!.writeUInt32BE(list.length, 0);
  for (const o of list) {
    parts.push(packObjectHeader(o.type, o.data.length));
    parts.push(deflateSync(o.data, { level: 6 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

// ---------------------------------------------------------------------------
// store
// ---------------------------------------------------------------------------

export interface Comment {
  id: number;
  body: string;
  seq: number;
}
export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: Comment[];
  seq: number;
}
export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  seq: number;
}
export interface Repo {
  id: number;
  name: string;
  owner: string;
  isPrivate: boolean;
  description: string;
  defaultBranch: string;
  seq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, { name: string; color: string }>;
  issues: Issue[];
  pulls: Pull[];
  nextNumber: number;
  nextCommentId: number;
}

const DEFAULT_LABELS: Array<[string, string]> = [
  ['bug', 'd73a4a'],
  ['enhancement', 'a2eeef'],
  ['documentation', '0075ca'],
  ['question', 'd876e3'],
  ['good first issue', '7057ff'],
  ['help wanted', '008672'],
];

class Store {
  repos = new Map<string, Repo>(); // key owner/name
  nextRepoId = 1;
  nextObjectId = 1; // global numeric id counter for issues/prs (per-repo numbers separate)
  seq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }
  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }
  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      id: this.nextRepoId++,
      name,
      owner: VIEWER_LOGIN,
      isPrivate,
      description,
      defaultBranch: 'main',
      seq: ++this.seq,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(DEFAULT_LABELS.map(([n, c]) => [n, { name: n, color: c }])),
      issues: [],
      pulls: [],
      nextNumber: 1,
      nextCommentId: 1,
    };
    this.repos.set(this.key(VIEWER_LOGIN, name), repo);
    return repo;
  }
  userRepos(): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === VIEWER_LOGIN) out.push(r);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }
}
const store = new Store();

// ---------------------------------------------------------------------------
// git repo helpers (operate on a Repo's object store)
// ---------------------------------------------------------------------------

function putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}
function getObject(repo: Repo, oid: string): GitObject | undefined {
  return repo.objects.get(oid);
}

/** All objects reachable from roots (commit -> tree+parents, tag -> target, tree -> entries). */
function collectReachable(repo: Repo, roots: Iterable<string>): Set<string> {
  const seen = new Set<string>();
  const queue: string[] = [];
  for (const r of roots) if (isOid(r)) queue.push(r);
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    seen.add(oid);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.data);
      queue.push(c.tree);
      for (const p of c.parents) queue.push(p);
    } else if (obj.type === 'tag') {
      queue.push(parseTag(obj.data).object);
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
    }
  }
  return seen;
}

/** Peel a tag (recursively) to its non-tag object; commits pass through. */
function peelToNonTag(repo: Repo, oid: string): string {
  let cur = oid;
  const seen = new Set<string>();
  for (;;) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tag' || seen.has(cur)) return cur;
    seen.add(cur);
    cur = parseTag(obj.data).object;
  }
}

/** Is `ancestor` (commit oid, peeled) an ancestor of `desc` (commit oid, peeled), or equal? */
function isAncestor(repo: Repo, ancestor: string, desc: string): boolean {
  const a = peelToNonTag(repo, ancestor);
  const d = peelToNonTag(repo, desc);
  if (a === d) return true;
  const seen = new Set<string>();
  const queue = [d];
  while (queue.length) {
    const oid = queue.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) {
      if (p === a) return true;
      queue.push(p);
    }
  }
  return false;
}

/** First common ancestor commit of a and b (peeling tags), or null. */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const aP = peelToNonTag(repo, a);
  const bP = peelToNonTag(repo, b);
  const ancestorsOf = (start: string): Set<string> => {
    const seen = new Set<string>();
    const queue = [start];
    while (queue.length) {
      const oid = queue.pop()!;
      if (seen.has(oid)) continue;
      seen.add(oid);
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push(p);
    }
    return seen;
  };
  const aSet = ancestorsOf(aP);
  const queue = [bP];
  const seenB = new Set<string>();
  while (queue.length) {
    const oid = queue.pop()!;
    if (seenB.has(oid)) continue;
    seenB.add(oid);
    if (aSet.has(oid)) return oid;
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.data).parents) queue.push(p);
  }
  return null;
}

/** Flat path -> {oid, mode} map of a tree (recursive). */
function flatTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return out;
  for (const e of parseTree(obj.data)) {
    const path = prefix ? `${prefix}/${e.name}` : e.name;
    if (e.mode === '40000') flatTree(repo, e.oid, path, out);
    else out.set(path, { oid: e.oid, mode: e.mode });
  }
  return out;
}

/** Build a tree object from a flat path map; returns the root tree oid. */
function treeFromFlat(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of files) {
    const segs = path.split('/');
    let node = root;
    for (let i = 0; i < segs.length - 1; i++) {
      const s = segs[i]!;
      if (!node.dirs.has(s)) node.dirs.set(s, make());
      node = node.dirs.get(s)!;
    }
    node.files.set(segs[segs.length - 1]!, entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, e] of node.files) entries.push({ mode: e.mode, name, oid: e.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return putObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Commit one file change on top of `parentCommit` (or root if null); returns new commit oid. */
function commitFileChange(repo: Repo, parentCommit: string | null, path: string, content: Buffer, message: string): { commit: string; blob: string } {
  const blob = putObject(repo, 'blob', content);
  const files = parentCommit ? flatTree(repo, parseCommit(getObject(repo, parentCommit)!.data).tree) : new Map();
  files.set(path, { oid: blob, mode: '100644' });
  const tree = treeFromFlat(repo, files);
  const parents = parentCommit ? [parentCommit] : [];
  const commit = putObject(repo, 'commit', buildCommit(tree, parents, message));
  return { commit, blob };
}

export interface FileDiff {
  filename: string;
  status: 'added' | 'modified' | 'removed';
  additions: number;
  deletions: number;
  changes: number;
}
function lineCount(b: Buffer): number {
  if (b.length === 0) return 0;
  const s = b.toString('utf8');
  return s.split('\n').length - (s.endsWith('\n') ? 1 : 0);
}
function diffFiles(repo: Repo, baseTree: string, headTree: string): FileDiff[] {
  const base = baseTree ? flatTree(repo, baseTree) : new Map<string, { oid: string; mode: string }>();
  const head = headTree ? flatTree(repo, headTree) : new Map<string, { oid: string; mode: string }>();
  const paths = new Set([...base.keys(), ...head.keys()]);
  const out: FileDiff[] = [];
  for (const p of [...paths].sort()) {
    const b = base.get(p);
    const h = head.get(p);
    if (b && !h) {
      const n = lineCount(getObject(repo, b.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: p, status: 'removed', additions: 0, deletions: n, changes: n });
    } else if (!b && h) {
      const n = lineCount(getObject(repo, h.oid)?.data ?? Buffer.alloc(0));
      out.push({ filename: p, status: 'added', additions: n, deletions: 0, changes: n });
    } else if (b && h && b.oid !== h.oid) {
      const oldLines = (getObject(repo, b.oid)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const newLines = (getObject(repo, h.oid)?.data ?? Buffer.alloc(0)).toString('utf8').split('\n');
      const oldCount = new Map<string, number>();
      for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
      let additions = 0;
      for (const l of newLines) {
        const c = oldCount.get(l) ?? 0;
        if (c > 0) oldCount.set(l, c - 1);
        else additions += 1;
      }
      let deletions = 0;
      for (const c of oldCount.values()) deletions += c;
      if (additions === 0 && deletions === 0) additions = 1;
      out.push({ filename: p, status: 'modified', additions, deletions, changes: additions + deletions });
    }
  }
  return out;
}

/** Resolve a ref name / branch / sha to a commit oid (or null). */
function resolveRef(repo: Repo, ref: string): string | null {
  if (isOid(ref)) return repo.objects.has(ref) ? ref : null;
  const direct = repo.refs.get(ref);
  if (direct) return direct;
  const headed = repo.refs.get(`refs/heads/${ref}`);
  if (headed) return headed;
  const tagged = repo.refs.get(`refs/tags/${ref}`);
  if (tagged) return tagged;
  return null;
}

/** List commits reachable from `tip` (newest first, following parents). */
function listCommits(repo: Repo, tip: string, limit = 100): Array<{ sha: string; commit: CommitView }> {
  const out: Array<{ sha: string; commit: CommitView }> = [];
  const seen = new Set<string>();
  const queue: string[] = [peelToNonTag(repo, tip)];
  while (queue.length && out.length < limit) {
    const oid = queue.shift()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'commit') continue;
    const c = parseCommit(obj.data);
    out.push({ sha: oid, commit: c });
    for (const p of c.parents) queue.push(p);
  }
  return out;
}

/** Does merging head into base conflict? (same file changed on both sides of merge-base). */
function mergeConflicts(repo: Repo, baseTip: string, headTip: string): boolean {
  const mb = mergeBase(repo, baseTip, headTip);
  if (mb === null) return false;
  const mbTree = parseCommit(getObject(repo, mb)!.data).tree;
  const baseTree = parseCommit(getObject(repo, peelToNonTag(repo, baseTip))!.data).tree;
  const headTree = parseCommit(getObject(repo, peelToNonTag(repo, headTip))!.data).tree;
  const mbFiles = flatTree(repo, mbTree);
  const baseFiles = flatTree(repo, baseTree);
  const headFiles = flatTree(repo, headTree);
  const paths = new Set([...mbFiles.keys(), ...baseFiles.keys(), ...headFiles.keys()]);
  for (const p of paths) {
    const m = mbFiles.get(p)?.oid;
    const b = baseFiles.get(p)?.oid;
    const h = headFiles.get(p)?.oid;
    if (h !== m && b !== m && h !== b) return true;
  }
  return false;
}

/** A pull request's base tip as it stands now (the branch may have moved since the PR opened). */
function pullBaseTipNow(repo: Repo, pull: Pull): string {
  return repo.refs.get(`refs/heads/${pull.baseRef}`) ?? pull.baseSha;
}

function globalId(kind: string, ...parts: Array<string | number>): string {
  return b64url(`${kind}:${parts.join(':')}`);
}
function parseGlobalId(id: string): { kind: string; parts: string[] } | null {
  const raw = unb64(id);
  const idx = raw.indexOf(':');
  if (idx < 0) return null;
  return { kind: raw.slice(0, idx), parts: raw.slice(idx + 1).split(':') };
}

// ---------------------------------------------------------------------------
// REST shapes
// ---------------------------------------------------------------------------

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('R', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: VIEWER_ID, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    pushed_at: FIXED_ISO,
    has_issues: true,
    has_projects: true,
    has_wiki: true,
    has_pages: false,
    has_downloads: true,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    forks_count: 0,
    stargazers_count: 0,
    watchers_count: 0,
    open_issues_count: repo.issues.filter((i) => i.state === 'open').length,
    license: null,
    topics: [],
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}
function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    body: issue.body ?? '',
    state: issue.state,
    locked: false,
    labels: issue.labels.map((n) => {
      const l = repo.labels.get(n);
      return { id: 0, node_id: '', name: n, color: l?.color ?? 'ededed', description: '' };
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    assignee: null,
    assignees: [],
    comments: issue.comments.length,
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: issue.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}
function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('P', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.state,
    locked: false,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}`, user: { login: repo.owner, id: VIEWER_ID } },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}`, user: { login: repo.owner, id: VIEWER_ID } },
    merged: pull.merged,
    mergeable: mergeConflicts(repo, pullBaseTipNow(repo, pull), pull.headSha) ? false : true,
    merge_commit_sha: pull.mergeCommitSha,
    merged_at: pull.mergedAt,
    merge_method: 'squash',
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    created_at: FIXED_ISO,
    updated_at: FIXED_ISO,
    closed_at: pull.state === 'closed' ? FIXED_ISO : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
  };
}
function commitJson(sha: string, c: CommitView): Record<string, unknown> {
  return {
    sha,
    node_id: globalId('C', sha),
    commit: {
      message: c.message.replace(/\n$/, ''),
      author: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      committer: { name: VIEWER_NAME, email: VIEWER_EMAIL, date: FIXED_ISO },
      tree: { sha: c.tree },
    },
    author: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    committer: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' },
    parents: c.parents.map((p) => ({ sha: p })),
    html_url: '',
    url: '',
  };
}
function pageParams(q: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(q.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(q.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}
function paginate<T>(items: readonly T[], q: URLSearchParams, req: IncomingMessage): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(q);
  const start = (page - 1) * perPage;
  const slice = items.slice(start, start + perPage);
  let link: string | null = null;
  const total = items.length;
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const host = req.headers.host ?? '127.0.0.1';
  const path = (req.url ?? '/').split('?')[0] ?? '/';
  const urlFor = (p: number): string => {
    const u = new URL(`http://${host}${path}`);
    for (const [k, v] of q) if (k !== 'page' && k !== 'per_page') u.searchParams.set(k, v);
    u.searchParams.set('page', String(p));
    u.searchParams.set('per_page', String(perPage));
    return u.toString();
  };
  const parts: string[] = [];
  if (page < lastPage) parts.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) parts.push(`<${urlFor(page - 1)}>; rel="prev"`);
  parts.push(`<${urlFor(1)}>; rel="first"`);
  parts.push(`<${urlFor(lastPage)}>; rel="last"`);
  if (parts.length) link = parts.join(', ');
  return { page: slice as T[], link };
}
function sendPage(res: ServerResponse, items: readonly unknown[], req: IncomingMessage): void {
  const q = queryOf(req);
  const { page, link } = paginate(items, q, req);
  const headers: Record<string, string> = {};
  if (link) headers.link = link;
  sendJson(res, 200, page, headers);
}

// ---------------------------------------------------------------------------
// REST v3
// ---------------------------------------------------------------------------

function needRepo(res: ServerResponse, owner: string, name: string): Repo | null {
  if (owner !== VIEWER_LOGIN) {
    notFound(res);
    return null;
  }
  const repo = store.getRepo(owner, name);
  if (!repo) {
    notFound(res);
    return null;
  }
  return repo;
}

async function handleRest(req: IncomingMessage, res: ServerResponse, segs: string[]): Promise<boolean> {
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  // Root and meta are public (as in the starter); everything else needs the token.
  const isRoot = segs.length === 0;
  const isMeta = segs.length === 1 && segs[0] === 'meta';
  if (!isRoot && !isMeta && !authed(req)) {
    unauthorized(res);
    return true;
  }
  if (isRoot && method === 'GET') {
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      current_user_authorizations_html_url: 'https://github.com/settings/applications',
      authorizations_url: '/api/v3/authorizations',
      code_search_url: '/api/v3/search/code?q={query}',
      commit_search_url: '/api/v3/search/commits?q={query}',
      emails_url: '/api/v3/user/emails',
      emojis_url: '/api/v3/emojis',
      events_url: '/api/v3/events',
      feeds_url: '/api/v3/feeds',
      followers_url: '/api/v3/user/followers',
      following_url: '/api/v3/user/following{/target}',
      gists_url: '/api/v3/gists{/gist_id}',
      hub_url: 'https://api.github.com/hub',
      issue_search_url: '/api/v3/search/issues?q={query}',
      issues_url: '/api/v3/issues',
      keys_url: '/api/v3/user/keys',
      label_search_url: '/api/v3/search/labels?q={query}',
      notifications_url: '/api/v3/notifications',
      organization_url: '/api/v3/orgs/{org}',
      organization_repositories_url: '/api/v3/orgs/{org}/repos{?type,page,per_page,sort}',
      organization_teams_url: '/api/v3/orgs/{org}/teams',
      public_gists_url: '/api/v3/gists/public',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
      repository_search_url: '/api/v3/search/repositories?q={query}',
      current_user_repositories_url: '/api/v3/user/repos{?type,page,per_page,sort}',
      starred_url: '/api/v3/user/starred{/owner}{/repo}',
      starred_gists_url: '/api/v3/user/starred',
      topic_search_url: '/api/v3/search/topics?q={query}',
      user_url: '/api/v3/users/{user}',
      user_organizations_url: '/api/v3/user/orgs',
      user_repositories_url: '/api/v3/users/{user}/repos{?type,page,per_page,sort}',
      user_search_url: '/api/v3/search/users?q={query}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }
  if (isMeta && method === 'GET') {
    sendJson(res, 200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // Bodies for write methods.
  let body: unknown = undefined;
  if (method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE') {
    const raw = await readBody(req);
    if (raw.length > 0) {
      const parsed = parseJsonBody(raw);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      body = parsed.value;
    } else {
      body = {};
    }
  }
  const b = isRecord(body) ? body : {};

  // GET /user
  if (segs.length === 1 && segs[0] === 'user' && method === 'GET') {
    sendJson(res, 200, {
      login: VIEWER_LOGIN, id: VIEWER_ID, node_id: globalId('U', VIEWER_ID),
      avatar_url: '', gravatar_id: '', type: 'User', site_admin: false,
      name: VIEWER_NAME, email: VIEWER_EMAIL, html_url: `https://github.com/${VIEWER_LOGIN}`,
      url: '/api/v3/user', followers_url: '/api/v3/user/followers', following_url: '/api/v3/user/following{/other_user}',
      repos_url: '/api/v3/user/repos', created_at: FIXED_ISO, updated_at: FIXED_ISO,
    });
    return true;
  }
  // /user/repos
  if (segs.length === 2 && segs[0] === 'user' && segs[1] === 'repos') {
    if (method === 'GET') {
      sendPage(res, store.userRepos().map(repoJson), req);
      return true;
    }
    if (method === 'POST') {
      const name = typeof b.name === 'string' ? b.name.trim() : '';
      if (!name || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendJson(res, 422, { message: 'Validation Failed: name is invalid' });
        return true;
      }
      if (store.getRepo(VIEWER_LOGIN, name)) {
        sendJson(res, 422, { message: 'Repository already exists', errors: [{ message: 'name already exists on this account' }] });
        return true;
      }
      const repo = store.createRepo(name, b.private === true, typeof b.description === 'string' ? b.description : '');
      sendJson(res, 201, repoJson(repo));
      return true;
    }
  }
  // GET /rate_limit
  if (segs.length === 1 && segs[0] === 'rate_limit' && method === 'GET') {
    sendJson(res, 200, { resources: { core: { limit: 5000, remaining: 4999, reset: 0, used: 1 }, search: { limit: 30, remaining: 30, reset: 0, used: 0 } }, rate: { limit: 5000, remaining: 4999, reset: 0, used: 1 } });
    return true;
  }
  // /repos/{owner}/{repo}[...]
  if (segs.length >= 3 && segs[0] === 'repos') {
    const owner = decodeURIComponent(segs[1]!);
    const name = decodeURIComponent(segs[2]!);
    const rest = segs.slice(3);
    // Repo itself
    if (rest.length === 0) {
      if (method === 'GET') {
        const repo = needRepo(res, owner, name);
        if (repo) sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const repo = needRepo(res, owner, name);
        if (!repo) return true;
        if (typeof b.description === 'string') repo.description = b.description;
        if (typeof b.private === 'boolean') repo.isPrivate = b.private;
        if (typeof b.default_branch === 'string' && repo.refs.has(`refs/heads/${b.default_branch}`)) repo.defaultBranch = b.default_branch;
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        const repo = needRepo(res, owner, name);
        if (!repo) return true;
        store.repos.delete(store.key(owner, name));
        sendJson(res, 204, null);
        return true;
      }
      return false;
    }
    const repo = needRepo(res, owner, name);
    if (!repo) return true;
    const sub = rest[0]!;

    // branches
    if (sub === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        const list = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith('refs/heads/'))
          .map(([r, sha]) => ({ name: r.slice('refs/heads/'.length), commit: { sha, url: '' }, protected: false }))
          .sort((a, c) => (a.name < c.name ? -1 : 1));
        sendJson(res, 200, list);
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const branch = decodeURIComponent(rest[1]!);
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (!sha) {
          notFound(res);
          return true;
        }
        sendJson(res, 200, { name: branch, commit: { sha, url: '' }, protected: false });
        return true;
      }
      return false;
    }
    // commits
    if (sub === 'commits' && rest.length === 1 && method === 'GET') {
      const ref = q.get('sha') ?? repo.defaultBranch;
      const tip = resolveRef(repo, ref);
      if (!tip) {
        sendJson(res, 200, []);
        return true;
      }
      const list = listCommits(repo, tip).map(({ sha, commit }) => commitJson(sha, commit));
      sendPage(res, list, req);
      return true;
    }
    // git/refs
    if (sub === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = typeof b.ref === 'string' ? b.ref : '';
        const sha = typeof b.sha === 'string' ? b.sha : '';
        if (!ref.startsWith('refs/') || !isOid(sha) || !repo.objects.has(sha)) {
          sendJson(res, 422, { message: 'Validation Failed: ref or sha is invalid' });
          return true;
        }
        if (repo.refs.has(ref)) {
          sendJson(res, 422, { message: 'Reference already exists' });
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, 201, { ref, node_id: globalId('RF', repo.id, ref), url: '', object: { sha, type: getObject(repo, sha)?.type ?? 'commit', url: '' } });
        return true;
      }
      if (method === 'GET') {
        const remainder = rest.slice(2).map(decodeURIComponent).join('/');
        if (remainder === '') {
          const all = [...repo.refs.entries()]
            .sort(([a], [c]) => (a < c ? -1 : 1))
            .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } }));
          sendJson(res, 200, all);
          return true;
        }
        const exact = repo.refs.get(remainder);
        if (exact) {
          sendJson(res, 200, { ref: remainder, object: { sha: exact, type: getObject(repo, exact)?.type ?? 'commit' } });
          return true;
        }
        const prefixed = [...repo.refs.entries()]
          .filter(([r]) => r.startsWith(remainder))
          .sort(([a], [c]) => (a < c ? -1 : 1))
          .map(([ref, sha]) => ({ ref, object: { sha, type: getObject(repo, sha)?.type ?? 'commit' } }));
        if (prefixed.length) {
          sendJson(res, 200, prefixed);
          return true;
        }
        notFound(res);
        return true;
      }
      return false;
    }
    // contents
    if (sub === 'contents') {
      const filePath = rest.slice(1).map(decodeURIComponent).join('/');
      const refParam = q.get('ref') ?? undefined;
      if (method === 'GET') {
        const tip = resolveRef(repo, refParam ?? repo.defaultBranch);
        if (!tip) {
          notFound(res);
          return true;
        }
        const treeOid = parseCommit(getObject(repo, peelToNonTag(repo, tip))!.data).tree;
        if (filePath === '') {
          const entries = [...flatTree(repo, treeOid).keys()].filter((p) => !p.includes('/'));
          const list = entries.map((p) => {
            const e = flatTree(repo, treeOid).get(p)!;
            return { type: 'file', name: p, path: p, sha: e.oid, size: (getObject(repo, e.oid)?.data.length ?? 0), url: '', html_url: '', download_url: null };
          });
          // include top-level dirs
          const dirs = new Set<string>();
          for (const p of flatTree(repo, treeOid).keys()) if (p.includes('/')) dirs.add(p.split('/')[0]!);
          for (const d of [...dirs].sort()) {
            list.push({ type: 'dir', name: d, path: d, sha: treeOid, size: 0, url: '', html_url: '', download_url: null });
          }
          sendJson(res, 200, list);
          return true;
        }
        const flat = flatTree(repo, treeOid);
        const file = flat.get(filePath);
        if (file) {
          const data = getObject(repo, file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file', encoding: 'base64', size: data.length, name: filePath.split('/').pop(),
            path: filePath, content: data.toString('base64'), sha: file.oid,
            url: '', html_url: '', download_url: null, _links: {},
          });
          return true;
        }
        // directory?
        const prefix = `${filePath}/`;
        const children = new Map<string, { type: 'file' | 'dir'; sha: string; size: number }>();
        for (const [p, e] of flat) {
          if (!p.startsWith(prefix)) continue;
          const rest2 = p.slice(prefix.length);
          if (!rest2.includes('/')) children.set(rest2, { type: 'file', sha: e.oid, size: getObject(repo, e.oid)?.data.length ?? 0 });
          else children.set(rest2.split('/')[0]!, { type: 'dir', sha: treeOid, size: 0 });
        }
        if (children.size) {
          const list = [...children.entries()].sort(([a], [c]) => (a < c ? -1 : 1)).map(([n, e]) => ({
            type: e.type, name: n, path: `${filePath}/${n}`, sha: e.sha, size: e.size, url: '', html_url: '', download_url: null,
          }));
          sendJson(res, 200, list);
          return true;
        }
        notFound(res);
        return true;
      }
      if (method === 'PUT') {
        const contentB64 = typeof b.content === 'string' ? b.content : '';
        const message = typeof b.message === 'string' ? b.message : `Update ${filePath}`;
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        let content: Buffer;
        try {
          content = Buffer.from(contentB64.replace(/\s+/g, ''), 'base64');
        } catch {
          sendJson(res, 422, { message: 'content is not valid base64' });
          return true;
        }
        const tip = repo.refs.get(`refs/heads/${branch}`) ?? null;
        let existed = false;
        let currentSha: string | null = null;
        if (tip) {
          const treeOid = parseCommit(getObject(repo, tip)!.data).tree;
          const f = flatTree(repo, treeOid).get(filePath);
          if (f) {
            existed = true;
            currentSha = f.oid;
          }
        }
        if (typeof b.sha === 'string' && b.sha !== '' && existed && b.sha.toLowerCase() !== currentSha) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        const { commit, blob } = commitFileChange(repo, tip, filePath, content, message);
        repo.refs.set(`refs/heads/${branch}`, commit);
        sendJson(res, existed ? 200 : 201, {
          content: { name: filePath.split('/').pop(), path: filePath, sha: blob, size: content.length, encoding: 'base64' },
          commit: { sha: commit, message },
        });
        return true;
      }
      if (method === 'DELETE') {
        const branch = typeof b.branch === 'string' ? b.branch : repo.defaultBranch;
        const tip = repo.refs.get(`refs/heads/${branch}`);
        if (!tip) {
          notFound(res);
          return true;
        }
        const treeOid = parseCommit(getObject(repo, tip)!.data).tree;
        const flat = flatTree(repo, treeOid);
        const f = flat.get(filePath);
        if (!f) {
          notFound(res);
          return true;
        }
        if (typeof b.sha === 'string' && b.sha !== '' && b.sha.toLowerCase() !== f.oid) {
          sendJson(res, 409, { message: 'sha does not match the current file' });
          return true;
        }
        flat.delete(filePath);
        const tree = treeFromFlat(repo, flat);
        const message = typeof b.message === 'string' ? b.message : `Delete ${filePath}`;
        const commit = putObject(repo, 'commit', buildCommit(tree, [tip], message));
        repo.refs.set(`refs/heads/${branch}`, commit);
        sendJson(res, 200, { content: null, commit: { sha: commit, message } });
        return true;
      }
      return false;
    }
    // labels
    if (sub === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((l) => ({ name: l.name, color: l.color, description: '' })));
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        const name = typeof b.name === 'string' ? b.name : '';
        const color = typeof b.color === 'string' ? b.color.replace(/^#/, '') : 'ededed';
        if (!name) {
          sendJson(res, 422, { message: 'Validation Failed: name is required' });
          return true;
        }
        repo.labels.set(name, { name, color });
        sendJson(res, 201, { name, color, description: typeof b.description === 'string' ? b.description : '' });
        return true;
      }
      return false;
    }
    // issues
    if (sub === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          const sort = q.get('sort') ?? 'created';
          const direction = q.get('direction') ?? 'desc';
          let list = [...repo.issues];
          if (state === 'open') list = list.filter((i) => i.state === 'open');
          else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
          if (sort === 'created') list.sort((a, c) => (direction === 'asc' ? a.seq - c.seq : c.seq - a.seq));
          sendPage(res, list.map((i) => issueJson(repo, i)), req);
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          if (!title) {
            sendJson(res, 422, { message: 'Validation Failed: title is required' });
            return true;
          }
          const labelsRaw: unknown[] = Array.isArray(b.labels) ? b.labels : [];
          const labelNames: string[] = [];
          for (const l of labelsRaw) {
            const n = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
            if (!n) continue;
            if (!repo.labels.has(n)) {
              sendJson(res, 422, { message: `Validation Failed: label "${n}" does not exist` });
              return true;
            }
            labelNames.push(n);
          }
          const issue: Issue = {
            id: ++store.nextObjectId,
            number: repo.nextNumber++,
            title,
            body: typeof b.body === 'string' ? b.body : '',
            state: 'open',
            labels: labelNames,
            comments: [],
            seq: ++store.seq,
          };
          repo.issues.push(issue);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      const num = parseInt(rest[1] ?? '', 10);
      const issue = repo.issues.find((i) => i.number === num);
      if (rest.length === 2) {
        if (!issue) {
          notFound(res);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          if (typeof b.title === 'string') issue.title = b.title;
          if (typeof b.body === 'string') issue.body = b.body;
          if (b.state === 'open' || b.state === 'closed') issue.state = b.state;
          if (Array.isArray(b.labels)) {
            const names: string[] = [];
            for (const l of b.labels) {
              const n = typeof l === 'string' ? l : isRecord(l) && typeof l.name === 'string' ? l.name : '';
              if (n && repo.labels.has(n)) names.push(n);
            }
            issue.labels = names;
          }
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        return false;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (!issue) {
          notFound(res);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((c) => ({
            id: c.id, node_id: globalId('C', repo.id, issue.number, c.id), body: c.body,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO,
            html_url: '', url: '',
          })));
          return true;
        }
        if (method === 'POST') {
          const text = typeof b.body === 'string' ? b.body : '';
          const comment: Comment = { id: repo.nextCommentId++, body: text, seq: ++store.seq };
          issue.comments.push(comment);
          sendJson(res, 201, {
            id: comment.id, node_id: globalId('C', repo.id, issue.number, comment.id), body: text,
            user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: 'User' }, created_at: FIXED_ISO, updated_at: FIXED_ISO,
            html_url: '', url: '',
          });
          return true;
        }
        return false;
      }
      return false;
    }
    // pulls
    if (sub === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const state = q.get('state') ?? 'open';
          let list = [...repo.pulls];
          if (state === 'open') list = list.filter((p) => p.state === 'open');
          else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
          list.sort((a, c) => c.seq - a.seq);
          sendPage(res, list.map((p) => pullJson(repo, p)), req);
          return true;
        }
        if (method === 'POST') {
          const title = typeof b.title === 'string' ? b.title : '';
          const head = typeof b.head === 'string' ? b.head : '';
          const base = typeof b.base === 'string' ? b.base : repo.defaultBranch;
          if (!title || !head) {
            sendJson(res, 422, { message: 'Validation Failed: title and head are required' });
            return true;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (!headSha || !baseSha) {
            sendJson(res, 422, { message: 'Validation Failed: head or base branch does not exist' });
            return true;
          }
          const dup = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
          if (dup) {
            sendJson(res, 422, { message: 'Validation Failed: a pull request already exists for this head and base' });
            return true;
          }
          const pull: Pull = {
            id: ++store.nextObjectId, number: repo.nextNumber++, title,
            body: typeof b.body === 'string' ? b.body : '', state: 'open', merged: false,
            mergedAt: null, mergeCommitSha: null, headRef: head, baseRef: base,
            headSha, baseSha, seq: ++store.seq,
          };
          repo.pulls.push(pull);
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        return false;
      }
      const num = parseInt(rest[1] ?? '', 10);
      const pull = repo.pulls.find((p) => p.number === num);
      if (rest.length === 2) {
        if (!pull) {
          notFound(res);
          return true;
        }
        if (method === 'GET') {
          sendJson(res, 200, pullJson(repo, pull));
          return true;
        }
        return false;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        if (!pull) {
          notFound(res);
          return true;
        }
        const baseTree = parseCommit(getObject(repo, peelToNonTag(repo, pull.baseSha))!.data).tree;
        const headTree = parseCommit(getObject(repo, peelToNonTag(repo, pull.headSha))!.data).tree;
        const files = diffFiles(repo, baseTree, headTree).map((f) => ({
          sha: '', filename: f.filename, status: f.status, additions: f.additions,
          deletions: f.deletions, changes: f.changes, blob_url: '', raw_url: '', contents_url: '',
        }));
        sendJson(res, 200, files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        if (!pull) {
          notFound(res);
          return true;
        }
        if (pull.merged || pull.state === 'closed') {
          sendJson(res, 405, { message: 'Pull Request is already merged or closed' });
          return true;
        }
        if (mergeConflicts(repo, pullBaseTipNow(repo, pull), pull.headSha)) {
          sendJson(res, 405, { message: 'Merge conflict: the pull request cannot be merged' });
          return true;
        }
        const headTree = parseCommit(getObject(repo, peelToNonTag(repo, pull.headSha))!.data).tree;
        const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
        const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
        const mergeCommit = putObject(repo, 'commit', buildCommit(headTree, [baseTip], message));
        repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
        pull.merged = true;
        pull.state = 'closed';
        pull.mergedAt = FIXED_ISO;
        pull.mergeCommitSha = mergeCommit;
        sendJson(res, 200, { sha: mergeCommit, merged: true, message: 'Pull Request successfully merged' });
        return true;
      }
      return false;
    }
    return false;
  }
  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4 (small parser + executor for the documents gh / github-mcp-server send)
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: GqlValue[] }
  | { kind: 'object'; fields: Array<{ name: string; value: GqlValue }> };

interface GqlField {
  alias: string | null;
  name: string;
  args: Array<{ name: string; value: GqlValue }>;
  children: GqlField[];
  inlineType: string | null; // for `... on Type { }` (applies to children)
}
interface GqlOp {
  kind: 'query' | 'mutation';
  name: string | null;
  varDefs: Array<{ name: string; type: string }>;
  fields: GqlField[];
}

function gqlTokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s|,/.test(c)) {
      i++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if ('{}()[]:!=$@'.includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    if (c === '.') {
      if (src.slice(i, i + 3) === '...') {
        tokens.push('...');
        i += 3;
        continue;
      }
      throw new Error('bad dot');
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1]!;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_0-9-]/.test(c)) {
      let j = i;
      while (j < src.length && /[A-Za-z_0-9-]/.test(src[j]!)) j++;
      tokens.push(src.slice(i, j));
      i = j;
      continue;
    }
    throw new Error(`unexpected char ${c}`);
  }
  return tokens;
}

class GqlParser {
  tokens: string[];
  pos = 0;
  constructor(src: string) {
    this.tokens = gqlTokenize(src);
  }
  peek(): string | undefined {
    return this.tokens[this.pos];
  }
  next(): string {
    return this.tokens[this.pos++] ?? '';
  }
  expect(t: string): void {
    const got = this.next();
    if (got !== t) throw new Error(`expected ${t}, got ${got}`);
  }
  parseValue(): GqlValue {
    const t = this.next();
    if (t === '$') return { kind: 'variable', name: this.next() };
    if (t === '[') {
      const values: GqlValue[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', values };
    }
    if (t === '{') {
      const fields: Array<{ name: string; value: GqlValue }> = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (t === 'true') return { kind: 'boolean', value: true };
    if (t === 'false') return { kind: 'boolean', value: false };
    if (t === 'null') return { kind: 'null' };
    if (t.startsWith('"')) return { kind: 'string', value: JSON.parse(t) as string };
    if (/^-?\d+$/.test(t)) return { kind: 'int', value: parseInt(t, 10) };
    if (/^-?\d+\.\d+$/.test(t)) return { kind: 'float', value: parseFloat(t) };
    return { kind: 'enum', value: t };
  }
  parseArgs(): Array<{ name: string; value: GqlValue }> {
    const args: Array<{ name: string; value: GqlValue }> = [];
    if (this.peek() !== '(') return args;
    this.expect('(');
    while (this.peek() !== ')') {
      const name = this.next();
      this.expect(':');
      args.push({ name, value: this.parseValue() });
    }
    this.expect(')');
    return args;
  }
  parseSelection(): GqlField[] {
    this.expect('{');
    const fields: GqlField[] = [];
    while (this.peek() !== '}') {
      fields.push(...this.parseField());
    }
    this.expect('}');
    return fields;
  }
  parseField(): GqlField[] {
    if (this.peek() === '...') {
      this.next();
      let inlineType: string | null = null;
      if (this.peek() === 'on') {
        this.next();
        inlineType = this.next();
      } else {
        // named fragment spread: not used by the suite; skip its selection if any
        this.next();
        return [];
      }
      const children = this.parseSelection();
      return children.map((c) => ({ ...c, inlineType }));
    }
    let name = this.next();
    let alias: string | null = null;
    if (this.peek() === ':') {
      this.next();
      alias = name;
      name = this.next();
    }
    const args = this.parseArgs();
    let children: GqlField[] = [];
    if (this.peek() === '{') children = this.parseSelection();
    return [{ alias, name, args, children, inlineType: null }];
  }
  parseOperation(): GqlOp {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t === 'query' || t === 'mutation') {
      kind = this.next() as 'query' | 'mutation';
    }
    let name: string | null = null;
    if (this.peek() !== undefined && this.peek() !== '{' && this.peek() !== '(') name = this.next();
    const varDefs: Array<{ name: string; type: string }> = [];
    if (this.peek() === '(') {
      this.expect('(');
      while (this.peek() !== ')') {
        this.expect('$');
        const vn = this.next();
        this.expect(':');
        let type = '';
        while (this.peek() !== undefined && this.peek() !== ',' && this.peek() !== ')' && this.peek() !== '=') type += this.next();
        if (this.peek() === '=') {
          this.next();
          this.parseValue();
        }
        varDefs.push({ name: vn, type });
      }
      this.expect(')');
    }
    const fields = this.parseSelection();
    return { kind, name, varDefs, fields };
  }
}

function evalGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable':
      return vars[v.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.values.map((x) => evalGqlValue(x, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = evalGqlValue(f.value, vars);
      return out;
    }
  }
}
function argMap(field: GqlField, vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const a of field.args) out[a.name] = evalGqlValue(a.value, vars);
  return out;
}

// Schema field tables (for validation + introspection).
const GQL_TYPES: Record<string, { fields: string[]; kind: 'OBJECT' | 'ENUM'; enumValues?: string[] }> = {
  Query: { kind: 'OBJECT', fields: ['viewer', 'repository', 'node', '__type', '__schema'] },
  User: { kind: 'OBJECT', fields: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'] },
  Repository: {
    kind: 'OBJECT',
    fields: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url', 'createdAt'],
  },
  Issue: { kind: 'OBJECT', fields: ['id', 'number', 'title', 'state', 'body', 'createdAt', 'updatedAt', 'url', 'author', 'comments'] },
  PullRequest: {
    kind: 'OBJECT',
    fields: ['id', 'number', 'title', 'body', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files', 'mergedAt', 'mergeCommit', 'headRef', 'baseRef', 'url', 'createdAt'],
  },
  Ref: { kind: 'OBJECT', fields: ['name', 'target'] },
  IssueConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestChangedFileConnection: { kind: 'OBJECT', fields: ['nodes', 'edges', 'totalCount', 'pageInfo'] },
  PullRequestChangedFile: { kind: 'OBJECT', fields: ['path', 'additions', 'deletions', 'changeType'] },
  PageInfo: { kind: 'OBJECT', fields: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'] },
  IssueEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  PullRequestEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueCommentEdge: { kind: 'OBJECT', fields: ['node', 'cursor'] },
  IssueComment: { kind: 'OBJECT', fields: ['id', 'body', 'createdAt', 'author'] },
  __Type: { kind: 'OBJECT', fields: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes'] },
  __Field: { kind: 'OBJECT', fields: ['name', 'description', 'args', 'type'] },
  __EnumValue: { kind: 'OBJECT', fields: ['name', 'description'] },
  __Schema: { kind: 'OBJECT', fields: ['types', 'queryType', 'mutationType'] },
  Mutation: { kind: 'OBJECT', fields: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'] },
  CreateIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CloseIssuePayload: { kind: 'OBJECT', fields: ['issue', 'clientMutationId'] },
  CreatePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  MergePullRequestPayload: { kind: 'OBJECT', fields: ['pullRequest', 'clientMutationId'] },
  AddCommentPayload: { kind: 'OBJECT', fields: ['commentEdge', 'subject', 'clientMutationId'] },
  IssueState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED'] },
  PullRequestState: { kind: 'ENUM', fields: [], enumValues: ['OPEN', 'CLOSED', 'MERGED'] },
  MergeableState: { kind: 'ENUM', fields: [], enumValues: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'] },
  PullRequestMergeMethod: { kind: 'ENUM', fields: [], enumValues: ['MERGE', 'SQUASH', 'REBASE'] },
  RepositoryPermission: { kind: 'ENUM', fields: [], enumValues: ['ADMIN', 'MAINTAIN', 'WRITE', 'TRIAGE', 'READ'] },
  SearchType: { kind: 'ENUM', fields: [], enumValues: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE'] },
  IssueOrderField: { kind: 'ENUM', fields: [], enumValues: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'] },
  OrderDirection: { kind: 'ENUM', fields: [], enumValues: ['ASC', 'DESC'] },
};

function fieldTypeName(parent: string, field: string): string {
  if (field === 'nodes') {
    if (parent === 'IssueConnection') return 'Issue';
    if (parent === 'PullRequestConnection') return 'PullRequest';
    if (parent === 'PullRequestChangedFileConnection') return 'PullRequestChangedFile';
  }
  if (field === 'pageInfo') return 'PageInfo';
  if (field === 'edges') {
    if (parent === 'IssueConnection') return 'IssueEdge';
    if (parent === 'PullRequestConnection') return 'PullRequestEdge';
  }
  if (field === 'node') {
    if (parent === 'IssueEdge') return 'Issue';
    if (parent === 'PullRequestEdge') return 'PullRequest';
    if (parent === 'IssueCommentEdge') return 'IssueComment';
  }
  if (parent === 'Query') {
    if (field === 'viewer') return 'User';
    if (field === 'repository') return 'Repository';
    if (field === 'node') return 'Repository';
    if (field === '__type') return '__Type';
    if (field === '__schema') return '__Schema';
  }
  if (parent === 'Repository') {
    if (field === 'owner') return 'User';
    if (field === 'defaultBranchRef') return 'Ref';
    if (field === 'issue') return 'Issue';
    if (field === 'issues') return 'IssueConnection';
    if (field === 'pullRequests') return 'PullRequestConnection';
    if (field === 'pullRequest') return 'PullRequest';
  }
  if (parent === 'PullRequest' && field === 'files') return 'PullRequestChangedFileConnection';
  if (parent === 'AddCommentPayload' && field === 'commentEdge') return 'IssueCommentEdge';
  if (parent === 'CreateIssuePayload' || parent === 'CloseIssuePayload') return 'Issue';
  if (parent === 'CreatePullRequestPayload' || parent === 'MergePullRequestPayload') return 'PullRequest';
  if (parent === '__Type' && field === 'fields') return '__Field';
  if (parent === '__Type' && field === 'enumValues') return '__EnumValue';
  return 'String';
}

function issueGql(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalId('I', repo.id, issue.number),
    number: issue.number,
    title: issue.title,
    state: issue.state === 'open' ? 'OPEN' : 'CLOSED',
    body: issue.body ?? '',
    createdAt: FIXED_ISO,
    updatedAt: FIXED_ISO,
    url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
  };
}
function pullGql(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: globalId('P', repo.id, pull.number),
    number: pull.number,
    title: pull.title,
    body: pull.body ?? '',
    state: pull.merged ? 'MERGED' : pull.state === 'open' ? 'OPEN' : 'CLOSED',
    merged: pull.merged,
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
    mergeable: mergeConflicts(repo, pullBaseTipNow(repo, pull), pull.headSha) ? 'CONFLICTING' : 'MERGEABLE',
    mergedAt: pull.mergedAt,
    url: `https://github.com/${repo.owner}/${repo.name}/pull/${pull.number}`,
  };
}
function repoGql(repo: Repo): Record<string, unknown> {
  return {
    id: globalId('R', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    description: repo.description,
    isPrivate: repo.isPrivate,
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    url: `https://github.com/${repo.owner}/${repo.name}`,
    createdAt: FIXED_ISO,
  };
}

interface GqlCtx {
  errors: Array<{ message: string }>;
  vars: Record<string, unknown>;
}

function resolveFields(
  ctx: GqlCtx,
  parentType: string,
  obj: Record<string, unknown> | null,
  fields: GqlField[],
  resolver: (type: string, obj: Record<string, unknown> | null, field: GqlField) => unknown,
): Record<string, unknown> | null {
  if (obj === null) return null;
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.inlineType !== null && f.inlineType !== parentType && f.inlineType !== 'Node') continue;
    const key = f.alias ?? f.name;
    const known = GQL_TYPES[parentType]?.fields ?? [];
    if (!known.includes(f.name) && !f.name.startsWith('__')) {
      ctx.errors.push({ message: `Cannot query field "${f.name}" on type "${parentType}".` });
      out[key] = null;
      continue;
    }
    out[key] = resolver(parentType, obj, f);
  }
  return out;
}

function executeGql(op: GqlOp, vars: Record<string, unknown>): { data: unknown; errors?: Array<{ message: string }> } {
  const ctx: GqlCtx = { errors: [], vars };
  const isMutation = op.kind === 'mutation';
  const rootType = isMutation ? 'Mutation' : 'Query';

  const resolveValue = (parentType: string, obj: Record<string, unknown> | null, field: GqlField): unknown => {
    const args = argMap(field, vars);
    const children = field.children;
    // Scalars with no children.
    const scalar = (v: unknown): unknown => v;

    if (parentType === 'Query') {
      if (field.name === 'viewer') {
        const user: Record<string, unknown> = { login: VIEWER_LOGIN, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL, url: `https://github.com/${VIEWER_LOGIN}` };
        return children.length ? resolveFields(ctx, 'User', user, children, resolveValue) : user;
      }
      if (field.name === 'repository') {
        const owner = String(args.owner ?? '');
        const name = String(args.name ?? '');
        const repo = owner === VIEWER_LOGIN ? store.getRepo(owner, name) : undefined;
        if (!repo) return null;
        return resolveRepository(ctx, repo, children);
      }
      if (field.name === 'node') {
        const id = String(args.id ?? '');
        const parsed = parseGlobalId(id);
        if (!parsed) return null;
        if (parsed.kind === 'R') {
          const repoId = parseInt(parsed.parts[0] ?? '', 10);
          for (const r of store.repos.values()) {
            if (r.id === repoId) return resolveRepository(ctx, r, children);
          }
          return null;
        }
        return null;
      }
      if (field.name === '__type') {
        const name = String(args.name ?? '');
        const t = GQL_TYPES[name];
        if (!t) return null;
        const typeObj: Record<string, unknown> = { name, kind: t.kind, description: null };
        return children.length ? resolveFields(ctx, '__Type', typeObj, children, resolveValue) : typeObj;
      }
      if (field.name === '__schema') {
        const s: Record<string, unknown> = { queryType: { name: 'Query' }, mutationType: { name: 'Mutation' } };
        return children.length ? resolveFields(ctx, '__Schema', s, children, resolveValue) : s;
      }
      return null;
    }
    if (parentType === 'Mutation') {
      if (field.name === 'createIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = parseGlobalId(String(input.repositoryId ?? ''));
        let repo: Repo | undefined;
        if (repoId?.kind === 'R') {
          const id = parseInt(repoId.parts[0] ?? '', 10);
          for (const r of store.repos.values()) if (r.id === id) repo = r;
        }
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
          return null;
        }
        const title = typeof input.title === 'string' ? input.title : '';
        const issue: Issue = {
          id: ++store.nextObjectId, number: repo.nextNumber++, title,
          body: typeof input.body === 'string' ? input.body : '', state: 'open', labels: [], comments: [], seq: ++store.seq,
        };
        repo.issues.push(issue);
        const payload: Record<string, unknown> = { issue: issueGql(repo, issue) };
        return children.length ? resolveFields(ctx, 'CreateIssuePayload', payload, children, resolveValue) : payload;
      }
      if (field.name === 'closeIssue') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(String(input.issueId ?? ''));
        let found: { repo: Repo; issue: Issue } | null = null;
        if (parsed?.kind === 'I') {
          const repoId = parseInt(parsed.parts[0] ?? '', 10);
          const num = parseInt(parsed.parts[1] ?? '', 10);
          for (const r of store.repos.values()) {
            if (r.id !== repoId) continue;
            const iss = r.issues.find((i) => i.number === num);
            if (iss) found = { repo: r, issue: iss };
          }
        }
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
          return null;
        }
        found.issue.state = 'closed';
        const payload: Record<string, unknown> = { issue: issueGql(found.repo, found.issue) };
        return children.length ? resolveFields(ctx, 'CloseIssuePayload', payload, children, resolveValue) : payload;
      }
      if (field.name === 'createPullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const repoId = parseGlobalId(String(input.repositoryId ?? ''));
        let repo: Repo | undefined;
        if (repoId?.kind === 'R') {
          const id = parseInt(repoId.parts[0] ?? '', 10);
          for (const r of store.repos.values()) if (r.id === id) repo = r;
        }
        if (!repo) {
          ctx.errors.push({ message: 'Could not resolve to a Repository with the global id.' });
          return null;
        }
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        const headSha = repo.refs.get(`refs/heads/${head}`);
        const baseSha = repo.refs.get(`refs/heads/${base}`);
        if (!headSha || !baseSha) {
          ctx.errors.push({ message: 'Head or base ref does not exist.' });
          return null;
        }
        let pull = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
        if (!pull) {
          pull = {
            id: ++store.nextObjectId, number: repo.nextNumber++,
            title: typeof input.title === 'string' ? input.title : '',
            body: typeof input.body === 'string' ? input.body : '', state: 'open', merged: false,
            mergedAt: null, mergeCommitSha: null, headRef: head, baseRef: base, headSha, baseSha, seq: ++store.seq,
          };
          repo.pulls.push(pull);
        }
        const payload: Record<string, unknown> = { pullRequest: pullGql(repo, pull) };
        return children.length ? resolveFields(ctx, 'CreatePullRequestPayload', payload, children, resolveValue) : payload;
      }
      if (field.name === 'mergePullRequest') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(String(input.pullRequestId ?? ''));
        let found: { repo: Repo; pull: Pull } | null = null;
        if (parsed?.kind === 'P') {
          const repoId = parseInt(parsed.parts[0] ?? '', 10);
          const num = parseInt(parsed.parts[1] ?? '', 10);
          for (const r of store.repos.values()) {
            if (r.id !== repoId) continue;
            const pr = r.pulls.find((p) => p.number === num);
            if (pr) found = { repo: r, pull: pr };
          }
        }
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to a PullRequest with the global id.' });
          return null;
        }
        const { repo, pull } = found;
        if (!pull.merged && pull.state === 'open' && !mergeConflicts(repo, pullBaseTipNow(repo, pull), pull.headSha)) {
          const headTree = parseCommit(getObject(repo, peelToNonTag(repo, pull.headSha))!.data).tree;
          const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
          const mergeCommit = putObject(repo, 'commit', buildCommit(headTree, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`));
          repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
          pull.merged = true;
          pull.state = 'closed';
          pull.mergedAt = FIXED_ISO;
          pull.mergeCommitSha = mergeCommit;
        }
        const payload: Record<string, unknown> = { pullRequest: pullGql(repo, pull) };
        return children.length ? resolveFields(ctx, 'MergePullRequestPayload', payload, children, resolveValue) : payload;
      }
      if (field.name === 'addComment') {
        const input = isRecord(args.input) ? args.input : {};
        const parsed = parseGlobalId(String(input.subjectId ?? ''));
        let found: { repo: Repo; issue: Issue } | null = null;
        if (parsed?.kind === 'I') {
          const repoId = parseInt(parsed.parts[0] ?? '', 10);
          const num = parseInt(parsed.parts[1] ?? '', 10);
          for (const r of store.repos.values()) {
            if (r.id !== repoId) continue;
            const iss = r.issues.find((i) => i.number === num);
            if (iss) found = { repo: r, issue: iss };
          }
        }
        if (!found) {
          ctx.errors.push({ message: 'Could not resolve to an Issue with the global id.' });
          return null;
        }
        const text = typeof input.body === 'string' ? input.body : '';
        const comment: Comment = { id: found.repo.nextCommentId++, body: text, seq: ++store.seq };
        found.issue.comments.push(comment);
        const node: Record<string, unknown> = { id: globalId('C', found.repo.id, found.issue.number, comment.id), body: text };
        const payload: Record<string, unknown> = { commentEdge: { node, cursor: b64(`cursor:${comment.id}`) } };
        return children.length ? resolveFields(ctx, 'AddCommentPayload', payload, children, resolveValue) : payload;
      }
      return null;
    }
    if (parentType === '__Type') {
      const t = GQL_TYPES[String(obj?.name ?? '')];
      if (field.name === 'fields') {
        const names = t?.fields ?? [];
        const list = names.map((n) => ({ name: n, description: null }));
        if (!children.length) return list;
        return list.map((f) => resolveFields(ctx, '__Field', f as unknown as Record<string, unknown>, children, resolveValue));
      }
      if (field.name === 'enumValues') {
        const names = t?.enumValues ?? [];
        const list = names.map((n) => ({ name: n, description: null }));
        if (!children.length) return list;
        return list.map((f) => resolveFields(ctx, '__EnumValue', f as unknown as Record<string, unknown>, children, resolveValue));
      }
      if (field.name === 'kind') return t?.kind ?? 'OBJECT';
      if (field.name === 'name') return obj?.name ?? null;
      return scalar(obj?.[field.name]);
    }
    // Generic object field read.
    const v = obj?.[field.name];
    if (children.length === 0) return scalar(v);
    if (Array.isArray(v)) {
      const childType = fieldTypeName(parentType, field.name);
      return v.map((item) => (isRecord(item) ? resolveFields(ctx, childType, item, children, resolveValue) : item));
    }
    if (isRecord(v)) {
      const childType = fieldTypeName(parentType, field.name);
      return resolveFields(ctx, childType, v, children, resolveValue);
    }
    return v ?? null;
  };

  const resolveRepository = (c: GqlCtx, repo: Repo, fields: GqlField[]): Record<string, unknown> | null => {
    const base = repoGql(repo);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const key = f.alias ?? f.name;
      const known = GQL_TYPES.Repository?.fields ?? [];
      if (!known.includes(f.name)) {
        c.errors.push({ message: `Cannot query field "${f.name}" on type "Repository".` });
        out[key] = null;
        continue;
      }
      const args = argMap(f, vars);
      if (f.name === 'owner') {
        const user: Record<string, unknown> = { login: repo.owner, id: String(VIEWER_ID), name: VIEWER_NAME, email: VIEWER_EMAIL };
        out[key] = f.children.length ? resolveFields(c, 'User', user, f.children, resolveValue) : user;
        continue;
      }
      if (f.name === 'defaultBranchRef') {
        const ref: Record<string, unknown> = { name: repo.defaultBranch };
        out[key] = f.children.length ? resolveFields(c, 'Ref', ref, f.children, resolveValue) : ref;
        continue;
      }
      if (f.name === 'issue') {
        const num = Number(args.number);
        const issue = repo.issues.find((i) => i.number === num);
        out[key] = issue ? resolveIssueFields(c, repo, issue, f.children) : null;
        continue;
      }
      if (f.name === 'issues') {
        out[key] = resolveIssueConnection(c, repo, f, args);
        continue;
      }
      if (f.name === 'pullRequests') {
        out[key] = resolvePullConnection(c, repo, f, args);
        continue;
      }
      if (f.name === 'pullRequest') {
        const num = Number(args.number);
        const pull = repo.pulls.find((p) => p.number === num);
        out[key] = pull ? resolvePullFields(c, repo, pull, f.children) : null;
        continue;
      }
      const v = base[f.name];
      out[key] = f.children.length && isRecord(v) ? resolveFields(c, fieldTypeName('Repository', f.name), v, f.children, resolveValue) : v ?? null;
    }
    return out;
  };

  const resolveIssueFields = (c: GqlCtx, repo: Repo, issue: Issue, fields: GqlField[]): Record<string, unknown> => {
    const base = issueGql(repo, issue);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const key = f.alias ?? f.name;
      if (!(GQL_TYPES.Issue?.fields ?? []).includes(f.name)) {
        c.errors.push({ message: `Cannot query field "${f.name}" on type "Issue".` });
        out[key] = null;
        continue;
      }
      out[key] = base[f.name] ?? null;
    }
    return out;
  };

  const resolvePullFields = (c: GqlCtx, repo: Repo, pull: Pull, fields: GqlField[]): Record<string, unknown> => {
    const base = pullGql(repo, pull);
    const out: Record<string, unknown> = {};
    for (const f of fields) {
      const key = f.alias ?? f.name;
      if (!(GQL_TYPES.PullRequest?.fields ?? []).includes(f.name)) {
        c.errors.push({ message: `Cannot query field "${f.name}" on type "PullRequest".` });
        out[key] = null;
        continue;
      }
      if (f.name === 'files') {
        const args = argMap(f, vars);
        const first = typeof args.first === 'number' ? args.first : 100;
        const baseTree = parseCommit(getObject(repo, peelToNonTag(repo, pull.baseSha))!.data).tree;
        const headTree = parseCommit(getObject(repo, peelToNonTag(repo, pull.headSha))!.data).tree;
        const diffs = diffFiles(repo, baseTree, headTree).slice(0, first);
        const nodes = diffs.map((d) => ({ path: d.filename, additions: d.additions, deletions: d.deletions, changeType: d.status.toUpperCase() }));
        const conn: Record<string, unknown> = { nodes, totalCount: diffs.length, pageInfo: { hasNextPage: false, endCursor: null } };
        out[key] = f.children.length ? resolveFields(c, 'PullRequestChangedFileConnection', conn, f.children, resolveValue) : conn;
        continue;
      }
      out[key] = base[f.name] ?? null;
    }
    return out;
  };

  const resolveIssueConnection = (c: GqlCtx, repo: Repo, field: GqlField, args: Record<string, unknown>): Record<string, unknown> => {
    let list = [...repo.issues];
    const states = args.states;
    if (Array.isArray(states) && states.length) {
      const wanted = new Set(states.map((s) => String(s).toLowerCase()));
      list = list.filter((i) => wanted.has(i.state));
    }
    const orderBy = isRecord(args.orderBy) ? args.orderBy : {};
    const dir = String(orderBy.direction ?? 'DESC');
    const fieldName = String(orderBy.field ?? 'CREATED_AT');
    void fieldName;
    list.sort((a, b) => (dir === 'ASC' ? a.seq - b.seq : b.seq - a.seq));
    // cursor: after = base64 cursor:<number>
    let afterNum = -1;
    if (typeof args.after === 'string' && args.after !== '') {
      const raw = unb64(args.after);
      const m = /cursor:(\d+)/.exec(raw);
      if (m) afterNum = parseInt(m[1]!, 10);
    }
    if (afterNum >= 0) {
      const idx = list.findIndex((i) => i.number === afterNum);
      if (idx >= 0) list = list.slice(idx + 1);
    }
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    const hasNext = list.length > first;
    const endCursor = page.length ? b64(`cursor:${page[page.length - 1]!.number}`) : null;
    const conn: Record<string, unknown> = {
      nodes: page.map((i) => issueGql(repo, i)),
      totalCount: list.length,
      pageInfo: { hasNextPage: hasNext, hasPreviousPage: false, endCursor, startCursor: page.length ? b64(`cursor:${page[0]!.number}`) : null },
    };
    if (!field.children.length) return conn;
    const out: Record<string, unknown> = {};
    for (const f of field.children) {
      const key = f.alias ?? f.name;
      if (f.name === 'nodes') {
        out[key] = (conn.nodes as Array<Record<string, unknown>>).map((n) => resolveFields(c, 'Issue', n, f.children, resolveValue));
      } else if (f.name === 'pageInfo') {
        out[key] = resolveFields(c, 'PageInfo', conn.pageInfo as Record<string, unknown>, f.children, resolveValue);
      } else if (f.name === 'totalCount') {
        out[key] = conn.totalCount;
      } else {
        out[key] = null;
      }
    }
    return out;
  };

  const resolvePullConnection = (c: GqlCtx, repo: Repo, field: GqlField, args: Record<string, unknown>): Record<string, unknown> => {
    let list = repo.pulls.filter((p) => p.state === 'open');
    const first = typeof args.first === 'number' ? args.first : list.length;
    const page = list.slice(0, first);
    const conn: Record<string, unknown> = {
      nodes: page.map((p) => pullGql(repo, p)),
      totalCount: list.length,
      pageInfo: { hasNextPage: list.length > first, endCursor: null },
    };
    if (!field.children.length) return conn;
    const out: Record<string, unknown> = {};
    for (const f of field.children) {
      const key = f.alias ?? f.name;
      if (f.name === 'nodes') {
        out[key] = (conn.nodes as Array<Record<string, unknown>>).map((n) => {
          const pull = repo.pulls.find((p) => p.number === (n.number as number))!;
          return resolvePullFields(c, repo, pull, f.children);
        });
      } else if (f.name === 'pageInfo') {
        out[key] = resolveFields(c, 'PageInfo', conn.pageInfo as Record<string, unknown>, f.children, resolveValue);
      } else if (f.name === 'totalCount') {
        out[key] = conn.totalCount;
      } else {
        out[key] = null;
      }
    }
    return out;
  };

  const data = resolveFields(ctx, rootType, {}, op.fields, resolveValue) ?? {};
  const result: { data: unknown; errors?: Array<{ message: string }> } = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (!authed(req)) {
    unauthorized(res);
    return;
  }
  const raw = await readBody(req);
  const parsed = parseJsonBody(raw);
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return;
  }
  const runOne = (doc: unknown): Record<string, unknown> => {
    if (!isRecord(doc) || typeof doc.query !== 'string') {
      return { errors: [{ message: 'Request must include a query string.' }] };
    }
    const vars = isRecord(doc.variables) ? (doc.variables as Record<string, unknown>) : {};
    try {
      const parser = new GqlParser(doc.query);
      const op = parser.parseOperation();
      return executeGql(op, vars);
    } catch (err) {
      return { errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
  };
  if (Array.isArray(parsed.value)) {
    sendJson(res, 200, parsed.value.map(runOne));
    return;
  }
  sendJson(res, 200, runOne(parsed.value));
}

// ---------------------------------------------------------------------------
// MCP (streamable HTTP, JSON-RPC 2.0)
// ---------------------------------------------------------------------------

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required: string[] };
}
const MCP_TOOLS: McpToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the authenticated user.',
    inputSchema: { type: 'object', properties: { name: { type: 'string', description: 'Repository name' }, owner: { type: 'string', description: 'Owner login (defaults to the authenticated user)' }, description: { type: 'string' }, private: { type: 'boolean' } }, required: ['name'] },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' } }, required: ['owner', 'repo', 'title'] },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
  },
  {
    name: 'create_pull_request',
    description: 'Open a pull request from a head branch into a base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, title: { type: 'string' }, body: { type: 'string' }, head: { type: 'string' }, base: { type: 'string' } }, required: ['owner', 'repo', 'title', 'head', 'base'] },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request with a squash commit onto its base branch.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, pull_number: { type: 'integer' } }, required: ['owner', 'repo', 'pull_number'] },
  },
  {
    name: 'get_issue',
    description: 'Get one issue by number.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, issue_number: { type: 'integer' } }, required: ['owner', 'repo', 'issue_number'] },
  },
  {
    name: 'list_pull_requests',
    description: 'List pull requests in a repository.',
    inputSchema: { type: 'object', properties: { owner: { type: 'string' }, repo: { type: 'string' }, state: { type: 'string', description: 'open, closed or all' } }, required: ['owner', 'repo'] },
  },
];

function mcpArg(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}
function mcpRepoFromArgs(args: Record<string, unknown>): Repo | null {
  const full = typeof args.full_name === 'string' ? args.full_name : '';
  let owner = typeof args.owner === 'string' ? args.owner : typeof args.owner_login === 'string' ? args.owner_login : '';
  let repoName = typeof args.repo === 'string' ? args.repo : typeof args.repository === 'string' ? args.repository : '';
  if ((!owner || !repoName) && full.includes('/')) {
    const [o, r] = full.split('/', 2);
    owner = owner || o!;
    repoName = repoName || r!;
  }
  if (!owner || !repoName) return null;
  if (owner !== VIEWER_LOGIN) return null;
  return store.getRepo(owner, repoName) ?? null;
}
function toolResult(data: unknown): Record<string, unknown> {
  const text = typeof data === 'string' ? data : JSON.stringify(data);
  return { content: [{ type: 'text', text }], structuredContent: data };
}
function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callMcpTool(name: string, args: Record<string, unknown>): Record<string, unknown> {
  const missing = (tool: McpToolDef): Record<string, unknown> | null => {
    for (const r of tool.inputSchema.required) {
      if (args[r] === undefined || args[r] === null || args[r] === '') return toolError(`Missing required argument: ${r}`);
    }
    return null;
  };
  switch (name) {
    case 'create_repo': {
      const tool = MCP_TOOLS[0]!;
      const m = missing(tool);
      if (m) return m;
      const repoName = String(args.name);
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(repoName)) return toolError('Invalid repository name');
      if (store.getRepo(VIEWER_LOGIN, repoName)) return toolError('Repository already exists');
      const repo = store.createRepo(repoName, args.private === true, typeof args.description === 'string' ? args.description : '');
      return toolResult(repoJson(repo));
    }
    case 'get_repo': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return toolError('Repository not found');
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const tool = MCP_TOOLS[2]!;
      const m = missing(tool);
      if (m) return m;
      const repo = mcpRepoFromArgs(args);
      if (!repo) return toolError('Repository not found');
      const issue: Issue = {
        id: ++store.nextObjectId, number: repo.nextNumber++,
        title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
        state: 'open', labels: [], comments: [], seq: ++store.seq,
      };
      repo.issues.push(issue);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.issues];
      if (state === 'open') list = list.filter((i) => i.state === 'open');
      else if (state === 'closed') list = list.filter((i) => i.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return toolResult(list.map((i) => issueJson(repo, i)));
    }
    case 'create_pull_request': {
      const tool = MCP_TOOLS[4]!;
      const m = missing(tool);
      if (m) return m;
      const repo = mcpRepoFromArgs(args);
      if (!repo) return toolError('Repository not found');
      const head = String(args.head);
      const base = String(args.base);
      const headSha = repo.refs.get(`refs/heads/${head}`);
      const baseSha = repo.refs.get(`refs/heads/${base}`);
      if (!headSha || !baseSha) return toolError('Head or base branch does not exist');
      let pull = repo.pulls.find((p) => p.state === 'open' && p.headRef === head && p.baseRef === base);
      if (!pull) {
        pull = {
          id: ++store.nextObjectId, number: repo.nextNumber++,
          title: String(args.title), body: typeof args.body === 'string' ? args.body : '',
          state: 'open', merged: false, mergedAt: null, mergeCommitSha: null,
          headRef: head, baseRef: base, headSha, baseSha, seq: ++store.seq,
        };
        repo.pulls.push(pull);
      }
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const tool = MCP_TOOLS[5]!;
      const m = missing(tool);
      if (m) return m;
      const repo = mcpRepoFromArgs(args);
      if (!repo) return toolError('Repository not found');
      const num = Number(mcpArg(args, 'pull_number', 'number', 'pull_request_number'));
      const pull = repo.pulls.find((p) => p.number === num);
      if (!pull) return toolError('Pull request not found');
      if (pull.merged || pull.state === 'closed') return toolError('Pull request is already merged or closed');
      if (mergeConflicts(repo, pullBaseTipNow(repo, pull), pull.headSha)) return toolError('Merge conflict');
      const headTree = parseCommit(getObject(repo, peelToNonTag(repo, pull.headSha))!.data).tree;
      const baseTip = repo.refs.get(`refs/heads/${pull.baseRef}`)!;
      const mergeCommit = putObject(repo, 'commit', buildCommit(headTree, [baseTip], `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`));
      repo.refs.set(`refs/heads/${pull.baseRef}`, mergeCommit);
      pull.merged = true;
      pull.state = 'closed';
      pull.mergedAt = FIXED_ISO;
      pull.mergeCommitSha = mergeCommit;
      return toolResult({ sha: mergeCommit, merged: true, message: 'Pull Request successfully merged', pull_request: pullJson(repo, pull) });
    }
    case 'get_issue': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return toolError('Repository not found');
      const num = Number(mcpArg(args, 'issue_number', 'number'));
      const issue = repo.issues.find((i) => i.number === num);
      if (!issue) return toolError('Issue not found');
      return toolResult(issueJson(repo, issue));
    }
    case 'list_pull_requests': {
      const repo = mcpRepoFromArgs(args);
      if (!repo) return toolError('Repository not found');
      const state = typeof args.state === 'string' ? args.state : 'open';
      let list = [...repo.pulls];
      if (state === 'open') list = list.filter((p) => p.state === 'open');
      else if (state === 'closed') list = list.filter((p) => p.state === 'closed');
      list.sort((a, b) => b.seq - a.seq);
      return toolResult(list.map((p) => pullJson(repo, p)));
    }
    default:
      return toolError(`Unknown tool: ${name}`);
  }
}

async function handleMcp(req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method === 'DELETE') {
    res.writeHead(200, { 'x-github-request-id': nextReqId() });
    res.end();
    return;
  }
  if (req.method === 'GET') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authed(req)) {
    // JSON-RPC 401: plain JSON body; the client reads the HTTP status.
    sendJson(res, 401, { message: 'Requires authentication' });
    return;
  }
  const raw = await readBody(req);
  const text = raw.toString('utf8');
  let rpc: unknown;
  try {
    rpc = JSON.parse(text);
  } catch {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (!isRecord(rpc) || typeof rpc.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: isRecord(rpc) ? (rpc.id ?? null) : null, error: { code: -32600, message: 'Invalid Request' } });
    return;
  }
  const id = rpc.id ?? null;
  const isNotification = rpc.id === undefined;
  const params = isRecord(rpc.params) ? rpc.params : {};
  const result = (value: unknown): void => {
    if (isNotification) {
      res.writeHead(202, { 'x-github-request-id': nextReqId() });
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, result: value });
  };
  const rpcError = (code: number, message: string): void => {
    if (isNotification) {
      res.writeHead(202, { 'x-github-request-id': nextReqId() });
      res.end();
      return;
    }
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };
  const method = rpc.method;
  if (method === 'server/discover') {
    result({
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      capabilities: { tools: {} },
      supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
      protocolVersion: '2026-07-28',
    });
    return;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-11-25';
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    result({
      protocolVersion: known.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'x-github-request-id': nextReqId() });
    res.end();
    return;
  }
  if (method === 'ping') {
    result({});
    return;
  }
  if (method === 'tools/list') {
    result({ tools: MCP_TOOLS });
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = isRecord(params.arguments) ? (params.arguments as Record<string, unknown>) : {};
    const tool = MCP_TOOLS.find((t) => t.name === name);
    if (!tool) {
      rpcError(-32602, `Unknown tool: ${name}`);
      return;
    }
    result(callMcpTool(name, args));
    return;
  }
  rpcError(-32601, `Method not found: ${method}`);
}

// ---------------------------------------------------------------------------
// git smart HTTP
// ---------------------------------------------------------------------------

function v0RefLines(repo: Repo, caps: string): string[] {
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs.find(([r]) => r.startsWith('refs/heads/'))?.[1];
  const lines: string[] = [];
  if (refs.length === 0) {
    lines.push(`${ZERO_OID} capabilities^{}\0${caps}\n`);
    return lines;
  }
  if (headTip) lines.push(`${headTip} HEAD\0${caps}\n`);
  for (const [name, oid] of refs) {
    lines.push(`${oid} ${name}\n`);
    const obj = repo.objects.get(oid);
    if (obj?.type === 'tag') {
      const peeled = peelToNonTag(repo, oid);
      if (peeled !== oid) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  return lines;
}
const UPLOAD_V0_CAPS = `side-band-64k thin-pack ofs-delta multi_ack symref=HEAD:refs/heads/main shallow agent=${AGENT}`;
const RECEIVE_V0_CAPS = `report-status side-band-64k delete-refs ofs-delta symref=HEAD:refs/heads/main agent=${AGENT}`;

function lsRefsLines(repo: Repo, prefixes: string[], peel: boolean): string[] {
  const refs = [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  const lines: string[] = [];
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (refs.length === 0) {
    if (keep('HEAD')) lines.push(`unborn HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
    return lines;
  }
  if (prefixes.length === 0) {
    const headTip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? refs.find(([r]) => r.startsWith('refs/heads/'))?.[1];
    if (headTip) lines.push(`${headTip} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`);
  }
  for (const [name, oid] of refs) {
    if (!keep(name)) continue;
    let line = `${oid} ${name}`;
    const obj = repo.objects.get(oid);
    if (peel && obj?.type === 'tag') {
      const peeled = peelToNonTag(repo, oid);
      if (peeled !== oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

/** Objects to send for a fetch: reachable(wants) minus held(haves), honouring depth. */
function fetchObjects(
  repo: Repo,
  wants: string[],
  haves: string[],
  shallowBoundaries: string[],
  depth: number | null,
): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
  const wantCommits = wants.map((w) => peelToNonTag(repo, w)).filter((w) => repo.objects.get(w)?.type === 'commit');
  const wantTags = wants.filter((w) => repo.objects.get(w)?.type === 'tag');
  // What the client already holds: the closure of its haves, except a shallow
  // boundary's parents are NOT held (the boundary is where its history stops).
  const boundarySet = new Set(shallowBoundaries.map((b) => peelToNonTag(repo, b)));
  const held = new Set<string>();
  {
    const queue = [...haves];
    while (queue.length) {
      const oid = queue.pop()!;
      if (held.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      held.add(oid);
      if (obj.type === 'commit') {
        if (boundarySet.has(oid)) continue; // do not follow a shallow boundary's parents
        const c = parseCommit(obj.data);
        queue.push(c.tree);
        for (const p of c.parents) queue.push(p);
      } else if (obj.type === 'tag') {
        queue.push(parseTag(obj.data).object);
      } else if (obj.type === 'tree') {
        for (const e of parseTree(obj.data)) if (e.mode !== '160000') queue.push(e.oid);
      }
    }
  }
  let send: Set<string>;
  let shallow: string[] = [];
  let unshallow: string[] = [];
  if (depth !== null && depth >= 1) {
    // BFS distances from the wanted commits.
    const dist = new Map<string, number>();
    const queue: Array<[string, number]> = wantCommits.map((c) => [c, 0] as [string, number]);
    while (queue.length) {
      const [oid, d] = queue.shift()!;
      if (dist.has(oid)) continue;
      dist.set(oid, d);
      if (d + 1 >= depth) continue;
      const obj = repo.objects.get(oid);
      if (!obj || obj.type !== 'commit') continue;
      for (const p of parseCommit(obj.data).parents) queue.push([p, d + 1]);
    }
    const included = new Set([...dist.entries()].filter(([, d]) => d < depth).map(([o]) => o));
    // Closure of the included commits WITHOUT following parents past the cut:
    // each included commit plus its tree (recursively), plus the wanted tags.
    send = new Set<string>();
    const addTree = (treeOid: string): void => {
      const stack = [treeOid];
      while (stack.length) {
        const t = stack.pop()!;
        if (send.has(t)) continue;
        const obj = repo.objects.get(t);
        if (!obj) continue;
        send.add(t);
        if (obj.type === 'tree') for (const e of parseTree(obj.data)) stack.push(e.oid);
      }
    };
    for (const c of included) {
      send.add(c);
      const obj = repo.objects.get(c);
      if (obj?.type === 'commit') addTree(parseCommit(obj.data).tree);
    }
    for (const t of wantTags) send.add(t);
    shallow = [...dist.entries()].filter(([, d]) => d === depth - 1).map(([o]) => o);
    for (const b of boundarySet) if (included.has(b)) unshallow.push(b);
  } else {
    send = collectReachable(repo, wants);
  }
  for (const h of held) send.delete(h);
  const objects: GitObject[] = [];
  for (const oid of send) {
    const o = repo.objects.get(oid);
    if (o) objects.push(o);
  }
  // Deterministic pack order.
  objects.sort((a, b) => {
    const oa = hashObject(a.type, a.data);
    const ob = hashObject(b.type, b.data);
    return oa < ob ? -1 : 1;
  });
  return { objects, shallow, unshallow };
}

function sidebandPack(pack: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let off = 0; off < pack.length; off += 32768) {
    const chunk = pack.subarray(off, off + 32768);
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return Buffer.concat(parts);
}

async function handleGitUploadPackV2(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { packets } = decodePkts(body);
  const lines = packets.filter((p): p is { kind: 'data'; payload: Buffer } => p.kind === 'data').map((p) => p.payload.toString('utf8'));
  if (!lines.length || !lines[0]!.startsWith('command=')) {
    sendJson(res, 400, { message: 'expected a command' });
    return;
  }
  const command = lines[0]!.slice('command='.length).trim();
  const args = lines.slice(1);
  if (command === 'ls-refs') {
    const prefixes: string[] = [];
    let peel = false;
    for (const a of args) {
      const t = a.trim();
      if (t === 'peel') peel = true;
      else if (t.startsWith('ref-prefix ')) prefixes.push(t.slice('ref-prefix '.length));
    }
    const out = pktLines([...lsRefsLines(repo, prefixes, peel), 'flush']);
    sendRaw(res, 200, out, 'application/x-git-upload-pack-result');
    return;
  }
  if (command === 'fetch') {
    const wants: string[] = [];
    const haves: string[] = [];
    const shallow: string[] = [];
    let depth: number | null = null;
    for (const a of args) {
      const t = a.trim();
      if (t.startsWith('want ')) wants.push(t.slice(5).trim());
      else if (t.startsWith('have ')) haves.push(t.slice(5).trim());
      else if (t.startsWith('shallow ')) shallow.push(t.slice(8).trim());
      else if (t.startsWith('deepen ')) depth = parseInt(t.slice(7).trim(), 10) || null;
    }
    const { objects, shallow: newShallow, unshallow } = fetchObjects(repo, wants, haves, shallow, depth);
    const parts: Buffer[] = [];
    parts.push(pktLine('acknowledgments\n'));
    parts.push(pktLine('NAK\n'));
    parts.push(pktFlush());
    if (depth !== null || shallow.length > 0 || unshallow.length > 0) {
      parts.push(pktLine('shallow-info\n'));
      for (const s of newShallow) parts.push(pktLine(`shallow ${s}\n`));
      for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
      parts.push(pktFlush());
    }
    if (objects.length) {
      parts.push(pktLine('packfile\n'));
      parts.push(sidebandPack(writePack(objects)));
      parts.push(pktFlush());
    }
    sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
    return;
  }
  sendJson(res, 400, { message: `unknown command ${command}` });
}

async function handleGitUploadPackV0(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { packets } = decodePkts(body);
  if (!packets.length) {
    sendJson(res, 400, { message: 'malformed request' });
    return;
  }
  const wants: string[] = [];
  const haves: string[] = [];
  const shallow: string[] = [];
  let depth: number | null = null;
  let section = 0; // 0 = wants, 1 = haves
  for (const p of packets) {
    if (p.kind === 'flush') {
      section = 1;
      continue;
    }
    if (p.kind !== 'data') continue;
    const line = p.payload.toString('utf8').trim();
    if (section === 0) {
      if (line.startsWith('want ')) wants.push(line.slice(5).split(' ')[0]!);
      else if (line.startsWith('shallow ')) shallow.push(line.slice(8).trim());
      else if (line.startsWith('deepen ')) depth = parseInt(line.slice(7).trim(), 10) || null;
    } else {
      if (line.startsWith('have ')) haves.push(line.slice(5).trim());
    }
  }
  const { objects, shallow: newShallow, unshallow } = fetchObjects(repo, wants, haves, shallow, depth);
  const parts: Buffer[] = [];
  parts.push(pktLine('NAK\n'));
  for (const s of newShallow) parts.push(pktLine(`shallow ${s}\n`));
  for (const u of unshallow) parts.push(pktLine(`unshallow ${u}\n`));
  if (objects.length) parts.push(sidebandPack(writePack(objects)));
  parts.push(pktFlush());
  sendRaw(res, 200, Buffer.concat(parts), 'application/x-git-upload-pack-result');
}

async function handleGitReceivePack(req: IncomingMessage, res: ServerResponse, repo: Repo, body: Buffer): Promise<void> {
  const { packets, consumed } = decodePkts(body);
  const commands: Array<{ oldOid: string; newOid: string; ref: string }> = [];
  for (const p of packets) {
    if (p.kind === 'flush') break;
    if (p.kind !== 'data') continue;
    const text = p.payload.toString('utf8');
    const nul = text.indexOf('\0');
    const line = (nul >= 0 ? text.slice(0, nul) : text).trim();
    const parts = line.split(' ');
    if (parts.length >= 3) commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(' ') });
  }
  const packBytes = body.subarray(consumed);
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (packBytes.length > 0) {
    try {
      const { objects } = readPack(packBytes);
      for (const [oid, obj] of objects) repo.objects.set(oid, obj);
    } catch (err) {
      unpackOk = false;
      unpackDetail = err instanceof Error ? err.message : 'unpack error';
    }
  }
  const report: string[] = [unpackOk ? 'unpack ok\n' : `unpack ${unpackDetail}\n`];
  for (const cmd of commands) {
    if (!unpackOk) {
      report.push(`ng ${cmd.ref} unpack error\n`);
      continue;
    }
    const current = repo.refs.get(cmd.ref);
    if (cmd.newOid === ZERO_OID) {
      if (!current) report.push(`ng ${cmd.ref} remote ref does not exist\n`);
      else if (cmd.oldOid !== current) report.push(`ng ${cmd.ref} non-fast-forward\n`);
      else {
        repo.refs.delete(cmd.ref);
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (!repo.objects.has(cmd.newOid)) {
      report.push(`ng ${cmd.ref} object not found\n`);
      continue;
    }
    if (!current) {
      if (cmd.oldOid !== ZERO_OID) report.push(`ng ${cmd.ref} non-fast-forward\n`);
      else {
        repo.refs.set(cmd.ref, cmd.newOid);
        report.push(`ok ${cmd.ref}\n`);
      }
      continue;
    }
    if (cmd.oldOid !== current) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    if (!isAncestor(repo, current, cmd.newOid)) {
      report.push(`ng ${cmd.ref} non-fast-forward\n`);
      continue;
    }
    repo.refs.set(cmd.ref, cmd.newOid);
    report.push(`ok ${cmd.ref}\n`);
  }
  const reportPkts = pktLines(report);
  const out = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), reportPkts])), pktFlush()]);
  sendRaw(res, 200, out, 'application/x-git-receive-pack-result');
}

async function handleGit(req: IncomingMessage, res: ServerResponse, owner: string, repoName: string, rest: string[]): Promise<boolean> {
  if (!authed(req)) {
    unauthorized(res);
    return true;
  }
  if (owner !== VIEWER_LOGIN) {
    notFound(res);
    return true;
  }
  const repo = store.getRepo(owner, repoName);
  if (!repo) {
    notFound(res);
    return true;
  }
  const method = req.method ?? 'GET';
  const q = queryOf(req);
  if (method === 'GET' && rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs') {
    const service = q.get('service') ?? '';
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'service is required' });
      return true;
    }
    const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
    if (wantsV2) {
      const out = pktLines(['version 2\n', `agent=${AGENT}\n`, 'ls-refs=unborn\n', 'fetch=shallow filter\n', 'object-format=sha1\n', 'flush']);
      sendRaw(res, 200, out, 'application/x-git-upload-pack-advertisement');
      return true;
    }
    const caps = service === 'git-upload-pack' ? UPLOAD_V0_CAPS : RECEIVE_V0_CAPS;
    const preamble = `# service=${service}\n`;
    const out = Buffer.concat([pktLine(preamble), pktFlush(), ...v0RefLines(repo, caps).map((l) => pktLine(l)), pktFlush()]);
    sendRaw(res, 200, out, `application/x-${service}-advertisement`);
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-upload-pack') {
    const body = await readBody(req);
    const isV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    if (isV2) await handleGitUploadPackV2(req, res, repo, body);
    else await handleGitUploadPackV0(req, res, repo, body);
    return true;
  }
  if (method === 'POST' && rest.length === 1 && rest[0] === 'git-receive-pack') {
    const body = await readBody(req);
    await handleGitReceivePack(req, res, repo, body);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// server
// ---------------------------------------------------------------------------

export function createApp(): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async (): Promise<void> => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }
        if (path === '/api/graphql') {
          if (method !== 'POST') {
            sendJson(res, 405, { message: 'Method Not Allowed' });
            return;
          }
          await handleGraphql(req, res);
          return;
        }
        if (path === '/mcp') {
          await handleMcp(req, res);
          return;
        }
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const segs = path.replace(/^\/api\/v3\/?/, '').split('/').filter((s) => s !== '');
          const handled = await handleRest(req, res, segs);
          if (!handled) notFound(res);
          return;
        }
        const gitMatch = /^\/([^/]+)\/([^/]+)\.git(\/.*)?$/.exec(path);
        if (gitMatch) {
          const owner = decodeURIComponent(gitMatch[1]!);
          const repoName = decodeURIComponent(gitMatch[2]!);
          const rest = (gitMatch[3] ?? '').split('/').filter((s) => s !== '');
          const handled = await handleGit(req, res, owner, repoName, rest);
          if (!handled) notFound(res);
          return;
        }
        notFound(res);
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          try {
            res.end();
          } catch {
            // already closed
          }
        }
      }
    })();
  });
}
