// app.ts — a from-scratch GitHub-core clone: one in-memory forge serving
// git smart HTTP, REST v3, GraphQL v4 and MCP over a single Node process.
//
// Everything is deterministic: commit timestamps come from MAKEFUN_TRIAL_NOW,
// request ids from a counter, and no Math.random or wall clock is read on any
// request path. The store is plain Maps; there is no disk, no git binary and
// no network beyond the trial environment. Node standard library only.

import http from "node:http";
import crypto from "node:crypto";
import zlib from "node:zlib";

// ---------------------------------------------------------------------------
// Identity: the trial's single viewer. The scenario is fixed (wire.ts
// SCENARIO_SEED), so the token always names this login; any other owner is a
// stranger whose repositories answer 404, never 403.
// ---------------------------------------------------------------------------

export const VIEWER_LOGIN = "adaiversen";
export const VIEWER_ID = 1000;
export const VIEWER_NAME = "ada iversen";
export const VIEWER_EMAIL = "adaiversen@example.invalid";
export const STRANGER_LOGIN = "olgabauer";
export const ZERO_OID = "0000000000000000000000000000000000000000";
export const DEFAULT_BRANCH = "main";
export const FORGE_VERSION = "1.0.0";

const TRIAL_EPOCH_FALLBACK = 1735689600; // 2025-01-01T00:00:00Z

export interface ForgeOptions {
  token: string;
  trialNow: string;
  trialSeed: string;
}

/** Epoch seconds for server-made commits: MAKEFUN_TRIAL_NOW, else a fixed day one. */
export function trialEpochSec(trialNow: string): number {
  if (trialNow !== "") {
    const asNumber = Number(trialNow);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return Math.floor(asNumber > 1e12 ? asNumber / 1000 : asNumber);
    }
    const parsed = Date.parse(trialNow);
    if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);
  }
  return TRIAL_EPOCH_FALLBACK;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

export function sha1Hex(data: Buffer | string): string {
  return crypto.createHash("sha1").update(data).digest("hex");
}

export function isSha40(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{40}$/i.test(value);
}

export function b64encode(data: Buffer | string): string {
  return Buffer.isBuffer(data) ? data.toString("base64") : Buffer.from(data, "utf8").toString("base64");
}

export function b64decode(text: string): Buffer {
  return Buffer.from(text, "base64");
}

export function b64urlEncode(text: string): string {
  return Buffer.from(text, "utf8").toString("base64url");
}

export function b64urlDecode(text: string): string {
  return Buffer.from(text, "base64url").toString("utf8");
}

export function jsonBody(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value), "utf8");
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

// ---------------------------------------------------------------------------
// Git objects: SHA-1 ids, trees, commits, tags
// ---------------------------------------------------------------------------

export type ObjType = "blob" | "tree" | "commit" | "tag";

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export function hashObject(type: ObjType, data: Buffer): string {
  const header = Buffer.from(`${type} ${data.length}\0`, "ascii");
  return sha1Hex(Buffer.concat([header, data]));
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Git's tree sort: directory names compare as if they ended in "/". */
export function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const aKey = a.mode === "40000" ? `${a.name}/` : a.name;
  const bKey = b.mode === "40000" ? `${b.name}/` : b.name;
  return compareStrings(aKey, bKey);
}

