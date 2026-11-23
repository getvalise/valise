import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "~": path.resolve("app") } },
  test: {
    // The 5 s default failed tests that take 0.1 s alone on a busy machine.
    testTimeout: 30_000,
    environment: "node",
    // The eval index is a Node script too, with nothing of the Worker in it.
    include: ["test/clients/**/*.test.ts", "test/evals/**/*.test.ts"],
  },
});
