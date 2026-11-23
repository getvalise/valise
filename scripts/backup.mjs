#!/usr/bin/env node
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { installation } from "./backup-source.mjs";
import {
  applicationModule,
  checkTables,
  digest,
  literal,
  migrations,
  openDump,
  originals,
  recoverySql,
  TABLES,
} from "./recovery.mjs";

export { installation };

const SNAPSHOT = /^snapshot-[0-9T.Z-]+-[a-f0-9-]{36}$/;
const exec = promisify(execFile);

export async function wrangler(args) {
  try {
    return (
      await exec(
        process.execPath,
        [resolve("node_modules/wrangler/bin/wrangler.js"), ...args],
        {
          maxBuffer: 32 * 1024 * 1024,
          timeout: 300_000,
          env: { ...process.env, WRANGLER_SEND_METRICS: "false" },
        },
      )
    ).stdout;
  } catch (error) {
    // Wrangler errors may include SQL data or signed export URLs. Keep them
    // out of cron mail/status files; reproduce interactively for diagnostics.
    throw new Error(
      `Wrangler ${args.slice(0, 2).join(" ")} failed (${error.signal ?? error.code ?? "unknown exit"})`,
    );
  }
}

/** Attempts per R2 object get or put, before the error stands. */
export const R2_ATTEMPTS = 4;

/** Waits 0.5 s, 1 s, then 2 s between R2 attempts. */
const backoff = (attempt) =>
  new Promise((done) => setTimeout(done, 500 * 2 ** (attempt - 1)));

/**
 * One `wrangler r2 object` get or put, retried on failure. R2 answers an
 * occasional 500 (code 10001, "internal error, please try again"), and a get
 * or a put of the same bytes to the same key is safe to repeat. D1 calls never
 * come through here: the SQL import is not idempotent. Callers still check
 * size and SHA-256 of what they read; a mismatch is never retried.
 */
async function r2(run, args, wait) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await run(["r2", "object", ...args]);
    } catch (error) {
      if (attempt >= R2_ATTEMPTS)
        throw new Error(`${error.message} after ${attempt} attempts`, {
          cause: error,
        });
      await wait(attempt);
    }
  }
}