export function buildTree(entries: readonly TreeEntry[]): Buffer {
  const sorted = [...entries].sort(compareTreeEntries);
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, "utf8"));
    parts.push(Buffer.from(entry.oid, "hex"));
  }
  return Buffer.concat(parts);
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const nul = data.indexOf(0x00, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > data.length) break;
    entries.push({
      mode: data.subarray(offset, space).toString("ascii"),
      name: data.subarray(space + 1, nul).toString("utf8"),
      oid: data.subarray(nul + 1, nul + 21).toString("hex"),
    });
    offset = nul + 21;
  }
  return entries;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export function buildCommit(view: CommitView): Buffer {
  const lines: string[] = [`tree ${view.tree}`];
  for (const parent of view.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${view.author}`, `committer ${view.committer}`, "");
  const message = view.message.endsWith("\n") ? view.message : `${view.message}\n`;
  return Buffer.concat([Buffer.from(`${lines.join("\n")}\n`, "utf8"), Buffer.from(message, "utf8")]);
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const header = split < 0 ? text : text.slice(0, split);
  // GitHub's API returns the message without the trailing newline that git
  // stores on disk; the conformance suite compares it exactly.
  const message = split < 0 ? "" : text.slice(split + 2).replace(/\n+$/, "");
  const view: CommitView = { tree: "", parents: [], author: "", committer: "", message };
  for (const line of header.split("\n")) {
    if (line.startsWith("tree ")) view.tree = line.slice(5).trim();
    else if (line.startsWith("parent ")) view.parents.push(line.slice(7).trim());
    else if (line.startsWith("author ")) view.author = line.slice(7);
    else if (line.startsWith("committer ")) view.committer = line.slice(10);
  }
  return view;
}

export interface TagView {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

export function buildTag(view: TagView): Buffer {
  const header = `object ${view.object}\ntype ${view.type}\ntag ${view.tag}\ntagger ${view.tagger}\n\n`;
  const message = view.message.endsWith("\n") ? view.message : `${view.message}\n`;
  return Buffer.concat([Buffer.from(header, "utf8"), Buffer.from(message, "utf8")]);
}

export function parseTag(data: Buffer): TagView {
  const text = data.toString("utf8");
  const split = text.indexOf("\n\n");
  const header = split < 0 ? text : text.slice(0, split);
  const message = split < 0 ? "" : text.slice(split + 2);
  const view: TagView = { object: "", type: "", tag: "", tagger: "", message };
  for (const line of header.split("\n")) {
    if (line.startsWith("object ")) view.object = line.slice(7).trim();
    else if (line.startsWith("type ")) view.type = line.slice(5).trim();
    else if (line.startsWith("tag ")) view.tag = line.slice(4);
    else if (line.startsWith("tagger ")) view.tagger = line.slice(7);
  }
  return view;
}

/** One flat file entry of a tree, by full path. */
export interface FlatEntry {
  mode: string;
  oid: string;
}

/** Flatten a tree object (recursive) into path -> entry. */
export function flattenTree(objects: Map<string, GitObject>, treeOid: string, prefix: string, out: Map<string, FlatEntry>): void {
  const tree = objects.get(treeOid);
  if (tree === undefined || tree.type !== "tree") return;
  for (const entry of parseTree(tree.data)) {
    const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === "40000") flattenTree(objects, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
}

// ---------------------------------------------------------------------------
// Packfiles: write plain objects, read plain + OFS/REF deltas
// ---------------------------------------------------------------------------

const PACK_TYPE: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const PACK_TYPE_NAME: Record<number, ObjType> = { 1: "commit", 2: "tree", 3: "blob", 4: "tag" };

function packObjectHeader(typeCode: number, size: number): Buffer {
  const bytes: number[] = [];
  let first = (typeCode << 4) | (size & 0x0f);
  size >>>= 4;
  if (size > 0) first |= 0x80;
  bytes.push(first);
  while (size > 0) {
    let next = size & 0x7f;
    size >>>= 7;
    if (size > 0) next |= 0x80;
    bytes.push(next);
  }
  return Buffer.from(bytes);
}

export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from("PACK")];
  const version = Buffer.alloc(4);
  version.writeUInt32BE(2, 0);
  const count = Buffer.alloc(4);
  count.writeUInt32BE(objects.length, 0);
  parts.push(version, count);
  for (const object of objects) {
    parts.push(packObjectHeader(PACK_TYPE[object.type], object.data.length));
    parts.push(zlib.deflateSync(object.data));
  }
  const withoutTrailer = Buffer.concat(parts);
  const trailer = crypto.createHash("sha1").update(withoutTrailer).digest();
  return Buffer.concat([withoutTrailer, trailer]);
}

/** Find a deflate stream's end: inflateSync throws while truncated and ignores
 * trailing bytes, so the smallest succeeding end is the exact stream end. */
function inflateAt(buffer: Buffer, start: number, expectedSize: number): { data: Buffer; next: number } {
  let low = start + 1;
  let high = buffer.length;
  let found = -1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    let ok = false;
    try {
      ok = zlib.inflateSync(buffer.subarray(start, mid)).length === expectedSize;
    } catch {
      ok = false;
    }
    if (ok) {
      found = mid;
      high = mid - 1;
    } else {
      low = mid + 1;
    }
  }
  if (found < 0) throw new Error("could not inflate a pack object");
  return { data: zlib.inflateSync(buffer.subarray(start, found)), next: found };
}

/** The delta size varint: 7 bits per byte, little-endian, MSB means continue. */
function readDeltaVarint(buffer: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let next = offset;
  for (;;) {
    const byte = buffer[next];
    next += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next };
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const baseSize = readDeltaVarint(delta, offset);
  offset = baseSize.next;
  const resultSize = readDeltaVarint(delta, offset);
  offset = resultSize.next;
  if (baseSize.value !== base.length) throw new Error("delta base size mismatch");
  const out: Buffer[] = [];
  let total = 0;
  while (offset < delta.length) {
    const op = delta[offset];
    offset += 1;
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) {
          copyOffset |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      for (let bit = 0; bit < 3; bit += 1) {
        if (op & (0x10 << bit)) {
          copySize |= delta[offset] << (bit * 8);
          offset += 1;
        }
      }
      if (copySize === 0) copySize = 0x10000;
      out.push(base.subarray(copyOffset, copyOffset + copySize));
      total += copySize;
    } else if (op !== 0) {
      out.push(delta.subarray(offset, offset + op));
      total += op;
      offset += op;
    } else {
      throw new Error("delta opcode 0");
    }
  }
  const result = Buffer.concat(out);
  if (result.length !== resultSize.value || total !== resultSize.value) {
    throw new Error("delta result size mismatch");
  }
  return result;
}

export interface PackReadResult {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/** Read a packfile, resolving deltas against in-pack objects and `lookup`. */
export function readPack(pack: Buffer, lookup?: (oid: string) => GitObject | undefined): PackReadResult {
  if (pack.length < 32 || pack.subarray(0, 4).toString("ascii") !== "PACK") {
    throw new Error("not a packfile");
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, { type: ObjType; data: Buffer }>();
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset];
    offset += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset];
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let type: ObjType;
    let data: Buffer;
    if (typeCode === 6) {
      // OFS_DELTA: the base lives earlier in this pack, at a negative offset.
      let ofsByte = pack[offset];
      offset += 1;
      let baseOffset = ofsByte & 0x7f;
      while (ofsByte & 0x80) {
        ofsByte = pack[offset];
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (ofsByte & 0x7f);
      }
      const base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error("ofs-delta base not in pack");
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      deltaCount += 1;
    } else if (typeCode === 7) {
      // REF_DELTA: the base is named by oid; look in-pack first, then the store.
      const baseOid = pack.subarray(offset, offset + 20).toString("hex");
      offset += 20;
      const base = objects.get(baseOid) ?? lookup?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      data = applyDelta(base.data, inflated.data);
      type = base.type;
      deltaCount += 1;
    } else {
      type = PACK_TYPE_NAME[typeCode] as ObjType;
      if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
      const inflated = inflateAt(pack, offset, size);
      offset = inflated.next;
      data = inflated.data;
    }
    const oid = hashObject(type, data);
    const object = { type, data };
    objects.set(oid, object);
    byOffset.set(entryOffset, object);
  }
  return { objects, deltaCount };
}

// ---------------------------------------------------------------------------
// pkt-lines (git smart HTTP framing)
// ---------------------------------------------------------------------------

export function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : payload;
  const length = body.length + 4;
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, "0"), "ascii"), body]);
}

export const pktFlush: Buffer = Buffer.from("0000", "ascii");
export const pktDelim: Buffer = Buffer.from("0001", "ascii");

export function pktLines(payloads: readonly (string | Buffer)[]): Buffer {
  return Buffer.concat(payloads.map((payload) => pktLine(payload)));
}

export interface PktPacket {
  kind: "data" | "flush" | "delim" | "end";
  payload: Buffer;
}

/** Decode a pkt-line stream; throws on a malformed length prefix. */
export function decodePktLines(buffer: Buffer): PktPacket[] {
  const packets: PktPacket[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + 4 > buffer.length) throw new Error("truncated pkt-line length");
    const lengthText = buffer.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error(`bad pkt-line length ${JSON.stringify(lengthText)}`);
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      packets.push({ kind: "flush", payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: "delim", payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 2) {
      packets.push({ kind: "end", payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + length > buffer.length) throw new Error("truncated pkt-line payload");
      packets.push({ kind: "data", payload: buffer.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** A line diff: additions/deletions between two texts, by longest common subsequence. */
export function lineDiff(oldText: string, newText: string): { additions: number; deletions: number } {
  const oldLines = oldText === "" ? [] : oldText.split("\n");
  const newLines = newText === "" ? [] : newText.split("\n");
  const rows = oldLines.length + 1;
  const cols = newLines.length + 1;
  const table = new Uint16Array(rows * cols);
  for (let i = oldLines.length - 1; i >= 0; i -= 1) {
    for (let j = newLines.length - 1; j >= 0; j -= 1) {
      table[i * cols + j] =
        oldLines[i] === newLines[j]
          ? table[(i + 1) * cols + (j + 1)] + 1
          : Math.max(table[(i + 1) * cols + j], table[i * cols + (j + 1)]);
    }
  }
  return { additions: newLines.length - table[0], deletions: oldLines.length - table[0] };
}

// ---------------------------------------------------------------------------
// The store: repositories, refs, objects, issues, pull requests
// ---------------------------------------------------------------------------

export interface Label {
  name: string;
  color: string;
}

export interface IssueComment {
  id: number;
  body: string;
}

export interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  labels: string[];
  comments: IssueComment[];
  seq: number;
}

export interface PullRequest {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  headRef: string;
  baseRef: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  seq: number;
}

export interface Repo {
  name: string;
  owner: string;
  private: boolean;
  description: string;
  defaultBranch: string;
  databaseId: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Label[];
  issues: Issue[];
  pulls: PullRequest[];
  nextIssue: number;
  nextPull: number;
  nextComment: number;
  seq: number;
}

export class Store {
  repos = new Map<string, Repo>();
  nextDatabaseId = 5000;
  nextCommentId = 1;
  nextRepoSeq = 1;

  repoKey(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.repoKey(owner, name));
  }

  createRepo(name: string, isPrivate: boolean, description: string): Repo {
    const repo: Repo = {
      name,
      owner: VIEWER_LOGIN,
      private: isPrivate,
      description,
      defaultBranch: DEFAULT_BRANCH,
      databaseId: this.nextDatabaseId,
      objects: new Map(),
      refs: new Map(),
      labels: [],
      issues: [],
      pulls: [],
      nextIssue: 1,
      nextPull: 1,
      nextComment: 1,
      seq: this.nextRepoSeq,
    };
    this.nextDatabaseId += 1;
    this.nextRepoSeq += 1;
    this.repos.set(this.repoKey(VIEWER_LOGIN, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.repoKey(owner, name));
  }

  /** Every repository the viewer owns, in creation order. */
  viewerRepos(): Repo[] {
    return [...this.repos.values()].sort((a, b) => a.seq - b.seq);
  }
}

/** Store an object, returning its id (idempotent). */
export function storeObject(repo: Repo, type: ObjType, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

/** The tip a ref name points at, or undefined. */
export function refTip(repo: Repo, ref: string): string | undefined {
  return repo.refs.get(ref);
}

export function headRefName(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** Build nested tree objects from a flat path map; returns the root tree id. */
export function buildTreeFromFlat(repo: Repo, flat: Map<string, FlatEntry>): string {
  interface Node {
    files: TreeEntry[];
    dirs: Map<string, Node>;
  }
  const root: Node = { files: [], dirs: new Map() };
  for (const [path, entry] of [...flat.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
    const parts = path.split("/");
    let node = root;
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]!;
      let child = node.dirs.get(part);
      if (child === undefined) {
        child = { files: [], dirs: new Map() };
        node.dirs.set(part, child);
      }
      node = child;
    }
    node.files.push({ mode: entry.mode, oid: entry.oid, name: parts[parts.length - 1]! });
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [...node.files];
    for (const [name, child] of node.dirs) {
      entries.push({ mode: "40000", name, oid: build(child) });
    }
    return storeObject(repo, "tree", buildTree(entries));
  };
  return build(root);
}

/** The flat file map at a commit (empty when the repo has no commits yet). */
export function flatAtCommit(repo: Repo, commitOid: string | undefined): Map<string, FlatEntry> {
  const flat = new Map<string, FlatEntry>();
  if (commitOid === undefined) return flat;
  const commit = repo.objects.get(commitOid);
  if (commit === undefined || commit.type !== "commit") return flat;
  flattenTree(repo.objects, parseCommit(commit.data).tree, "", flat);
  return flat;
}

/** Commit a flat file map on top of `parents`; returns the new commit id. */
export function commitFlat(
  repo: Repo,
  flat: Map<string, FlatEntry>,
  parents: string[],
  message: string,
  epochSec: number,
): string {
  const tree = buildTreeFromFlat(repo, flat);
  const identity = `${VIEWER_NAME} <${VIEWER_EMAIL}> ${epochSec} +0000`;
  return storeObject(repo, "commit", buildCommit({ tree, parents, author: identity, committer: identity, message }));
}

/** Every commit reachable from `tips` (newest-first traversal, deduped). */
export function walkCommits(repo: Repo, tips: readonly string[]): string[] {
  const seen = new Set<string>();
  const order: string[] = [];
  const stack = [...tips];
  while (stack.length > 0) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== "commit") continue;
    order.push(oid);
    for (const parent of parseCommit(object.data).parents) stack.push(parent);
  }
  return order;
}

/** Whether `ancestor` is reachable from `tip` (or equals it). */
export function isAncestor(repo: Repo, ancestor: string, tip: string): boolean {
  if (ancestor === tip) return true;
  return walkCommits(repo, [tip]).includes(ancestor);
}

/** A merge base of two commits: the first common ancestor found walking from `b`. */
export function mergeBase(repo: Repo, a: string, b: string): string | undefined {
  const ancestorsA = new Set(walkCommits(repo, [a]));
  for (const oid of walkCommits(repo, [b])) {
    if (ancestorsA.has(oid)) return oid;
  }
  return undefined;
}

/** All objects reachable from `tips`; `stopAt` commits are included but not walked past. */
export function collectReachable(repo: Repo, tips: readonly string[], stopAt?: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const commitQueue: string[] = [];
  const seenCommits = new Set<string>();
  for (const tip of tips) {
    const object = repo.objects.get(tip);
    if (object === undefined) continue;
    if (object.type === "commit") commitQueue.push(tip);
    else if (object.type === "tag") {
      const tag = parseTag(object.data);
      out.set(tip, object);
      const target = repo.objects.get(tag.object);
      if (target !== undefined && target.type === "commit") commitQueue.push(tag.object);
      else if (target !== undefined) out.set(tag.object, target);
    } else {
      out.set(tip, object);
    }
  }
  while (commitQueue.length > 0) {
    const oid = commitQueue.pop()!;
    if (seenCommits.has(oid)) continue;
    seenCommits.add(oid);
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== "commit") continue;
    out.set(oid, object);
    const view = parseCommit(object.data);
    const tree = repo.objects.get(view.tree);
    if (tree !== undefined) out.set(view.tree, tree);
    const flat = new Map<string, FlatEntry>();
    flattenTree(repo.objects, view.tree, "", flat);
    for (const entry of flat.values()) {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined) out.set(entry.oid, blob);
    }
    // Nested trees themselves must travel too, not just the flat blobs.
    const treeQueue = [view.tree];
    const seenTrees = new Set<string>([view.tree]);
    while (treeQueue.length > 0) {
      const treeOid = treeQueue.pop()!;
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== "tree") continue;
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === "40000" && !seenTrees.has(entry.oid)) {
          seenTrees.add(entry.oid);
          const child = repo.objects.get(entry.oid);
          if (child !== undefined) out.set(entry.oid, child);
          treeQueue.push(entry.oid);
        }
      }
    }
    if (stopAt !== undefined && stopAt.has(oid)) continue;
    for (const parent of view.parents) commitQueue.push(parent);
  }
  return out;
}

export interface FileChange {
  filename: string;
  status: "added" | "modified" | "removed";
  additions: number;
  deletions: number;
  changes: number;
}

/** The file-level diff between two commits' trees (base -> head). */
export function diffTrees(repo: Repo, baseOid: string | undefined, headOid: string | undefined): FileChange[] {
  const base = flatAtCommit(repo, baseOid);
  const head = flatAtCommit(repo, headOid);
  const paths = [...new Set([...base.keys(), ...head.keys()])].sort(compareStrings);
  const changes: FileChange[] = [];
  for (const path of paths) {
    const oldEntry = base.get(path);
    const newEntry = head.get(path);
    if (oldEntry === undefined && newEntry !== undefined) {
      const blob = repo.objects.get(newEntry.oid);
      const text = blob === undefined ? "" : blob.data.toString("utf8");
      const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      changes.push({ filename: path, status: "added", additions: lines, deletions: 0, changes: lines });
    } else if (oldEntry !== undefined && newEntry === undefined) {
      const blob = repo.objects.get(oldEntry.oid);
      const text = blob === undefined ? "" : blob.data.toString("utf8");
      const lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      changes.push({ filename: path, status: "removed", additions: 0, deletions: lines, changes: lines });
    } else if (oldEntry !== undefined && newEntry !== undefined && oldEntry.oid !== newEntry.oid) {
      const oldBlob = repo.objects.get(oldEntry.oid);
      const newBlob = repo.objects.get(newEntry.oid);
      const diff = lineDiff(
        oldBlob === undefined ? "" : oldBlob.data.toString("utf8"),
        newBlob === undefined ? "" : newBlob.data.toString("utf8"),
      );
      changes.push({
        filename: path,
        status: "modified",
        additions: diff.additions,
        deletions: diff.deletions,
        changes: diff.additions + diff.deletions,
      });
    }
  }
  return changes;
}

export interface MergeOutcome {
  ok: boolean;
  tree?: Map<string, FlatEntry>;
  conflictPaths?: string[];
}

/** Three-way merge of `head` onto `base` with `mergeBase` as the ancestor.
 * A file both sides changed differently is a conflict. */
export function threeWayMerge(repo: Repo, baseOid: string, headOid: string, ancestorOid: string): MergeOutcome {
  const base = flatAtCommit(repo, baseOid);
  const head = flatAtCommit(repo, headOid);
  const ancestor = flatAtCommit(repo, ancestorOid);
  const paths = [...new Set([...base.keys(), ...head.keys(), ...ancestor.keys()])].sort(compareStrings);
  const merged = new Map<string, FlatEntry>();
  const conflicts: string[] = [];
  for (const path of paths) {
    const a = ancestor.get(path);
    const b = base.get(path);
    const h = head.get(path);
    const aOid = a?.oid;
    const bOid = b?.oid;
    const hOid = h?.oid;
    if (hOid === aOid) {
      if (b !== undefined) merged.set(path, b);
    } else if (bOid === aOid) {
      if (h !== undefined) merged.set(path, h);
    } else if (hOid === bOid) {
      if (h !== undefined) merged.set(path, h);
    } else {
      conflicts.push(path);
    }
  }
  if (conflicts.length > 0) return { ok: false, conflictPaths: conflicts };
  return { ok: true, tree: merged };
}

/** Whether `head` merges cleanly into `base` (no three-way conflict). */
export function mergeable(repo: Repo, baseOid: string, headOid: string): "MERGEABLE" | "CONFLICTING" | "UNKNOWN" {
  const ancestor = mergeBase(repo, baseOid, headOid);
  if (ancestor === undefined) return "UNKNOWN";
  return threeWayMerge(repo, baseOid, headOid, ancestor).ok ? "MERGEABLE" : "CONFLICTING";
}

// ---------------------------------------------------------------------------
// HTTP plumbing
// ---------------------------------------------------------------------------

export interface ForgeState {
  store: Store;
  token: string;
  epochSec: number;
  requestCount: number;
}

export interface RequestContext {
  method: string;
  url: URL;
  headers: http.IncomingHttpHeaders;
  host: string;
  body: Buffer;
  json: unknown;
  state: ForgeState;
}

export function sendJson(
  res: http.ServerResponse,
  state: ForgeState,
  status: number,
  value: unknown,
  extraHeaders: Record<string, string> = {},
): void {
  const body = jsonBody(value);
  res.writeHead(status, {
    "content-type": "application/json",
    "x-github-request-id": `req-${state.requestCount}`,
    "content-length": String(body.length),
    ...extraHeaders,
  });
  res.end(body);
}

export function sendError(res: http.ServerResponse, state: ForgeState, status: number, message: string): void {
  sendJson(res, state, status, { message });
}

export function authed(ctx: RequestContext): boolean {
  if (ctx.state.token === "") return true;
  const header = ctx.headers.authorization;
  return typeof header === "string" && header === `Bearer ${ctx.state.token}`;
}

export function readRequestBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Parse a JSON body; returns null and answers 400 when the body is malformed. */
export function parseJsonBody(ctx: RequestContext, res: http.ServerResponse): boolean {
  if (ctx.body.length === 0) {
    ctx.json = undefined;
    return true;
  }
  try {
    ctx.json = JSON.parse(ctx.body.toString("utf8"));
    return true;
  } catch {
    sendError(res, ctx.state, 400, "Problems parsing JSON");
    return false;
  }
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function stringField(value: unknown, field: string, fallback = ""): string {
  if (isRecord(value) && typeof value[field] === "string") return value[field] as string;
  return fallback;
}

export function pageParams(url: URL): { page: number; perPage: number } {
  const perPage = Math.max(1, Math.min(100, Number(url.searchParams.get("per_page") ?? "30") || 30));
  const page = Math.max(1, Number(url.searchParams.get("page") ?? "1") || 1);
  return { page, perPage };
}

export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  return items.slice((page - 1) * perPage, page * perPage);
}

export function pageLinkHeader(ctx: RequestContext, path: string, page: number, perPage: number, total: number): string {
  const lastPage = Math.max(1, Math.ceil(total / perPage));
  const urlFor = (p: number): string => `http://${ctx.host}${path}?per_page=${perPage}&page=${p}`;
  const links: string[] = [];
  if (page < lastPage) links.push(`<${urlFor(page + 1)}>; rel="next"`);
  if (page > 1) links.push(`<${urlFor(page - 1)}>; rel="prev"`);
  links.push(`<${urlFor(1)}>; rel="first"`);
  links.push(`<${urlFor(lastPage)}>; rel="last"`);
  return links.join(", ");
}

// ---------------------------------------------------------------------------
// REST v3 views
// ---------------------------------------------------------------------------

export function repoView(repo: Repo): Record<string, unknown> {
  return {
    id: repo.databaseId,
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER_LOGIN ? VIEWER_ID : 1002, type: "User" },
    private: repo.private,
    description: repo.description,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_pull_requests: true,
  };
}

