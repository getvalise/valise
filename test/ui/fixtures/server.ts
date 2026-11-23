import { execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  cp,
  mkdir,
  open,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

/*
 * Each Playwright worker runs `wrangler dev` on the production build with its
 * own port and state directory, so workers, and suites in other worktrees,
 * never share a server, a D1 file or a port. Migrations run once into a
 * template that each worker copies.
 */

const execute = promisify(execFile);
const WRANGLER = resolve("node_modules/wrangler/bin/wrangler.js");
const QUIET = { WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" };
const UI_TEST = resolve(".wrangler", "ui-test");

/** An address `VALISE_ADMIN_EMAILS` names in every UI test server. */
export const UI_ADMIN_EMAIL = "admin-ui@example.com";

const FALLBACK_SECRETS: Record<string, string> = {
  VALISE_ADMIN_PASSWORD: "local-playwright-password-0001",
  SESSION_SECRET: "local-playwright-session-secret-0001",
  TOKEN_PEPPER: "local-playwright-token-pepper-0001",
};

/**
 * `.dev.vars` overrides the fallback, so a developer's local password keeps
 * working and a clean checkout stays green.
 */
export function testSecrets(): Record<string, string> {
  let text: string;
  try {
    text = readFileSync(".dev.vars", "utf8");
  } catch {
    return { ...FALLBACK_SECRETS, VALISE_ADMIN_EMAILS: UI_ADMIN_EMAIL };
  }
  const parsed = Object.fromEntries(
    text
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#") && line.includes("="))
      .map((line) => {
        const at = line.indexOf("=");
        return [
          line.slice(0, at).trim(),
          line
            .slice(at + 1)
            .trim()
            .replace(/^['"`]|['"`]$/g, ""),
        ];
      }),
  );
  // The suite's admin address is always on the list, beside any a
  // developer's `.dev.vars` names. Google stays off, so nobody signs in
  // with it; `/__dev/member` makes the account. ADR-0016.
  const admins = [parsed.VALISE_ADMIN_EMAILS, UI_ADMIN_EMAIL]
    .filter(Boolean)
    .join(",");
  return { ...FALLBACK_SECRETS, ...parsed, VALISE_ADMIN_EMAILS: admins };
}

/** One Playwright run's directory, named for the process that owns it. */
export function runRoot(pid = process.pid): string {
  return join(UI_TEST, `run-${pid}`);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes run directories whose Playwright process is gone, and stops any
 * server a hard-killed run left behind.
 */
export async function sweepStaleRuns(): Promise<void> {
  for (const run of await readdir(UI_TEST).catch(() => [] as string[])) {
    if (alive(Number(run.split("-").at(-1)))) continue;
    const dir = join(UI_TEST, run);
    for (const entry of await readdir(dir).catch(() => [] as string[])) {
      if (!entry.startsWith("server-")) continue;
      const { server } = JSON.parse(await readFile(join(dir, entry), "utf8"));
      if (alive(server)) {
        try {
          process.kill(-server, "SIGKILL");
        } catch {}
      }
    }
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Builds the bundle once, builds the browser-side test modules, and applies
 * every migration into `<root>/template`.
 */
export async function prepareRun(root: string): Promise<void> {
  await mkdir(root, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  await Promise.all([
    execute(npm, ["run", "build"], { maxBuffer: 64 * 1024 * 1024 }),
    buildBrowserModules(join(root, "modules")),
    execute(
      process.execPath,
      [
        WRANGLER,
        "d1",
        "migrations",
        "apply",
        "DB",
        "--local",
        "--persist-to",
        join(root, "template"),
      ],
      {
        env: { ...process.env, ...QUIET, CI: "1" },
        maxBuffer: 16 * 1024 * 1024,
      },
    ),
  ]);
}

/**
 * Test-only modules a spec imports into a real page, such as the thumbnail
 * component mounted on its own. The production build has no route for them,
 * so they are built here and served by `serveBrowserModules`.
 */
export const MODULES_PATH = "/__test-modules/";

async function buildBrowserModules(outDir: string): Promise<void> {
  const { build } = await import("vite");
  await build({
    configFile: false,
    logLevel: "error",
    publicDir: false,
    base: MODULES_PATH,
    resolve: { alias: { "~": resolve("app") } },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      rollupOptions: {
        input: resolve("test/fixtures/asset-thumbnail.mjs"),
        preserveEntrySignatures: "exports-only",
        output: { entryFileNames: "[name].mjs" },
      },
    },
  });
}

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const probe = createServer();
    probe.once("error", fail);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => done(port));
    });
  });
}

export type UiServer = {
  baseURL: string;
  port: number;
  state: string;
  stop: () => Promise<void>;
};

/**
 * One server for one Playwright worker. With `VALISE_TEST_PORT` set, the
 * worker in parallel slot N listens on that port plus N; otherwise the port
 * is picked free, and a lost race retries on another.
 */
export async function startServer({
  root,
  worker,
  slot,
}: {
  root: string;
  worker: number;
  slot: number;
}): Promise<UiServer> {
  const state = join(root, `valise-playwright-w${worker}`);
  await rm(state, { recursive: true, force: true });
  await cp(join(root, "template"), state, { recursive: true });
  const envFile = join(state, "secrets.env");
  await writeFile(
    envFile,
    Object.entries(testSecrets())
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join("\n"),
    { mode: 0o600 },
  );
  const basePort = Number(process.env.VALISE_TEST_PORT) || 0;
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = basePort ? basePort + slot : await freePort();
    try {
      return await launch(root, state, envFile, port);
    } catch (error) {
      lastError = error;
      if (basePort) break;
    }
  }
  throw lastError;
}

