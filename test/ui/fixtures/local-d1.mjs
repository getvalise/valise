import { readdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/*
 * Fixture reads and writes on one Playwright worker's local D1, in-process.
 * `wrangler d1 execute --local` opened this same SQLite file from a second
 * process too, beside the running `wrangler dev`, but cost about 2 s of
 * startup a call on an idle machine and far more under parallel load.
 * The file is in WAL mode, so a short transaction here waits on, rather than
 * breaks, workerd's own.
 */

const BUSY_MS = 15_000;

/** The isolated Playwright state behind a UI test server's port, never a dev or remote store. */
function stateFor(baseURL) {
  const port = new URL(baseURL).port;
  if (!/^\d+$/.test(port)) throw new Error("Expected a UI test port");
  const descriptor = JSON.parse(
    readFileSync(resolve(".wrangler", `ui-test-state-${port}.json`), "utf8"),
  );
  if (
    !isAbsolute(descriptor.state) ||
    !basename(descriptor.state).startsWith("valise-playwright-")
  )
    throw new Error("Refuse non-test state");
  process.kill(descriptor.pid, 0);
  return descriptor.state;
}

function databaseFile(state) {
  const dir = join(state, "v3", "d1", "miniflare-D1DatabaseObject");
  const files = readdirSync(dir).filter(
    (name) => name.endsWith(".sqlite") && name !== "metadata.sqlite",
  );
  if (files.length !== 1)
    throw new Error(`Expected one local D1 database in ${dir}`);
  return join(dir, files[0]);
}

function withDatabase(baseURL, work) {
  const db = new DatabaseSync(databaseFile(stateFor(baseURL)), {
    timeout: BUSY_MS,
  });
  try {
    return work(db);
  } finally {
    db.close();
  }
}

/** Runs one or more statements in a single transaction, as one fixture step. */
export function localSql(baseURL, sql) {
  withDatabase(baseURL, (db) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(sql);
      db.exec("COMMIT");
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      throw error;
    }
  });
}

/** The rows of one SELECT. */
export function localQuery(baseURL, sql) {
  return withDatabase(baseURL, (db) =>
    db
      .prepare(sql)
      .all()
      .map((row) => ({ ...row })),
  );
}
