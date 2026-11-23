import { existsSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("adds unpublished 0039 after its immediate predecessor without rewriting released migration history", () => {
  const read = (name: string) =>
    JSON.parse(readFileSync(`drizzle/meta/${name}`, "utf8"));
  const processing = read("0039_snapshot.json");
  const expiry = read("0031_snapshot.json");
  const journal = read("_journal.json");
  const predecessor = journal.entries
    .filter((entry: { idx: number }) => entry.idx < 39)
    .at(-1);
  const previous = read(
    `${String(predecessor.idx).padStart(4, "0")}_snapshot.json`,
  );
  expect(processing.prevId).toBe(previous.id);
  expect(expiry.prevId).toBe(read("0028_snapshot.json").id);
  expect(existsSync("drizzle/0030_asset_processing.sql")).toBe(false);
  expect(
    journal.entries
      .filter((entry: { idx: number }) => entry.idx === 39)
      .map((entry: { tag: string }) => entry.tag),
  ).toEqual(["0039_asset_processing"]);
  expect(processing.tables.users.columns.verification_expires_at).toBeDefined();
  expect(expiry.tables.users.columns.verification_expires_at).toBeDefined();
  for (const table of [
    "asset_processing",
    "asset_processing_outputs",
    "asset_processing_heads",
    "asset_suggestion_decisions",
    "asset_processing_admissions",
    "asset_vector_pending",
  ]) {
    expect(expiry.tables[table]).toBeUndefined();
    expect(processing.tables[table].columns.user_id.notNull).toBe(true);
    expect(processing.tables[table].columns.user_id.default).toBeUndefined();
  }
  expect(
    processing.tables.skills.indexes.skills_user_name_unique.columns,
  ).toEqual(["user_id", "name"]);
  for (const [name, table] of Object.entries(previous.tables)) {
    expect(processing.tables[name]).toEqual(table);
  }
  expect(
    processing.tables.asset_processing_admissions.columns.attempts.default,
  ).toBe(0);
  expect(
    processing.tables.asset_processing_admissions.columns.lease_until.default,
  ).toBe(0);
  expect(processing.tables.asset_processing_admissions.foreignKeys).toEqual({});
});
