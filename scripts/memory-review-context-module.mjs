import { resolve } from "node:path";
import { build } from "esbuild";

/** One graph: validation and reporting must share the same ReviewFailure class. */
export async function loadReviewComparisonModule() {
  const built = await build({
    stdin: {
      contents:
        'export { validateReviewProposal } from "./app/concepts/memory-review.ts"; export * from "./app/concepts/memory-review-model.ts";',
      resolveDir: resolve("."),
      sourcefile: "memory-review-context-entry.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    alias: { "~": resolve("app") },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`
  );
}
