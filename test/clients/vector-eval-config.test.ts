import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { vectorEvalConfig } from "../../scripts/vector-eval-config";

describe("vector eval resource isolation", () => {
  it("rejects production in the provider scope contract before invoking Wrangler", async () => {
    await expect(
      promisify(execFile)(process.execPath, [
        "scripts/vector-scope-contract.mjs",
        "valise-memories-v1",
      ]),
    ).rejects.toThrow("explicit disposable eval index required");
  });
  it.each([
    ["valise-memories-v1", "rollout-eval-test"],
    ["valise-rollout-eval-test", "valise-prod-v1"],
    ["valise-rollout-eval-test", undefined],
    ["someone-elses-index", "rollout-eval-test"],
  ])(
    "rejects non-eval index %s and namespace %s before writing config",
    (index, namespace) => {
      expect(() => vectorEvalConfig(index ?? "", namespace)).toThrow(
        "Only rollout eval",
      );
    },
  );
});
