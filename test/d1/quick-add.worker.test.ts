import { describe, expect, it } from "vitest";
import { parseQuickAdd, suggestQuickAdd } from "~/concepts/quick-add";

describe("parseQuickAdd", () => {
  it("reads facets and #tags out of the title", () => {
    expect(
      parseQuickAdd("Fix ranking priority:1 #duckdb area:search for memories"),
    ).toEqual({
      title: "Fix ranking for memories",
      project: null,
      tags: ["priority:1", "duckdb", "area:search"],
    });
  });

  it("keeps prose that only looks like a facet in the title", () => {
    expect(
      parseQuickAdd("TODO:fix the https://x.dev link, note: soon"),
    ).toEqual({
      title: "TODO:fix the https://x.dev link, note: soon",
      project: null,
      tags: [],
    });
  });

  it("routes project: to the column, over the filter in view", () => {
    expect(parseQuickAdd("Ship it project:valise", "other")).toMatchObject({
      title: "Ship it",
      project: "valise",
      tags: [],
    });
    expect(parseQuickAdd("Ship it", "other")).toMatchObject({
      project: "other",
    });
  });

  it("reads @name as the project, and leaves addresses and punctuation", () => {
    expect(
      parseQuickAdd("Split the ideas list @valise #triage", "other"),
    ).toEqual({
      title: "Split the ideas list",
      project: "valise",
      tags: ["triage"],
    });
    expect(
      parseQuickAdd("Mail owner@example.com about @ notation @valise."),
    ).toEqual({
      title: "Mail owner@example.com about @ notation @valise.",
      project: null,
      tags: [],
    });
    expect(parseQuickAdd("Ship @valise project:valise")).toMatchObject({
      title: "Ship",
      project: "valise",
    });
  });

  it.each([
    ["Two @a @b", "contradicts"],
    ["Typed type:decision", "type: is reserved"],
    ["Moved state:done", "state: is reserved"],
    ["priority:1 #duckdb", "title"],
    ["Two project:a project:b", "contradicts"],
  ])("refuses %s", (line, message) => {
    const parsed = parseQuickAdd(line);
    expect(parsed).toHaveProperty("error");
    expect((parsed as { error: string }).error).toContain(message);
  });
});

describe("suggestQuickAdd", () => {
  const vocabulary = {
    tags: ["duckdb", "priority:1", "dune"],
    projects: ["valise", "vault"],
    facets: [
      { key: "priority", value: "1", tag: "priority:1", count: 12 },
      { key: "priority", value: "high", tag: "priority:high", count: 1 },
    ],
  };

  it("offers projects for @", () => {
    expect(suggestQuickAdd("@va", vocabulary)).toEqual([
      { insert: "@valise " },
      { insert: "@vault " },
    ]);
    expect(suggestQuickAdd("@vali", vocabulary)).toEqual([
      { insert: "@valise " },
    ]);
  });

  it("offers keys and tags for a bare word", () => {
    expect(suggestQuickAdd("pr", vocabulary)).toEqual([
      { insert: "priority:", hint: "2 values" },
      { insert: "project:", hint: "2 values" },
    ]);
    expect(suggestQuickAdd("du", vocabulary)).toEqual([
      { insert: "#duckdb " },
      { insert: "#dune " },
    ]);
    expect(suggestQuickAdd("d", vocabulary)).toEqual([]);
  });

  it("offers the values under a key, drift and counts included", () => {
    expect(suggestQuickAdd("priority:", vocabulary)).toEqual([
      { insert: "priority:1 ", hint: "12 to-dos" },
      { insert: "priority:high ", hint: "1 to-do" },
    ]);
    expect(suggestQuickAdd("project:va", vocabulary)).toEqual([
      { insert: "project:valise " },
      { insert: "project:vault " },
    ]);
  });

  it("offers only bare tags after #", () => {
    expect(suggestQuickAdd("#", vocabulary)).toEqual([
      { insert: "#duckdb " },
      { insert: "#dune " },
    ]);
  });
});
