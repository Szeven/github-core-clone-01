// main.ts — the entrypoint: start the forge, register with the trial
// environment, then long-poll /done until the suite finishes and exit 0.
//
// Lifecycle (competition.yaml): bind an ephemeral port, POST {"port": N} to
// $MAKEFUN_ENV_URL/register, then GET $MAKEFUN_ENV_URL/done until it answers
// {"done": true}. The forge itself lives in app.ts; this file only wires the
// process lifecycle around it.
//
// Shutdown: SIGTERM/SIGINT close the HTTP server first and exit 0, so the
// trial runner never sees a half-open socket. Registration is retried with
// backoff — the environment endpoint can be briefly unavailable at boot.

import { createForge } from "./app.ts";

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? "").replace(/\/+$/, "");
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? "";
const TRIAL_NOW = process.env.MAKEFUN_TRIAL_NOW ?? "";
const TRIAL_SEED = process.env.MAKEFUN_TRIAL_SEED ?? "";

const server = createForge({ token: TOKEN, trialNow: TRIAL_NOW, trialSeed: TRIAL_SEED });

let shuttingDown = false;
function shutdown(code: number): void {
  if (shuttingDown) return;
  shuttingDown = true;
  server.close(() => process.exit(code));
  // Never hang the trial on a stuck keep-alive connection.
  setTimeout(() => process.exit(code), 2_000).unref();
}
process.once("SIGTERM", () => shutdown(0));
process.once("SIGINT", () => shutdown(0));

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postJson(url: string, body: unknown): Promise<{ status: number; text: string }> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

async function getJson(url: string): Promise<unknown> {
  const res = await fetch(url, { headers: { accept: "application/json" } });
  return JSON.parse(await res.text());
}

/** POST /register, retrying transient failures with backoff (up to ~10 s). */
async function registerWithRetry(url: string, port: number): Promise<void> {
  let lastError = "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const registered = await postJson(url, { port });
      if (registered.status === 200 || registered.status === 201 || registered.status === 409) return;
      lastError = `register answered HTTP ${registered.status}: ${registered.text.slice(0, 200)}`;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
    }
    await sleep(250 * 2 ** attempt);
  }
  throw new Error(lastError);
}

async function main(): Promise<number> {
  const port = await new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("the forge did not bind a port"));
        return;
      }
      resolve(address.port);
    });
  });

  if (ENV_URL === "") {
    // No trial environment (local manual run): serve until killed.
    return await new Promise<number>(() => undefined);
  }

  await registerWithRetry(`${ENV_URL}/register`, port);

  for (;;) {
    try {
      const done = await getJson(`${ENV_URL}/done`);
      if (typeof done === "object" && done !== null && (done as { done?: unknown }).done === true) {
        break;
      }
    } catch {
      // The environment may hiccup while the suite runs; keep polling.
    }
    await sleep(200);
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.stack ?? err.message : String(err));
    process.exit(1);
  },
);
