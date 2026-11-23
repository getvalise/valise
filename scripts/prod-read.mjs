#!/usr/bin/env node
// Runs one read-only query against the production D1 and prints its rows.
//
//   node scripts/prod-read.mjs "SELECT count(*) AS n FROM memories"
//
// Agents may read production; they may not write to it. `wrangler d1 execute
// --remote --command` runs every statement in its string, so no allow rule on
// that command can tell a read from `SELECT 1; DELETE FROM users`. This script
// is the thing an allow rule can name instead: it refuses anything but a
// single SELECT or WITH statement with no write keyword, before wrangler runs.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const DATABASE = "valise";
// The account that holds it; wrangler.jsonc names none, and this login sees several.
const ACCOUNT = "cf073c8346e14a9226d271688bb10ee5";

// Statement keywords that write, change the schema, or change the session.
// REPLACE alone is the string function; only REPLACE INTO is a write.
const WRITES =
  /\b(insert|update|delete|upsert|drop|alter|create|attach|detach|pragma|vacuum|reindex|analyze|begin|commit|rollback|savepoint|release)\b|\breplace\s+into\b/i;

/**
 * The query with literals and quoted identifiers blanked, so a keyword or a
 * semicolon inside a string cannot hide or fake a statement boundary.
 */
function blankQuoted(sql) {
  let out = "";
  for (let i = 0; i < sql.length; i++) {
    const open = sql[i];
    const close = { "'": "'", '"': '"', "`": "`", "[": "]" }[open];
    if (!close) {
      out += open;
      continue;
    }
    let j = i + 1;
    for (;;) {
      if (j >= sql.length) throw new Error(`unterminated ${open} in the query`);
      if (sql[j] === close) {
        // SQL escapes a quote by doubling it.
        if (close !== "]" && sql[j + 1] === close) {
          j += 2;
          continue;
        }
        break;
      }
      j++;
    }
    out += " ";
    i = j;
  }
  return out;
}

/** Returns the query to run, or throws saying why it is not a single read. */
export function readOnlySql(sql) {
  const query = String(sql ?? "").trim();
  if (!query) throw new Error("give one SELECT or WITH query");
  const bare = blankQuoted(query);
  if (/--|\/\*/.test(bare)) throw new Error("comments are not accepted");
  const body = bare.trimEnd().replace(/;$/, "");
  if (body.includes(";")) throw new Error("one statement only");
  if (!/^(select|with)\b/i.test(body.trimStart()))
    throw new Error("the query must start with SELECT or WITH");
  const write = WRITES.exec(body);
  if (write) throw new Error(`"${write[0]}" is not accepted in a read`);
  return query;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const args = process.argv.slice(2);
  if (args.length !== 1) {
    console.error('usage: node scripts/prod-read.mjs "SELECT ..."');
    process.exit(2);
  }
  let query;
  try {
    query = readOnlySql(args[0]);
  } catch (error) {
    console.error(`prod-read: refused, ${error.message}`);
    process.exit(2);
  }
  // No shell: the query reaches wrangler as one argument.
  try {
    execFileSync(
      "npx",
      [
        "wrangler",
        "d1",
        "execute",
        DATABASE,
        "--remote",
        "--json",
        "--command",
        query,
      ],
      {
        stdio: "inherit",
        env: { ...process.env, CLOUDFLARE_ACCOUNT_ID: ACCOUNT },
      },
    );
  } catch (error) {
    process.exit(error.status ?? 1);
  }
}