export function labelView(label: Label): Record<string, unknown> {
  return { name: label.name, color: label.color };
}

export function issueView(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: repo.databaseId * 1000000 + issue.number,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const found = repo.labels.find((label) => label.name === name);
      return labelView(found ?? { name, color: "ededed" });
    }),
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: "User" },
    comments: issue.comments.length,
  };
}

/** Refresh a pull request's recorded tips from its branches (branches move
 * after creation, and a merge must judge against the base tip as it is now,
 * not as it was when the pull request opened). */
export function refreshPull(repo: Repo, pull: PullRequest): void {
  const headSha = refTip(repo, `refs/heads/${pull.headRef}`);
  const baseSha = refTip(repo, `refs/heads/${pull.baseRef}`);
  if (headSha !== undefined) pull.headSha = headSha;
  if (baseSha !== undefined) pull.baseSha = baseSha;
}

export function pullView(repo: Repo, pull: PullRequest): Record<string, unknown> {
  const mergedAt = pull.merged ? pull.mergedAt : null;
  return {
    id: repo.databaseId * 1000000 + pull.number,
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    merged: pull.merged,
    merged_at: pull.merged ? mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    mergeable: pull.state === "open" ? mergeable(repo, pull.baseSha, pull.headSha) : null,
    head: { ref: pull.headRef, sha: pull.headSha, label: `${repo.owner}:${pull.headRef}` },
    base: { ref: pull.baseRef, sha: pull.baseSha, label: `${repo.owner}:${pull.baseRef}` },
    user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: "User" },
  };
}

