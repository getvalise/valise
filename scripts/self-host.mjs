#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  existsSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export const STATE_FILE = ".valise-setup.json";
export const CONFIG_FILE = "wrangler.self-host.jsonc";
const LABEL = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;

export function validateInstallation(installation) {
  const { account, app, subdomain, backend, suffix } = installation;
  if (!/^[a-f0-9]{32}$/.test(account ?? ""))
    throw new Error(
      "Use the 32-character Cloudflare account ID, not its name.",
    );
  if (!LABEL.test(app ?? "") || app.length < 3 || app.length > 40)
    throw new Error(
      "App name must be 3–40 lowercase letters, digits or hyphens, with no leading/trailing hyphen.",
    );
  if (!LABEL.test(subdomain ?? "") || subdomain.length > 63)
    throw new Error(
      "Register a workers.dev subdomain in the Cloudflare dashboard first.",
    );
  if (!["lexical", "clef", "jev"].includes(backend))
    throw new Error("Choose lexical, clef or jev.");
  if (![undefined, "on", "off"].includes(installation.background))
    throw new Error("Background jobs are on or off.");
  if (!/^[a-f0-9]{8}$/.test(suffix ?? ""))
    throw new Error(
      "Invalid installation identity; do not edit the setup state.",
    );
}

/** Bucket Lock retention on the backup bucket's snapshots and originals. ADR-0019. */
export const BACKUP_LOCK_DAYS = 30;
export const BACKUP_LOCK_RULES = ["snapshots/", "originals/"].map((prefix) => ({
  id: `valise-${prefix.slice(0, -1)}-${BACKUP_LOCK_DAYS}d`,
  enabled: true,
  prefix,
  condition: { type: "Age", maxAgeSeconds: BACKUP_LOCK_DAYS * 86_400 },
}));

/** Daily, at a minute derived from the installation, so installations spread out. */
export function backupCron(installation) {
  return `${Number.parseInt(installation.suffix, 16) % 60} 3 * * *`;
}

/**
 * The minute cron drives file processing, bookmark fetching, built-in skill
 * updates and the hourly backup check (workers/app.ts). Processing and
 * fetching run on Workers AI, so `on` binds AI too. A state file written
 * before the setting existed keeps the old behaviour, off.
 */
export function backgroundJobs(installation) {
  return installation.background === "on";
}

/** Explicit allowlist: never copy hosted origins, resource IDs, routes or previews. */
export function selfHostConfig(source, installation, resources) {
  validateInstallation(installation);
  const { account, app, subdomain, backend } = installation;
  const origin = `https://${app}.${subdomain}.workers.dev`;
  const backups = backupCron(installation);
  return {
    $schema: "node_modules/wrangler/config-schema.json",
    name: app,
    account_id: account,
    main: source.main,
    compatibility_date: source.compatibility_date,
    compatibility_flags: source.compatibility_flags,
    keep_vars: true,
    workers_dev: true,
    vars: {
      APP_ORIGIN: origin,
      MCP_RESOURCE_URL: `${origin}/mcp`,
      SKILLS_REGISTRY_URL: "https://skills.sh",
      VALISE_RERANK: backend,
      GOOGLE_CLIENT_ID: "none",
      VALISE_BACKUP_CRON: backups,
      VALISE_BACKUP_KEEP: "30",
    },
    secrets: {
      required: [
        "VALISE_ADMIN_PASSWORD",
        "SESSION_SECRET",
        "TOKEN_PEPPER",
        ...(backend === "jev" ? ["TYPESAFE_API_KEY"] : []),
      ],
    },
    d1_databases: [
      {
        binding: "DB",
        database_name: resources.db.name,
        database_id: resources.db.uuid,
        migrations_dir: "drizzle",
      },
    ],
    r2_buckets: [
      { binding: "BUNDLES", bucket_name: resources.bucket.name },
      { binding: "BACKUPS", bucket_name: resources.backups.name },
    ],
    workflows: [
      {
        name: `${app}-backup`,
        binding: "BACKUP_WORKFLOW",
        class_name: "BackupWorkflow",
      },
    ],
    kv_namespaces: [{ binding: "OAUTH_KV", id: resources.kv.id }],
    ...(backend === "clef" || backgroundJobs(installation)
      ? { ai: { binding: "AI" } }
      : {}),
    ratelimits: [
      {
        name: "MCP_LIMITER",
        namespace_id: String(Number.parseInt(installation.suffix, 16)),
        simple: { limit: 60, period: 60 },
      },
      {
        name: "CAPTURE_LIMITER",
        namespace_id: String(Number.parseInt(installation.suffix, 16) + 1),
        simple: { limit: 20, period: 60 },
      },
    ],
    durable_objects: source.durable_objects,
    migrations: source.migrations,
    triggers: {
      crons: [
        ...(backgroundJobs(installation) ? ["* * * * *"] : []),
        "0 4 * * *",
        backups,
      ],
    },
    observability: {
      enabled: true,
      traces: { enabled: true, head_sampling_rate: 0.01 },
    },
  };
}

