import path from "node:path";
import {
  cloudflareTest,
  readD1Migrations,
} from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";
import { backupSource } from "./scripts/backup-source.mjs";

export default defineConfig({
  resolve: {
    alias: { "~": path.resolve("app") },
  },
  // What a production build fixes into the bundle for the backup manifest.
  define: {
    __VALISE_BACKUP_SOURCE__: JSON.stringify(backupSource("wrangler.jsonc")),
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
          VALISE_ADMIN_PASSWORD: "local-test-password-for-oauth",
          SESSION_SECRET: "local-test-session-secret",
          TOKEN_PEPPER: "local-test-token-pepper",
          // Empty over whatever `.dev.vars` holds, so no test reaches
          // TypeSafe; the rerank tests pass a key and stub `fetch`.
          TYPESAFE_API_KEY: "",
          // The generic transport suite exercises lexical/Jev contracts without
          // remote AI. Hybrid paths pass their explicit service doubles.
          VALISE_RERANK: "jev",
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
    include: ["test/mcp/**/*.worker.test.ts"],
    setupFiles: ["./test/d1/apply-migrations.ts"],
  },
});
