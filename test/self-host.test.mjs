import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import ts from "typescript";
import { validateDeployTarget } from "../scripts/deploy-target.mjs";
import {
  BACKUP_LOCK_RULES,
  cloudflareApi,
  listResources,
  lockBackups,
  provisionResources,
  selfHostConfig,
  validateInstallation,
} from "../scripts/self-host.mjs";

const installation = {
  account: "a".repeat(32),
  app: "my-case",
  subdomain: "not-the-account-username",
  backend: "lexical",
  suffix: "1234abcd",
};
const source = ts.parseConfigFileTextToJson(
  "wrangler.jsonc",
  readFileSync("wrangler.jsonc", "utf8"),
).config;

function fakeAccount() {
  const rows = new Map([
    ["d1/database", []],
    ["r2/buckets", []],
    ["storage/kv/namespaces", []],
  ]);
  const writes = [];
  const locks = new Map();
  const lockWrites = [];
  const api = async (path, body, method) => {
    const base = path.split("?")[0];
    const lock = /^r2\/buckets\/([^/]+)\/lock$/.exec(base);
    if (lock) {
      if (body) {
        assert.equal(method, "PUT");
        lockWrites.push(lock[1]);
        locks.set(lock[1], body.rules);
        return { result: {} };
      }
      return { result: { rules: locks.get(lock[1]) ?? [] } };
    }
    const values = rows.get(base);
    assert.ok(values, `Unexpected API call: ${path}`);
    if (body) {
      writes.push(base);
      const row = {
        ...body,
        ...(base === "d1/database"
          ? { uuid: "db-id" }
          : base === "storage/kv/namespaces"
            ? { id: "kv-id" }
            : { creation_date: "2026-10-23T00:00:00Z" }),
      };
      values.push(row);
      return { result: row };
    }
    return { result: base === "r2/buckets" ? { buckets: values } : values };
  };
  return { rows, writes, api, locks, lockWrites };
}

test("fresh lexical setup has isolated resources and no inference credentials/bindings", async () => {
  const account = fakeAccount();
  let saved;
  const resources = await provisionResources(
    account.api,
    installation,
    (state) => {
      saved = state;
    },
  );
  const config = selfHostConfig(source, installation, resources);
  assert.equal(
    config.vars.APP_ORIGIN,
    "https://my-case.not-the-account-username.workers.dev",
  );
  assert.equal(config.vars.MCP_RESOURCE_URL, `${config.vars.APP_ORIGIN}/mcp`);
  assert.equal(config.vars.VALISE_RERANK, "lexical");
  assert.equal(config.account_id, installation.account);
  assert.deepEqual(config.secrets.required, [
    "VALISE_ADMIN_PASSWORD",
    "SESSION_SECRET",
    "TOKEN_PEPPER",
  ]);
  assert.equal(config.ai, undefined);
  assert.equal(config.vectorize, undefined);
  assert.equal(config.previews, undefined);
  assert.equal(config.routes, undefined);
  assert.equal(config.vars.VALISE_VECTOR_NAMESPACE, undefined);
  assert.deepEqual(config.triggers.crons, ["0 4 * * *", "41 3 * * *"]);
  assert.equal(config.vars.VALISE_BACKUP_CRON, "41 3 * * *");
  assert.deepEqual(config.r2_buckets[1], {
    binding: "BACKUPS",
    bucket_name: "my-case-1234abcd-backups",
  });
  assert.deepEqual(config.workflows, [
    {
      name: "my-case-backup",
      binding: "BACKUP_WORKFLOW",
      class_name: "BackupWorkflow",
    },
  ]);
  assert.deepEqual(
    account.locks.get("my-case-1234abcd-backups"),
    BACKUP_LOCK_RULES,
  );
  assert.notEqual(
    config.ratelimits[0].namespace_id,
    source.ratelimits[0].namespace_id,
  );
  assert.equal(config.d1_databases[0].database_name, "my-case-1234abcd-data");
  assert.equal(config.r2_buckets[0].bucket_name, "my-case-1234abcd-bundles");
  assert.deepEqual(saved.resources, resources);
  await provisionResources(account.api, saved, () => {});
  assert.equal(account.writes.length, 4, "retry must reuse all four resources");
  assert.equal(account.lockWrites.length, 1, "lock rules are written once");
});

for (const backend of ["clef", "jev"]) {
  test(`${backend} setup declares only its selected inference dependency`, async () => {
    const resources = await provisionResources(
      fakeAccount().api,
      installation,
      () => {},
    );
    const config = selfHostConfig(
      source,
      { ...installation, backend },
      resources,
    );
    assert.equal(config.vars.VALISE_RERANK, backend);
    assert.equal(Boolean(config.ai), backend === "clef");
    assert.equal(
      config.secrets.required.includes("TYPESAFE_API_KEY"),
      backend === "jev",
    );
  });
}

