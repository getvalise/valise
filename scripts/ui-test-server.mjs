import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** One suite owns one directory, including D1, KV, R2 and Durable Objects. */
export async function runUiTestServer({
  port,
  signal,
  run = runNode,
  stateFile,
}) {
  const state = await mkdtemp(join(tmpdir(), "valise-playwright-"));
  let ownsStateFile = false;
  const options = {
    env: {
      ...process.env,
      VALISE_STATE: state,
      VALISE_UI_TEST: "1",
      VALISE_RERANK: "off",
    },
    signal,
  };
  console.log(`[ui-test-server] State: ${state}`);
  try {
    // Local test-process discovery only, never a Worker endpoint. Fixture tests
    // may seed this isolated D1 through Wrangler --local, without production hooks.
    if (stateFile) {
      await mkdir(dirname(stateFile), { recursive: true });
      await writeFile(stateFile, JSON.stringify({ state, pid: process.pid }), {
        flag: "wx",
        mode: 0o600,
      });
      ownsStateFile = true;
    }
    await run(
      [
        resolve("node_modules/wrangler/bin/wrangler.js"),
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--persist-to",
        state,
      ],
      options,
    );
    if (signal.aborted) return;
    await run(
      [
        "--conditions=development",
        resolve("node_modules/@react-router/dev/bin.cjs"),
        "dev",
        "--port",
        String(port),
        "--strictPort",
      ],
      options,
    );
  } finally {
    // Vite installs its own signal handlers, so it must be a child: the
    // supervisor outlives it and removes state only after its handles close.
    await rm(state, { recursive: true, force: true });
    if (ownsStateFile) await rm(stateFile, { force: true });
    console.log(`[ui-test-server] Removed: ${state}`);
  }
}

export function runNode(args, { env, signal }) {
  return new Promise((done, fail) => {
    if (signal.aborted) return done();
    const child = spawn(process.execPath, args, { stdio: "inherit", env });
    const stop = () => child.kill("SIGTERM");
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", fail);
    child.once("close", (code) => {
      signal.removeEventListener("abort", stop);
      if (code === 0 || signal.aborted) done();
      else
        fail(new Error(`UI test command exited with code ${code}: ${args[0]}`));
    });
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const controller = new AbortController();
  const port = Number(process.argv[2] ?? 4173);
  process.once("SIGINT", () => controller.abort());
  process.once("SIGTERM", () => controller.abort());
  await runUiTestServer({
    port,
    stateFile: resolve(".wrangler", `ui-test-state-${port}.json`),
    signal: controller.signal,
  }).catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
