import { availableParallelism } from "node:os";
import { defineConfig } from "@playwright/test";

/*
 * Every worker starts its own server on the production build, with its own
 * port and store (test/ui/fixtures/session.ts). Workers never share rows and
 * concurrent worktrees never share a port, so tests spread across workers
 * freely; within a worker they run one at a time. VALISE_TEST_WORKERS
 * overrides the count.
 */
const workers =
  Number(process.env.VALISE_TEST_WORKERS) ||
  Math.max(1, Math.floor(availableParallelism() / 2));

export default defineConfig({
  testDir: "./test/ui",
  globalSetup: "./test/ui/global-setup.ts",
  workers,
  fullyParallel: true,
  use: {
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
});
