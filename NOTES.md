# github-core-clone-01 — NOTES

## What it is

A GitHub-compatible git forge in one Node process, standard library only
(no dependencies, no git binary, no network at grading time). The whole
implementation is `app.ts` (about 120 KB, single file); `main.ts` is the
kit's starter lifecycle, used unchanged.

## What it implements

- **git smart HTTP** — `info/refs` (v0 + v2 advertisements), `git-upload-pack`
  (v0 and v2, `ls-refs`, shallow fetch with depth/deepen, fetch-by-sha1,
  unborn HEAD, peeled annotated tags), `git-receive-pack` (v0, per-ref
  non-fast-forward refusal with the exact `non-fast-forward` reason, mixed
  ok/ng reports, delete-only pushes). Packs are written with no deltas and
  read with OFS_DELTA/REF_DELTA resolution.
- **REST v3** (`/api/v3`) — root, `/meta`, `/user`, `/user/repos` (paginated,
  absolute-URL `Link` headers), repo CRUD, branches, commits (`?sha=`),
  `git/refs`, contents (GET file/dir, PUT create/update with stale-sha 409,
  DELETE), labels (default six), issues + comments (state/sort/direction),
  pull requests (create, files diff, squash merge, 405 on conflict, 422 on
  duplicate open PR). Issues and PRs share one number counter per repo.
- **GraphQL v4** (`/api/graphql`) — a small tokenizer/parser/executor for
  `viewer`, `repository`, `node(id:)` (opaque base64url ids), `__type`,
  issue/pull-request connections with cursor pagination, mutations
  `createIssue` / `closeIssue` / `createPullRequest` / `mergePullRequest` /
  `addComment`, batched array bodies, unknown fields return HTTP 200 with
  `errors` naming the field.
- **MCP** (`/mcp`) — streamable HTTP, modern `server/discover` (revision
  `2026-07-28`) with a legacy `initialize` fallback; 8 tools
  (`create_repo`, `get_repo`, `create_issue`, `list_issues`,
  `create_pull_request`, `merge_pull_request`, `get_issue`,
  `list_pull_requests`). JSON-RPC errors (`-32700`, `-32602`, `isError`).
- **Identity** — the scenario viewer from the kit (`adaiversen`, id 1000);
  bearer auth: when `MAKEFUN_SHOP_TOKEN` is set it must match exactly, when
  unset any non-empty Bearer is accepted locally; `/healthz` is public.
- **Store** — in-memory `Map`s per process; deterministic timestamps
  (`2025-01-01T00:00:00Z`, commit time `1700000000`).

## Run it

```sh
node --experimental-strip-types main.ts
```

It binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`,
then polls `$MAKEFUN_ENV_URL/done` until the suite finishes. Node 22.18+.

## Local verification (2026-11-18, Node v24.22.1)

Kit local runner, fresh server, from the kit directory:

```sh
node --experimental-strip-types sdk/run.ts \
  --url http://127.0.0.1:PORT --token test-token --perf --json
```

- **Conformance: 120/120 checks passed** (git 30/30, repos 15/15,
  issues 15/15, pulls 20/20, protocol 5/5, graphql 20/20, mcp 15/15).
- **Perf: 164/200** — push 46, clone 39, read 43, write 36.
- **Estimated total score: 964/1000** (feature 600 + agent 200 + perf 164).
- `GET /healthz` → `{"ok":true}`.
- `main.ts` lifecycle verified against a fake env: registers its port,
  waits for `done`, exits 0.

Bugs found and fixed during verification: depth-limited fetch included
parent commits beyond the depth (and treated shallow-boundary parents as
held); REST commit messages kept a trailing newline; merge-conflict
detection used the stale `baseSha` instead of the current base-branch tip.

## Notes for the coordinator

- Do not submit without the three badges in `README.md` (main + rank +
  reward) and the footer line — a main-badge-only README is refused 422.
- `.makefun/owner.json` is included as the competition rules require it;
  no other dotfile is in the repo (no `.gitkeep` anywhere).
- The entry was built and tested from source only; no repo was created,
  nothing was pushed, nothing was submitted.
