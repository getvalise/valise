import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("restores authoritative snapshots but discards index acknowledgements, backfill checkpoints and drain leases", () => {
  const script = readFileSync("scripts/restore.sh", "utf8");
  const pattern = script.match(/^awk '(.+)' "\$dump" >> "\$rows"$/m)?.[1];
  if (!pattern) throw new Error("restore filter not found");
  const rows = execFileSync("awk", [pattern], {
    encoding: "utf8",
    input: [
      'INSERT INTO "vector_pending" VALUES (1);',
      "INSERT INTO `vector_backfills` VALUES (1);",
      "INSERT INTO vector_backfills VALUES (2);",
      'INSERT INTO "vector_drain_state" VALUES (1);',
      "INSERT INTO `vector_drain_state` VALUES (2);",
      "INSERT INTO vector_drain_state VALUES (3);",
      'INSERT INTO "vector_snapshots" VALUES (1);',
      "INSERT INTO memories VALUES (1);",
    ].join("\n"),
  });
  expect(rows).not.toContain("vector_pending");
  expect(rows).not.toContain("vector_backfills");
  expect(rows).not.toContain("vector_drain_state");
  expect(rows).toContain("vector_snapshots");
  expect(rows).toContain("memories");
});
