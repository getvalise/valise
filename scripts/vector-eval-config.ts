import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

/** Generated local-only config: remote-binding discovery precedes Vite's config hook. */
export function vectorEvalConfig(index: string, namespace: string | undefined) {
  if (
    !index.startsWith("valise-rollout-eval-") ||
    !namespace?.startsWith("rollout-eval-")
  )
    throw new Error("Only rollout eval indexes/namespaces are allowed");
  const { config, error } = ts.parseConfigFileTextToJson(
    "wrangler.jsonc",
    readFileSync("wrangler.jsonc", "utf8"),
  );
  if (error) throw new Error("Invalid source Wrangler configuration");
  config.main = resolve(config.main);
  config.vectorize = [
    { binding: "VECTOR_INDEX", index_name: index, remote: true },
  ];
  config.vars.VALISE_VECTOR_NAMESPACE = namespace;
  config.ai.remote = true;
  for (const db of config.d1_databases)
    db.migrations_dir = resolve(db.migrations_dir);
  mkdirSync(".wrangler", { recursive: true });
  // Wrangler resolves .dev.vars beside its config. Keep secrets out of this file.
  const key = createHash("sha256")
    .update(JSON.stringify([index, namespace]))
    .digest("hex")
    .slice(0, 12);
  const path = resolve(`.wrangler/vector-eval-${key}.jsonc`);
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
  return path;
}