/** Error text never contains credentials, request bodies or provider messages. */
export function cloudflareApi(token, account, fetcher = fetch) {
  if (!/^[a-f0-9]{32}$/.test(account)) throw new Error("Invalid account ID");
  return async (path, body, method = body === undefined ? "GET" : "POST") => {
    const response = await fetcher(
      `https://api.cloudflare.com/client/v4/accounts/${account}/${path}`,
      {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(30_000),
      },
    );
    const envelope = await response.json().catch(() => null);
    if (!response.ok || envelope?.success !== true)
      throw new Error(
        `Cloudflare ${path.split("?")[0]} failed (HTTP ${response.status}); check token permissions and retry setup.`,
      );
    return envelope;
  };
}

/** D1/KV use numbered pages; R2 uses a continuation cursor. Read all of them. */
export async function listResources(api, path, buckets = false) {
  const rows = [];
  let cursor = "";
  for (let page = 1; page <= 1000; page++) {
    const query = buckets
      ? `per_page=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`
      : `per_page=100&page=${page}`;
    const out = await api(`${path}?${query}`);
    const batch = buckets ? out.result?.buckets : out.result;
    if (!Array.isArray(batch))
      throw new Error(`Invalid resource list from ${path}`);
    rows.push(...batch);
    if (buckets) {
      const next = out.result_info?.cursor;
      if (!next) return rows;
      if (next === cursor) throw new Error(`Repeated cursor from ${path}`);
      cursor = next;
    } else if (batch.length < (out.result_info?.per_page ?? 100)) {
      return rows;
    }
  }
  throw new Error(`Resource listing exceeded 1000 pages: ${path}`);
}

/** Stable, installation-specific names survive a lost create response or process. */
export async function provisionResources(api, installation, checkpoint) {
  validateInstallation(installation);
  const prefix = `${installation.app}-${installation.suffix}`;
  const resources = {};
  for (const [key, path, field, name] of [
    ["db", "d1/database", "name", `${prefix}-data`],
    ["bucket", "r2/buckets", "name", `${prefix}-bundles`],
    ["kv", "storage/kv/namespaces", "title", `${prefix}-oauth`],
    ["backups", "r2/buckets", "name", `${prefix}-backups`],
  ]) {
    const matching = (
      await listResources(api, path, path === "r2/buckets")
    ).filter((row) => row[field] === name);
    if (matching.length > 1)
      throw new Error(
        `Multiple resources named ${name}; resolve the ambiguity before retrying.`,
      );
    const previous = installation.resources?.[key];
    if (
      previous &&
      (!matching[0] ||
        (matching[0].uuid ??
          matching[0].id ??
          matching[0].creation_date ??
          matching[0].name) !==
          (previous.uuid ??
            previous.id ??
            previous.creation_date ??
            previous.name))
    )
      throw new Error(
        `Resource ${name} changed or disappeared; refusing to replace it.`,
      );
    const row = matching[0] ?? (await api(path, { [field]: name })).result;
    if (
      row?.[field] !== name ||
      (key === "db" && !row.uuid) ||
      (key === "kv" && !row.id)
    )
      throw new Error(
        `Invalid create response for ${name}; retry to rediscover it.`,
      );
    resources[key] = row;
    await checkpoint({
      ...installation,
      resources: { ...installation.resources, ...resources },
    });
  }
  await lockBackups(api, resources.backups.name);
  return resources;
}

/**
 * Add the snapshot and original lock rules, keeping any other rules. A rerun
 * that finds them in place writes nothing. ADR-0019.
 */
export async function lockBackups(api, bucket) {
  const path = `r2/buckets/${encodeURIComponent(bucket)}/lock`;
  const rules = (await api(path)).result?.rules ?? [];
  const missing = BACKUP_LOCK_RULES.filter(
    (rule) =>
      !rules.some(
        (existing) =>
          existing.id === rule.id &&
          existing.enabled &&
          existing.prefix === rule.prefix &&
          existing.condition?.type === "Age" &&
          existing.condition.maxAgeSeconds >= rule.condition.maxAgeSeconds,
      ),
  );
  if (!missing.length) return false;
  await api(
    path,
    {
      rules: [
        ...rules.filter((r) => !missing.some((m) => m.id === r.id)),
        ...missing,
      ],
    },
    "PUT",
  );
  return true;
}

