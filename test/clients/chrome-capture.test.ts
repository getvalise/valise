import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("passes the isolated Chrome capture client suite", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--test",
      "--test-reporter=tap",
      "clients/chrome-extension/test/client.test.mjs",
      "clients/chrome-extension/test/oauth.test.mjs",
    ],
    { encoding: "utf8" },
  );
  expect(output).toContain("# fail 0");
}, 30_000);