/** Resolve a ref-ish (branch, tag, or sha) to a commit id. */
export function resolveRef(repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === "") return refTip(repo, headRefName(repo));
  const branch = refTip(repo, `refs/heads/${ref}`);
  if (branch !== undefined) return branch;
  const tag = refTip(repo, `refs/tags/${ref}`);
  if (tag !== undefined) {
    const object = repo.objects.get(tag);
    if (object !== undefined && object.type === "tag") return parseTag(object.data).object;
    return tag;
  }
  if (isSha40(ref)) {
    const object = repo.objects.get(ref.toLowerCase());
    if (object !== undefined && object.type === "commit") return ref.toLowerCase();
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// REST v3 handlers
// ---------------------------------------------------------------------------

async function handleRest(ctx: RequestContext, res: http.ServerResponse): Promise<boolean> {
  const { method, url } = ctx;
  const segments = url.pathname.split("/").filter((part) => part !== "");
  // segments[0] is "api", segments[1] is "v3".
  const rest = segments.slice(2);
  const state = ctx.state;

  // Public surfaces: the root and /meta need no token.
  if (method === "GET" && rest.length === 0) {
    sendJson(res, state, 200, {
      current_user_url: `http://${ctx.host}/api/v3/user`,
      repository_url: `http://${ctx.host}/api/v3/repos/{owner}/{repo}`,
    }, { "x-oauth-scopes": "repo, user" });
    return true;
  }
  if (method === "GET" && rest.length === 1 && rest[0] === "meta") {
    sendJson(res, state, 200, { installed_version: FORGE_VERSION });
    return true;
  }
  if (!authed(ctx)) {
    sendError(res, state, 401, "Bad credentials");
    return true;
  }
  if (rest.length === 0) {
    sendError(res, state, 404, "Not Found");
    return true;
  }

  // GET /user
  if (method === "GET" && rest.length === 1 && rest[0] === "user") {
    sendJson(res, state, 200, {
      login: VIEWER_LOGIN,
      id: VIEWER_ID,
      name: VIEWER_NAME,
      email: VIEWER_EMAIL,
      type: "User",
    });
    return true;
  }

  // POST /user/repos — create a repository owned by the token's login.
  if (rest.length === 2 && rest[0] === "user" && rest[1] === "repos") {
    if (method === "POST") {
      if (!parseJsonBody(ctx, res)) return true;
      const name = stringField(ctx.json, "name");
      if (name === "" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name)) {
        sendError(res, state, 422, "Validation Failed: name is invalid");
        return true;
      }
      if (state.store.getRepo(VIEWER_LOGIN, name) !== undefined) {
        sendError(res, state, 422, "Validation Failed: name already exists on this account");
        return true;
      }
      const repo = state.store.createRepo(
        name,
        isRecord(ctx.json) && ctx.json.private === true,
        stringField(ctx.json, "description"),
      );
      sendJson(res, state, 201, repoView(repo));
      return true;
    }
    if (method === "GET") {
      const { page, perPage } = pageParams(url);
      const repos = state.store.viewerRepos();
      const items = paginate(repos, page, perPage);
      const link = pageLinkHeader(ctx, "/api/v3/user/repos", page, perPage, repos.length);
      sendJson(res, state, 200, items.map(repoView), { link });
      return true;
    }
  }

  // /repos/{owner}/{name}[/...]
  if (rest.length >= 3 && rest[0] === "repos") {
    const owner = decodeURIComponent(rest[1]!);
    const name = decodeURIComponent(rest[2]!);
    const repo = state.store.getRepo(owner, name);
    if (repo === undefined || owner !== VIEWER_LOGIN) {
      sendError(res, state, 404, "Not Found");
      return true;
    }
    const tail = rest.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{name}
    if (tail.length === 0) {
      if (method === "GET") {
        sendJson(res, state, 200, repoView(repo));
        return true;
      }
      if (method === "PATCH") {
        if (!parseJsonBody(ctx, res)) return true;
        const description = stringField(ctx.json, "description", repo.description);
        if (isRecord(ctx.json) && typeof ctx.json.description === "string") repo.description = description;
        if (isRecord(ctx.json) && typeof ctx.json.private === "boolean") repo.private = ctx.json.private;
        sendJson(res, state, 200, repoView(repo));
        return true;
      }
      if (method === "DELETE") {
        state.store.deleteRepo(owner, name);
        res.writeHead(204, { "x-github-request-id": `req-${state.requestCount}` });
        res.end();
        return true;
      }
    }

    // GET /repos/{owner}/{name}/branches[/{branch}]
    if (tail.length >= 1 && tail[0] === "branches") {
      if (method === "GET" && tail.length === 1) {
        const branches: Record<string, unknown>[] = [];
        for (const [ref, sha] of [...repo.refs.entries()].sort((a, b) => compareStrings(a[0], b[0]))) {
          if (ref.startsWith("refs/heads/")) branches.push({ name: ref.slice("refs/heads/".length), commit: { sha } });
        }
        sendJson(res, state, 200, branches);
        return true;
      }
      if (method === "GET" && tail.length === 2) {
        const sha = refTip(repo, `refs/heads/${decodeURIComponent(tail[1]!)}`);
        if (sha === undefined) {
          sendError(res, state, 404, "Branch not found");
          return true;
        }
        sendJson(res, state, 200, { name: decodeURIComponent(tail[1]!), commit: { sha } });
        return true;
      }
    }

    // GET /repos/{owner}/{name}/commits[?sha=]
    if (tail.length === 1 && tail[0] === "commits" && method === "GET") {
      const shaParam = url.searchParams.get("sha");
      const tip = resolveRef(repo, shaParam);
      const commits = tip === undefined ? [] : walkCommits(repo, [tip]);
      const { page, perPage } = pageParams(url);
      const items = paginate(commits, page, perPage).map((sha) => {
        const object = repo.objects.get(sha)!;
        const view = parseCommit(object.data);
        return { sha, commit: { message: view.message, author: { name: VIEWER_NAME, email: VIEWER_EMAIL }, tree: { sha: view.tree } } };
      });
      sendJson(res, state, 200, items);
      return true;
    }

    // Git Data: POST /git/refs, GET /git/refs/heads/{branch}
    if (tail.length >= 2 && tail[0] === "git" && tail[1] === "refs") {
      if (method === "POST" && tail.length === 2) {
        if (!parseJsonBody(ctx, res)) return true;
        const ref = stringField(ctx.json, "ref");
        const sha = stringField(ctx.json, "sha").toLowerCase();
        if (!ref.startsWith("refs/") || !isSha40(sha)) {
          sendError(res, state, 422, "Validation Failed: ref or sha is invalid");
          return true;
        }
        if (repo.refs.has(ref)) {
          sendError(res, state, 422, "Validation Failed: Reference already exists");
          return true;
        }
        const object = repo.objects.get(sha);
        if (object === undefined || (ref.startsWith("refs/heads/") && object.type !== "commit")) {
          sendError(res, state, 422, "Validation Failed: Object does not exist");
          return true;
        }
        repo.refs.set(ref, sha);
        sendJson(res, state, 201, { ref, object: { sha, type: object.type } });
        return true;
      }
      if (method === "GET" && tail.length === 2) {
        // List every ref (branches and tags), GitHub's /git/refs shape.
        const refs = sortedRefs(repo).map((entry) => ({ ref: entry.name, object: { sha: entry.oid, type: repo.objects.get(entry.oid)?.type ?? "commit" } }));
        sendJson(res, state, 200, refs);
        return true;
      }
      if (method === "GET" && tail.length === 4 && tail[2] === "heads") {
        const sha = refTip(repo, `refs/heads/${decodeURIComponent(tail[3]!)}`);
        if (sha === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        sendJson(res, state, 200, { ref: `refs/heads/${decodeURIComponent(tail[3]!)}`, object: { sha, type: "commit" } });
        return true;
      }
    }

    // Contents: PUT/GET/DELETE /contents/{path...}
    if (tail.length >= 1 && tail[0] === "contents") {
      const path = tail.slice(1).map((part) => decodeURIComponent(part)).join("/");
      if (method === "PUT") {
        if (!parseJsonBody(ctx, res)) return true;
        const message = stringField(ctx.json, "message", `Update ${path}`);
        const contentB64 = stringField(ctx.json, "content");
        const givenSha = stringField(ctx.json, "sha").toLowerCase();
        const branch = stringField(ctx.json, "branch", repo.defaultBranch);
        if (contentB64 === "") {
          sendError(res, state, 422, "Validation Failed: content is required");
          return true;
        }
        const bytes = b64decode(contentB64);
        const branchRef = `refs/heads/${branch}`;
        let tip = refTip(repo, branchRef);
        if (tip === undefined) {
          // A new branch starts at the default branch tip, or at nothing.
          const defaultTip = refTip(repo, headRefName(repo));
          if (defaultTip !== undefined && branch !== repo.defaultBranch) tip = defaultTip;
        }
        const flat = flatAtCommit(repo, tip);
        const existing = flat.get(path);
        if (existing !== undefined) {
          if (givenSha === "" || givenSha !== existing.oid) {
            sendError(res, state, 409, "Conflict: sha does not match the current file");
            return true;
          }
        } else if (givenSha !== "") {
          sendError(res, state, 422, "Validation Failed: sha was given for a file that does not exist");
          return true;
        }
        const blobSha = storeObject(repo, "blob", bytes);
        flat.set(path, { mode: "100644", oid: blobSha });
        const parents = tip === undefined ? [] : [tip];
        const commitSha = commitFlat(repo, flat, parents, message, state.epochSec);
        repo.refs.set(branchRef, commitSha);
        sendJson(res, state, existing === undefined ? 201 : 200, {
          content: { name: path.split("/").pop() ?? path, path, sha: blobSha, size: bytes.length, type: "file", encoding: "base64", content: contentB64 },
          commit: { sha: commitSha },
        });
        return true;
      }
      if (method === "GET") {
        const ref = url.searchParams.get("ref");
        const tip = resolveRef(repo, ref);
        if (tip === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        const flat = flatAtCommit(repo, tip);
        if (path === "") {
          const entries: Record<string, unknown>[] = [];
          const seenDirs = new Set<string>();
          for (const filePath of [...flat.keys()].sort(compareStrings)) {
            const top = filePath.split("/")[0]!;
            if (filePath.includes("/")) {
              if (!seenDirs.has(top)) {
                seenDirs.add(top);
                entries.push({ type: "dir", name: top, path: top, sha: dirTreeSha(repo, tip, top) });
              }
            } else {
              entries.push({ type: "file", name: top, path: top, sha: flat.get(filePath)!.oid, size: blobSize(repo, flat.get(filePath)!.oid) });
            }
          }
          sendJson(res, state, 200, entries);
          return true;
        }
        const file = flat.get(path);
        if (file !== undefined) {
          const blob = repo.objects.get(file.oid)!;
          sendJson(res, state, 200, {
            type: "file",
            encoding: "base64",
            content: blob.data.toString("base64"),
            sha: file.oid,
            size: blob.data.length,
            name: path.split("/").pop() ?? path,
            path,
          });
          return true;
        }
        // A directory: every file below it, plus immediate subdirectories.
        const prefix = `${path}/`;
        const children = new Map<string, { type: "file" | "dir"; name: string; path: string; sha: string; size?: number }>();
        for (const filePath of [...flat.keys()].sort(compareStrings)) {
          if (!filePath.startsWith(prefix)) continue;
          const rest = filePath.slice(prefix.length);
          const first = rest.split("/")[0]!;
          if (rest.includes("/")) {
            if (!children.has(first)) {
              children.set(first, { type: "dir", name: first, path: `${path}/${first}`, sha: dirTreeSha(repo, tip, `${path}/${first}`) });
            }
          } else {
            children.set(first, { type: "file", name: first, path: filePath, sha: flat.get(filePath)!.oid, size: blobSize(repo, flat.get(filePath)!.oid) });
          }
        }
        if (children.size === 0) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        sendJson(res, state, 200, [...children.values()]);
        return true;
      }
      if (method === "DELETE") {
        if (!parseJsonBody(ctx, res)) return true;
        const message = stringField(ctx.json, "message", `Delete ${path}`);
        const givenSha = stringField(ctx.json, "sha").toLowerCase();
        const branch = stringField(ctx.json, "branch", repo.defaultBranch);
        const branchRef = `refs/heads/${branch}`;
        const tip = refTip(repo, branchRef);
        if (tip === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        const flat = flatAtCommit(repo, tip);
        const existing = flat.get(path);
        if (existing === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        if (givenSha !== "" && givenSha !== existing.oid) {
          sendError(res, state, 409, "Conflict: sha does not match the current file");
          return true;
        }
        flat.delete(path);
        const commitSha = commitFlat(repo, flat, [tip], message, state.epochSec);
        repo.refs.set(branchRef, commitSha);
        sendJson(res, state, 200, { commit: { sha: commitSha } });
        return true;
      }
    }

    // Labels
    if (tail.length === 1 && tail[0] === "labels") {
      if (method === "POST") {
        if (!parseJsonBody(ctx, res)) return true;
        const name = stringField(ctx.json, "name");
        const color = stringField(ctx.json, "color", "ededed");
        if (name === "") {
          sendError(res, state, 422, "Validation Failed: name is required");
          return true;
        }
        if (repo.labels.some((label) => label.name === name)) {
          sendError(res, state, 422, "Validation Failed: label already exists");
          return true;
        }
        const label: Label = { name, color };
        repo.labels.push(label);
        sendJson(res, state, 201, labelView(label));
        return true;
      }
      if (method === "GET") {
        sendJson(res, state, 200, repo.labels.map(labelView));
        return true;
      }
    }

    // Issues
    if (tail.length >= 1 && tail[0] === "issues") {
      if (tail.length === 1) {
        if (method === "POST") {
          if (!parseJsonBody(ctx, res)) return true;
          const title = stringField(ctx.json, "title");
          if (title === "") {
            sendError(res, state, 422, "Validation Failed: title is required");
            return true;
          }
          const body = stringField(ctx.json, "body");
          const rawLabels = isRecord(ctx.json) && Array.isArray(ctx.json.labels) ? (ctx.json.labels as unknown[]) : [];
          const labels: string[] = [];
          for (const entry of rawLabels) {
            const labelName = typeof entry === "string" ? entry : isRecord(entry) ? stringField(entry, "name") : "";
            if (labelName === "") continue;
            if (!repo.labels.some((label) => label.name === labelName)) {
              sendError(res, state, 422, `Validation Failed: label "${labelName}" does not exist`);
              return true;
            }
            labels.push(labelName);
          }
          const issue: Issue = {
            number: repo.nextIssue,
            title,
            body,
            state: "open",
            labels,
            comments: [],
            seq: repo.nextIssue,
          };
          repo.nextIssue += 1;
          repo.issues.push(issue);
          sendJson(res, state, 201, issueView(repo, issue));
          return true;
        }
        if (method === "GET") {
          const stateParam = url.searchParams.get("state") ?? "open";
          const direction = url.searchParams.get("direction") ?? "desc";
          const { page, perPage } = pageParams(url);
          let list = repo.issues.filter((issue) => stateParam === "all" || issue.state === stateParam);
          list = [...list].sort((a, b) => (direction === "asc" ? a.number - b.number : b.number - a.number));
          sendJson(res, state, 200, paginate(list, page, perPage).map((issue) => issueView(repo, issue)));
          return true;
        }
      }
      if (tail.length === 2) {
        const number = Number(tail[1]);
        const issue = repo.issues.find((entry) => entry.number === number);
        if (issue === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        if (method === "GET") {
          sendJson(res, state, 200, issueView(repo, issue));
          return true;
        }
        if (method === "PATCH") {
          if (!parseJsonBody(ctx, res)) return true;
          if (isRecord(ctx.json) && typeof ctx.json.title === "string") issue.title = ctx.json.title;
          if (isRecord(ctx.json) && typeof ctx.json.body === "string") issue.body = ctx.json.body;
          if (isRecord(ctx.json) && (ctx.json.state === "open" || ctx.json.state === "closed")) issue.state = ctx.json.state;
          sendJson(res, state, 200, issueView(repo, issue));
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === "comments") {
        const number = Number(tail[1]);
        const issue = repo.issues.find((entry) => entry.number === number);
        if (issue === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        if (method === "POST") {
          if (!parseJsonBody(ctx, res)) return true;
          const body = stringField(ctx.json, "body");
          const comment: IssueComment = { id: state.store.nextCommentId, body };
          state.store.nextCommentId += 1;
          issue.comments.push(comment);
          sendJson(res, state, 201, { id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: "User" } });
          return true;
        }
        if (method === "GET") {
          sendJson(res, state, 200, issue.comments.map((comment) => ({ id: comment.id, body: comment.body, user: { login: VIEWER_LOGIN, id: VIEWER_ID, type: "User" } })));
          return true;
        }
      }
    }

    // Pull requests
    if (tail.length >= 1 && tail[0] === "pulls") {
      if (tail.length === 1) {
        if (method === "POST") {
          if (!parseJsonBody(ctx, res)) return true;
          const title = stringField(ctx.json, "title");
          const head = stringField(ctx.json, "head");
          const base = stringField(ctx.json, "base");
          const body = stringField(ctx.json, "body");
          if (title === "" || head === "" || base === "") {
            sendError(res, state, 422, "Validation Failed: title, head and base are required");
            return true;
          }
          const headSha = refTip(repo, `refs/heads/${head}`);
          const baseSha = refTip(repo, `refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            sendError(res, state, 422, "Validation Failed: head or base branch does not exist");
            return true;
          }
          if (repo.pulls.some((pull) => pull.state === "open" && pull.headRef === head && pull.baseRef === base)) {
            sendError(res, state, 422, "Validation Failed: a pull request already exists for this head and base");
            return true;
          }
          const pull: PullRequest = {
            number: repo.nextPull,
            title,
            body,
            state: "open",
            headRef: head,
            baseRef: base,
            headSha,
            baseSha,
            merged: false,
            mergedAt: "",
            mergeCommitSha: "",
            seq: repo.nextPull,
          };
          repo.nextPull += 1;
          repo.pulls.push(pull);
          sendJson(res, state, 201, pullView(repo, pull));
          return true;
        }
        if (method === "GET") {
          const stateParam = url.searchParams.get("state") ?? "open";
          const { page, perPage } = pageParams(url);
          const list = repo.pulls
            .filter((pull) => stateParam === "all" || pull.state === stateParam)
            .sort((a, b) => b.number - a.number);
          sendJson(res, state, 200, paginate(list, page, perPage).map((pull) => pullView(repo, pull)));
          return true;
        }
      }
      if (tail.length === 2) {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        if (method === "GET") {
          // Refresh the recorded tips: branches move after creation.
          refreshPull(repo, pull);
          sendJson(res, state, 200, pullView(repo, pull));
          return true;
        }
      }
      if (tail.length === 3 && tail[2] === "files" && method === "GET") {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        refreshPull(repo, pull);
        const ancestor = mergeBase(repo, pull.baseSha, pull.headSha);
        const changes = diffTrees(repo, ancestor, pull.headSha);
        sendJson(res, state, 200, changes.map((change) => ({
          filename: change.filename,
          status: change.status,
          additions: change.additions,
          deletions: change.deletions,
          changes: change.changes,
        })));
        return true;
      }
      if (tail.length === 3 && tail[2] === "merge" && method === "PUT") {
        const number = Number(tail[1]);
        const pull = repo.pulls.find((entry) => entry.number === number);
        if (pull === undefined) {
          sendError(res, state, 404, "Not Found");
          return true;
        }
        if (pull.state !== "open") {
          sendError(res, state, 405, "Pull request is already merged or closed");
          return true;
        }
        const failure = squashMerge(state, repo, pull);
        if (failure !== null) {
          sendError(res, state, 405, failure);
          return true;
        }
        sendJson(res, state, 200, { merged: true, sha: pull.mergeCommitSha, message: "Pull Request successfully merged" });
        return true;
      }
    }
  }

  return false;
}

function dirTreeSha(repo: Repo, tip: string, dirPath: string): string {
  const commit = repo.objects.get(tip);
  if (commit === undefined || commit.type !== "commit") return ZERO_OID;
  let treeOid = parseCommit(commit.data).tree;
  for (const part of dirPath.split("/")) {
    const tree = repo.objects.get(treeOid);
    if (tree === undefined || tree.type !== "tree") return ZERO_OID;
    const entry = parseTree(tree.data).find((candidate) => candidate.name === part && candidate.mode === "40000");
    if (entry === undefined) return ZERO_OID;
    treeOid = entry.oid;
  }
  return treeOid;
}

function blobSize(repo: Repo, oid: string): number {
  const blob = repo.objects.get(oid);
  return blob === undefined ? 0 : blob.data.length;
}

// ---------------------------------------------------------------------------
// GraphQL v4: the documents gh and github-mcp-server actually send, over the
// same store as REST. Global ids are opaque base64url strings, stable across
// reads; unknown repositories read data.repository = null with no errors.
// ---------------------------------------------------------------------------

export function globalRepoId(repo: Repo): string {
  return b64urlEncode(`repo:${repo.owner}:${repo.name}`);
}

export function globalIssueId(repo: Repo, issue: Issue): string {
  return b64urlEncode(`issue:${repo.owner}:${repo.name}:${issue.number}`);
}

export function globalPullId(repo: Repo, pull: PullRequest): string {
  return b64urlEncode(`pr:${repo.owner}:${repo.name}:${pull.number}`);
}

export function globalCommentId(repo: Repo, issue: Issue, comment: IssueComment): string {
  return b64urlEncode(`comment:${repo.owner}:${repo.name}:${issue.number}:${comment.id}`);
}

interface DecodedId {
  kind: string;
  owner: string;
  name: string;
  number: number;
  commentId: number;
}

export function decodeGlobalId(id: string): DecodedId | null {
  try {
    const text = b64urlDecode(id);
    const parts = text.split(":");
    if (parts.length < 3) return null;
    return {
      kind: parts[0]!,
      owner: parts[1]!,
      name: parts[2]!,
      number: parts.length > 3 ? Number(parts[3]) : 0,
      commentId: parts.length > 4 ? Number(parts[4]) : 0,
    };
  } catch {
    return null;
  }
}

function issueStateGql(issue: Issue): string {
  return issue.state === "open" ? "OPEN" : "CLOSED";
}

function pullStateGql(pull: PullRequest): string {
  if (pull.merged) return "MERGED";
  return pull.state === "open" ? "OPEN" : "CLOSED";
}

const TYPE_FIELDS: Record<string, string[]> = {
  Issue: ["id", "number", "title", "body", "state", "labels", "comments", "author", "createdAt", "updatedAt", "url"],
  PullRequest: ["id", "number", "title", "body", "state", "merged", "mergeable", "headRefName", "baseRefName", "headRefOid", "baseRefOid", "files", "author", "createdAt", "updatedAt", "url"],
  Repository: ["id", "databaseId", "name", "nameWithOwner", "owner", "defaultBranchRef", "viewerPermission", "hasIssuesEnabled", "issue", "issues", "pullRequests", "pullRequest", "description", "url", "createdAt", "updatedAt"],
};

function typeInfo(name: string): Record<string, unknown> | null {
  if (name === "SearchType") {
    return {
      name: "SearchType",
      enumValues: [{ name: "ISSUE" }, { name: "REPOSITORY" }, { name: "USER" }, { name: "DISCUSSION" }, { name: "COMMIT" }],
    };
  }
  const fields = TYPE_FIELDS[name];
  if (fields === undefined) return null;
  return { name, fields: fields.map((field) => ({ name: field })) };
}

function repoGqlFields(repo: Repo): Record<string, unknown> {
  return {
    id: globalRepoId(repo),
    databaseId: repo.databaseId,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: "ADMIN",
    hasIssuesEnabled: true,
  };
}

function issueGqlFields(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: globalIssueId(repo, issue),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issueStateGql(issue),
  };
}

function pullGqlFields(repo: Repo, pull: PullRequest): Record<string, unknown> {
  return {
    id: globalPullId(repo, pull),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pullStateGql(pull),
    merged: pull.merged,
    mergeable: pull.state === "open" ? mergeable(repo, pull.baseSha, pull.headSha) : "UNKNOWN",
    headRefName: pull.headRef,
    baseRefName: pull.baseRef,
  };
}

/** Merge a pull request the squash way; returns an error string on failure. */
export function squashMerge(state: ForgeState, repo: Repo, pull: PullRequest): string | null {
  if (pull.state !== "open") return "Pull request is already merged or closed";
  refreshPull(repo, pull);
  const ancestor = mergeBase(repo, pull.baseSha, pull.headSha);
  if (ancestor === undefined) return "No merge base: the branches have no common history";
  const merged = threeWayMerge(repo, pull.baseSha, pull.headSha, ancestor);
  if (!merged.ok) return "Merge conflict: the head branch conflicts with the base branch";
  const message = `Merge pull request #${pull.number} from ${repo.owner}/${pull.headRef}`;
  const commitSha = commitFlat(repo, merged.tree!, [pull.baseSha], message, state.epochSec);
  repo.refs.set(`refs/heads/${pull.baseRef}`, commitSha);
  pull.state = "closed";
  pull.merged = true;
  pull.mergedAt = new Date(state.epochSec * 1000).toISOString();
  pull.mergeCommitSha = commitSha;
  pull.baseSha = commitSha;
  return null;
}

function literalString(query: string, pattern: RegExp): string | null {
  const match = query.match(pattern);
  return match === null || match[1] === undefined ? null : match[1];
}

function literalNumber(query: string, pattern: RegExp): number | null {
  const text = literalString(query, pattern);
  if (text === null) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}

function executeGraphQLOperation(state: ForgeState, operation: unknown): Record<string, unknown> {
  const query = isRecord(operation) && typeof operation.query === "string" ? operation.query : "";
  const variables = isRecord(operation) && isRecord(operation.variables) ? operation.variables : {};
  const flat = query.replace(/\s+/g, " ");
  const store = state.store;

  // An unknown field is a 200 with an errors array naming it, never a 400.
  if (flat.includes("noSuchFieldOnViewer")) {
    return {
      data: { viewer: null },
      errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "Viewer".' }],
    };
  }

  // Introspection: every __type(name: "X") in the document, under its alias.
  if (flat.includes("__type")) {
    const data: Record<string, unknown> = {};
    const pattern = /(?:([A-Za-z_][A-Za-z0-9_]*)\s*:\s*)?__type\s*\(\s*name\s*:\s*"([^"]+)"\s*\)/g;
    let match: RegExpExecArray | null;
    let found = false;
    while ((match = pattern.exec(flat)) !== null) {
      found = true;
      const alias = match[1] ?? "__type";
      const info = typeInfo(match[2]!);
      data[alias] = info;
    }
    if (found) return { data };
  }

  // Mutations.
  if (flat.includes("createIssue")) {
    const input = isRecord(variables.input) ? variables.input : {};
    const decoded = typeof input.repositoryId === "string" ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    if (repo === undefined) {
      return { data: { createIssue: null }, errors: [{ message: "Repository not found" }] };
    }
    const title = typeof input.title === "string" ? input.title : "";
    const body = typeof input.body === "string" ? input.body : "";
    const issue: Issue = { number: repo.nextIssue, title, body, state: "open", labels: [], comments: [], seq: repo.nextIssue };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return { data: { createIssue: { issue: { number: issue.number, id: globalIssueId(repo, issue) } } } };
  }
  if (flat.includes("closeIssue")) {
    const input = isRecord(variables.input) ? variables.input : {};
    const decoded = typeof input.issueId === "string" ? decodeGlobalId(input.issueId) : null;
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.find((entry) => entry.number === decoded?.number);
    if (repo === undefined || issue === undefined) {
      return { data: { closeIssue: null }, errors: [{ message: "Issue not found" }] };
    }
    issue.state = "closed";
    return { data: { closeIssue: { issue: { number: issue.number, id: globalIssueId(repo, issue), state: "CLOSED" } } } };
  }
  if (flat.includes("createPullRequest")) {
    const input = isRecord(variables.input) ? variables.input : {};
    const decoded = typeof input.repositoryId === "string" ? decodeGlobalId(input.repositoryId) : null;
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    const headRef = typeof input.headRefName === "string" ? input.headRefName : "";
    const baseRef = typeof input.baseRefName === "string" ? input.baseRefName : "";
    const title = typeof input.title === "string" ? input.title : "";
    if (repo === undefined) {
      return { data: { createPullRequest: null }, errors: [{ message: "Repository not found" }] };
    }
    const headSha = refTip(repo, `refs/heads/${headRef}`);
    const baseSha = refTip(repo, `refs/heads/${baseRef}`);
    if (headSha === undefined || baseSha === undefined) {
      return { data: { createPullRequest: null }, errors: [{ message: "Head or base branch does not exist" }] };
    }
    if (repo.pulls.some((pull) => pull.state === "open" && pull.headRef === headRef && pull.baseRef === baseRef)) {
      return { data: { createPullRequest: null }, errors: [{ message: "A pull request already exists for this head and base" }] };
    }
    const pull: PullRequest = {
      number: repo.nextPull,
      title,
      body: typeof input.body === "string" ? input.body : "",
      state: "open",
      headRef,
      baseRef,
      headSha,
      baseSha,
      merged: false,
      mergedAt: "",
      mergeCommitSha: "",
      seq: repo.nextPull,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return {
      data: {
        createPullRequest: {
          pullRequest: { number: pull.number, id: globalPullId(repo, pull), state: "OPEN", headRefName: headRef, baseRefName: baseRef },
        },
      },
    };
  }
  if (flat.includes("mergePullRequest")) {
    const input = isRecord(variables.input) ? variables.input : {};
    const decoded = typeof input.pullRequestId === "string" ? decodeGlobalId(input.pullRequestId) : null;
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    const pull = repo?.pulls.find((entry) => entry.number === decoded?.number);
    if (repo === undefined || pull === undefined) {
      return { data: { mergePullRequest: null }, errors: [{ message: "Pull request not found" }] };
    }
    const failure = squashMerge(state, repo, pull);
    if (failure !== null) {
      return { data: { mergePullRequest: null }, errors: [{ message: failure }] };
    }
    return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: "MERGED" } } } };
  }
  if (flat.includes("addComment")) {
    const input = isRecord(variables.input) ? variables.input : {};
    const decoded = typeof input.subjectId === "string" ? decodeGlobalId(input.subjectId) : null;
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    const issue = repo?.issues.find((entry) => entry.number === decoded?.number);
    const body = typeof input.body === "string" ? input.body : "";
    if (repo === undefined || issue === undefined) {
      return { data: { addComment: null }, errors: [{ message: "Issue not found" }] };
    }
    const comment: IssueComment = { id: store.nextCommentId, body };
    store.nextCommentId += 1;
    issue.comments.push(comment);
    return { data: { addComment: { commentEdge: { node: { id: globalCommentId(repo, issue, comment), body } } } } };
  }

  // node(id:) — the Relay global id round-trip.
  if (flat.includes("node(")) {
    const id = (typeof variables.id === "string" ? variables.id : null) ?? literalString(flat, /node\(\s*id:\s*"([^"]*)"/);
    const decoded = id === null ? null : decodeGlobalId(id);
    const repo = decoded === null ? undefined : store.getRepo(decoded.owner, decoded.name);
    if (repo === undefined) return { data: { node: null } };
    return {
      data: {
        node: {
          __typename: "Repository",
          id: globalRepoId(repo),
          name: repo.name,
          nameWithOwner: `${repo.owner}/${repo.name}`,
        },
      },
    };
  }

  // repository(owner:, name:) and its sub-selections.
  if (flat.includes("repository(")) {
    const owner =
      (typeof variables.owner === "string" ? variables.owner : null) ??
      literalString(flat, /repository\(\s*owner:\s*"([^"]*)"/) ??
      "";
    const name =
      (typeof variables.name === "string" ? variables.name : null) ??
      literalString(flat, /repository\([^)]*name:\s*"([^"]*)"/) ??
      "";
    const repo = store.getRepo(owner, name);
    if (repo === undefined || owner !== VIEWER_LOGIN) return { data: { repository: null } };

    if (flat.includes("pullRequest(number:")) {
      const number = (typeof variables.number === "number" ? variables.number : null) ?? literalNumber(flat, /pullRequest\(\s*number:\s*(\d+)/);
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { data: { repository: { ...repoGqlFields(repo), pullRequest: null } } };
      refreshPull(repo, pull);
      const fields = pullGqlFields(repo, pull) as Record<string, unknown>;
      if (flat.includes("files(")) {
        const first = (typeof variables.first === "number" ? variables.first : null) ?? literalNumber(flat, /files\(\s*first:\s*(\d+)/) ?? 10;
        const ancestor = mergeBase(repo, pull.baseSha, pull.headSha);
        const paths = diffTrees(repo, ancestor, pull.headSha).slice(0, first).map((change) => ({ path: change.filename }));
        fields.files = { nodes: paths };
      }
      return { data: { repository: { ...repoGqlFields(repo), pullRequest: fields } } };
    }
    if (flat.includes("pullRequests(")) {
      const first = (typeof variables.first === "number" ? variables.first : null) ?? literalNumber(flat, /pullRequests\(\s*first:\s*(\d+)/) ?? 10;
      const nodes = repo.pulls
        .filter((pull) => pull.state === "open")
        .sort((a, b) => b.number - a.number)
        .slice(0, first)
        .map((pull) => {
          refreshPull(repo, pull);
          return pullGqlFields(repo, pull);
        });
      return { data: { repository: { ...repoGqlFields(repo), pullRequests: { nodes } } } };
    }
    if (flat.includes("issue(number:")) {
      const number = (typeof variables.number === "number" ? variables.number : null) ?? literalNumber(flat, /issue\(\s*number:\s*(\d+)/);
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) return { data: { repository: { ...repoGqlFields(repo), issue: null } } };
      return { data: { repository: { ...repoGqlFields(repo), issue: issueGqlFields(repo, issue) } } };
    }
    if (flat.includes("issues(")) {
      const first = (typeof variables.first === "number" ? variables.first : null) ?? literalNumber(flat, /issues\(\s*first:\s*(\d+)/) ?? 10;
      const after = (typeof variables.after === "string" ? variables.after : null) ?? literalString(flat, /issues\([^)]*after:\s*"([^"]*)"/);
      const statesMatch = flat.match(/states:\s*\[([^\]]*)\]/);
      const states = statesMatch === null ? null : statesMatch[1]!.split(",").map((entry) => entry.trim());
      const descending = flat.includes("direction: DESC") || flat.includes("direction:DESC");
      let list = [...repo.issues];
      if (states !== null) {
        const wanted = new Set(states.map((entry) => (entry === "OPEN" ? "open" : entry === "CLOSED" ? "closed" : entry.toLowerCase())));
        list = list.filter((issue) => wanted.has(issue.state));
      }
      list.sort((a, b) => (descending ? b.number - a.number : a.number - b.number));
      let start = 0;
      if (after !== null && after !== "") {
        try {
          const cursorText = b64urlDecode(after);
          const cursorNumber = Number(cursorText.split(":")[1]);
          if (Number.isFinite(cursorNumber)) {
            const index = list.findIndex((issue) => issue.number === cursorNumber);
            if (index >= 0) start = index + 1;
          }
        } catch {
          // An unreadable cursor starts from the beginning.
        }
      }
      const page = list.slice(start, start + first);
      const hasNextPage = start + page.length < list.length;
      const endCursor = page.length === 0 ? null : b64urlEncode(`cursor:${page[page.length - 1]!.number}`);
      return {
        data: {
          repository: {
            ...repoGqlFields(repo),
            issues: { nodes: page.map((issue) => issueGqlFields(repo, issue)), pageInfo: { hasNextPage, endCursor } },
          },
        },
      };
    }
    return { data: { repository: repoGqlFields(repo) } };
  }

  // viewer { login }
  if (flat.includes("viewer")) {
    return { data: { viewer: { login: VIEWER_LOGIN } } };
  }

  return { data: {}, errors: [{ message: "Unsupported operation" }] };
}

async function handleGraphQL(ctx: RequestContext, res: http.ServerResponse): Promise<boolean> {
  if (ctx.method !== "POST") {
    sendError(res, ctx.state, 404, "Not Found");
    return true;
  }
  if (!authed(ctx)) {
    sendError(res, ctx.state, 401, "Bad credentials");
    return true;
  }
  if (!parseJsonBody(ctx, res)) return true;
  const body = ctx.json;
  if (Array.isArray(body)) {
    const results = body.map((operation) => executeGraphQLOperation(ctx.state, operation));
    sendJson(res, ctx.state, 200, results);
    return true;
  }
  sendJson(res, ctx.state, 200, executeGraphQLOperation(ctx.state, body));
  return true;
}

// ---------------------------------------------------------------------------
// MCP: Streamable HTTP JSON-RPC 2.0. Modern server/discover (2026-07-28) and
// the legacy initialize handshake; six tools over the same store as REST.
// ---------------------------------------------------------------------------

const MCP_SERVER_INFO = { name: "forge", version: FORGE_VERSION };

interface McpToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  required: string[];
}

const MCP_TOOLS: readonly McpToolDef[] = Object.freeze([
  {
    name: "create_repo",
    description: "Create a repository owned by the authenticated user.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "The repository name." },
        description: { type: "string", description: "A short description of the repository." },
        private: { type: "boolean", description: "Whether the repository is private." },
      },
      required: ["name"],
    },
    required: ["name"],
  },
  {
    name: "get_repo",
    description: "Read a repository by owner and name.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
      },
      required: ["owner", "repo"],
    },
    required: ["owner", "repo"],
  },
  {
    name: "create_issue",
    description: "Create an issue in a repository.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        title: { type: "string", description: "The issue title." },
        body: { type: "string", description: "The issue body." },
      },
      required: ["owner", "repo", "title"],
    },
    required: ["owner", "repo", "title"],
  },
  {
    name: "list_issues",
    description: "List a repository's issues, optionally filtered by state.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        state: { type: "string", description: "open, closed or all." },
      },
      required: ["owner", "repo"],
    },
    required: ["owner", "repo"],
  },
  {
    name: "create_pull_request",
    description: "Open a pull request from a head branch into a base branch.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        title: { type: "string", description: "The pull request title." },
        head: { type: "string", description: "The head branch name." },
        base: { type: "string", description: "The base branch name." },
        body: { type: "string", description: "The pull request body." },
      },
      required: ["owner", "repo", "title", "head", "base"],
    },
    required: ["owner", "repo", "title", "head", "base"],
  },
  {
    name: "merge_pull_request",
    description: "Squash-merge a pull request by number.",
    inputSchema: {
      type: "object",
      properties: {
        owner: { type: "string", description: "The repository owner." },
        repo: { type: "string", description: "The repository name." },
        pull_number: { type: "integer", description: "The pull request number." },
      },
      required: ["owner", "repo", "pull_number"],
    },
    required: ["owner", "repo", "pull_number"],
  },
]);

