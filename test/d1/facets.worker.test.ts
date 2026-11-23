import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { listFacets, parseFacet, routeReservedTags } from "~/concepts/facets";
import { filtersFromRequest, listHref, withTag } from "~/concepts/list-filters";
import { listMemories, saveMemory } from "~/concepts/memories";

const db = env.DB;

afterEach(async () => {
  for (const table of ["search_docs", "memory_revisions", "memories"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("parseFacet", () => {
  it.each([
    ["priority:1", { key: "priority", value: "1" }],
    ["area:search", { key: "area", value: "search" }],
    ["sprint_no:12", { key: "sprint_no", value: "12" }],
    // The first colon splits, so a URL value survives whole.
    ["url:https://example.com", { key: "url", value: "https://example.com" }],
  ])("reads %s as a facet", (tag, facet) => {
    expect(parseFacet(tag)).toEqual(facet);
  });

  it.each([
    "duckdb",
    "TODO:fix",
    "https://example.com",
    "priority:",
    "priority: 1",
    "two words:x",
    ":x",
    "1st:x",
  ])("keeps %s a plain tag", (tag) => {
    expect(parseFacet(tag)).toBeNull();
  });
});

describe("routeReservedTags", () => {
  it("moves a reserved facet to its column and keeps the rest", () => {
    expect(
      routeReservedTags(["project:valise", "priority:1", "duckdb"], {
        project: undefined,
      }),
    ).toEqual({
      tags: ["priority:1", "duckdb"],
      routed: { project: "valise" },
    });
  });

  it("drops a facet that agrees with its explicit argument", () => {
    expect(
      routeReservedTags(["project:valise"], { project: "valise" }),
    ).toEqual({ tags: [], routed: { project: "valise" } });
  });

  it("rejects a facet that contradicts its explicit argument", () => {
    expect(routeReservedTags(["project:other"], { project: "valise" })).toEqual(
      { error: expect.stringContaining("contradicts project") },
    );
  });

  it("rejects a reserved key with no column here", () => {
    expect(routeReservedTags(["state:done"], { project: "valise" })).toEqual({
      error: expect.stringContaining("state: is reserved"),
    });
  });
});

describe("list filters", () => {
  it("routes a reserved facet typed into the tag box to its column", () => {
    expect(
      filtersFromRequest(new Request("https://x/memories?tag=project:valise")),
    ).toEqual({ project: "valise" });
    expect(
      filtersFromRequest(new Request("https://x/memories?tag=type:decision")),
    ).toEqual({ type: "decision" });
    expect(
      filtersFromRequest(new Request("https://x/memories?tag=priority:1")),
    ).toMatchObject({ tags: ["priority:1"] });
  });

  it("reads repeated tags as a set, and writes them back the same way", () => {
    const filters = filtersFromRequest(
      new Request(
        "https://x/todos?tag=duckdb&tag=project:valise&tag=&tag=DuckDB&tag=priority:1",
      ),
    );
    expect(filters).toMatchObject({
      project: "valise",
      tags: ["duckdb", "priority:1"],
    });
    expect(listHref("/todos", filters)).toBe(
      "/todos?project=valise&tag=duckdb&tag=priority%3A1",
    );
    // A chip adds its tag, once.
    expect(withTag(filters, "area:search").tags).toEqual([
      "duckdb",
      "priority:1",
      "area:search",
    ]);
    expect(withTag(filters, "DUCKDB")).toBe(filters);
  });

  it("lists only the rows carrying every tag asked for", async () => {
    const provenance = {
      userId: "local",
      agent: "vitest",
      client: "test",
      session: null,
    };
    for (const tags of [["duckdb", "priority:1"], ["duckdb"], ["priority:1"]]) {
      await saveMemory(
        env,
        { type: "fact", title: tags.join(" + "), body: "b", tags },
        provenance,
      );
    }
    const titles = async (tags?: string[]) =>
      (await listMemories(db, "local", { tags }))
        .map((row) => row.title)
        .sort();

    expect(await titles()).toHaveLength(3);
    expect(await titles(["DuckDB"])).toEqual(["duckdb", "duckdb + priority:1"]);
    expect(await titles(["duckdb", "priority:1"])).toEqual([
      "duckdb + priority:1",
    ]);
    expect(await titles(["duckdb", "absent"])).toEqual([]);
  });
});

describe("listFacets", () => {
  it("counts each facet as written, drift included, and skips plain tags", async () => {
    const provenance = {
      userId: "local",
      agent: "vitest",
      client: "test",
      session: null,
    };
    for (const tags of [
      ["priority:1", "duckdb"],
      ["priority:1", "TODO:fix"],
      ["priority:high"],
    ]) {
      await saveMemory(
        env,
        { type: "fact", title: tags.join(" "), body: "b", tags },
        provenance,
      );
    }

    expect(await listFacets(db, "local", "memory")).toEqual([
      { key: "priority", value: "1", tag: "priority:1", count: 2 },
      { key: "priority", value: "high", tag: "priority:high", count: 1 },
    ]);
    expect(await listFacets(db, "local", "todo")).toEqual([]);
  });
});
