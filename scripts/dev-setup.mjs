/**
 * What `npm run dev` does before and after it starts the server, so a fresh
 * worktree or a first clone needs no setup step: secrets, migrations, a seed,
 * and optionally a tailnet URL.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Local only: the Worker refuses an admin password shorter than 16. */
export const DEV_PASSWORD = "valise-local-dev-password";

export function sharedDevVarsPath(env = process.env) {
  return env.VALISE_DEV_VARS ?? join(homedir(), ".valise", "dev.vars");
}

/** The example with its three required placeholders filled in. */
export function devVarsFromExample(example, random = randomHex) {
  const values = {
    VALISE_ADMIN_PASSWORD: DEV_PASSWORD,
    SESSION_SECRET: random(),
    TOKEN_PEPPER: random(),
  };
  const lines = example.split("\n");
  const header = lines.findIndex((line) => !line.startsWith("#"));
  return lines
    .slice(header)
    .map((line) => {
      const key = line.split("=")[0];
      return key in values ? `${key}=${values[key]}` : line;
    })
    .join("\n");
}

/**
 * A worktree without `.dev.vars` gets a copy of the machine-wide file, which
 * is created from `.dev.vars.example` the first time. Every branch then signs
 * in with the same password. An existing `.dev.vars` is never touched.
 */
export function ensureDevVars({
  cwd = process.cwd(),
  shared = sharedDevVarsPath(),
  random = randomHex,
} = {}) {
  const local = join(cwd, ".dev.vars");
  if (existsSync(local)) return { local, created: [] };
  const created = [];
  if (!existsSync(shared)) {
    const example = readFileSync(join(cwd, ".dev.vars.example"), "utf8");
    mkdirSync(dirname(shared), { recursive: true });
    writeFileSync(shared, devVarsFromExample(example, random), { mode: 0o600 });
    created.push(shared);
  }
  copyFileSync(shared, local);
  created.push(local);
  return { local, shared, created };
}

/** Where the Vite plugin keeps D1, KV, R2 and Durable Objects. */
export function statePath(env = process.env, cwd = process.cwd()) {
  return resolve(cwd, env.VALISE_STATE ?? ".wrangler/state");
}

export function isFreshState(state) {
  return !existsSync(join(state, "v3", "d1"));
}

export function migrateArgs(env = process.env, cwd = process.cwd()) {
  return [
    resolve(cwd, "node_modules/wrangler/bin/wrangler.js"),
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    statePath(env, cwd),
    ...(env.VALISE_CONFIG ? ["--config", env.VALISE_CONFIG] : []),
  ];
}

/**
 * Without a terminal, Wrangler reprints its table after every migration: a
 * new store printed 8,000 lines. The output is shown only when it fails.
 */
export function migrate(env = process.env) {
  const result = spawnSync(process.execPath, migrateArgs(env), {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    env: { ...env, CI: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stderr.write(result.stdout + result.stderr);
    throw new Error(`local migrations failed with status ${result.status}`);
  }
  return /No migrations to apply/.test(result.stdout)
    ? "local D1 is up to date"
    : "applied local migrations";
}

/**
 * Splits our own flags from the ones passed through to `react-router dev`,
 * and reads the port the caller asked for, if any.
 */
export function parseArgs(argv) {
  const passthrough = [];
  let tailnet = false;
  let port;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--tailnet") {
      tailnet = true;
      continue;
    }
    if (arg === "--port") port = Number(argv[i + 1]);
    else if (arg.startsWith("--port=")) port = Number(arg.slice(7));
    passthrough.push(arg);
  }
  return { tailnet, port, passthrough };
}

function portIsFree(port) {
  return new Promise((done) => {
    const server = createServer();
    server.once("error", (error) => done(error.code !== "EADDRINUSE"));
    server.listen(port, "localhost", () => server.close(() => done(true)));
  });
}

export async function freePort(from = 5173) {
  for (let port = from; port < from + 100; port++) {
    if (await portIsFree(port)) return port;
  }
  throw new Error(`no free port between ${from} and ${from + 99}`);
}

/** This machine's MagicDNS name, from `tailscale status --json`. */
export function tailnetHost(run = spawnSync) {
  const result = run("tailscale", ["status", "--json"], { encoding: "utf8" });
  if (result.error || result.status !== 0)
    throw new Error(
      "--tailnet needs Tailscale running: `tailscale status --json` failed",
    );
  const name = JSON.parse(result.stdout)?.Self?.DNSName?.replace(/\.$/, "");
  if (!name)
    throw new Error(
      "--tailnet: Tailscale reports no MagicDNS name for this machine",
    );
  return name;
}

/**
 * Vite refuses a Host header it does not know; this variable adds one
 * without a config change. Vite listens on localhost, which on macOS is ::1
 * only, so the proxy targets `localhost` rather than 127.0.0.1.
 */
export function allowHost(env, host) {
  const existing = env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS;
  return existing ? `${existing},${host}` : host;
}

export function serveArgs(port) {
  return ["serve", "--bg", `--https=${port}`, `http://localhost:${port}`];
}

export function unserveArgs(port) {
  return ["serve", `--https=${port}`, "off"];
}

export async function waitForHealth(origin, { timeoutMs = 120_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(new URL("/health", origin));
      if (response.ok) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 500));
  }
  throw new Error(`${origin} did not answer /health within ${timeoutMs} ms`);
}

function randomHex() {
  return randomBytes(32).toString("hex");
}