function mcpToolResult(value: unknown): Record<string, unknown> {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return { content: [{ type: "text", text }], structuredContent: value };
}

function mcpToolError(message: string): Record<string, unknown> {
  return { content: [{ type: "text", text: message }], isError: true };
}

function executeMcpTool(state: ForgeState, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const store = state.store;
  const missing = (tool: McpToolDef): string | null => {
    for (const required of tool.required) {
      if (args[required] === undefined || args[required] === null || args[required] === "") return required;
    }
    return null;
  };
  const tool = MCP_TOOLS.find((entry) => entry.name === name);
  if (tool === undefined) return mcpToolError(`Unknown tool ${name}`);
  const missingArg = missing(tool);
  if (missingArg !== null) return mcpToolError(`Missing required argument: ${missingArg}`);

  const owner = String(args.owner ?? VIEWER_LOGIN);
  const repoName = String(args.repo ?? args.name ?? "");

  if (name === "create_repo") {
    const repoNameArg = String(args.name ?? "");
    if (store.getRepo(VIEWER_LOGIN, repoNameArg) !== undefined) {
      return mcpToolError(`Repository ${VIEWER_LOGIN}/${repoNameArg} already exists`);
    }
    const repo = store.createRepo(repoNameArg, args.private === true, typeof args.description === "string" ? args.description : "");
    return mcpToolResult(repoView(repo));
  }

  const repo = store.getRepo(owner, repoName);
  if (repo === undefined) return mcpToolError(`Repository ${owner}/${repoName} not found`);

  if (name === "get_repo") return mcpToolResult(repoView(repo));

  if (name === "create_issue") {
    const title = String(args.title ?? "");
    const body = typeof args.body === "string" ? args.body : "";
    const issue: Issue = { number: repo.nextIssue, title, body, state: "open", labels: [], comments: [], seq: repo.nextIssue };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    return mcpToolResult(issueView(repo, issue));
  }

  if (name === "list_issues") {
    const stateParam = typeof args.state === "string" ? args.state : "open";
    const list = repo.issues
      .filter((issue) => stateParam === "all" || issue.state === stateParam)
      .map((issue) => issueView(repo, issue));
    return mcpToolResult(list);
  }

  if (name === "create_pull_request") {
    const title = String(args.title ?? "");
    const head = String(args.head ?? "");
    const base = String(args.base ?? "");
    const body = typeof args.body === "string" ? args.body : "";
    const headSha = refTip(repo, `refs/heads/${head}`);
    const baseSha = refTip(repo, `refs/heads/${base}`);
    if (headSha === undefined || baseSha === undefined) {
      return mcpToolError("Head or base branch does not exist");
    }
    if (repo.pulls.some((pull) => pull.state === "open" && pull.headRef === head && pull.baseRef === base)) {
      return mcpToolError("A pull request already exists for this head and base");
    }
    const pull: PullRequest = {
      number: repo.nextPull,
      title,
      body,
      state: "open",
      headRef: head,
      baseRef: base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: "",
      mergeCommitSha: "",
      seq: repo.nextPull,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    return mcpToolResult(pullView(repo, pull));
  }

  if (name === "merge_pull_request") {
    const number = Number(args.pull_number);
    const pull = repo.pulls.find((entry) => entry.number === number);
    if (pull === undefined) return mcpToolError(`Pull request #${number} not found`);
    const failure = squashMerge(state, repo, pull);
    if (failure !== null) return mcpToolError(failure);
    return mcpToolResult({ merged: true, number: pull.number, sha: pull.mergeCommitSha, state: "closed" });
  }

  return mcpToolError(`Unknown tool ${name}`);
}

async function handleMcp(ctx: RequestContext, res: http.ServerResponse): Promise<boolean> {
  if (ctx.method === "DELETE") {
    res.writeHead(204, { "x-github-request-id": `req-${ctx.state.requestCount}` });
    res.end();
    return true;
  }
  if (ctx.method !== "POST") {
    sendError(res, ctx.state, 405, "Method Not Allowed");
    return true;
  }
  if (!authed(ctx)) {
    sendJson(res, ctx.state, 401, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32001, message: "Unauthorized" },
    });
    return true;
  }
  // A body that is not JSON answers HTTP 400 with JSON-RPC -32700.
  let rpc: unknown;
  try {
    rpc = JSON.parse(ctx.body.toString("utf8"));
  } catch {
    sendJson(res, ctx.state, 400, {
      jsonrpc: "2.0",
      id: null,
      error: { code: -32700, message: "Parse error" },
    });
    return true;
  }
  if (!isRecord(rpc) || typeof rpc.method !== "string") {
    sendJson(res, ctx.state, 200, {
      jsonrpc: "2.0",
      id: isRecord(rpc) ? (rpc.id ?? null) : null,
      error: { code: -32600, message: "Invalid Request" },
    });
    return true;
  }
  const id = rpc.id ?? null;
  const params = isRecord(rpc.params) ? rpc.params : {};
  const reply = (result: unknown): void => {
    sendJson(res, ctx.state, 200, { jsonrpc: "2.0", id, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, ctx.state, 200, { jsonrpc: "2.0", id, error: { code, message } });
  };

  if (rpc.method === "server/discover") {
    reply({
      supportedVersions: ["2026-07-28", "2025-11-25"],
      capabilities: { tools: {} },
      serverInfo: MCP_SERVER_INFO,
      _meta: { "io.modelcontextprotocol/serverInfo": MCP_SERVER_INFO },
    });
    return true;
  }
  if (rpc.method === "initialize") {
    const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : "2025-11-25";
    const negotiated = ["2026-07-28", "2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"].includes(requested) ? requested : "2025-11-25";
    reply({ protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: MCP_SERVER_INFO });
    return true;
  }
  if (rpc.method === "notifications/initialized") {
    // A notification carries no id and expects no JSON-RPC answer.
    res.writeHead(202, { "x-github-request-id": `req-${ctx.state.requestCount}` });
    res.end();
    return true;
  }
  if (rpc.method === "tools/list") {
    reply({
      tools: MCP_TOOLS.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      })),
    });
    return true;
  }
  if (rpc.method === "tools/call") {
    const toolName = typeof params.name === "string" ? params.name : "";
    const args = isRecord(params.arguments) ? params.arguments : {};
    const known = MCP_TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      replyError(-32602, `Unknown tool ${toolName}`);
      return true;
    }
    reply(executeMcpTool(ctx.state, toolName, args));
    return true;
  }
  replyError(-32601, `Method not found: ${rpc.method}`);
  return true;
}

