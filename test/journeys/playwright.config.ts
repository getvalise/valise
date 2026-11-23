import { defineConfig } from "@playwright/test";

/*
 * Journey acceptance runs (docs/testing/user-journeys.md), signed in as a
 * non-admin member with real bearer-token MCP clients. Not part of `verify`:
 * the same specs run against a local build or a deployed origin, and a
 * deployed run writes synthetic rows a person must approve.
 *
 *   npx playwright test -c test/journeys            # local build, seeded members
 *   JOURNEY_ORIGIN=https://app.valise.run \
 *   JOURNEY_A_EMAIL=… JOURNEY_A_PASSWORD=… \
 *   npx playwright test -c test/journeys j3          # deployed, member A only
 *
 * Evidence lands in docs/testing/evidence/<journey>/<label>/, the label being
 * `local` or the origin's host.
 */
export default defineConfig({
  testDir: ".",
  testMatch: /.*\.journey\.ts$/,
  globalSetup: "./setup.ts",
  workers: 1,
  fullyParallel: false,
  timeout: 180_000,
  use: {
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
