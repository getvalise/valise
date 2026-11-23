import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { listMemoryRevisions } from "~/concepts/memories";
import { changeMemoryLink, listMemoryLinks } from "~/concepts/memory-links";
import { callMcp } from "./fixture-worker";

const db = env.DB;
afterEach(async () => {
  for (const table of [
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
    "mcp_calls",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});
async function tool(name: string, args: Record<string, unknown>) {
  return (await callMcp("tools/call", { name, arguments: args }, "model-a"))
    .value.result;
}
async function save(title: string, relates?: unknown) {
  const result = await tool("save_memory", {
    title,
    body: "Original",
    type: "fact",
    tags: ["tests"],
    project: "valise",
    relates,
  });
  expect(result.isError).not.toBe(true);
  const id = result.structuredContent?.id;
  if (typeof id !== "string") throw new Error("Save returned no id");
  return id;
}

describe("MCP memory editing", () => {
  it("edits supplied fields, records model provenance, and clears project", async () => {
    const id = await save("Original title");
    const result = await tool("edit_memory", {
      id,
      body: "New claim",
      project: null,
      tags: ["changed"],
      type: "decision",
    });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      title: "Original title",
      text: "New claim",
      metadata: { type: "decision", project: null, tags: ["changed"] },
    });
    expect(
      (await listMemoryRevisions(db, "local", id.slice(7)))[0],
    ).toMatchObject({
      title: "Original title",
      body: "Original",
      createdBy: "model-a",
    });
    const call = await db
      .prepare(
        "SELECT required_scope, target_id FROM mcp_calls WHERE tool = 'edit_memory'",
      )
      .first();
    expect(call).toEqual({ required_scope: "memories:write", target_id: id });
  });

  it("links on save and edit without giving MCP confirmation authority", async () => {
    const a = await save("Parent");
    const b = await save("Child", [{ id: a, kind: "part-of" }]);
    const saved = await tool("fetch", { id: b });
    expect(saved.structuredContent?.metadata).toMatchObject({
      links: [
        { id: a, kind: "part-of", confirmed: false, asserted_by: "model" },
      ],
    });
    const result = await tool("edit_memory", {
      id: b,
      relates: [{ id: a, kind: "related" }],
      asserted_by: "person",
      confirmed: true,
    });
    expect(result.isError).not.toBe(true);
    expect(await listMemoryRevisions(db, "local", b.slice(7))).toEqual([]);
    const links = await listMemoryLinks(db, "local", b.slice(7));
    expect(links).toHaveLength(2);
    expect(
      links.every((link) => !link.confirmed && link.asserted_by === "model"),
    ).toBe(true);
    const link = links.find((link) => link.kind === "related");
    if (!link) throw new Error("Missing related link");
    await changeMemoryLink(env, b.slice(7), link.link_id, "remove", "local");
    const retried = await tool("edit_memory", {
      id: b,
      relates: [{ id: a, kind: "related" }],
    });
    expect(retried.structuredContent?.metadata).toMatchObject({
      removed_links: [
        expect.objectContaining({
          id: a,
          kind: "related",
          removed_at: expect.any(Number),
        }),
      ],
    });
    expect(
      (await tool("fetch", { id: b })).structuredContent?.metadata,
    ).toMatchObject({ links: [expect.objectContaining({ kind: "part-of" })] });
  });

  it("rejects empty edits, malformed links and missing targets without editing", async () => {
    const id = await save("Original");
    for (const args of [
      { id },
      { id, relates: [] },
      { id, relates: [{ id: "todo:no", kind: "related" }] },
      { id, relates: [{ id, kind: "invented" }] },
      {
        id,
        title: "Wrong",
        relates: [{ id: "memory:missing", kind: "related" }],
      },
    ]) {
      expect((await tool("edit_memory", args)).isError).toBe(true);
    }
    expect((await tool("fetch", { id })).structuredContent?.title).toBe(
      "Original",
    );
    expect(await listMemoryRevisions(db, "local", id.slice(7))).toEqual([]);
  });

  it("routes reserved facet edits and refuses a project tag that conflicts with clearing project", async () => {
    const id = await save("Facets");
    const edited = await tool("edit_memory", {
      id,
      tags: ["type:insight", "project:other", "topic"],
    });
    expect(edited.structuredContent?.metadata).toMatchObject({
      type: "insight",
      project: "other",
      tags: ["topic"],
    });
    expect(
      (
        await tool("edit_memory", {
          id,
          project: null,
          tags: ["project:other"],
        })
      ).isError,
    ).toBe(true);
  });
});

describe("MCP embedding backlog feedback", () => {
  afterEach(async () => {
    for (const table of [
      "vector_deferred",
      "vector_pending",
      "vector_snapshots",
    ])
      await db.prepare(`DELETE FROM ${table}`).run();
  });
  const capped = { VALISE_VECTOR_BACKLOG_CAP: "1" } as Partial<Env>;
  async function cappedTool(name: string, args: Record<string, unknown>) {
    return (
      await callMcp(
        "tools/call",
        { name, arguments: args },
        "model-a",
        undefined,
        {},
        capped,
      )
    ).value.result;
  }
  const memory = (title: string) => ({
    title,
    body: "A claim",
    type: "fact",
    tags: ["tests"],
  });

  it("saves at the cap and says only semantic indexing waits", async () => {
    const first = await cappedTool("save_memory", memory("First"));
    expect(first.structuredContent?.metadata).not.toHaveProperty(
      "vector_indexing",
    );
    const second = await cappedTool("save_memory", memory("Second"));
    expect(second.isError).not.toBe(true);
    expect(second.structuredContent?.metadata).toMatchObject({
      vector_indexing: { state: "deferred", outstanding: 1, cap: 1 },
    });
    const edited = await cappedTool("edit_memory", {
      id: second.structuredContent?.id,
      body: "A sharper claim",
    });
    expect(edited.isError).not.toBe(true);
    expect(edited.structuredContent).toMatchObject({
      text: "A sharper claim",
      metadata: {
        vector_indexing: { state: "deferred", outstanding: 1, cap: 1 },
      },
    });
  });
});