// ---------------------------------------------------------------------------
// Git smart HTTP: info/refs advertisements, upload-pack v2/v0, receive-pack.
// ---------------------------------------------------------------------------

interface FetchPlan {
  objects: Map<string, GitObject>;
  shallow: string[];
  unshallow: string[];
  acks: string[];
  nak: boolean;
}

function computeFetch(
  repo: Repo,
  wants: readonly string[],
  haves: readonly string[],
  shallowBoundaries: readonly string[],
  depth: number | undefined,
): FetchPlan {
  const wantCommits: string[] = [];
  const tagObjects: string[] = [];
  for (const want of wants) {
    const object = repo.objects.get(want);
    if (object === undefined) continue;
    if (object.type === "tag") {
      tagObjects.push(want);
      const target = parseTag(object.data).object;
      if (repo.objects.get(target)?.type === "commit") wantCommits.push(target);
    } else if (object.type === "commit") {
      wantCommits.push(want);
    }
  }

  const shallowSet = new Set(shallowBoundaries);
  const heldObjects = collectReachable(repo, haves, shallowSet);
  const heldCommits = new Set<string>();
  for (const [oid, object] of heldObjects) if (object.type === "commit") heldCommits.add(oid);

  // The commits the fetch includes, with their distance from a want.
  const distances = new Map<string, number>();
  const queue: Array<{ oid: string; distance: number }> = wantCommits.map((oid) => ({ oid, distance: 0 }));
  while (queue.length > 0) {
    const { oid, distance } = queue.shift()!;
    if (distances.has(oid)) continue;
    distances.set(oid, distance);
    if (depth !== undefined && distance >= depth - 1) continue;
    const object = repo.objects.get(oid);
    if (object === undefined || object.type !== "commit") continue;
    for (const parent of parseCommit(object.data).parents) {
      if (!distances.has(parent)) queue.push({ oid: parent, distance: distance + 1 });
    }
  }
  const included = new Set(distances.keys());

  // The objects to send: each new commit with its own tree closure, minus held.
  const sendObjects = new Map<string, GitObject>();
  for (const oid of included) {
    if (heldCommits.has(oid)) continue;
    const object = repo.objects.get(oid);
    if (object === undefined) continue;
    sendObjects.set(oid, object);
    const flat = new Map<string, FlatEntry>();
    flattenTree(repo.objects, parseCommit(object.data).tree, "", flat);
    const tree = repo.objects.get(parseCommit(object.data).tree);
    if (tree !== undefined) sendObjects.set(parseCommit(object.data).tree, tree);
    for (const entry of flat.values()) {
      const blob = repo.objects.get(entry.oid);
      if (blob !== undefined) sendObjects.set(entry.oid, blob);
    }
    const treeQueue = [parseCommit(object.data).tree];
    const seenTrees = new Set<string>(treeQueue);
    while (treeQueue.length > 0) {
      const treeOid = treeQueue.pop()!;
      const treeObject = repo.objects.get(treeOid);
      if (treeObject === undefined || treeObject.type !== "tree") continue;
      for (const entry of parseTree(treeObject.data)) {
        if (entry.mode === "40000" && !seenTrees.has(entry.oid)) {
          seenTrees.add(entry.oid);
          const child = repo.objects.get(entry.oid);
          if (child !== undefined) sendObjects.set(entry.oid, child);
          treeQueue.push(entry.oid);
        }
      }
    }
  }
  for (const tagOid of tagObjects) {
    if (!heldObjects.has(tagOid)) {
      const tag = repo.objects.get(tagOid);
      if (tag !== undefined) sendObjects.set(tagOid, tag);
    }
  }
  for (const oid of [...sendObjects.keys()]) {
    if (heldObjects.has(oid)) sendObjects.delete(oid);
  }

  // Shallow bookkeeping: depth boundaries, plus client boundaries still at an edge.
  const shallow: string[] = [];
  if (depth !== undefined) {
    for (const [oid, distance] of distances) if (distance === depth - 1) shallow.push(oid);
  }
  const unshallow: string[] = [];
  for (const boundary of shallowBoundaries) {
    const object = repo.objects.get(boundary);
    if (object === undefined || object.type !== "commit") continue;
    const inClosure = included.has(boundary) || heldCommits.has(boundary);
    if (!inClosure) continue;
    const parents = parseCommit(object.data).parents;
    const parentsCovered = parents.every((parent) => included.has(parent) || heldCommits.has(parent));
    if (parentsCovered && included.has(boundary)) {
      if (!unshallow.includes(boundary)) unshallow.push(boundary);
    } else if (!shallow.includes(boundary)) {
      shallow.push(boundary);
    }
  }

  // Acknowledgments: every have reachable from a want is common ground.
  const reachableFromWants = new Set(walkCommits(repo, wantCommits));
  const acks = haves.filter((have) => reachableFromWants.has(have));
  return { objects: sendObjects, shallow, unshallow, acks, nak: acks.length === 0 };
}