for (const failure of ["d1/database", "r2/buckets", "storage/kv/namespaces"]) {
  test(`lost create response for ${failure} is rediscovered without a duplicate`, async () => {
    const account = fakeAccount();
    let state = installation;
    await assert.rejects(
      provisionResources(
        async (path, body) => {
          const out = await account.api(path, body, body && "PUT");
          if (body && path === failure)
            throw new Error("connection lost after server committed");
          return out;
        },
        state,
        (next) => {
          state = next;
        },
      ),
      /connection lost/,
    );
    await provisionResources(account.api, state, () => {});
    assert.equal(account.writes.length, 4);
  });
}

test("background jobs add the minute cron and Workers AI; off and older state files leave both out", async () => {
  const resources = await provisionResources(
    fakeAccount().api,
    installation,
    () => {},
  );
  const on = selfHostConfig(
    source,
    { ...installation, background: "on" },
    resources,
  );
  assert.deepEqual(on.triggers.crons, ["* * * * *", "0 4 * * *", "41 3 * * *"]);
  assert.deepEqual(on.ai, { binding: "AI" });
  assert.equal(on.vars.VALISE_RERANK, "lexical");
  for (const background of ["off", undefined]) {
    const config = selfHostConfig(
      source,
      { ...installation, background },
      resources,
    );
    assert.deepEqual(config.triggers.crons, ["0 4 * * *", "41 3 * * *"]);
    assert.equal(config.ai, undefined);
  }
  assert.throws(
    () => validateInstallation({ ...installation, background: "yes" }),
    /on or off/,
  );
});

test("backup lock rules keep the account's other rules and repair a weakened one", async () => {
  const account = fakeAccount();
  const foreign = {
    id: "someone-elses",
    enabled: true,
    prefix: "x/",
    condition: { type: "Indefinite" },
  };
  account.locks.set("b", [
    foreign,
    { ...BACKUP_LOCK_RULES[0], condition: { type: "Age", maxAgeSeconds: 60 } },
  ]);
  assert.equal(await lockBackups(account.api, "b"), true);
  assert.deepEqual(account.locks.get("b"), [foreign, ...BACKUP_LOCK_RULES]);
  assert.equal(await lockBackups(account.api, "b"), false);
  assert.equal(account.lockWrites.length, 1);
});

test("never replaces a recorded resource that was deleted or renamed", async () => {
  const account = fakeAccount();
  let state;
  await provisionResources(account.api, installation, (next) => {
    state = next;
  });
  account.rows.get("d1/database").length = 0;
  await assert.rejects(
    provisionResources(account.api, state, () => {}),
    /changed or disappeared/,
  );
  assert.equal(account.writes.length, 4);
});

test("a recreated same-name R2 bucket is not mistaken for the saved bucket", async () => {
  const account = fakeAccount();
  let state;
  await provisionResources(account.api, installation, (next) => {
    state = next;
  });
  const buckets = account.rows.get("r2/buckets");
  buckets[0] = { ...buckets[0], creation_date: "2026-10-24T00:00:00Z" };
  await assert.rejects(
    provisionResources(account.api, state, () => {}),
    /changed or disappeared/,
  );
  assert.equal(account.writes.length, 4);
});

test("duplicate names are an error rather than picking another installation's namespace", async () => {
  const account = fakeAccount();
  const name = `${installation.app}-${installation.suffix}-data`;
  account.rows
    .get("d1/database")
    .push({ name, uuid: "1" }, { name, uuid: "2" });
  await assert.rejects(
    provisionResources(account.api, installation, () => {}),
    /Multiple resources/,
  );
  assert.equal(account.writes.length, 0);
});

test("resource lookup traverses numbered and cursor pages", async () => {
  const paths = [];
  const numbered = await listResources(async (path) => {
    paths.push(path);
    return paths.length === 1
      ? { result: [{ id: "other" }], result_info: { per_page: 1 } }
      : { result: [] };
  }, "storage/kv/namespaces");
  assert.equal(numbered.length, 1);
  assert.match(paths[1], /page=2/);
  paths.length = 0;
  const buckets = await listResources(
    async (path) => {
      paths.push(path);
      return paths.length === 1
        ? {
            result: { buckets: [{ name: "first" }] },
            result_info: { cursor: "next/page" },
          }
        : { result: { buckets: [{ name: "last" }] } };
    },
    "r2/buckets",
    true,
  );
  assert.equal(buckets.length, 2);
  assert.match(paths[1], /cursor=next%2Fpage/);
});