async function launch(
  root: string,
  state: string,
  envFile: string,
  port: number,
): Promise<UiServer> {
  const log = join(state, `wrangler-${port}.log`);
  const output = await open(log, "a");
  const child = spawn(
    process.execPath,
    [
      WRANGLER,
      "dev",
      "--config",
      resolve("build/server/wrangler.json"),
      "--port",
      String(port),
      "--persist-to",
      state,
      "--local",
      "--inspector-port",
      "0",
      "--env-file",
      envFile,
      "--show-interactive-dev-session=false",
      "--var",
      "VALISE_RERANK:off",
    ],
    {
      // Its own process group, so stop() reaches workerd as well as wrangler.
      detached: true,
      stdio: ["ignore", output.fd, output.fd],
      env: { ...process.env, ...QUIET },
    },
  );
  await output.close();
  const pid = child.pid ?? 0;
  let gone = false;
  const exited = new Promise<void>((done) =>
    child.once("exit", () => {
      gone = true;
      done();
    }),
  );
  await writeFile(
    join(root, `server-${port}.json`),
    JSON.stringify({ server: pid }),
  );
  // The fixtures that write D1 directly find this server's state by its port.
  const descriptor = resolve(".wrangler", `ui-test-state-${port}.json`);
  await mkdir(dirname(descriptor), { recursive: true });
  await writeFile(descriptor, JSON.stringify({ state, pid: process.pid }), {
    mode: 0o600,
  });
  const stop = async () => {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {}
    const kill = setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {}
    }, 5_000);
    await exited;
    clearTimeout(kill);
    await rm(descriptor, { force: true });
    await rm(join(root, `server-${port}.json`), { force: true });
  };
  const baseURL = `http://localhost:${port}`;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline && !gone) {
    try {
      if ((await fetch(`${baseURL}/health`)).ok)
        return { baseURL, port, state, stop };
    } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  await stop();
  const tail = (await readFile(log, "utf8").catch(() => "")).slice(-2000);
  throw new Error(
    `UI server on port ${port} ${gone ? "exited" : "did not answer"}:\n${tail}`,
  );
}
