[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Szeven/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Szeven/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

# github-core-clone-01

A GitHub-compatible git forge in one Node process, standard library only: git
smart HTTP (upload-pack protocol v2 and v0, receive-pack v0), the REST v3 API
under `/api/v3`, GraphQL v4 at `/api/graphql`, and an MCP endpoint at `/mcp`
(streamable HTTP, revision 2026-07-28 with a legacy `initialize` fallback).
Everything is served from an in-memory store — repositories, refs, commits,
trees and blobs, issues, comments, labels, pull requests, files and squash
merges — with no UI, no outside service and no git binary.

## Run it

```sh
node --experimental-strip-types main.ts
```

The entry binds an ephemeral port, registers it with the suite at
`$MAKEFUN_ENV_URL/register`, then polls `$MAKEFUN_ENV_URL/done` until the
suite is finished (see `main.ts`, the lifecycle the kit's starter ships).
`GET /healthz` answers `{"ok": true}`.

Node 22.18+ (the platform runs `node /bot/main.ts`). Nothing to install.

## Layout

- `main.ts` — the entry <-> env lifecycle (bind, register, wait for done).
- `app.ts` — the whole forge: the object store and packfile code, the REST v3
  routes, the GraphQL executor, the MCP tools and the git smart-HTTP server.
- `package.json`, `tsconfig.json` — metadata; `LICENSE` — MIT.

## Verify it locally

Start the server on a port of your own, then run the kit's local runner
against it (from the unpacked kit directory):

```sh
node --experimental-strip-types sdk/run.ts --url http://127.0.0.1:PORT --token test-token
```

See `NOTES.md` for what the forge implements and the local results.

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
