import { createHash } from "node:crypto";
import {
  checkTables,
  inventory,
  literal,
  type Original,
  quote,
  TABLES,
} from "../../scripts/recovery-policy.mjs";

/**
 * The scheduled backup, as steps. `BackupWorkflow` runs these inside a
 * Cloudflare Workflow; the recovery drill runs the same function with an
 * inline step runner against local bindings. Every step is idempotent: it
 * writes deterministic keys, skips what is already stored, and returns small
 * values the Workflow engine caches. ADR-0019.
 *
 * R2 layout in the backups bucket:
 *
 * - `staging/<snapshot>/<attempt>/` row pages, the assembled SQL and the
 *   original inventory. Unlocked; deleted after publish.
 * - `snapshots/<snapshot>/` `database.sql`, `wrangler-source.jsonc` and,
 *   last, `manifest.json`. A manifest means the snapshot verified.
 * - `originals/<sha256>` each original's bytes, stored once per content hash.
 *
 * `scripts/backup.mjs pull` turns one snapshot back into the directory that
 * `capture` writes, so `restore` reads it unchanged.
 */

export const PAGE_ROWS = 500;
export const ATTEMPTS = 3;
const TORN_RETRY_MS = 10 * 60_000;
const ORIGINALS_PER_STEP = 25;
/** R2 multipart parts must be equal-sized, and at least 5 MiB but the last. */
const PART_BYTES = 8 * 1024 * 1024;
const STALE_STAGING_MS = 2 * 24 * 3_600_000;

export type Identity = {
  worker: string;
  account: string | null;
  database: string;
  bucket: string;
  kv: string;
  vectorNamespace: string | null;
};

/** The deployed config, fixed into the bundle at build time. */
export type BackupSource = {
  raw: string;
  identity: Identity;
  revision: string | null;
};

export type Migration = { name: string; sha256: string };

export type BackupBindings = {
  DB: D1Database;
  BUNDLES: R2Bucket;
  BACKUPS: R2Bucket;
};

export type BackupStep = {
  do<T>(name: string, work: () => Promise<T>): Promise<T>;
  sleep(name: string, ms: number): Promise<void>;
};

export type BackupRequest = { snapshot: string; startedAt: string };

export type BackupBuild = {
  source: BackupSource;
  migrations: Migration[];
  keep: number;
};

type Value = string | number | null;

type TablePlan = {
  table: string;
  create: string;
  primaryKey: string[];
  foreignKeys: { parent: string; from: string[]; to: string[] }[];
};

type Page = { columns: string[]; rows: Value[][] };

type Assembled =
  | { ok: true; sha256: string; bytes: number; originals: number }
  | { ok: false; reason: string };

export type Manifest = {
  format: "valise-recovery";
  version: 1;
  startedAt: string;
  completedAt: string;
  source: Identity;
  target: "worker";
  codeRevision: string | null;
  tables: readonly string[];
  migrations: Migration[];
  originals: (Original & { file: string })[];
  checksums: { "database.sql": string; "wrangler-source.jsonc": string };
};

export const SNAPSHOT = /^snapshot-[0-9T.Z-]+-[a-f0-9-]{36}$/;
export const snapshotKey = (snapshot: string, file: string) =>
  `snapshots/${snapshot}/${file}`;
export const originalKey = (sha256: string) => `originals/${sha256}`;
const stagingPrefix = (snapshot: string, attempt: number) =>
  `staging/${snapshot}/${attempt}/`;
const pageKey = (prefix: string, table: string, index: number) =>
  `${prefix}rows/${table}/${String(index).padStart(6, "0")}.json`;

export const sha256 = (data: string | Uint8Array) =>
  createHash("sha256").update(data).digest("hex");

