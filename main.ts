// main.ts — the forge's entrypoint (node /bot/main.ts, Node 22).
//
// With MAKEFUN_ENV_URL set (a trial pod): bind an ephemeral port, POST the port
// to $MAKEFUN_ENV_URL/register, then long-poll GET $MAKEFUN_ENV_URL/done and
// exit 0 when the suite answers {"done": true}.
// Without it (a local run): listen on FORGE_PORT (default 8080) and serve
// forever. The forge itself lives in app.ts; this file only owns the lifecycle.

import { startForge } from './app.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const FORGE_PORT = Number(process.env.FORGE_PORT ?? '8080');

/** POST {"port": n} to the suite's /register; true when the suite accepted it. */
async function register(port: number): Promise<boolean> {
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200) return true;
      console.error(`register attempt ${attempt}: HTTP ${response.status}`);
      if (response.status === 409) return false;
    } catch (err) {
      console.error(`register attempt ${attempt} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  return false;
}

/** Poll GET /done once a second until the suite says it is done. */
async function pollDone(): Promise<void> {
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`, {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      const body = (await response.json().catch(() => null)) as { done?: unknown } | null;
      if (body !== null && body.done === true) return;
    } catch (err) {
      console.error(`poll /done failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function main(): Promise<void> {
  const { port } = await startForge({ port: ENV_URL === '' ? FORGE_PORT : 0 });
  if (ENV_URL === '') {
    console.error(`forge listening on http://127.0.0.1:${port} (no MAKEFUN_ENV_URL: standalone mode)`);
    return;
  }
  const accepted = await register(port);
  if (!accepted) {
    console.error('the suite did not accept the register; serving anyway');
  } else {
    console.error(`registered port ${port} with the suite`);
  }
  await pollDone();
  console.error('the suite is done; exiting 0');
  process.exit(0);
}

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));

main().catch((err: unknown) => {
  console.error(`fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
  process.exit(1);
});
