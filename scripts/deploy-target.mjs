import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import ts from "typescript";

function target(config) {
  return {
    name: config.name,
    account: config.account_id,
    origin: config.vars?.APP_ORIGIN,
    resource: config.vars?.MCP_RESOURCE_URL,
    db: config.d1_databases?.map(({ binding, database_id }) => ({
      binding,
      database_id,
    })),
    r2: config.r2_buckets?.map(({ binding, bucket_name }) => ({
      binding,
      bucket_name,
    })),
    kv: config.kv_namespaces?.map(({ binding, id }) => ({ binding, id })),
  };
}

/** A different/stale Vite build must not migrate one installation and deploy another. */
export function validateDeployTarget(source, built, origin) {
  if (
    !source.name ||
    !source.account_id ||
    !source.vars?.APP_ORIGIN ||
    origin !== source.vars.APP_ORIGIN ||
    source.vars.MCP_RESOURCE_URL !== `${origin}/mcp` ||
    !isDeepStrictEqual(target(source), target(built))
  )
    throw new Error(
      "deploy: build, VALISE_CONFIG and VALISE_ORIGIN must name the same installation; rebuild with VALISE_CONFIG before retrying",
    );
}

if (
  process.argv[1] &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url
) {
  try {
    const { config, error } = ts.parseConfigFileTextToJson(
      process.env.VALISE_CONFIG,
      readFileSync(process.env.VALISE_CONFIG, "utf8"),
    );
    if (error) throw new Error("Invalid selected configuration");
    validateDeployTarget(
      config,
      JSON.parse(readFileSync("build/server/wrangler.json", "utf8")),
      process.env.VALISE_ORIGIN,
    );
  } catch {
    console.error(
      "deploy: build, VALISE_CONFIG and VALISE_ORIGIN must name the same installation; rebuild with VALISE_CONFIG before retrying",
    );
    process.exitCode = 1;
  }
}
