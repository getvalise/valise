import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { build } from "esbuild";
import {
  checkTables,
  insert,
  inventory,
  quote,
  TABLES,
} from "./recovery-policy.mjs";

export {
  checkTables,
  insert,
  literal,
  OMITTED,
  quote,
  TABLES,
} from "./recovery-policy.mjs";

export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function migrations() {
  return Promise.all(
    (await readdir("drizzle"))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map(async (name) => {
        const sql = await readFile(`drizzle/${name}`, "utf8");
        return { name, sha256: digest(sql), sql };
      }),
  );
}

export function openDump(sql) {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    db.exec(sql);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

/** Inventory comes from the D1 snapshot, never a later query of live heads. */
export function originals(db) {
  return inventory(
    db.prepare("SELECT r2_key, size, sha256, content_type FROM objects").all(),
    db.prepare("SELECT files_json FROM skill_versions").all(),
  ).map((entry) => ({ ...entry, file: `files/${digest(entry.key)}` }));
}

export function restoredRow(table, row) {
  const result = { ...row };
  if (table === "users") {
    result.verification_token = null;
    result.verification_expires_at = null;
  }
  if (table === "assets") {
    result.upload_token_digest = null;
    result.upload_expires_at = null;
    if (result.state === "pending") {
      result.state = "failed";
      result.failure =
        "Interrupted upload; restored without transfer credentials";
    }
  }
  if (table === "todos") {
    if (
      !Number.isSafeInteger(result.fencing_token) ||
      result.fencing_token >= Number.MAX_SAFE_INTEGER - 1
    )
      throw new Error("Invalid fencing floor");
    result.fencing_token++;
    result.lease_holder = null;
    // Keep the state snapshot, but never replay its live lease. The fresh
    // coordinator adopts an expired claim and performs the next transition.
    result.lease_expires_at = result.state === "claimed" ? 0 : null;
  }
  if (table === "asset_processing" || table === "asset_processing_admissions") {
    if (
      !Number.isSafeInteger(result.attempts) ||
      result.attempts < 0 ||
      result.attempts > 3
    )
      throw new Error("Invalid processing attempt budget");
    result.lease_token = null;
    result.lease_until = 0;
    if (
      table === "asset_processing" &&
      ["queued", "running"].includes(result.state)
    ) {
      result.state = "failed";
      result.error_code = "restored_interrupted";
      result.finished_at = null;
    }
  }
  if (table === "memory_review_settings") {
    // A restored preference is not consent to transmit private text or incur
    // inference charges in a different installation, even if keys are configured.
    result.enabled = 0;
    result.overnight = 0;
    // Applying results without asking is part of the same consent (ADR-0012, 2026-11-04).
    if ("auto_apply" in result) result.auto_apply = 0;
    result.lock_token = null;
    result.lock_until = 0;
    result.next_run_at = 0;
  }
  if (table === "memory_review_ranking") {
    if (
      !Number.isSafeInteger(result.revision) ||
      result.revision < 0 ||
      result.revision >= Number.MAX_SAFE_INTEGER - 1
    )
      throw new Error("Invalid ranking permission revision");
    result.enabled = 0;
    result.revision++;
    result.manual_model = null;
  }
  if (table === "memory_review_groups" && result.state === "running") {
    // Retain sources, coverage, attempt count and reserved cost. There is no
    // provider request to resume; any remaining retry needs fresh user opt-in.
    result.state = "failed";
    result.retry_at = 0;
    result.error = [
      result.error,
      "Interrupted review; restored without an in-flight provider request. Enable reviews explicitly before retrying.",
    ]
      .filter(Boolean)
      .join("; ");
  }
  if (table === "todo_relation_fences") {
    // Preserve the owner but never replay a captured graph-operation token.
    // Deterministic transformation makes the backup's dry run and restore agree;
    // fresh Worker/DO/D1 identities, not this value, isolate old in-flight calls.
    result.token = `recovery:${digest(`${result.user_id}\0${result.token}`)}`;
  }
  return result;
}

function validateProcessingHistory(db) {
  const bad = db
    .prepare(`SELECT 1 FROM asset_processing p LEFT JOIN assets a
      ON a.asset_id = p.asset_id AND a.user_id = p.user_id WHERE a.asset_id IS NULL
    UNION ALL SELECT 1 FROM asset_processing_outputs o
      LEFT JOIN asset_processing p ON p.processing_id = o.processing_id AND p.asset_id = o.asset_id AND p.user_id = o.user_id
      LEFT JOIN assets a ON a.asset_id = o.asset_id AND a.user_id = o.user_id AND a.object_id = o.object_id
      LEFT JOIN objects b ON b.object_id = o.object_id AND b.user_id = o.user_id AND b.sha256 = o.original_sha256
      WHERE p.processing_id IS NULL OR a.asset_id IS NULL OR b.object_id IS NULL
    UNION ALL SELECT 1 FROM asset_processing_heads h LEFT JOIN asset_processing_outputs o
      ON o.processing_id = h.processing_id AND o.asset_id = h.asset_id AND o.user_id = h.user_id WHERE o.processing_id IS NULL
    UNION ALL SELECT 1 FROM asset_suggestion_decisions d LEFT JOIN asset_processing_outputs o
      ON o.processing_id = d.processing_id AND o.user_id = d.user_id WHERE o.processing_id IS NULL
    UNION ALL SELECT 1 FROM asset_processing_admissions r JOIN asset_processing p USING(processing_id)
      WHERE r.user_id <> p.user_id OR r.attempts <> p.attempts
    LIMIT 1`)
    .get();
  if (bad)
    throw new Error(
      "Processing history has inconsistent ownership, budget or original identity",
    );
}

export async function applicationModule(entry) {
  const output = await build({
    entryPoints: [resolve(entry)],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    alias: { "~": resolve("app") },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );
}

/** Discard only eligibility produced by loading a fresh destination's memories
 * and links. Then restore the exact captured queue, not a new all-memory review.
 */
export function beforeTableRestore(table) {
  // Asset INSERTs made singleton defaults. Replace them with the captured
  // containers/membership before restoring these two authoritative tables.
  if (table === "asset_folders")
    return ["DELETE FROM asset_folder_files;", "DELETE FROM asset_folders;"];
  return table === "memory_review_pending"
    ? ["DELETE FROM memory_review_pending;"]
    : [];
}

/** node:sqlite decodes TEXT only up to an embedded NUL. Read text as bytes
 * before serializing a snapshot so neither a restore nor its rehearsal drops
 * the remainder of an authoritative value. SQLite's own hex() sees all bytes.
 */
function recoveryRows(source, table) {
  const columns = source.prepare(`PRAGMA table_info(${quote(table)})`).all();
  const textColumns = columns.filter((c) => /TEXT|CHAR|CLOB/i.test(c.type));
  const textNames = new Set(textColumns.map((c) => c.name));
  const select = columns.map((c) =>
    textNames.has(c.name)
      ? `CAST(${quote(c.name)} AS BLOB) AS ${quote(c.name)}`
      : quote(c.name),
  );
  const decoder = new TextDecoder("utf-8", { fatal: true });
  return source
    .prepare(`SELECT ${select.join(", ")} FROM ${quote(table)}`)
    .all()
    .map((row) =>
      Object.fromEntries(
        Object.entries(row).map(([name, value]) => [
          name,
          textNames.has(name) && value !== null ? decoder.decode(value) : value,
        ]),
      ),
    );
}

/** Reuse the actual application's projection/reindex code, not a SQL copy. */
export async function recoverySql(source, schema) {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    for (const migration of schema) db.exec(migration.sql);
    checkTables(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    const statements = [];
    for (const table of TABLES) {
      for (const sql of beforeTableRestore(table)) {
        db.exec(sql);
        statements.push(sql);
      }
      for (const row of recoveryRows(source, table)) {
        const sql = insert(table, restoredRow(table, row));
        db.exec(sql);
        statements.push(sql);
      }
    }
    if (db.prepare("PRAGMA foreign_key_check").all().length)
      throw new Error("Recovery snapshot has broken foreign keys");
    validateProcessingHistory(db);
    const { reindex } = await applicationModule("app/search/reindex.ts");
    function prepare(sql, values = []) {
      return {
        bind: (...args) => prepare(sql, args),
        all: async () => ({ results: db.prepare(sql).all(...values) }),
        run: async () => db.prepare(sql).run(...values),
      };
    }
    await reindex({
      DB: { prepare, batch: (batch) => Promise.all(batch.map((s) => s.run())) },
    });
    for (const row of db.prepare("SELECT * FROM search_docs").all())
      statements.push(insert("search_docs", row));
    statements.push(
      "INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild');",
    );
    return `PRAGMA defer_foreign_keys=TRUE;\n${statements.join("\n")}\n`;
  } finally {
    db.close();
  }
}
