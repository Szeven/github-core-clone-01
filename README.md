# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Szeven/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Szeven/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A from-scratch GitHub-core clone in a single Node.js process, standard library
only. It serves the four surfaces the trial drives:

- **Git smart HTTP** (`/<owner>/<repo>.git`) — protocol v2 and v0
  `git-upload-pack` (`ls-refs`, `fetch`, shallow deepen) and v0
  `git-receive-pack` with fast-forward enforcement, plus a real SHA-1 object
  store (blobs, trees, commits, annotated tags) and packfile read/write with
  delta resolution.
- **REST v3** (`/api/v3`) — repositories, branches, commits, contents, labels,
  issues, comments and pull requests with squash merge and three-way conflict
  detection, all paginated the way GitHub paginates them.
- **GraphQL v4** (`/api/graphql`) — viewer, repository, issues, pull requests,
  mutations and cursor pagination over the same store as REST, with opaque
  stable global ids.
- **MCP** (`/mcp`) — Streamable HTTP JSON-RPC 2.0, modern `server/discover`
  (revision 2026-07-28) and the legacy `initialize` handshake, with six tools
  that act on the same store as REST.

Run it with `node main.ts`. It binds an ephemeral port, registers with the
trial environment at `$MAKEFUN_ENV_URL`, serves until the environment reports
done, then exits 0. Everything is in memory and deterministic: timestamps come
from `MAKEFUN_TRIAL_NOW` and ids from a counter, never from the wall clock or
`Math.random`.

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