function writeJson(path, value) {
  writeFileSync(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  renameSync(`${path}.tmp`, path);
}

async function main() {
  if (process.argv.includes("--help")) {
    console.log(
      "Usage: scripts/first-deploy.sh\nInteractive, resumable resource setup; no migrations, secret changes or deployments.\nSee docs/operations/self-hosting.md.",
    );
    return;
  }
  if (process.argv.length > 2)
    throw new Error("No arguments supported; use --help.");
  // One local process per installation. No remote POST is blindly retried.
  const lock = `${STATE_FILE}.lock`;
  writeFileSync(lock, String(process.pid), { flag: "wx", mode: 0o600 });
  const terminal = createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  try {
    let installation = existsSync(STATE_FILE)
      ? JSON.parse(readFileSync(STATE_FILE, "utf8"))
      : null;
    if (!installation && existsSync(CONFIG_FILE))
      throw new Error(
        `Found ${CONFIG_FILE} without ${STATE_FILE}; recover the installation state before creating resources.`,
      );
    if (installation) validateInstallation(installation);
    const { config: source, error } = ts.parseConfigFileTextToJson(
      "wrangler.jsonc",
      readFileSync("wrangler.jsonc", "utf8"),
    );
    if (error) throw new Error("Invalid source Wrangler configuration");
    const account =
      installation?.account ??
      (
        process.env.CLOUDFLARE_ACCOUNT_ID ||
        (await terminal.question("Cloudflare account ID: "))
      ).trim();
    if (
      process.env.CLOUDFLARE_ACCOUNT_ID &&
      process.env.CLOUDFLARE_ACCOUNT_ID !== account
    )
      throw new Error(
        "Account differs from saved installation; use its original account or a separate checkout.",
      );
    // Capture rather than print Wrangler's credential output. No global API keys.
    const credentials = process.env.CLOUDFLARE_API_TOKEN
      ? { token: process.env.CLOUDFLARE_API_TOKEN }
      : JSON.parse(
          execFileSync("npx", ["wrangler", "auth", "token", "--json"], {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
          }),
        );
    if (!credentials.token)
      throw new Error(
        "Run npx wrangler login or set CLOUDFLARE_API_TOKEN; global API keys are not supported.",
      );
    const api = cloudflareApi(credentials.token, account);
    const { subdomain } = (await api("workers/subdomain")).result;
    if (installation && installation.subdomain !== subdomain)
      throw new Error(
        "The account Workers subdomain changed; review OAuth URLs before resuming.",
      );
    installation ??= {
      account,
      app: (await terminal.question("App name (e.g. my-valise): ")).trim(),
      subdomain,
      backend:
        (
          await terminal.question(
            "Search: lexical (no inference), clef (Cloudflare), jev (TypeSafe) [lexical]: ",
          )
        ).trim() || "lexical",
      background:
        (
          await terminal.question(
            "Background jobs every minute (file processing and bookmark fetching on Workers AI, skill updates): on, off [on]: ",
          )
        ).trim() || "on",
      suffix: randomBytes(4).toString("hex"),
    };
    validateInstallation(installation);
    console.log(
      `Account: ${account}\nApp: ${installation.app}\nOrigin: https://${installation.app}.${subdomain}.workers.dev\nSearch: ${installation.backend}\nBackground jobs: ${backgroundJobs(installation) ? "every minute" : "off"}\nResources: ${installation.app}-${installation.suffix}-{data,bundles,oauth,backups}\nBackups: daily at ${backupCron(installation)} UTC, snapshots locked ${BACKUP_LOCK_DAYS} days`,
    );
    console.log(
      "Creates or reuses these resources only. Does not change wrangler.jsonc, secrets, schema or deployed code.",
    );
    if (backgroundJobs(installation))
      console.log(
        "Background jobs bind Workers AI: processing a file or fetching a bookmark incurs inference charges; bookmark fetching stays inside VALISE_SOURCE_DAILY_USD. See docs/operations/self-hosting.md.",
      );
    if (installation.backend !== "lexical")
      console.log(
        "Reranking sends each query and up to 50 candidate titles/bodies to the selected provider and incurs inference charges. See docs/operations/self-hosting.md.",
      );
    if ((await terminal.question("Type setup to continue: ")) !== "setup")
      return;
    // Identity must be durable BEFORE the first create; never choose a new suffix on retry.
    writeJson(STATE_FILE, installation);
    const resources = await provisionResources(api, installation, (state) =>
      writeJson(STATE_FILE, state),
    );
    const config = selfHostConfig(source, installation, resources);
    const formatted = execFileSync(
      "npx",
      ["biome", "format", "--stdin-file-path", CONFIG_FILE],
      {
        input: `${JSON.stringify(config, null, 2)}\n`,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    if (
      existsSync(CONFIG_FILE) &&
      readFileSync(CONFIG_FILE, "utf8") !== formatted
    )
      throw new Error(
        `${CONFIG_FILE} has changed; preserve/review it before regenerating. Resources are saved in ${STATE_FILE}.`,
      );
    writeFileSync(`${CONFIG_FILE}.tmp`, formatted, { mode: 0o600 });
    renameSync(`${CONFIG_FILE}.tmp`, CONFIG_FILE);
    console.log(
      `Prepared ${CONFIG_FILE}. Required secrets: ${config.secrets.required.join(", ")}.\nFollow docs/operations/self-hosting.md to initialize the fresh schema and deploy from your fork's main with Workers Builds.`,
    );
  } finally {
    terminal.close();
    unlinkSync(lock);
  }
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  main().catch((error) => {
    // execFile errors include captured output; never print their details.
    console.error(
      error?.cmd
        ? "Setup helper failed; confirm npm ci and npx wrangler login succeeded, then retry."
        : error.message,
    );
    process.exitCode = 1;
  });
}
