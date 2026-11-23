/**
 * `npm run dev`: make sure the worktree has secrets and a migrated local D1,
 * build the shared stylesheet and watch it beside the dev server, and seed a
 * store that is new. `npm run dev -- --tailnet` also serves it over HTTPS on
 * this machine's tailnet name.
 */
import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  allowHost,
  DEV_PASSWORD,
  ensureDevVars,
  freePort,
  isFreshState,
  migrate,
  parseArgs,
  serveArgs,
  statePath,
  tailnetHost,
  unserveArgs,
  waitForHealth,
} from "./dev-setup.mjs";

const {
  tailnet,
  port: askedPort,
  passthrough,
} = parseArgs(process.argv.slice(2));
const env = { ...process.env };

const vars = ensureDevVars();
for (const path of vars.created) console.log(`[dev] wrote ${path}`);
if (vars.created.includes(vars.shared))
  console.log(`[dev] admin password: ${DEV_PASSWORD}`);

const fresh = isFreshState(statePath(env));
console.log(`[dev] ${migrate(env)}`);

const port = askedPort ?? (await freePort());
const devArgs = askedPort
  ? passthrough
  : [...passthrough, "--port", String(port), "--strictPort"];
const host = tailnet ? tailnetHost() : null;
if (host) env.__VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS = allowHost(env, host);

const css = [
  resolve("node_modules/@tailwindcss/cli/dist/index.mjs"),
  "-i",
  "styles/valise.css",
  "-o",
  "public/valise.css",
];
const built = spawnSync(process.execPath, css, { stdio: "inherit" });
if (built.error) throw built.error;
if (built.status !== 0) process.exit(built.status ?? 1);
const children = [
  spawn(process.execPath, [...css, "--watch=always"], { stdio: "inherit" }),
  spawn(
    process.execPath,
    [
      "--conditions=development",
      resolve("node_modules/@react-router/dev/bin.cjs"),
      "dev",
      ...devArgs,
    ],
    { stdio: "inherit", env },
  ),
];

let served = false;
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  if (served) spawnSync("tailscale", unserveArgs(port), { stdio: "ignore" });
  for (const child of children) child.kill("SIGTERM");
}
for (const child of children) {
  child.once("error", (error) => {
    console.error(error);
    stop(1);
  });
  child.once("exit", (code) => stop(code ?? 1));
}
process.once("SIGINT", () => stop(0));
process.once("SIGTERM", () => stop(0));

const origin = `http://localhost:${port}`;
try {
  await waitForHealth(origin);
  if (fresh) {
    const seeded = await fetch(new URL("/__dev/seed", origin));
    if (!seeded.ok) throw new Error(`seed returned ${seeded.status}`);
    console.log("[dev] seeded a new store: one skill, one memory, one to-do");
  }
  if (host && !stopping) {
    const result = spawnSync("tailscale", serveArgs(port), {
      stdio: "ignore",
    });
    if (result.status === 0) {
      served = true;
      console.log(`[dev] tailnet: https://${host}:${port}`);
    } else {
      console.error(
        `[dev] \`tailscale ${serveArgs(port).join(" ")}\` failed; the server still answers on ${origin}`,
      );
    }
  }
  console.log(`[dev] sign in at ${origin}/login`);
} catch (error) {
  if (!stopping) console.error(`[dev] ${error.message}`);
}