test("permission errors fail closed and never print provider bodies or credentials", async () => {
  const api = cloudflareApi(
    "secret-key",
    installation.account,
    async (_url, init) => {
      assert.equal(init.headers.authorization, "Bearer secret-key");
      return Response.json(
        { success: false, errors: [{ message: "secret-key" }] },
        { status: 403 },
      );
    },
  );
  await assert.rejects(api("workers/subdomain"), (error) => {
    assert.match(error.message, /HTTP 403/);
    assert.ok(!error.message.includes("secret-key"));
    return true;
  });
});

test("invalid app/account/backend/subdomain/state is rejected before provisioning", async () => {
  for (const overrides of [
    { app: "../valise" },
    { app: "A" },
    { app: "x".repeat(41) },
    { account: "my-account" },
    { subdomain: "https://name.workers.dev" },
    { backend: "fts" },
    { suffix: "" },
  ]) {
    assert.throws(() =>
      validateInstallation({ ...installation, ...overrides }),
    );
    const account = fakeAccount();
    await assert.rejects(
      provisionResources(
        account.api,
        { ...installation, ...overrides },
        () => {},
      ),
    );
    assert.equal(account.writes.length, 0);
  }
});

test("a generated config without its identity stops before authentication or provisioning", () => {
  const directory = mkdtempSync(join(tmpdir(), "valise-setup-test-"));
  try {
    writeFileSync(join(directory, "wrangler.self-host.jsonc"), "{}");
    assert.throws(
      () =>
        execFileSync(process.execPath, [resolve("scripts/self-host.mjs")], {
          cwd: directory,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      /recover the installation state/,
    );
    assert.deepEqual(readdirSync(directory), ["wrangler.self-host.jsonc"]);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("the migration gate selects the same self-host config for both read and apply", () => {
  const directory = mkdtempSync(join(tmpdir(), "valise-migration-target-"));
  try {
    const calls = join(directory, "calls.jsonl");
    const applied = readdirSync("drizzle")
      .filter(
        (name) => name.endsWith(".sql") && name !== "0032_group_invites.sql",
      )
      .map((name) => ({ name }));
    writeFileSync(
      join(directory, "npx"),
      `#!/usr/bin/env node
      const fs = require('node:fs');
      fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');
      if (process.argv.includes('execute')) console.log(${JSON.stringify(JSON.stringify([{ results: applied }]))});
    `,
      { mode: 0o755 },
    );
    execFileSync(process.execPath, ["scripts/migrations.mjs", "apply"], {
      env: {
        ...process.env,
        PATH: `${directory}:${process.env.PATH}`,
        VALISE_CONFIG: "wrangler.self-host.jsonc",
      },
      stdio: "pipe",
    });
    const commands = readFileSync(calls, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(commands.length, 2);
    for (const args of commands) {
      assert.deepEqual(args.slice(0, 3), [
        "wrangler",
        "--config",
        "wrangler.self-host.jsonc",
      ]);
      assert.ok(args.includes("--remote"));
    }
    assert.ok(commands[0].includes("execute"));
    assert.ok(commands[1].includes("apply"));
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test("self-host deployment requires its smoke origin before any remote command", () => {
  assert.throws(
    () =>
      execFileSync("bash", ["scripts/deploy.sh"], {
        env: {
          ...process.env,
          WORKERS_CI_BRANCH: "main",
          VALISE_CONFIG: "fixture.jsonc",
          VALISE_ORIGIN: "",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /set VALISE_ORIGIN/,
  );
});

test("deployment rejects a mismatched build, origin or binding before migration", async () => {
  const resources = await provisionResources(
    fakeAccount().api,
    installation,
    () => {},
  );
  const config = selfHostConfig(source, installation, resources);
  validateDeployTarget(config, structuredClone(config), config.vars.APP_ORIGIN);
  for (const overrides of [
    { name: "other-worker" },
    { account_id: "b".repeat(32) },
    { d1_databases: [{ binding: "DB", database_id: "other-db" }] },
    { r2_buckets: [{ binding: "BUNDLES", bucket_name: "other-bucket" }] },
    { kv_namespaces: [{ binding: "OAUTH_KV", id: "other-kv" }] },
    { vars: { ...config.vars, MCP_RESOURCE_URL: "https://other.invalid/mcp" } },
  ]) {
    assert.throws(
      () =>
        validateDeployTarget(
          config,
          { ...config, ...overrides },
          config.vars.APP_ORIGIN,
        ),
      /same installation/,
    );
  }
  assert.throws(
    () => validateDeployTarget(config, config, "https://other.invalid"),
    /same installation/,
  );
});

test("the actual interactive bootstrap resumes without changing identity, resources or hosted config", async () => {
  const directory = mkdtempSync(join(tmpdir(), "valise-interactive-setup-"));
  try {
    const hosted = readFileSync("wrangler.jsonc", "utf8");
    writeFileSync(join(directory, "wrangler.jsonc"), hosted);
    symlinkSync(
      resolve("node_modules"),
      join(directory, "node_modules"),
      "dir",
    );
    const mock = join(directory, "mock-cloudflare.mjs");
    writeFileSync(
      mock,
      `
      import fs from 'node:fs';
      globalThis.fetch = async (url, init) => {
        const prefix = 'https://api.cloudflare.com/client/v4/accounts/${installation.account}/';
        if (!url.startsWith(prefix)) throw new Error('Unexpected external request');
        const path = url.slice(prefix.length).split('?')[0];
        const saved = fs.existsSync('api-state.json') ? JSON.parse(fs.readFileSync('api-state.json', 'utf8')) : {writes: 0, rows: {}};
        let result;
        if (path === 'workers/subdomain') result = {subdomain: '${installation.subdomain}'};
        else if (['d1/database', 'r2/buckets', 'storage/kv/namespaces'].includes(path)) {
          const rows = saved.rows[path] ??= [];
          if (init.method === 'POST') {
            result = {...JSON.parse(init.body), ...(path === 'd1/database' ? {uuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'} : path === 'storage/kv/namespaces' ? {id: 'b'.repeat(32)} : {creation_date: '2026-10-23T00:00:00Z'})};
            rows.push(result);
            saved.writes++;
          } else result = path === 'r2/buckets' ? {buckets: rows} : rows;
        } else if (/^r2\\/buckets\\/[^/]+\\/lock$/.test(path)) {
          if (init.method === 'PUT') {
            saved.rules = JSON.parse(init.body).rules;
            saved.locks = (saved.locks ?? 0) + 1;
            result = {};
          } else result = {rules: saved.rules ?? []};
        } else throw new Error('Unexpected API path: ' + path);
        fs.writeFileSync('api-state.json', JSON.stringify(saved));
        return Response.json({success: true, result});
      };
    `,
    );
    async function runSetup(first) {
      const prompts = first
        ? [
            ["App name", "my-case\n"],
            ["Search:", "\n"],
            ["Background jobs", "\n"],
            ["Type setup", "setup\n"],
          ]
        : [["Type setup", "setup\n"]];
      const child = spawn(
        process.execPath,
        ["--import", mock, resolve("scripts/self-host.mjs")],
        {
          cwd: directory,
          env: {
            ...process.env,
            CLOUDFLARE_ACCOUNT_ID: installation.account,
            CLOUDFLARE_API_TOKEN: "fixture-token",
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let errors = "";
      child.stdout.on("data", (chunk) => {
        output += chunk;
        if (prompts[0] && output.includes(prompts[0][0])) {
          child.stdin.write(prompts.shift()[1]);
        }
      });
      child.stderr.on("data", (chunk) => {
        errors += chunk;
      });
      const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
      try {
        const code = await new Promise((done, fail) => {
          child.once("error", fail);
          child.once("close", done);
        });
        assert.equal(code, 0, errors || output);
        assert.match(output, /Prepared wrangler.self-host.jsonc/);
        assert.ok(!output.includes("fixture-token"));
      } finally {
        clearTimeout(timeout);
        child.kill();
      }
    }
    await runSetup(true);
    const state = readFileSync(join(directory, ".valise-setup.json"), "utf8");
    const config = readFileSync(
      join(directory, "wrangler.self-host.jsonc"),
      "utf8",
    );
    await runSetup(false);
    assert.equal(
      readFileSync(join(directory, ".valise-setup.json"), "utf8"),
      state,
    );
    assert.equal(
      readFileSync(join(directory, "wrangler.self-host.jsonc"), "utf8"),
      config,
    );
    assert.equal(
      readFileSync(join(directory, "wrangler.jsonc"), "utf8"),
      hosted,
    );
    assert.equal(
      JSON.parse(readFileSync(join(directory, "api-state.json"), "utf8"))
        .writes,
      4,
    );
    assert.equal(
      JSON.parse(readFileSync(join(directory, "api-state.json"), "utf8")).locks,
      1,
    );
    assert.equal(JSON.parse(config).vars.VALISE_RERANK, "lexical");
    assert.equal(JSON.parse(state).background, "on");
    assert.ok(JSON.parse(config).triggers.crons.includes("* * * * *"));
    assert.ok(!readdirSync(directory).includes(".valise-setup.json.lock"));
  } finally {
    rmSync(directory, { recursive: true });
  }
});
