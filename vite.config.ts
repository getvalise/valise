import { cloudflare } from "@cloudflare/vite-plugin";
import { reactRouter } from "@react-router/dev/vite";
import { defineConfig } from "vite";
import { backupSource } from "./scripts/backup-source.mjs";
import { vectorEvalConfig } from "./scripts/vector-eval-config";

const uiTest = process.env.VALISE_UI_TEST === "1";
const vectorEvalIndex = process.env.VALISE_VECTOR_EVAL_INDEX;
const vectorEvalNamespace = process.env.VALISE_VECTOR_EVAL_NAMESPACE;
if (vectorEvalIndex && process.env.VALISE_CONFIG)
  throw new Error("Choose VALISE_CONFIG or a vector eval config, not both");
if (
  vectorEvalIndex &&
  (!process.env.VALISE_STATE ||
    !vectorEvalNamespace ||
    vectorEvalIndex === "valise-memories-v1" ||
    vectorEvalNamespace === "valise-prod-v1")
)
  throw new Error(
    "Vector eval requires isolated VALISE_STATE, eval index and namespace; production resources are forbidden",
  );

/*
 * The scheduled backup records the deployed config and its resource identity
 * in every manifest, so restore can refuse the source. Read here, once, from
 * the config this build deploys. A config that names no D1/R2/KV gets none,
 * and the Workflow refuses to run. ADR-0019.
 */
function source(path: string) {
  try {
    return backupSource(path);
  } catch {
    return null;
  }
}

export default defineConfig({
  resolve: { tsconfigPaths: true },
  define: {
    __VALISE_BACKUP_SOURCE__: JSON.stringify(
      vectorEvalIndex
        ? null
        : source(process.env.VALISE_CONFIG ?? "wrangler.jsonc"),
    ),
  },
  plugins: [
    cloudflare({
      ...(process.env.VALISE_CONFIG && {
        configPath: process.env.VALISE_CONFIG,
      }),
      ...(vectorEvalIndex && {
        configPath: vectorEvalConfig(vectorEvalIndex, vectorEvalNamespace),
      }),
      viteEnvironment: { name: "ssr" },
      inspectorPort: uiTest ? false : undefined,
      remoteBindings: uiTest ? false : undefined,
      /*
       * The evals read the store live, so they get one of their own that a
       * Playwright run or a session in the console cannot add to.
       * `npm run evals:store` builds it; see evals/README.md.
       */
      persistState: process.env.VALISE_STATE
        ? { path: process.env.VALISE_STATE }
        : true,
      /*
       * ADR-0013's rerank experiment: `VALISE_RERANK=fts|hybrid npm run dev`
       * reranks the MCP `search` tool's results. Unset, the Worker config is
       * untouched, and the Workers Builds environment does not set it.
       */
      config: (worker) =>
        process.env.VALISE_RERANK ||
        vectorEvalIndex ||
        (uiTest && process.env.VALISE_UI_REGISTRY_URL)
          ? {
              vars: {
                ...worker.vars,
                ...(vectorEvalIndex && {
                  VALISE_VECTOR_NAMESPACE: vectorEvalNamespace,
                }),
                ...(process.env.VALISE_RERANK && {
                  VALISE_RERANK: process.env.VALISE_RERANK,
                }),
                ...(uiTest &&
                  process.env.VALISE_UI_REGISTRY_URL && {
                    SKILLS_REGISTRY_URL: process.env.VALISE_UI_REGISTRY_URL,
                  }),
              },
            }
          : undefined,
    }),
    reactRouter(),
  ],
  /*
   * Pre-bundle at server start what Vite would otherwise discover on the
   * first request to /memories. Mid-session discovery re-optimizes and
   * reloads every open page, which on CI's cold cache destroyed Playwright's
   * evaluation context partway through the viewport sweep.
   */
  optimizeDeps: { include: ["react-markdown", "remark-gfm"] },
});
