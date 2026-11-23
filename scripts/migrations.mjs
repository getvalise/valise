#!/usr/bin/env node
/**
 * Decide which migrations a deploy is allowed to apply on its own.
 *
 * A migration that only adds things is safe to apply ahead of the code that
 * needs it: the running Worker ignores a column it does not read, so the
 * schema can land first and the deploy that follows finds it there. A
 * migration that drops or renames is not, because no single ordering is
 * correct — the old code breaks the moment the rename lands, and the new code
 * breaks until it does. That one is two merges and a person, which is the rule
 * ADR-0008 keeps from ADR-0001's era.
 *
 * A non-additive migration declares itself with a marker on its own line:
 *
 *     -- valise:by-hand drops skills.legacy_slug, see V1-23
 *
 * The marker is what `audit` demands and what `apply` refuses, so the decision
 * is written in the migration rather than remembered at merge time.
 *
 *   node scripts/migrations.mjs audit [dir]   classify every file, exit 1 on an
 *                                             undeclared non-additive statement
 *   node scripts/migrations.mjs apply         apply what is pending on the
 *                                             remote D1, exit 2 if anything
 *                                             pending needs a person
 *
 * `audit` runs offline and is part of `npm run verify`. `apply` talks to the
 * remote database and belongs to the deploy, through `scripts/deploy.sh`.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;
const BINDING = "DB";
const CONFIG_ARGS = process.env.VALISE_CONFIG
  ? ["--config", process.env.VALISE_CONFIG]
  : [];
const MARKER = /^\s*--\s*valise:by-hand\b(.*)$/im;

/**
 * Heads that only add. Everything else needs a person, including anything this
 * list does not recognise, so a statement shape nobody thought about fails
 * closed rather than running itself on production.
 */
const ADDITIVE = [
  /^CREATE\s+(TABLE|VIEW|TRIGGER|VIRTUAL\s+TABLE)\b/,
  /^CREATE\s+(UNIQUE\s+)?INDEX\b/,
  /^ALTER\s+TABLE\s+\S+\s+ADD\b/,
  /^INSERT\s+INTO\b/,
];

/**
 * drizzle-kit separates statements with its own marker, which is the only
 * split that survives a trigger body: `CREATE TRIGGER ... BEGIN ... END;`
 * holds semicolons and holds the word DELETE, and splitting on either would
 * read the body as a statement of its own. A trigger is classified by its
 * head; what it does when it fires is runtime behaviour, not a migration.
 */
function statements(sql) {
  return sql
    .split("--> statement-breakpoint")
    .map((chunk) =>
      chunk
        .split("\n")
        .filter((line) => !/^\s*--/.test(line))
        .join("\n")
        .replace(/\s+/g, " ")
        .replace(/;\s*$/, "")
        .trim(),
    )
    .filter(Boolean);
}

/** Every statement in `sql` that the deploy may not run by itself. */
function nonAdditive(sql) {
  return statements(sql).filter(
    (statement) => !ADDITIVE.some((head) => head.test(statement.toUpperCase())),
  );
}

function classify(dir = "drizzle") {
  const from = isAbsolute(dir) ? dir : join(ROOT, dir);
  return readdirSync(from)
    .filter((name) => name.endsWith(".sql"))
    .sort()
    .map((name) => {
      const sql = readFileSync(join(from, name), "utf8");
      const marked = MARKER.exec(sql);
      return {
        name,
        blocking: nonAdditive(sql),
        byHand: marked !== null,
        reason: marked?.[1].trim() ?? "",
      };
    });
}

function audit(dir) {
  const files = classify(dir);
  const undeclared = files.filter((f) => f.blocking.length > 0 && !f.byHand);
  for (const file of files) {
    const mark = file.byHand
      ? "by-hand"
      : file.blocking.length
        ? "UNDECLARED"
        : "additive";
    console.log(
      `${file.name}  ${mark}${file.reason ? `  ${file.reason}` : ""}`,
    );
    for (const statement of file.blocking) {
      console.log(`    ${statement.slice(0, 100)}`);
    }
  }
  if (undeclared.length === 0) {
    const byHand = files.filter((f) => f.byHand).length;
    console.log(
      `\nmigrations: ${files.length} files, ${byHand} declared by-hand, the rest additive`,
    );
    return 0;
  }
  console.error(
    `\nmigrations: ${undeclared.length} file(s) drop, rename, or rewrite without saying so.\n` +
      "The deploy applies additive migrations only. Either generate an additive\n" +
      "migration instead, or put the decision in the file and plan the two merges:\n\n" +
      "    -- valise:by-hand <what it does and why it cannot wait for the deploy>\n",
  );
  return 1;
}

/** Migration names the remote database has already run. */
function applied() {
  const out = execFileSync(
    "npx",
    [
      "wrangler",
      ...CONFIG_ARGS,
      "d1",
      "execute",
      BINDING,
      "--remote",
      "--json",
      "--command",
      "select name from d1_migrations order by id;",
    ],
    { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
  );
  return new Set(
    JSON.parse(out)
      .flatMap((r) => r.results)
      .map((row) => row.name),
  );
}

function apply() {
  const done = applied();
  const pending = classify().filter((file) => !done.has(file.name));
  if (pending.length === 0) {
    console.log("migrations: remote is up to date");
    return 0;
  }

  // Marked by-hand, or non-additive and never declared, which `audit` should
  // have stopped at review time. Either way the deploy does not run it.
  const blocked = pending.filter(
    (file) => file.byHand || file.blocking.length > 0,
  );
  if (blocked.length > 0) {
    console.error(
      "migrations: pending migrations this deploy may not apply.\n" +
        `${blocked.map((f) => `    ${f.name}  ${f.reason || f.blocking[0]}`).join("\n")}\n\n` +
        "Run `npm run db:migrate:prod`, then rerun the build. Production keeps\n" +
        "serving the code it has until then, which is the point of stopping here.",
    );
    return 2;
  }

  console.log(`migrations: applying ${pending.map((f) => f.name).join(", ")}`);
  execFileSync(
    "npx",
    [
      "wrangler",
      ...CONFIG_ARGS,
      "d1",
      "migrations",
      "apply",
      BINDING,
      "--remote",
    ],
    {
      cwd: ROOT,
      stdio: "inherit",
    },
  );
  return 0;
}

const [command, dir] = process.argv.slice(2);
if (command === "audit") process.exit(audit(dir));
else if (command === "apply") process.exit(apply());
else {
  console.error("usage: node scripts/migrations.mjs audit [dir] | apply");
  process.exit(64);
}
