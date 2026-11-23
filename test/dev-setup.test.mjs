import assert from "node:assert/strict";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  allowHost,
  DEV_PASSWORD,
  devVarsFromExample,
  ensureDevVars,
  freePort,
  isFreshState,
  migrateArgs,
  parseArgs,
  serveArgs,
  tailnetHost,
  unserveArgs,
} from "../scripts/dev-setup.mjs";

const example = readFileSync(".dev.vars.example", "utf8");

function worktree() {
  const dir = mkdtempSync(join(tmpdir(), "valise-dev-setup-"));
  writeFileSync(join(dir, ".dev.vars.example"), example);
  return dir;
}

test("the example's three required values are filled, the rest kept", () => {
  let n = 0;
  const vars = devVarsFromExample(example, () => `secret-${++n}`);
  assert.match(
    vars,
    new RegExp(`^VALISE_ADMIN_PASSWORD=${DEV_PASSWORD}$`, "m"),
  );
  assert.match(vars, /^SESSION_SECRET=secret-1$/m);
  assert.match(vars, /^TOKEN_PEPPER=secret-2$/m);
  assert.doesNotMatch(vars, /replace-with/);
  assert.ok(vars.startsWith("VALISE_ADMIN_PASSWORD="), "header dropped");
  assert.match(vars, /^GOOGLE_CLIENT_ID=$/m);
  assert.ok(DEV_PASSWORD.length >= 16, "the Worker refuses shorter passwords");
});

test("a fresh machine gets a shared file and the worktree a copy of it", () => {
  const cwd = worktree();
  const shared = join(cwd, "home", ".valise", "dev.vars");
  const result = ensureDevVars({ cwd, shared, random: () => "r" });
  assert.deepEqual(result.created, [shared, join(cwd, ".dev.vars")]);
  assert.equal(
    readFileSync(join(cwd, ".dev.vars"), "utf8"),
    readFileSync(shared, "utf8"),
  );
  assert.equal(statSync(shared).mode & 0o777, 0o600);
});

test("a second worktree reuses the shared file, so the password matches", () => {
  const shared = join(worktree(), "dev.vars");
  writeFileSync(shared, "VALISE_ADMIN_PASSWORD=mine-from-before-1234\n");
  const cwd = worktree();
  const result = ensureDevVars({ cwd, shared });
  assert.deepEqual(result.created, [join(cwd, ".dev.vars")]);
  assert.equal(
    readFileSync(join(cwd, ".dev.vars"), "utf8"),
    "VALISE_ADMIN_PASSWORD=mine-from-before-1234\n",
  );
});

test("an existing .dev.vars is never touched", () => {
  const cwd = worktree();
  writeFileSync(join(cwd, ".dev.vars"), "KEEP=1\n");
  const shared = join(cwd, "never-made");
  assert.deepEqual(ensureDevVars({ cwd, shared }).created, []);
  assert.equal(readFileSync(join(cwd, ".dev.vars"), "utf8"), "KEEP=1\n");
  assert.throws(() => statSync(shared));
});

test("a store is fresh until it has a D1 directory", () => {
  const state = mkdtempSync(join(tmpdir(), "valise-state-"));
  assert.equal(isFreshState(state), true);
  mkdirSync(join(state, "v3", "d1"), { recursive: true });
  assert.equal(isFreshState(state), false);
});

test("migrations target the store and config the dev server uses", () => {
  const args = migrateArgs(
    {
      VALISE_STATE: ".wrangler/other",
      VALISE_CONFIG: "wrangler.staging.jsonc",
    },
    "/repo",
  );
  assert.deepEqual(args.slice(1), [
    "d1",
    "migrations",
    "apply",
    "DB",
    "--local",
    "--persist-to",
    "/repo/.wrangler/other",
    "--config",
    "wrangler.staging.jsonc",
  ]);
  assert.equal(migrateArgs({}, "/repo")[7], "/repo/.wrangler/state");
});

test("--tailnet is ours; everything else passes through", () => {
  assert.deepEqual(parseArgs(["--tailnet", "--host"]), {
    tailnet: true,
    port: undefined,
    passthrough: ["--host"],
  });
  assert.equal(parseArgs(["--port", "4546", "--strictPort"]).port, 4546);
  assert.equal(parseArgs(["--port=4547"]).port, 4547);
});

test("freePort skips a port something already listens on", async () => {
  const server = createServer();
  const taken = await new Promise((done) =>
    server.listen(0, "localhost", () => done(server.address().port)),
  );
  try {
    assert.notEqual(await freePort(taken), taken);
  } finally {
    server.close();
  }
});

test("the tailnet name comes from tailscale, without the trailing dot", () => {
  const run = () => ({
    status: 0,
    stdout: JSON.stringify({ Self: { DNSName: "box.tail1234.ts.net." } }),
  });
  assert.equal(tailnetHost(run), "box.tail1234.ts.net");
  assert.throws(
    () => tailnetHost(() => ({ status: 1, stdout: "" })),
    /Tailscale running/,
  );
});

test("the allowed host is appended, and serve targets localhost", () => {
  assert.equal(allowHost({}, "a.ts.net"), "a.ts.net");
  assert.equal(
    allowHost({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "x" }, "a.ts.net"),
    "x,a.ts.net",
  );
  assert.deepEqual(serveArgs(5174), [
    "serve",
    "--bg",
    "--https=5174",
    "http://localhost:5174",
  ]);
  assert.deepEqual(unserveArgs(5174), ["serve", "--https=5174", "off"]);
});
