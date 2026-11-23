import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: { "~": path.resolve("app") },
  },
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: "./wrangler.jsonc" },
      // The AI binding is remote-only. No test calls it, and a CI runner has
      // no Cloudflare login to proxy it with.
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.resolve("drizzle")),
          // `verify` measures retrieval at 50 memories. A larger store is a
          // run on demand, evals/README.md "Retrieval at scale".
          RETRIEVAL_SIZES: process.env.RETRIEVAL_SIZES ?? "50",
        },
      },
    })),
  ],
  test: {
    // verify runs the d1 and mcp suites at once, so each takes half the
    // cores rather than all of them. The 5 s default still failed a
    // pagination test that takes 0.1 s alone when the machine was busy.
    maxWorkers: "50%",
    testTimeout: 30_000,
    include: ["test/d1/**/*.worker.test.ts"],
    setupFiles: ["./test/d1/apply-migrations.ts"],
  },
});
