import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import ts from "typescript";

/** The installation a Wrangler config names, as recovery identifies it. */
export async function installation(path) {
  return parseInstallation(path, await readFile(path, "utf8"));
}

function parseInstallation(path, raw) {
  const { config, error } = ts.parseConfigFileTextToJson(path, raw);
  if (error) throw new Error("Invalid Wrangler configuration");
  const database = config.d1_databases?.find((b) => b.binding === "DB");
  const bucket = config.r2_buckets?.find((b) => b.binding === "BUNDLES");
  const kv = config.kv_namespaces?.find((b) => b.binding === "OAUTH_KV");
  if (!config.name || !database?.database_id || !bucket?.bucket_name || !kv?.id)
    throw new Error(
      "Config must name Worker, DB, BUNDLES and OAUTH_KV resources",
    );
  if (
    resolve(dirname(path), database.migrations_dir ?? "migrations") !==
    resolve("drizzle")
  )
    throw new Error(
      "Run from the release checkout with DB migrations_dir pointing to its drizzle directory",
    );
  return {
    raw,
    config,
    identity: {
      worker: config.name,
      account: config.account_id ?? null,
      database: database.database_id,
      bucket: bucket.bucket_name,
      kv: kv.id,
      vectorNamespace: config.vars?.VALISE_VECTOR_NAMESPACE ?? null,
    },
  };
}

/**
 * What the scheduled backup records as its source, fixed at build time from
 * the config the build deploys: the raw config, its resource identity and the
 * Git revision. Restore refuses these resources as a destination. ADR-0019.
 */
export function backupSource(path) {
  const { raw, identity } = parseInstallation(
    resolve(path),
    readFileSync(path, "utf8"),
  );
  let revision = process.env.WORKERS_CI_COMMIT_SHA ?? null;
  try {
    revision ??= execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {}
  return { raw, identity, revision };
}