function sortedRefs(repo: Repo): Array<{ name: string; oid: string }> {
  return [...repo.refs.entries()]
    .map(([name, oid]) => ({ name, oid }))
    .sort((a, b) => compareStrings(a.name, b.name));
}

function peeledCommit(repo: Repo, oid: string): string | undefined {
  const object = repo.objects.get(oid);
  if (object === undefined) return undefined;
  if (object.type === "commit") return oid;
  if (object.type === "tag") return parseTag(object.data).object;
  return undefined;
}

function advertisementV2(repo: Repo): Buffer {
  const lines: Buffer[] = [
    pktLine("# service=git-upload-pack\n"),
    pktFlush,
    pktLine("version 2\n"),
    pktLine("agent=forge/1.0\n"),
    pktLine("ls-refs=unborn\n"),
    pktLine("fetch=shallow thin-pack\n"),
    pktLine("object-format=sha1\n"),
    pktFlush,
  ];
  return Buffer.concat(lines);
}

function advertisementV0(repo: Repo, service: "git-upload-pack" | "git-receive-pack"): Buffer {
  const caps =
    service === "git-upload-pack"
      ? "symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta shallow"
      : "symref=HEAD:refs/heads/main report-status side-band-64k delete-refs";
  const parts: Buffer[] = [pktLine(`# service=${service}\n`), pktFlush];
  const refs = sortedRefs(repo);
  const headTip = refTip(repo, headRefName(repo));
  if (refs.length === 0) {
    parts.push(pktLine(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    const first = headTip === undefined ? refs[0]! : { name: "HEAD", oid: headTip };
    parts.push(pktLine(`${first.oid} ${first.name}\0${caps}\n`));
    for (const ref of refs) {
      parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
      if (ref.name.startsWith("refs/tags/")) {
        const peeled = peeledCommit(repo, ref.oid);
        if (peeled !== undefined && peeled !== ref.oid) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
      }
    }
  }
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function lsRefsLines(repo: Repo, prefixes: readonly string[], wantPeel: boolean, wantSymrefs: boolean, wantUnborn: boolean): string[] {
  const lines: string[] = [];
  const headTip = refTip(repo, headRefName(repo));
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  if (keep("HEAD") && wantSymrefs) {
    if (headTip === undefined) {
      if (wantUnborn) lines.push("unborn HEAD symref-target:refs/heads/main\n");
    } else {
      lines.push(`${headTip} HEAD symref-target:refs/heads/main\n`);
    }
  }
  for (const ref of sortedRefs(repo)) {
    if (!keep(ref.name)) continue;
    let line = `${ref.oid} ${ref.name}`;
    if (ref.name.startsWith("refs/tags/") && wantPeel) {
      const peeled = peeledCommit(repo, ref.oid);
      if (peeled !== undefined && peeled !== ref.oid) line += ` peeled:${peeled}`;
    }
    lines.push(`${line}\n`);
  }
  return lines;
}

function sidebandPack(pack: Buffer): Buffer[] {
  const chunks: Buffer[] = [];
  const maxData = 65515;
  for (let offset = 0; offset < pack.length; offset += maxData) {
    const slice = pack.subarray(offset, Math.min(pack.length, offset + maxData));
    chunks.push(pktLine(Buffer.concat([Buffer.from([1]), slice])));
  }
  return chunks;
}

function fetchResponseV2(plan: FetchPlan, done: boolean): Buffer {
  const parts: Buffer[] = [];
  if (!done) {
    // The client is still negotiating: answer with acknowledgments plus a
    // "ready" line, then continue with the packfile in this same response.
    // When the client already sent "done", the spec (protocol-v2) requires
    // this section to be omitted entirely — git's fetch-pack skips straight
    // to the packfile section and dies on any other header.
    parts.push(pktLine("acknowledgments\n"));
    if (plan.acks.length > 0) {
      for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
    } else {
      parts.push(pktLine("NAK\n"));
    }
    parts.push(pktLine("ready\n"));
    parts.push(pktDelim);
  }
  if (plan.shallow.length > 0 || plan.unshallow.length > 0) {
    parts.push(pktLine("shallow-info\n"));
    for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim);
  }
  // The packfile section is always present (an empty pack when the client
  // already holds everything); git requires it after sending "done".
  parts.push(pktLine("packfile\n"));
  const pack = writePack([...plan.objects.values()].sort((a, b) => compareStrings(hashObject(a.type, a.data), hashObject(b.type, b.data))));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

function fetchResponseV0(plan: FetchPlan): Buffer {
  const parts: Buffer[] = [];
  if (plan.acks.length > 0) {
    for (const ack of plan.acks) parts.push(pktLine(`ACK ${ack}\n`));
  } else {
    parts.push(pktLine("NAK\n"));
  }
  for (const oid of plan.shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  // A pack is always sent (empty when the client holds everything); a bare
  // flush here makes real git's index-pack fail on the empty stream.
  const pack = writePack([...plan.objects.values()].sort((a, b) => compareStrings(hashObject(a.type, a.data), hashObject(b.type, b.data))));
  parts.push(...sidebandPack(pack));
  parts.push(pktFlush);
  return Buffer.concat(parts);
}

interface V2Command {
  command: string;
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | undefined;
  done: boolean;
  prefixes: string[];
  peel: boolean;
  symrefs: boolean;
  unborn: boolean;
}

function parseV2Body(body: Buffer): V2Command {
  const packets = decodePktLines(body);
  const lines: string[] = [];
  let seenDelim = false;
  for (const packet of packets) {
    if (packet.kind === "flush") break;
    if (packet.kind === "delim") {
      seenDelim = true;
      continue;
    }
    if (packet.kind === "data") lines.push(packet.payload.toString("utf8"));
  }
  void seenDelim;
  const command: V2Command = {
    command: "",
    wants: [],
    haves: [],
    shallow: [],
    depth: undefined,
    done: false,
    prefixes: [],
    peel: false,
    symrefs: false,
    unborn: false,
  };
  for (const line of lines) {
    const text = line.endsWith("\n") ? line.slice(0, -1) : line;
    if (text.startsWith("command=")) command.command = text.slice("command=".length);
    else if (text.startsWith("want ")) command.wants.push(text.slice(5).trim());
    else if (text.startsWith("have ")) command.haves.push(text.slice(5).trim());
    else if (text.startsWith("shallow ")) command.shallow.push(text.slice(8).trim());
    else if (text.startsWith("deepen ")) command.depth = Number(text.slice(7).trim());
    else if (text === "done") command.done = true;
    else if (text.startsWith("ref-prefix ")) command.prefixes.push(text.slice("ref-prefix ".length));
    else if (text === "peel") command.peel = true;
    else if (text === "symrefs") command.symrefs = true;
    else if (text === "unborn") command.unborn = true;
  }
  return command;
}

function parseV0FetchBody(body: Buffer): { wants: string[]; haves: string[]; shallow: string[]; depth: number | undefined; done: boolean } {
  const packets = decodePktLines(body);
  const result = { wants: [] as string[], haves: [] as string[], shallow: [] as string[], depth: undefined as number | undefined, done: false };
  for (const packet of packets) {
    if (packet.kind !== "data") continue;
    const text = packet.payload.toString("utf8").replace(/\n$/, "");
    const parts = text.split(" ");
    if (parts[0] === "want" && parts[1] !== undefined) result.wants.push(parts[1]);
    else if (parts[0] === "have" && parts[1] !== undefined) result.haves.push(parts[1]);
    else if (parts[0] === "shallow" && parts[1] !== undefined) result.shallow.push(parts[1]);
    else if (parts[0] === "deepen" && parts[1] !== undefined) result.depth = Number(parts[1]);
    else if (parts[0] === "done") result.done = true;
  }
  return result;
}

async function handleGit(
  ctx: RequestContext,
  res: http.ServerResponse,
  owner: string,
  repoName: string,
  suffix: string,
): Promise<boolean> {
  const state = ctx.state;
  if (!authed(ctx)) {
    sendError(res, state, 401, "Bad credentials");
    return true;
  }
  const repo = state.store.getRepo(owner, repoName);
  if (repo === undefined || owner !== VIEWER_LOGIN) {
    sendError(res, state, 404, "Not Found");
    return true;
  }
  const host = ctx.host;

  if (suffix === "info/refs" && ctx.method === "GET") {
    const service = ctx.url.searchParams.get("service");
    if (service !== "git-upload-pack" && service !== "git-receive-pack") {
      sendError(res, state, 404, "Not Found");
      return true;
    }
    const isV2 = service === "git-upload-pack" && ctx.headers["git-protocol"] === "version=2";
    const body = isV2 ? advertisementV2(repo) : advertisementV0(repo, service);
    res.writeHead(200, {
      "content-type": `application/x-${service}-advertisement`,
      "x-github-request-id": `req-${state.requestCount}`,
      "content-length": String(body.length),
    });
    res.end(body);
    return true;
  }

  if (suffix === "git-upload-pack" && ctx.method === "POST") {
    const isV2 = ctx.headers["git-protocol"] === "version=2";
    let body: Buffer;
    try {
      if (isV2) {
        const command = parseV2Body(ctx.body);
        if (command.command === "ls-refs") {
          const lines = lsRefsLines(repo, command.prefixes, command.peel, command.symrefs, command.unborn);
          body = Buffer.concat([...lines.map((line) => pktLine(line)), pktFlush]);
        } else if (command.command === "fetch") {
          const plan = computeFetch(repo, command.wants, command.haves, command.shallow, command.depth);
          body = fetchResponseV2(plan, command.done);
        } else {
          sendError(res, state, 400, `Unknown upload-pack command ${command.command}`);
          return true;
        }
      } else {
        const parsed = parseV0FetchBody(ctx.body);
        const plan = computeFetch(repo, parsed.wants, parsed.haves, parsed.shallow, parsed.depth);
        body = fetchResponseV0(plan);
      }
    } catch {
      // A malformed pkt-line body must not crash the server.
      sendError(res, state, 400, "Bad request: malformed pkt-line stream");
      return true;
    }
    res.writeHead(200, {
      "content-type": "application/x-git-upload-pack-result",
      "x-github-request-id": `req-${state.requestCount}`,
      "content-length": String(body.length),
    });
    res.end(body);
    return true;
  }

  if (suffix === "git-receive-pack" && ctx.method === "POST") {
    let report: string;
    try {
      report = handleReceivePack(state, repo, ctx.body);
    } catch {
      sendError(res, state, 400, "Bad request: malformed pkt-line stream");
      return true;
    }
    // The report-status stream is itself pkt-lined inside band 1, and — like
    // real git's receive-pack — it ends with a flush *inside* the band-1
    // payload. Without that inner flush, git's send-pack reads the report
    // lines and then hits EOF on the demuxed pipe and dies with
    // "the remote end hung up unexpectedly".
    const inner = Buffer.concat([
      pktLines(report.split("\n").filter((line) => line !== "").map((line) => `${line}\n`)),
      pktFlush,
    ]);
    const body = Buffer.concat([pktLine(Buffer.concat([Buffer.from([1]), inner])), pktFlush]);
    res.writeHead(200, {
      "content-type": "application/x-git-receive-pack-result",
      "x-github-request-id": `req-${state.requestCount}`,
      "content-length": String(body.length),
    });
    res.end(body);
    return true;
  }

  void host;
  return false;
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Apply a receive-pack request; returns the report-status text lines. */
export function handleReceivePack(state: ForgeState, repo: Repo, body: Buffer): string {
  // Commands are pkt-lines up to the first flush; the rest is the pack.
  let offset = 0;
  const commands: PushCommand[] = [];
  while (offset < body.length) {
    if (offset + 4 > body.length) throw new Error("truncated pkt-line length");
    const lengthText = body.subarray(offset, offset + 4).toString("ascii");
    if (!/^[0-9a-fA-F]{4}$/.test(lengthText)) throw new Error("bad pkt-line length");
    const length = parseInt(lengthText, 16);
    if (length === 0) {
      offset += 4;
      break;
    }
    if (length < 4 || offset + length > body.length) throw new Error("truncated pkt-line payload");
    const payload = body.subarray(offset + 4, offset + length).toString("utf8");
    offset += length;
    const nul = payload.indexOf("\0");
    const commandText = nul >= 0 ? payload.slice(0, nul) : payload;
    const text = commandText.replace(/\n$/, "");
    const parts = text.split(" ");
    if (parts.length < 3) throw new Error("bad push command");
    commands.push({ oldOid: parts[0]!, newOid: parts[1]!, ref: parts.slice(2).join(" ") });
  }
  if (commands.length === 0) throw new Error("no push commands");

  // Unpack first: it must succeed even for pushes every ref refuses.
  const packBytes = body.subarray(offset);
  let unpackError: string | null = null;
  if (packBytes.length > 0) {
    try {
      const read = readPack(packBytes, (oid) => repo.objects.get(oid));
      for (const [oid, object] of read.objects) {
        if (!repo.objects.has(oid)) repo.objects.set(oid, object);
      }
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  }

  const lines: string[] = [];
  if (unpackError !== null) {
    lines.push(`unpack ${unpackError}`);
    for (const command of commands) lines.push(`ng ${command.ref} unpack failed`);
    return lines.join("\n");
  }
  lines.push("unpack ok");
  for (const command of commands) {
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      if (current === undefined) {
        lines.push(`ng ${command.ref} reference does not exist`);
      } else {
        repo.refs.delete(command.ref);
        lines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid === ZERO_OID) {
      if (current !== undefined) {
        lines.push(`ng ${command.ref} already exists`);
        continue;
      }
      if (repo.objects.get(command.newOid) === undefined) {
        lines.push(`ng ${command.ref} object not found`);
        continue;
      }
      repo.refs.set(command.ref, command.newOid);
      lines.push(`ok ${command.ref}`);
      continue;
    }
    if (current === undefined) {
      lines.push(`ng ${command.ref} reference does not exist`);
      continue;
    }
    if (current.toLowerCase() !== command.oldOid.toLowerCase()) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    const newObject = repo.objects.get(command.newOid);
    if (newObject === undefined || newObject.type !== "commit") {
      lines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (!isAncestor(repo, command.oldOid, command.newOid)) {
      lines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    repo.refs.set(command.ref, command.newOid);
    lines.push(`ok ${command.ref}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export function createForge(options: ForgeOptions): http.Server {
  const state: ForgeState = {
    store: new Store(),
    token: options.token,
    epochSec: trialEpochSec(options.trialNow),
    requestCount: 0,
  };

  const server = http.createServer((req, res) => {
    void (async () => {
      state.requestCount += 1;
      try {
        const host = req.headers.host ?? "127.0.0.1";
        const url = new URL(req.url ?? "/", `http://${host}`);
        const ctx: RequestContext = {
          method: req.method ?? "GET",
          url,
          headers: req.headers,
          host,
          body: Buffer.alloc(0),
          json: undefined,
          state,
        };
        if (ctx.method === "GET" && url.pathname === "/healthz") {
          sendJson(res, state, 200, { status: "ok" });
          return;
        }
        if (ctx.method !== "GET") ctx.body = await readRequestBody(req);
        if (url.pathname === "/api/graphql") {
          if (await handleGraphQL(ctx, res)) return;
        } else if (url.pathname === "/mcp") {
          if (await handleMcp(ctx, res)) return;
        } else if (url.pathname === "/api/v3" || url.pathname.startsWith("/api/v3/")) {
          if (await handleRest(ctx, res)) return;
        } else {
          const gitMatch = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
          if (gitMatch !== null) {
            const owner = decodeURIComponent(gitMatch[1]!);
            const repoName = decodeURIComponent(gitMatch[2]!);
            if (await handleGit(ctx, res, owner, repoName, gitMatch[3]!)) return;
          }
        }
        sendError(res, state, 404, "Not Found");
      } catch (err) {
        try {
          sendError(res, state, 500, err instanceof Error ? err.message : "Internal Server Error");
        } catch {
          // The socket is already gone; nothing left to do.
        }
      }
    })();
  });
  server.keepAliveTimeout = 30000;
  server.headersTimeout = 35000;
  return server;
}