async function jsonFile(path, value) {
  await writeFile(`${path}.tmp`, `${JSON.stringify(value, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(`${path}.tmp`, path);
}

async function regularFile(path) {
  if (!(await lstat(path)).isFile())
    throw new Error("Backup entry must be a regular file, not a symlink");
  return readFile(path);
}

export async function verifySnapshot(dir) {
  // These artifacts are private, operator-trusted inputs, not uploads. Hashes
  // detect corruption; they are not a signature against a malicious author.
  if (!(await lstat(dir)).isDirectory())
    throw new Error("Snapshot must be a directory");
  if (!(await lstat(join(dir, "files"))).isDirectory())
    throw new Error("Originals must be a directory, not a symlink");
  const manifest = JSON.parse(await regularFile(join(dir, "manifest.json")));
  if (manifest.format !== "valise-recovery" || manifest.version !== 1)
    throw new Error("Not a valise-recovery v1 snapshot");
  if (JSON.stringify(manifest.tables) !== JSON.stringify(TABLES))
    throw new Error("Unexpected recovery table policy");
  for (const name of ["database.sql", "wrangler-source.jsonc"]) {
    if (digest(await regularFile(join(dir, name))) !== manifest.checksums[name])
      throw new Error(`Checksum mismatch: ${name}`);
  }
  const source = openDump(
    (await regularFile(join(dir, "database.sql"))).toString(),
  );
  try {
    checkTables(
      source
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((row) => row.name),
    );
    const expected = originals(source);
    if (JSON.stringify(expected) !== JSON.stringify(manifest.originals))
      throw new Error("Original-file inventory does not match D1 snapshot");
    for (const file of expected) {
      const bytes = await regularFile(join(dir, file.file));
      if (bytes.length !== file.size || digest(bytes) !== file.sha256)
        throw new Error("Original-file checksum mismatch");
    }
  } finally {
    source.close();
  }
  return manifest;
}

export async function capture({
  root,
  config,
  target,
  keep = 14,
  run = wrangler,
  wait = backoff,
}) {
  root = resolve(root);
  config = resolve(config);
  if (!Number.isInteger(keep) || keep < 1 || keep > 365)
    throw new Error("Retention must be 1..365 completed snapshots");
  if (!["--local", "--remote"].includes(target))
    throw new Error("Choose --local or --remote explicitly");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const lock = join(root, ".backup-lock");
  await mkdir(lock); // Exclusive: never steal a crashed or running process's lock.
  const startedAt = new Date().toISOString();
  const name = `snapshot-${startedAt.replaceAll(":", "-")}-${randomUUID()}`;
  const partial = join(root, `.${name}.partial`);
  const statusPath = join(root, "status.json");
  let previous = {};
  try {
    previous = JSON.parse(await readFile(statusPath, "utf8"));
  } catch {}
  const status = {
    state: "running",
    startedAt,
    lastSuccessAt: previous.lastSuccessAt ?? null,
    snapshot: previous.snapshot ?? null,
  };
  try {
    await writeFile(
      join(lock, "owner.json"),
      JSON.stringify({ pid: process.pid, startedAt }),
      { mode: 0o600 },
    );
    await jsonFile(statusPath, status);
    const source = await installation(config);
    const identity = { ...source.identity, target };
    const identityPath = join(root, "installation.json");
    let recorded;
    try {
      recorded = JSON.parse(await readFile(identityPath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (recorded && JSON.stringify(recorded) !== JSON.stringify(identity))
      throw new Error("Backup root belongs to another installation or target");
    if (!recorded) await jsonFile(identityPath, identity);
    await mkdir(join(partial, "files"), { recursive: true, mode: 0o700 });
    const base = ["--config", config, target];
    const tables = JSON.parse(
      await run([
        "d1",
        "execute",
        "DB",
        ...base,
        "--json",
        "--command",
        "SELECT name FROM sqlite_master WHERE type='table'",
      ]),
    );
    checkTables(
      tables.flatMap((result) => result.results.map((row) => row.name)),
    );
    const schema = await migrations();
    const applied = JSON.parse(
      await run([
        "d1",
        "execute",
        "DB",
        ...base,
        "--json",
        "--command",
        "SELECT name FROM d1_migrations ORDER BY name",
      ]),
    ).flatMap((result) => result.results.map((row) => row.name));
    if (JSON.stringify(applied) !== JSON.stringify(schema.map((m) => m.name)))
      throw new Error("Backup checkout and database migrations differ");
    await run([
      "d1",
      "export",
      "DB",
      ...base,
      ...TABLES.flatMap((table) => ["--table", table]),
      "--output",
      join(partial, "database.sql"),
    ]);
    const sql = await readFile(join(partial, "database.sql"), "utf8");
    const db = openDump(sql);
    let files;
    try {
      files = originals(db);
      // Exercise the restore transformations and relational/projection rebuild
      // before advertising this snapshot as recoverable.
      await recoverySql(db, schema);
    } finally {
      db.close();
    }
    for (const file of files) {
      await r2(
        run,
        [
          "get",
          `${source.identity.bucket}/${file.key}`,
          ...base,
          "--file",
          join(partial, file.file),
        ],
        wait,
      );
      const bytes = await readFile(join(partial, file.file));
      if (bytes.length !== file.size || digest(bytes) !== file.sha256)
        throw new Error("Downloaded original does not match D1 snapshot");
    }
    await writeFile(join(partial, "wrangler-source.jsonc"), source.raw, {
      mode: 0o600,
    });
    const manifest = {
      format: "valise-recovery",
      version: 1,
      startedAt,
      completedAt: new Date().toISOString(),
      source: source.identity,
      target,
      codeRevision: await exec("git", ["rev-parse", "HEAD"])
        .then((out) => out.stdout.trim())
        .catch(() => null),
      tables: TABLES,
      migrations: schema.map(({ name, sha256 }) => ({ name, sha256 })),
      originals: files,
      checksums: {
        "database.sql": digest(sql),
        "wrangler-source.jsonc": digest(source.raw),
      },
    };
    // A complete marker is published only after every original is checked.
    await jsonFile(join(partial, "manifest.json"), manifest);
    await verifySnapshot(partial);
    await rename(partial, join(root, name));
    status.lastSuccessAt = manifest.completedAt;
    status.snapshot = name;
    // Retention owns only completed snapshot directories with our marker. It
    // runs after success, never after a failed or partial capture.
    const completed = [];
    for (const entry of await readdir(root)) {
      if (
        !SNAPSHOT.test(entry) ||
        !(await lstat(join(root, entry))).isDirectory()
      )
        continue;
      const marker = JSON.parse(
        await regularFile(join(root, entry, "manifest.json")),
      );
      if (marker.format === "valise-recovery" && marker.version === 1)
        completed.push(entry);
    }
    for (const old of completed.sort().reverse().slice(keep))
      await rm(join(root, old), { recursive: true });
    await jsonFile(statusPath, {
      ...status,
      state: "ok",
      finishedAt: new Date().toISOString(),
    });
    return manifest;
  } catch (error) {
    await jsonFile(statusPath, {
      ...status,
      state: "failed",
      finishedAt: new Date().toISOString(),
      error: error.message,
    });
    throw error;
  } finally {
    await rm(partial, { recursive: true, force: true });
    await rm(lock, { recursive: true });
  }
}

export async function status(root, maxAgeHours = 26, now = Date.now()) {
  if (!Number.isFinite(maxAgeHours) || maxAgeHours <= 0)
    throw new Error("Invalid maximum backup age");
  const report = JSON.parse(await readFile(join(root, "status.json"), "utf8"));
  const ageHours = (now - Date.parse(report.lastSuccessAt)) / 3_600_000;
  const locked = !!(await lstat(join(root, ".backup-lock")).catch(() => null));
  const snapshotPresent =
    SNAPSHOT.test(report.snapshot ?? "") &&
    (
      await lstat(join(root, report.snapshot)).catch(() => null)
    )?.isDirectory() &&
    (
      await lstat(join(root, report.snapshot, "manifest.json")).catch(
        () => null,
      )
    )?.isFile();
  return {
    ...report,
    locked,
    snapshotPresent: !!snapshotPresent,
    healthy:
      !locked &&
      !!snapshotPresent &&
      report.state === "ok" &&
      Number.isFinite(ageHours) &&
      ageHours >= 0 &&
      ageHours <= maxAgeHours,
    ageHours: Number.isFinite(ageHours) ? ageHours : null,
  };
}

export async function restore({
  dir,
  config,
  target,
  confirmation,
  run = wrangler,
  wait = backoff,
}) {
  dir = resolve(dir);
  config = resolve(config);
  if (!["--local", "--remote"].includes(target))
    throw new Error("Choose --local or --remote explicitly");
  const manifest = await verifySnapshot(dir);
  const destination = await installation(config);
  if (confirmation !== destination.identity.worker)
    throw new Error(
      "Confirm the fresh installation's Worker name with --fresh",
    );
  if (!["lexical", "off"].includes(destination.config.vars?.VALISE_RERANK))
    throw new Error(
      "Restore must explicitly use lexical/off mode, not inference reranking",
    );
  if (target === "--remote") {
    for (const field of ["worker", "database", "bucket", "kv"]) {
      if (destination.identity[field] === manifest.source[field])
        throw new Error(
          `Restore requires a new ${field}; cannot target the source installation`,
        );
    }
    if (
      destination.identity.vectorNamespace &&
      destination.identity.vectorNamespace === manifest.source.vectorNamespace
    )
      throw new Error("Restore cannot reuse the source vector namespace");
  } else {
    // Local restore never overlays a live coordinator/KV/R2 namespace, even if
    // D1 happens to be empty. Config-relative state is Wrangler's export path.
    const state = join(dirname(config), ".wrangler", "state");
    const existingState = await lstat(state).catch((error) => {
      if (error.code !== "ENOENT") throw error;
      return null;
    });
    if (existingState)
      throw new Error(
        "Local restore requires fresh config-relative .wrangler/state",
      );
  }
  if (destination.identity.vectorNamespace)
    throw new Error(
      "Restore must pause vector delivery with an empty VALISE_VECTOR_NAMESPACE",
    );
  const schema = await migrations();
  if (
    JSON.stringify(schema.map(({ name, sha256 }) => ({ name, sha256 }))) !==
    JSON.stringify(manifest.migrations)
  )
    throw new Error(
      "Use the snapshot's exact migration revision; restore first, upgrade afterwards",
    );
  const source = openDump(
    (await readFile(join(dir, "database.sql"))).toString(),
  );
  let sql;
  try {
    sql = await recoverySql(source, schema);
  } finally {
    source.close();
  }
  const base = ["--config", config, target];
  // The operator confirms NEW, unpublished resources. No app, coordinator or
  // scheduled job may have used them; the source IDs above are refused.
  const existing = JSON.parse(
    await run([
      "d1",
      "execute",
      "DB",
      ...base,
      "--json",
      "--command",
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'",
    ]),
  );
  if (existing.some((result) => result.results.length))
    throw new Error(
      "Restore requires an uninitialized D1 database; use new resources after a partial restore",
    );
  await run(["d1", "migrations", "apply", "DB", ...base]);
  const file = join(dirname(config), `.valise-recovery-${randomUUID()}.sql`);
  try {
    await writeFile(file, sql, { mode: 0o600 });
    // Originals before rows: no visible authoritative row points at missing
    // bytes if the SQL import fails. Resources remain unpublished on failure.
    for (const original of manifest.originals) {
      await r2(
        run,
        [
          "put",
          `${destination.identity.bucket}/${original.key}`,
          ...base,
          "--file",
          join(dir, original.file),
          "--content-type",
          original.contentType,
        ],
        wait,
      );
      const readback = `${file}.original`;
      try {
        await r2(
          run,
          [
            "get",
            `${destination.identity.bucket}/${original.key}`,
            ...base,
            "--file",
            readback,
          ],
          wait,
        );
        const bytes = await readFile(readback);
        if (bytes.length !== original.size || digest(bytes) !== original.sha256)
          throw new Error("Restored original failed readback checksum");
      } finally {
        await rm(readback, { force: true });
      }
    }
    await run(["d1", "execute", "DB", ...base, "--file", file]);
    const checks = JSON.parse(
      await run([
        "d1",
        "execute",
        "DB",
        ...base,
        "--json",
        "--command",
        "PRAGMA foreign_key_check",
      ]),
    );
    if (checks.some((result) => result.results.length))
      throw new Error("Restored foreign-key check failed");
    return {
      restored: manifest.tables.length,
      originals: manifest.originals.length,
      search: "rebuilt",
      credentials:
        "sessions, tokens, OAuth grants and live leases not restored",
      memoryReviews:
        "disabled; model choices, limits and review history retained; enable reviews and opt in to overnight again explicitly",
    };
  } finally {
    await rm(file, { force: true });
  }
}

/**
 * Download one snapshot the scheduled Workflow wrote to R2 into the directory
 * layout `capture` produces, verify it, and rehearse the restore when this
 * checkout's migrations match. `restore` then reads it unchanged. The config
 * is any config whose account (or, with --local, whose local state) holds the
 * backups bucket; its BACKUPS binding names the bucket. ADR-0019.
 */
export async function pull({
  snapshot,
  dir,
  config,
  target,
  run = wrangler,
  wait = backoff,
}) {
  if (!SNAPSHOT.test(snapshot ?? ""))
    throw new Error("Name the snapshot as snapshot-<time>-<uuid>");
  if (!["--local", "--remote"].includes(target))
    throw new Error("Choose --local or --remote explicitly");
  config = resolve(config);
  dir = resolve(dir);
  const { config: parsed, error } = ts.parseConfigFileTextToJson(
    config,
    await readFile(config, "utf8"),
  );
  const bucket = parsed?.r2_buckets?.find(
    (b) => b.binding === "BACKUPS",
  )?.bucket_name;
  if (error || !bucket)
    throw new Error("Config must bind the backups bucket as BACKUPS");
  if (await lstat(dir).catch(() => null))
    throw new Error("Pull into a new directory");
  const partial = `${dir}.partial-${randomUUID()}`;
  const get = (key, file) =>
    r2(
      run,
      ["get", `${bucket}/${key}`, "--config", config, target, "--file", file],
      wait,
    );
  try {
    await mkdir(join(partial, "files"), { recursive: true, mode: 0o700 });
    for (const name of [
      "manifest.json",
      "database.sql",
      "wrangler-source.jsonc",
    ])
      await get(`snapshots/${snapshot}/${name}`, join(partial, name));
    const manifest = JSON.parse(
      await readFile(join(partial, "manifest.json"), "utf8"),
    );
    for (const original of manifest.originals ?? []) {
      if (!/^[a-f0-9]{64}$/.test(original.sha256))
        throw new Error("Invalid original checksum in manifest");
      await get(`originals/${original.sha256}`, join(partial, original.file));
    }
    await verifySnapshot(partial);
    const schema = await migrations();
    let rehearsed = false;
    if (
      JSON.stringify(schema.map(({ name, sha256 }) => ({ name, sha256 }))) ===
      JSON.stringify(manifest.migrations)
    ) {
      const db = openDump(
        await readFile(join(partial, "database.sql"), "utf8"),
      );
      try {
        await recoverySql(db, schema);
      } finally {
        db.close();
      }
      rehearsed = true;
    }
    await rename(partial, dir);
    return {
      snapshot,
      dir,
      originals: manifest.originals.length,
      codeRevision: manifest.codeRevision,
      rehearsed,
      ...(rehearsed
        ? {}
        : {
            next: "Check out the manifest's codeRevision to rehearse and restore",
          }),
    };
  } finally {
    await rm(partial, { recursive: true, force: true });
  }
}

function boundSql(sql, values = []) {
  let position = 0;
  const result = sql.replace(
    /'(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\?/g,
    (token) => (token === "?" ? literal(values[position++]) : token),
  );
  if (position !== values.length)
    throw new Error("Recovery enqueue binding mismatch");
  return result;
}

function enqueueDatabase(run, base) {
  const execute = async (sql) => {
    const replies = JSON.parse(
      await run(["d1", "execute", "DB", ...base, "--json", "--command", sql]),
    );
    if (
      !Array.isArray(replies) ||
      replies.some(
        (reply) => reply.success === false || !Array.isArray(reply.results),
      )
    )
      throw new Error("Invalid recovery enqueue response");
    return replies.map((reply) => ({
      ...reply,
      meta: { ...reply.meta, changes: reply.meta?.changes ?? 0 },
    }));
  };
  const prepare = (sql, values = []) => ({
    get sql() {
      return boundSql(sql, values);
    },
    bind: (...args) => prepare(sql, args),
    all: async () => ({
      results: (await execute(boundSql(sql, values))).flatMap(
        (reply) => reply.results,
      ),
    }),
    run: async () => (await execute(boundSql(sql, values))).at(-1),
  });
  // Only idempotent derived INSERTs are batched here, never authoritative writes.
  return {
    prepare,
    batch: (statements) =>
      execute(statements.map((statement) => `${statement.sql};`).join("\n")),
  };
}

/** Provider-free recovery step using the application's existing asset outbox. */
export async function enqueueAssetVectors({
  dir,
  config,
  target,
  confirmation,
  namespace,
  run = wrangler,
}) {
  if (!["--local", "--remote"].includes(target))
    throw new Error("Choose --local or --remote explicitly");
  if (
    typeof namespace !== "string" ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(namespace)
  )
    throw new Error(
      "Supply a fresh vector deployment identity with --namespace",
    );
  dir = resolve(dir);
  config = resolve(config);
  const manifest = await verifySnapshot(dir);
  const destination = await installation(config);
  if (confirmation !== destination.identity.worker)
    throw new Error("Confirm the recovery Worker's name with --fresh");
  if (
    !["lexical", "off"].includes(destination.config.vars?.VALISE_RERANK) ||
    destination.identity.vectorNamespace ||
    destination.config.vectorize?.length
  )
    throw new Error(
      "Enqueue recovery in lexical/off mode with empty VALISE_VECTOR_NAMESPACE and no Vectorize binding",
    );
  for (const field of ["worker", "database", "bucket", "kv"]) {
    if (destination.identity[field] === manifest.source[field])
      throw new Error(`Vector recovery cannot target the source ${field}`);
  }
  if (namespace === manifest.source.vectorNamespace)
    throw new Error("Vector recovery cannot reuse the source vector namespace");
  const schema = await migrations();
  if (
    JSON.stringify(schema.map(({ name, sha256 }) => ({ name, sha256 }))) !==
    JSON.stringify(manifest.migrations)
  )
    throw new Error("Use the recovery snapshot's exact migration revision");
  const DB = enqueueDatabase(run, ["--config", config, target]);
  const applied = (
    await DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all()
  ).results.map((row) => row.name);
  if (
    JSON.stringify(applied) !==
    JSON.stringify(schema.map((migration) => migration.name))
  )
    throw new Error("Recovery target migrations do not match the snapshot");
  const { backfillAssetVectors } = await applicationModule(
    "app/search/asset-vectors.ts",
  );
  const env = { DB, VALISE_VECTOR_NAMESPACE: namespace };
  let after = "";
  let outputs = 0;
  let queuedChunks = 0;
  for (;;) {
    const page = await backfillAssetVectors(env, after);
    outputs += page.outputs;
    queuedChunks += page.queuedChunks;
    if (page.done) break;
    if (page.cursor <= after)
      throw new Error("Recovery enqueue cursor did not advance");
    after = page.cursor;
  }
  // Bookmark passages queue the same way, from their current enrichment.
  const { backfillSourceVectors } = await applicationModule(
    "app/search/source-vectors.ts",
  );
  after = "";
  let sources = 0;
  for (;;) {
    const page = await backfillSourceVectors(env, after);
    sources += page.outputs;
    queuedChunks += page.queuedChunks;
    if (page.done) break;
    if (page.cursor <= after)
      throw new Error("Recovery enqueue cursor did not advance");
    after = page.cursor;
  }
  return {
    namespace,
    outputs,
    sources,
    queuedChunks,
    delivered: false,
    visibilityVerified: false,
    next: "Keep lexical search. Explicitly attach a fresh index and enable this base identity for bounded embedding delivery; validate fresh ANN queries before hybrid.",
  };
}

async function main() {
  const [command, path, ...args] = process.argv.slice(2);
  const options = {};
  for (let i = command === "pull" ? 1 : 0; i < args.length; i++) {
    const flag = args[i];
    if (["--local", "--remote"].includes(flag)) {
      if (options.target) throw new Error("Choose exactly one target");
      options.target = flag;
    } else if (
      [
        "--config",
        "--keep",
        "--fresh",
        "--max-age-hours",
        "--namespace",
      ].includes(flag) &&
      args[i + 1]
    )
      options[flag.slice(2)] = args[++i];
    else throw new Error(`Unknown or incomplete option: ${flag}`);
  }
  if (command === "status" && path) {
    const report = await status(path, Number(options["max-age-hours"] ?? 26));
    console.log(JSON.stringify(report));
    if (!report.healthy) process.exitCode = 1;
  } else if (command === "verify" && path) {
    const manifest = await verifySnapshot(path);
    console.log(
      JSON.stringify({ verified: true, originals: manifest.originals.length }),
    );
  } else if (command === "capture" && path && options.config) {
    const result = await capture({
      root: path,
      config: options.config,
      target: options.target,
      keep: Number(options.keep ?? 14),
    });
    console.log(
      JSON.stringify({
        event: "backup",
        completedAt: result.completedAt,
        originals: result.originals.length,
      }),
    );
  } else if (command === "pull" && path && args[0] && options.config) {
    console.log(
      JSON.stringify(
        await pull({
          snapshot: path,
          dir: args[0],
          config: options.config,
          target: options.target,
        }),
      ),
    );
  } else if (command === "restore" && path && options.config) {
    console.log(
      JSON.stringify(
        await restore({
          dir: path,
          config: options.config,
          target: options.target,
          confirmation: options.fresh,
        }),
      ),
    );
  } else if (command === "enqueue-assets" && path && options.config) {
    console.log(
      JSON.stringify(
        await enqueueAssetVectors({
          dir: path,
          config: options.config,
          target: options.target,
          confirmation: options.fresh,
          namespace: options.namespace,
        }),
      ),
    );
  } else
    throw new Error(
      "Usage: node scripts/backup.mjs capture ROOT --config FILE --local|--remote [--keep 14]\n  verify SNAPSHOT | status ROOT [--max-age-hours 26]\n  pull SNAPSHOT_NAME DIR --config FILE --local|--remote\n  restore SNAPSHOT --config NEW_FILE --local|--remote --fresh NEW_WORKER_NAME\n  enqueue-assets SNAPSHOT --config RECOVERY_FILE --local|--remote --fresh NEW_WORKER_NAME --namespace FRESH_BASE",
    );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  // Backup data includes password hashes and all tenants' private originals.
  process.umask(0o077);
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
