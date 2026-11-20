# github-core-clone-01 — Round 2 entry: a GitHub-compatible git forge

## What it is

A single-file forge in Node's standard library only (no dependencies, no git
binary, no network beyond the suite). `app.ts` holds the whole forge;
`main.ts` is the lifecycle entrypoint the suite starts with `node /bot/main.ts`.

State is held in memory (maps of repositories, objects, issues, pull
requests). The suite's identity is fixed by the spec: the viewer is
`adaiversen` (id 1000, `adaiversen@example.invalid`), and every repository
belongs to that user. Commit timestamps come from a fixed epoch plus a
counter, request ids from a counter — two runs fed the same requests leave
the same state.

## Layout

- `main.ts` — entrypoint. With `MAKEFUN_ENV_URL` set it binds an ephemeral
  port, POSTs `{"port": n}` to `$MAKEFUN_ENV_URL/register`, then polls
  `GET $MAKEFUN_ENV_URL/done` and exits 0 when the suite answers
  `{"done": true}`. Without it (a local run) it listens on `FORGE_PORT`
  (default 8080) and serves until SIGTERM/SIGINT, which exit 0.
- `app.ts` — the forge, in six layers:
  1. **Git objects** — SHA-1 commit/tree/blob/tag objects, zlib via
     `node:zlib`, pack v2/v3 read/write (whole objects only; OFS_DELTA and
     REF_DELTA resolution on read), pkt-line framing, sideband.
  2. **Store** — repositories, refs, issues, pull requests, labels and
     comments, with merge-base search, three-way tree diffs, conflict
     detection and squash merges.
  3. **Git smart HTTP** — upload-pack v2 (ls-refs with peel/symrefs/unborn/
     ref-prefix, fetch with shallow/deepen) and v0, receive-pack v0 with
     report-status, fast-forward-only pushes, mixed ok/ng reports.
  4. **REST v3** — repositories, branches, commits, contents (create/update/
     delete with stale-sha 409s), labels, issues, comments and pull requests
     with squash merge; every reply carries `X-GitHub-Request-Id` and JSON
     error bodies; unauthenticated calls are 401.
  5. **GraphQL** — a small recursive-descent parser plus an executor for
     `viewer`, `repository`, `node`, `__type` (with aliases and batched
     array requests), cursor pagination, and the five mutations
     (`createIssue`, `closeIssue`, `createPullRequest`, `mergePullRequest`,
     `addComment`). Global ids are opaque base64url strings, stable across
     reads. Invalid fields answer HTTP 200 with an `errors` array.
  6. **MCP** — JSON-RPC 2.0 Streamable HTTP: `server/discover` answers
     -32601, `initialize` echoes the client's protocol version,
     `tools/list` returns the same 6 tools byte-for-byte every time,
     `tools/call` runs them against the same store REST and GraphQL use,
     so objects created over MCP read back identically over REST.
- A small web UI (`/`, `/{owner}/{repo}`, `.../issues`, `.../pulls`,
  `.../blob/{branch}/{path}`) browses repositories, issues and pull
  requests as HTML, plus a create-repository form on the home page.

## How to run it

```sh
MAKEFUN_SHOP_TOKEN=<token> FORGE_PORT=8080 node --experimental-strip-types main.ts
```

`GET /healthz` answers `ok` with no authentication. All `/api/v3/*`,
`/api/graphql` and `/mcp` routes require `Authorization: Bearer <token>`
(the `MAKEFUN_SHOP_TOKEN` value in a trial). Git smart-HTTP routes need no
token beyond what the client sends.

## What was verified

- `node --experimental-strip-types` imports `app.ts` cleanly
  (`APP-IMPORT-OK`); `node --check` does not strip types, so the import
  check is the type check for `.ts` files here.
- The kit's own conformance runner, from the fresh r2 kit (harness
  f7e0f88e):
  `node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:18081 --token <token> --json`
  — **120/120 checks pass** (git 30/30, repos 15/15, issues 15/15, pulls
  20/20, protocol 5/5, graphql 20/20, mcp 15/15; feature 600, agent 200).
- Perf workloads (same runner with `--perf`, final clean run):
  **173/200 points** (push 43, clone 43, read 50, write 37) — total score
  973. (An earlier run scored 174; perf varies a little run to run.)
- Real `git` 2.43.0 end to end against the forge (not just the suite's
  client): create a repo over REST, clone an empty repo, push a first
  commit, clone again and verify blob bytes, push a second commit, `git
  pull` (multi-round v2 negotiation with `ACK` + a separate `ready` line),
  push an unrelated orphan branch and fetch it (the no-common-commit
  negotiation: `NAK` + flush, then `done`, then the packfile with no
  acknowledgments section). All pass. Three real-git interop bugs were
  found by this smoke test and fixed in `app.ts` (see "Fixes" below).
- Web UI smoke test: home lists the repo, the repo page shows the file
  tree, the issues page lists issues, `.../blob/main/hello.txt` serves the
  file bytes.
- Entrypoint as the grader runs it: a copy of the repo run from `/tmp` as
  user 65534 via `setpriv --reuid=65534 --regid=65534 --clear-groups`
  serves `/healthz` and the REST API, and exits **0** on SIGTERM.
- No file named `.gitkeep` exists anywhere in the repo.

## Fixes found during verification (all in `app.ts`)

1. `startForge` took a plain port number and returned the server; `main.ts`
   calls it as `startForge({ port })` and destructures `{ port }`. The
   trial's register step would have posted an undefined port. It now
   takes `{ port }` and resolves `{ port, server }`.
2. `decodePktLines` parsed the whole request body as pkt-lines, so a
   receive-pack request died on its binary pack (`PACK` reads as a bogus
   length). It now stops at the first flush and reports the bytes
   consumed; the pack is sliced from there.
3. `globalId` called a `b64url` function that did not exist (the real one
   is `b64urlEncode`). Every GraphQL query touching a repository 500'd.
4. `planFetch` treated a have as a wall: the fetch walk stopped at held
   commits, so `deepen 2` never delivered the parent. The walk now passes
   through held commits (depth-limited), and the sent set is the walked
   set minus what the client holds. A shallow boundary's parents are not
   in the held set — that is what makes a deepen deliver exactly one more
   generation.
5. Protocol v2 fetch framing, found only by testing with real `git`
   (the suite's client is more lenient than git itself):
   - no acknowledgments section when the client sent no haves, and none
     when the client sent `done` (git skips ack processing then);
   - `ready` is a line of its own after `ACK <oid>`, not `ACK <oid> ready`;
   - with no common commit and no `done`, the answer is `NAK` closed
     with a FLUSH and nothing after it — a DELIM there makes git die.

## Files

- `README.md` — written first, frozen, three live make.fun badges.
- `LICENSE` — MIT text + `SPDX-License-Identifier: MIT`.
- `.makefun/owner.json` — the payout wallet.
- `package.json` — `{"type": "module", "engines": {"node": ">=22"}}`.
- `.gitignore` — `out/`, `node_modules/`, `data/`, `*.log`.