function hex(buffer: ArrayBuffer | undefined): string | null {
  if (!buffer) return null;
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function readJson<T>(bucket: R2Bucket, key: string): Promise<T> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Backup object missing: ${key}`);
  return object.json<T>();
}

/** Stream an object through SHA-256 without holding it in memory. */
async function hashObject(
  bucket: R2Bucket,
  key: string,
): Promise<{ sha256: string; bytes: number }> {
  const object = await bucket.get(key);
  if (!object) throw new Error(`Backup object missing: ${key}`);
  const hash = createHash("sha256");
  let bytes = 0;
  const reader = object.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    bytes += value.byteLength;
  }
  return { sha256: hash.digest("hex"), bytes };
}

/** Write once: a locked key cannot be overwritten, so a retry skips it. */
async function putVerified(
  bucket: R2Bucket,
  key: string,
  body: () => Promise<ReadableStream | string>,
  expected: { sha256: string; size: number },
) {
  const existing = await bucket.head(key);
  if (
    existing &&
    existing.size === expected.size &&
    hex(existing.checksums.sha256) === expected.sha256
  )
    return false;
  // R2 refuses the put when the bytes do not hash to the expected SHA-256.
  await bucket.put(key, await body(), { sha256: expected.sha256 });
  return true;
}

// --- D1 run log ---------------------------------------------------------------

export async function recordStart(
  DB: D1Database,
  snapshot: string,
  startedAt: number,
) {
  await DB.prepare(
    "INSERT OR IGNORE INTO backup_runs (snapshot, state, started_at) VALUES (?, 'running', ?)",
  )
    .bind(snapshot, startedAt)
    .run();
}

/** Also records a run that failed before its start step wrote a row. */
export async function recordFailure(
  DB: D1Database,
  request: BackupRequest,
  error: string,
  at: number,
) {
  await DB.prepare(
    `INSERT INTO backup_runs (snapshot, state, started_at, finished_at, error)
     VALUES (?1, 'failed', ?2, ?3, ?4)
     ON CONFLICT(snapshot) DO UPDATE SET state='failed', finished_at=?3, error=?4
     WHERE backup_runs.state<>'complete'`,
  )
    .bind(
      request.snapshot,
      Date.parse(request.startedAt) || at,
      at,
      error.slice(0, 500),
    )
    .run();
}

// --- Steps --------------------------------------------------------------------

/** Classify every table and record each authoritative table's shape. */
async function plan(
  env: BackupBindings,
  migrations: Migration[],
  attempt: number,
  snapshot: string,
): Promise<TablePlan[]> {
  const tables = (
    await env.DB.prepare(
      "SELECT name, sql FROM sqlite_master WHERE type='table'",
    ).all<{ name: string; sql: string | null }>()
  ).results;
  checkTables(tables.map((table) => table.name));
  const applied = (
    await env.DB.prepare("SELECT name FROM d1_migrations ORDER BY name").all<{
      name: string;
    }>()
  ).results.map((row) => row.name);
  if (
    JSON.stringify(applied) !==
    JSON.stringify(migrations.map((migration) => migration.name))
  )
    throw new Error("Deployed code and database migrations differ");
  await env.DB.prepare("UPDATE backup_runs SET attempts=? WHERE snapshot=?")
    .bind(attempt, snapshot)
    .run();
  const plans: TablePlan[] = [];
  for (const table of TABLES) {
    const create = tables.find((t) => t.name === table)?.sql;
    if (!create) throw new Error(`Missing recovery table: ${table}`);
    const columns = (
      await env.DB.prepare(`PRAGMA table_info(${quote(table)})`).all<{
        name: string;
        pk: number;
      }>()
    ).results;
    const primaryKey = columns
      .filter((column) => column.pk > 0)
      .sort((a, b) => a.pk - b.pk)
      .map((column) => column.name);
    const keys = (
      await env.DB.prepare(`PRAGMA foreign_key_list(${quote(table)})`).all<{
        id: number;
        seq: number;
        table: string;
        from: string;
        to: string | null;
      }>()
    ).results;
    const grouped = new Map<number, typeof keys>();
    for (const key of keys)
      grouped.set(key.id, [...(grouped.get(key.id) ?? []), key]);
    plans.push({
      table,
      create,
      primaryKey,
      foreignKeys: [...grouped.values()].map((parts) => {
        const ordered = parts.sort((a, b) => a.seq - b.seq);
        return {
          parent: ordered[0].table,
          from: ordered.map((part) => part.from),
          // A null target means the parent's primary key; resolved below.
          to: ordered.map((part) => part.to ?? ""),
        };
      }),
    });
  }
  for (const { foreignKeys } of plans)
    for (const key of foreignKeys)
      if (key.to.includes(""))
        key.to = plans.find((p) => p.table === key.parent)?.primaryKey ?? [];
  return plans;
}

/**
 * Children before parents. A row inserted while the capture runs is then
 * missing from the snapshot, but a captured child never misses a parent that
 * existed when the child was read. Cycles fall back to reverse table order.
 */
export function readOrder(plans: TablePlan[]): string[] {
  const parentsOf = new Map(
    plans.map((p) => [
      p.table,
      new Set(
        p.foreignKeys
          .map((key) => key.parent)
          .filter((parent) => parent !== p.table),
      ),
    ]),
  );
  const order: string[] = [];
  const remaining = new Set(plans.map((p) => p.table));
  while (remaining.size) {
    const ready = [...remaining].filter(
      (table) =>
        ![...remaining].some(
          (other) => other !== table && parentsOf.get(other)?.has(table),
        ),
    );
    const next = ready.length ? ready : [[...remaining].at(-1) as string];
    for (const table of next) {
      order.push(table);
      remaining.delete(table);
    }
  }
  return order;
}

async function readPage(
  env: BackupBindings,
  prefix: string,
  table: string,
  after: number,
  index: number,
): Promise<{ next: number | null; rows: number }> {
  const [header, ...rows] = await env.DB.prepare(
    `SELECT rowid AS "__valise_rowid", * FROM ${quote(table)} WHERE rowid > ? ORDER BY rowid LIMIT ?`,
  )
    .bind(after, PAGE_ROWS)
    .raw<Value[]>({ columnNames: true });
  for (const row of rows)
    for (const value of row)
      if (
        value !== null &&
        typeof value !== "string" &&
        typeof value !== "number"
      )
        throw new Error(`Unsupported value type in ${table}`);
  const page: Page = {
    columns: (header as string[]).slice(1),
    rows: rows.map((row) => row.slice(1)),
  };
  await env.BACKUPS.put(pageKey(prefix, table, index), JSON.stringify(page));
  return {
    rows: rows.length,
    next: rows.length < PAGE_ROWS ? null : (rows.at(-1)?.[0] as number),
  };
}

async function* pages(
  env: BackupBindings,
  prefix: string,
  table: string,
  count: number,
) {
  for (let index = 0; index < count; index++)
    yield await readJson<Page>(env.BACKUPS, pageKey(prefix, table, index));
}

const tuple = (row: Value[], positions: number[]) =>
  JSON.stringify(positions.map((position) => row[position]));

/** Equal-sized multipart parts, hashed as they are cut. */
function partWriter(upload: R2MultipartUpload) {
  const hash = createHash("sha256");
  const encoder = new TextEncoder();
  const parts: R2UploadedPart[] = [];
  let pending: Uint8Array[] = [];
  let pendingBytes = 0;
  let bytes = 0;
  async function flush(final: boolean) {
    while (pendingBytes >= PART_BYTES || (final && pendingBytes > 0)) {
      const size = Math.min(PART_BYTES, pendingBytes);
      const part = new Uint8Array(size);
      let offset = 0;
      while (offset < size) {
        const head = pending[0];
        const take = Math.min(head.byteLength, size - offset);
        part.set(head.subarray(0, take), offset);
        offset += take;
        if (take === head.byteLength) pending.shift();
        else pending[0] = head.subarray(take);
      }
      pendingBytes -= size;
      parts.push(await upload.uploadPart(parts.length + 1, part));
    }
  }
  return {
    async write(text: string) {
      const chunk = encoder.encode(text);
      hash.update(chunk);
      bytes += chunk.byteLength;
      pending.push(chunk);
      pendingBytes += chunk.byteLength;
      if (pendingBytes >= PART_BYTES) await flush(false);
    },
    async close() {
      await flush(true);
      await upload.complete(parts);
      pending = [];
      return { sha256: hash.digest("hex"), bytes };
    },
  };
}

/**
 * Write `database.sql` in the format `openDump` loads, and refuse a torn read:
 * a duplicated primary key or a child whose parent row was not captured.
 */
async function assemble(
  env: BackupBindings,
  prefix: string,
  plans: TablePlan[],
  counts: Record<string, number>,
): Promise<Assembled> {
  const byTable = new Map(plans.map((p) => [p.table, p]));
  // Parent keys first, so each child row is checked as it is written.
  const parentKeys = new Map<string, Set<string>>();
  const needed = new Map<string, string[][]>();
  for (const { foreignKeys } of plans)
    for (const key of foreignKeys)
      if (byTable.has(key.parent))
        needed.set(key.parent, [...(needed.get(key.parent) ?? []), key.to]);
  for (const [parent, columnSets] of needed) {
    for (const columns of columnSets)
      parentKeys.set(`${parent}|${columns.join(",")}`, new Set());
    for await (const page of pages(env, prefix, parent, counts[parent])) {
      for (const columns of columnSets) {
        const positions = columns.map((c) => page.columns.indexOf(c));
        const set = parentKeys.get(`${parent}|${columns.join(",")}`);
        for (const row of page.rows) set?.add(tuple(row, positions));
      }
    }
  }
  const upload = await env.BACKUPS.createMultipartUpload(
    `${prefix}database.sql`,
  );
  const out = partWriter(upload);
  const objects: {
    r2_key: string;
    size: number;
    sha256: string;
    content_type: string;
  }[] = [];
  const versions: { files_json: string }[] = [];
  try {
    await out.write("PRAGMA defer_foreign_keys=TRUE;\n");
    for (const table of TABLES)
      await out.write(`${(byTable.get(table) as TablePlan).create};\n`);
    for (const table of TABLES) {
      const tablePlan = byTable.get(table) as TablePlan;
      const seen = new Set<string>();
      for await (const page of pages(env, prefix, table, counts[table])) {
        const pk = tablePlan.primaryKey.map((c) => page.columns.indexOf(c));
        const checks = tablePlan.foreignKeys
          .filter((key) => byTable.has(key.parent))
          .map((key) => ({
            set: parentKeys.get(`${key.parent}|${key.to.join(",")}`),
            positions: key.from.map((c) => page.columns.indexOf(c)),
            name: `${table} → ${key.parent}`,
          }));
        const columns = page.columns.map(quote).join(",");
        for (const row of page.rows) {
          if (pk.length) {
            const key = tuple(row, pk);
            if (seen.has(key)) {
              await upload.abort();
              return { ok: false, reason: `duplicate key in ${table}` };
            }
            seen.add(key);
          }
          for (const check of checks) {
            const values = check.positions.map((p) => row[p]);
            if (values.some((value) => value === null)) continue;
            if (!check.set?.has(JSON.stringify(values))) {
              await upload.abort();
              return { ok: false, reason: `missing parent for ${check.name}` };
            }
          }
          await out.write(
            `INSERT INTO ${quote(table)} (${columns}) VALUES(${row.map(literal).join(",")});\n`,
          );
          const record = Object.fromEntries(
            page.columns.map((column, i) => [column, row[i]]),
          );
          if (table === "objects") objects.push(record as never);
          if (table === "skill_versions") versions.push(record as never);
        }
      }
    }
  } catch (error) {
    await upload.abort().catch(() => {});
    throw error;
  }
  const { sha256: digest, bytes } = await out.close();
  const files = inventory(objects, versions).map((entry) => ({
    ...entry,
    file: `files/${sha256(entry.key)}`,
  }));
  await env.BACKUPS.put(`${prefix}originals.json`, JSON.stringify(files));
  return { ok: true, sha256: digest, bytes, originals: files.length };
}

/** Copy one batch of originals into the content-addressed pool. */
async function copyOriginals(
  env: BackupBindings,
  prefix: string,
  batch: number,
): Promise<{ copied: number; present: number }> {
  const files = await readJson<Manifest["originals"]>(
    env.BACKUPS,
    `${prefix}originals.json`,
  );
  let copied = 0;
  let present = 0;
  for (const file of files.slice(
    batch * ORIGINALS_PER_STEP,
    (batch + 1) * ORIGINALS_PER_STEP,
  )) {
    // The pool may already hold these bytes, so the source is not reread,
    // but a missing or resized source original still fails the run.
    const head = await env.BUNDLES.head(file.key);
    if (!head || head.size !== file.size)
      throw new Error("Original missing or changed since the D1 read");
    const wrote = await putVerified(
      env.BACKUPS,
      originalKey(file.sha256),
      async () => {
        const source = await env.BUNDLES.get(file.key);
        if (!source || source.size !== file.size)
          throw new Error("Original missing or changed since the D1 read");
        return source.body;
      },
      file,
    );
    if (wrote) copied++;
    else present++;
  }
  return { copied, present };
}

/** Move the assembled SQL and the source config under the snapshot prefix. */
async function store(
  env: BackupBindings,
  prefix: string,
  snapshot: string,
  sql: { sha256: string; bytes: number },
  raw: string,
) {
  await putVerified(
    env.BACKUPS,
    snapshotKey(snapshot, "database.sql"),
    async () => {
      const staged = await env.BACKUPS.get(`${prefix}database.sql`);
      if (!staged) throw new Error("Assembled SQL missing from staging");
      return staged.body;
    },
    { sha256: sql.sha256, size: sql.bytes },
  );
  await putVerified(
    env.BACKUPS,
    snapshotKey(snapshot, "wrangler-source.jsonc"),
    async () => raw,
    { sha256: sha256(raw), size: new TextEncoder().encode(raw).byteLength },
  );
}

/** Reread what the manifest is about to vouch for. */
async function verify(
  env: BackupBindings,
  prefix: string,
  snapshot: string,
  sql: { sha256: string; bytes: number },
) {
  const stored = await hashObject(
    env.BACKUPS,
    snapshotKey(snapshot, "database.sql"),
  );
  if (stored.sha256 !== sql.sha256 || stored.bytes !== sql.bytes)
    throw new Error("Stored database.sql failed its checksum");
  const files = await readJson<Manifest["originals"]>(
    env.BACKUPS,
    `${prefix}originals.json`,
  );
  for (const file of files) {
    const head = await env.BACKUPS.head(originalKey(file.sha256));
    if (
      !head ||
      head.size !== file.size ||
      hex(head.checksums.sha256) !== file.sha256
    )
      throw new Error("Stored original failed its checksum");
  }
  return { originals: files.length };
}

async function publish(
  env: BackupBindings,
  prefix: string,
  request: BackupRequest,
  build: BackupBuild,
  sql: { sha256: string; bytes: number },
  completedAt: number,
): Promise<{ completedAt: string; originals: number }> {
  const key = snapshotKey(request.snapshot, "manifest.json");
  let manifest = (await env.BACKUPS.get(key).then((o) =>
    o?.json(),
  )) as Manifest | null;
  if (!manifest) {
    manifest = {
      format: "valise-recovery",
      version: 1,
      startedAt: request.startedAt,
      completedAt: new Date(completedAt).toISOString(),
      source: build.source.identity,
      target: "worker",
      codeRevision: build.source.revision,
      tables: TABLES,
      migrations: build.migrations.map(({ name, sha256 }) => ({
        name,
        sha256,
      })),
      originals: await readJson<Manifest["originals"]>(
        env.BACKUPS,
        `${prefix}originals.json`,
      ),
      checksums: {
        "database.sql": sql.sha256,
        "wrangler-source.jsonc": sha256(build.source.raw),
      },
    };
    await env.BACKUPS.put(key, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  await env.DB.prepare(
    "UPDATE backup_runs SET state='complete', finished_at=?, error=NULL, originals=?, database_bytes=? WHERE snapshot=?",
  )
    .bind(
      Date.parse(manifest.completedAt),
      manifest.originals.length,
      sql.bytes,
      request.snapshot,
    )
    .run();
  return {
    completedAt: manifest.completedAt,
    originals: manifest.originals.length,
  };
}

async function listAll(bucket: R2Bucket, options: R2ListOptions) {
  const objects: R2Object[] = [];
  const prefixes: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({ ...options, cursor });
    objects.push(...page.objects);
    prefixes.push(...page.delimitedPrefixes);
    if (!page.truncated) return { objects, prefixes };
    cursor = page.cursor;
  }
}

/** A delete Bucket Lock refuses is left for a later run. */
async function tryDelete(bucket: R2Bucket, key: string) {
  try {
    await bucket.delete(key);
    return true;
  } catch {
    return false;
  }
}

/**
 * Keep the newest `keep` complete snapshots and never the newest one, then
 * drop originals no kept snapshot names and this run's staging.
 */
export async function retain(
  env: Pick<BackupBindings, "BACKUPS">,
  snapshot: string,
  keep: number,
  now: number,
) {
  const { prefixes } = await listAll(env.BACKUPS, {
    prefix: "snapshots/",
    delimiter: "/",
  });
  const names = prefixes
    .map((prefix) => prefix.slice("snapshots/".length, -1))
    .filter((name) => SNAPSHOT.test(name))
    .sort()
    .reverse();
  const complete: string[] = [];
  for (const name of names)
    if (await env.BACKUPS.head(snapshotKey(name, "manifest.json")))
      complete.push(name);
  const kept = complete.slice(0, Math.max(1, keep));
  let deleted = 0;
  let locked = 0;
  for (const name of complete.slice(kept.length)) {
    const { objects } = await listAll(env.BACKUPS, {
      prefix: `snapshots/${name}/`,
    });
    const manifest = snapshotKey(name, "manifest.json");
    let removable = true;
    for (const object of objects)
      if (
        object.key !== manifest &&
        !(await tryDelete(env.BACKUPS, object.key))
      )
        removable = false;
    // The manifest goes last, so a snapshot stays complete or disappears.
    if (removable && (await tryDelete(env.BACKUPS, manifest))) deleted++;
    else locked++;
  }
  const referenced = new Set<string>();
  for (const name of kept) {
    const manifest = await readJson<Manifest>(
      env.BACKUPS,
      snapshotKey(name, "manifest.json"),
    );
    for (const file of manifest.originals) referenced.add(file.sha256);
  }
  let originalsDeleted = 0;
  const pool = await listAll(env.BACKUPS, { prefix: "originals/" });
  for (const object of pool.objects) {
    const hash = object.key.slice("originals/".length);
    // A young unreferenced original may belong to a run still in flight.
    if (
      referenced.has(hash) ||
      now - object.uploaded.getTime() < STALE_STAGING_MS
    )
      continue;
    if (await tryDelete(env.BACKUPS, object.key)) originalsDeleted++;
  }
  const staging = await listAll(env.BACKUPS, { prefix: "staging/" });
  for (const object of staging.objects)
    if (
      object.key.startsWith(`staging/${snapshot}/`) ||
      now - object.uploaded.getTime() > STALE_STAGING_MS
    )
      await tryDelete(env.BACKUPS, object.key);
  return { kept: kept.length, deleted, locked, originalsDeleted };
}

/** The whole run. A torn read starts a fresh attempt; anything else throws. */
export async function runBackup(
  env: BackupBindings,
  step: BackupStep,
  request: BackupRequest,
  build: BackupBuild,
  now: () => number = Date.now,
) {
  const { snapshot } = request;
  if (!SNAPSHOT.test(snapshot)) throw new Error("Invalid snapshot name");
  await step.do("start", () =>
    recordStart(env.DB, snapshot, Date.parse(request.startedAt)),
  );
  let assembled: { sha256: string; bytes: number; originals: number } | null =
    null;
  let prefix = "";
  let reason = "";
  for (let attempt = 1; attempt <= ATTEMPTS && !assembled; attempt++) {
    prefix = stagingPrefix(snapshot, attempt);
    const plans = await step.do(`plan ${attempt}`, () =>
      plan(env, build.migrations, attempt, snapshot),
    );
    const counts: Record<string, number> = {};
    for (const table of readOrder(plans)) {
      let after = 0;
      let index = 0;
      for (;;) {
        const page = await step.do(`rows ${attempt} ${table} ${index}`, () =>
          readPage(env, prefix, table, after, index),
        );
        index++;
        if (page.next === null) break;
        after = page.next;
      }
      counts[table] = index;
    }
    const result = await step.do(`assemble ${attempt}`, () =>
      assemble(env, prefix, plans, counts),
    );
    if (result.ok) assembled = result;
    else {
      reason = result.reason;
      console.log(
        JSON.stringify({ event: "backup_torn", snapshot, attempt, reason }),
      );
      if (attempt < ATTEMPTS)
        await step.sleep(`torn ${attempt}`, TORN_RETRY_MS);
    }
  }
  if (!assembled)
    throw new Error(
      `Rows changed under the capture ${ATTEMPTS} times (${reason})`,
    );
  const sql = { sha256: assembled.sha256, bytes: assembled.bytes };
  for (let batch = 0; batch * ORIGINALS_PER_STEP < assembled.originals; batch++)
    await step.do(`originals ${batch}`, () =>
      copyOriginals(env, prefix, batch),
    );
  await step.do("store", () =>
    store(env, prefix, snapshot, sql, build.source.raw),
  );
  await step.do("verify", () => verify(env, prefix, snapshot, sql));
  const published = await step.do("publish", () =>
    publish(env, prefix, request, build, sql, now()),
  );
  const retention = await step.do("retention", () =>
    retain(env, snapshot, build.keep, now()),
  );
  return { snapshot, ...published, bytes: sql.bytes, retention };
}

/** `VALISE_BACKUP_KEEP`, 1–365 complete snapshots, default 30. */
export function keepCount(value: string | undefined): number {
  const keep = Number(value ?? 30);
  return Number.isInteger(keep) && keep >= 1 && keep <= 365 ? keep : 30;
}
