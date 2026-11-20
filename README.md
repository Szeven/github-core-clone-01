# Forge — a GitHub-compatible git forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Szeven/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Szeven/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Forge is a standalone, single-process, GitHub-compatible git forge written in
TypeScript on Node 22 with no dependencies — only the Node standard library.
One process serves everything the suite drives:

- **git smart HTTP** — upload-pack protocol v2 (ls-refs, fetch, shallow/deepen,
  thin-pack) and receive-pack v0 with report-status, fast-forward-only pushes
- **REST v3** under `/api/v3` — repositories, branches, commits, contents,
  labels, issues, comments and pull requests (including squash merge)
- **GraphQL v4** at `/api/graphql` — the viewer/repository/issue/pull-request
  reads and mutations `gh` and `github-mcp-server` send, plus introspection
  and operation batching
- **MCP** at `/mcp` — JSON-RPC 2.0 over Streamable HTTP (legacy handshake era),
  with tools for repositories, issues and pull requests
- **A small read-only web UI** at `/` for browsing repositories, issues and
  pull requests

## Run it

```sh
node main.ts
```

With `MAKEFUN_ENV_URL` set (a trial pod) it binds an ephemeral port, registers
it with the suite and exits 0 when the suite answers `{"done": true}`. Without
it, it listens on `FORGE_PORT` (default 8080) and serves forever. The token the
suite presents is read from `MAKEFUN_SHOP_TOKEN`; when that variable is unset
any non-empty bearer token is accepted (local runs only).

```sh
# local conformance run against the kit's own suite
node --experimental-strip-types ../github-core-clone-01-kit-r2/sdk/run.ts \
  --url http://127.0.0.1:8080 --token test-token
```

## Layout

- `main.ts` — the entrypoint: starts the forge, registers with the suite,
  polls `/done`
- `app.ts` — the whole forge: the in-memory git object store, smart HTTP,
  REST v3, GraphQL, MCP and the web UI
- `NOTES.md` — design summary, what was verified and how

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
