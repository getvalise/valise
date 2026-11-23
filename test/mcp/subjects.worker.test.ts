import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { callMcp } from "./fixture-worker";

const db = env.DB;
afterEach(async () => {
  for (const table of [
    "memory_subject_members",
    "memory_subjects",
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
    "mcp_calls",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

type ToolResult = {
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
};
async function tool(
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  return (await callMcp("tools/call", { name, arguments: args }, "model-a"))
    .value.result as ToolResult;
}
async function ok(name: string, args: Record<string, unknown>) {
  const result = await tool(name, args);
  expect(result.isError, JSON.stringify(result.content)).not.toBe(true);
  if (!result.structuredContent) throw new Error(`${name} returned nothing`);
  return result.structuredContent;
}
async function memory(title: string) {
  return (
    await ok("save_memory", {
      title,
      body: `evidence ${title}`,
      type: "fact",
      tags: ["subjects"],
    })
  ).id as string;
}

describe("MCP memory subjects", () => {
  it("runs the whole cycle: create, find, organize, summarize, delete, restore", async () => {
    const created = await ok("save_subject", {
      name: "vineyard",
      kind: "topic",
      description: "Workshop site",
    });
    expect(created).toMatchObject({ name: "vineyard", created: true });
    const id = created.id as string;
    expect(id).toMatch(/^subject:sub_/);

    // The 2026-11-03 retry gets the same subject back, not a second one.
    expect(
      await ok("save_subject", { name: " VineYard ", kind: "area" }),
    ).toMatchObject({ id, name: "vineyard", kind: "topic", created: false });
    expect(await ok("list_subjects", { name: "YARD" })).toMatchObject({
      subjects: [{ id, name: "vineyard", members: 0, summary: "missing" }],
      has_more: false,
    });

    const a = await memory("Deploys on Workers");
    const b = await memory("Uses React Router");
    const edited = await ok("edit_subject", {
      id,
      description: "Workshop site for friends",
      add_members: [a, b],
      new_summary: "A React Router app on Workers.",
    });
    expect(edited).toMatchObject({
      id,
      title: "vineyard",
      text: "A React Router app on Workers.",
      metadata: {
        description: "Workshop site for friends",
        member_count: 2,
        // Members added in the summary's second are newer evidence, conservatively.
        freshness: "needs review",
      },
    });
    expect(
      (edited.metadata as { members: { id: string }[] }).members.map(
        (m) => m.id,
      ),
    ).toEqual(expect.arrayContaining([a, b]));
    // An agent's membership is recorded as the model's, and counts as confirmed.
    expect(
      await db
        .prepare(
          "SELECT asserted_by, confirmed_at IS NOT NULL AS confirmed FROM memory_subject_members WHERE memory_id = ?",
        )
        .bind(a.slice("memory:".length))
        .first(),
    ).toEqual({ asserted_by: "model", confirmed: 1 });

    expect(
      await ok("edit_subject", { id, add_members: [a], remove_members: [b] }),
    ).toMatchObject({
      metadata: { member_count: 1, unchanged: [`${a} was already a member.`] },
    });
    expect(await ok("fetch", { id })).toMatchObject({
      id,
      text: "A React Router app on Workers.",
      metadata: { member_count: 1, next_cursor: null, deleted_at: null },
    });

    expect(await ok("edit_subject", { id, deleted: true })).toMatchObject({
      metadata: { deleted_at: expect.any(Number) },
    });
    expect((await ok("list_subjects", {})).subjects).toEqual([]);
    const refused = await tool("edit_subject", { id, name: "Renamed" });
    expect(refused.isError).toBe(true);
    expect(refused.content[0].text).toContain("deleted: false");
    expect(await ok("edit_subject", { id, deleted: false })).toMatchObject({
      metadata: { deleted_at: null, member_count: 1 },
    });
    expect(await ok("fetch", { id: a })).toMatchObject({ id: a });

    const calls = await db
      .prepare(
        "SELECT tool, required_scope, target_id FROM mcp_calls WHERE tool IN ('save_subject','edit_subject','list_subjects') ORDER BY rowid LIMIT 3",
      )
      .all();
    expect(calls.results).toEqual([
      { tool: "save_subject", required_scope: "memories:write", target_id: id },
      { tool: "save_subject", required_scope: "memories:write", target_id: id },
      {
        tool: "list_subjects",
        required_scope: "memories:read",
        target_id: null,
      },
    ]);
  });

  it("refuses an edit before any write when part of it is invalid", async () => {
    const id = (await ok("save_subject", { name: "Orchard", kind: "area" }))
      .id as string;
    await ok("save_subject", { name: "Meadow", kind: "area" });
    const a = await memory("Pruned in March");

    for (const [args, message] of [
      [{ name: "meadow", add_members: [a] }, "already named"],
      [{ add_members: [a, "memory:mem_missing"] }, "No active memory"],
      [{ add_members: [a], remove_members: [a] }, "both"],
      [{ summary: a, new_summary: "x" }, "not both"],
      [{ deleted: true, name: "Gone" }, "alone"],
      [{}, "Nothing to change"],
    ] as const) {
      const result = await tool("edit_subject", { id, ...args });
      expect(result.isError, JSON.stringify(args)).toBe(true);
      expect(result.content[0].text).toContain(message);
    }
    expect(await ok("fetch", { id })).toMatchObject({
      title: "Orchard",
      metadata: { member_count: 0 },
    });

    // A member cannot become the summary unless it leaves in the same call.
    await ok("edit_subject", { id, add_members: [a] });
    const member = await tool("edit_subject", { id, summary: a });
    expect(member.isError).toBe(true);
    expect(
      await ok("edit_subject", { id, summary: a, remove_members: [a] }),
    ).toMatchObject({ metadata: { member_count: 0, summary: { id: a } } });

    const missing = await tool("fetch", {
      id: "subject:sub_00000000-0000-0000-0000-000000000000",
    });
    expect(missing.isError).toBe(true);
  });
});

describe("subjects while saving (ADR-0003, 2026-11-05)", () => {
  it("save_memory attaches the memory to the subjects it names in the same write", async () => {
    const valise = (await ok("save_subject", { name: "Valise", kind: "topic" }))
      .id as string;
    const duckdb = (await ok("save_subject", { name: "DuckDB", kind: "topic" }))
      .id as string;
    const saved = await ok("save_memory", {
      title: "Valise search runs on D1 FTS5",
      body: "BM25 over search_docs.",
      type: "fact",
      tags: ["search"],
      subjects: [valise, duckdb, valise],
    });
    const fetched = await ok("fetch", { id: valise });
    expect(fetched).toMatchObject({ metadata: { member_count: 1 } });
    expect(
      (fetched.metadata as { members: { id: string }[] }).members.map(
        (m) => m.id,
      ),
    ).toEqual([saved.id]);
    const row = await db
      .prepare(
        "SELECT asserted_by, confirmed_at FROM memory_subject_members WHERE subject_id = ?",
      )
      .bind(duckdb.slice("subject:".length))
      .first<{ asserted_by: string; confirmed_at: number | null }>();
    expect(row?.asserted_by).toBe("model");
    expect(row?.confirmed_at).not.toBeNull();
  });

  it("refuses the whole save when a subject is deleted or unknown", async () => {
    const gone = (await ok("save_subject", { name: "Old", kind: "topic" }))
      .id as string;
    await ok("edit_subject", { id: gone, deleted: true });
    for (const subject of [
      gone,
      "subject:sub_00000000-0000-4000-8000-000000000000",
    ]) {
      const refused = await tool("save_memory", {
        title: "Should not be saved",
        body: "x",
        type: "fact",
        tags: ["subjects"],
        subjects: [subject],
      });
      expect(refused.isError).toBe(true);
      expect(refused.content[0].text).toMatch(/not a live subject/);
    }
    const count = await db
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .first<{ n: number }>();
    expect(count?.n).toBe(0);
  });

  it("search names the subjects its query names; get_brief lists them by project", async () => {
    const valise = (await ok("save_subject", { name: "Valise", kind: "topic" }))
      .id as string;
    await ok("save_subject", { name: "Ada Lovelace", kind: "person" });
    await ok("save_subject", { name: "Unrelated", kind: "area" });
    await ok("save_memory", {
      title: "Valise deploys from main",
      body: "Workers Builds watches main.",
      type: "fact",
      tags: ["deploy"],
      project: "valise",
      subjects: [valise],
    });

    const found = await ok("search", { query: "how does valise deploy" });
    expect(found.subjects).toEqual([
      { id: valise, name: "Valise", kind: "topic", members: 1 },
    ]);
    expect(
      (await ok("search", { query: "notes on Ada Lovelace" })).subjects,
    ).toMatchObject([{ name: "Ada Lovelace", kind: "person" }]);
    // A query that is a word run of the name finds it; a part of a word does not.
    expect((await ok("search", { query: "Ada" })).subjects).toMatchObject([
      { name: "Ada Lovelace" },
    ]);
    expect((await ok("search", { query: "Adam" })).subjects).toBeUndefined();
    // To-do searches carry none.
    expect(
      (await ok("search", { query: "valise", type: "todo" })).subjects,
    ).toBeUndefined();

    expect((await ok("get_brief", { project: "valise" })).subjects).toEqual({
      limit: 10,
      has_more: false,
      items: [{ id: valise, name: "Valise", kind: "topic", members: 1 }],
    });
    expect(
      ((await ok("get_brief", {})).subjects as { items: unknown[] }).items,
    ).toHaveLength(3);
  });
});

describe("subject suggestions (ADR-0012, 2026-11-05)", () => {
  async function tagged(title: string, tags: string[]) {
    return (
      await ok("save_memory", {
        title,
        body: `about ${title}`,
        type: "fact",
        tags,
      })
    ).id as string;
  }

  it("suggests memories tagged with the subject's name until added or dismissed", async () => {
    const id = (
      await ok("save_subject", { name: "Ada Lovelace", kind: "person" })
    ).id as string;
    const a = await tagged("Wrote the first program", ["ada-lovelace"]);
    const b = await tagged("Worked with Babbage", ["Ada_Lovelace", "history"]);
    await tagged("Unrelated", ["ada"]);

    const suggested = (s: Record<string, unknown>) =>
      (s.metadata as { suggested: { id: string; reason: string }[] }).suggested;
    const first = await ok("fetch", { id });
    expect(
      suggested(first)
        .map((m) => m.id)
        .sort(),
    ).toEqual([a, b].sort());
    expect(suggested(first).find((m) => m.id === b)?.reason).toBe(
      "tagged Ada_Lovelace",
    );
    expect(first.metadata).toMatchObject({ member_count: 0, members: [] });

    // Adding confirms one; removing the other dismisses it for good.
    const after = await ok("edit_subject", {
      id,
      add_members: [a],
      remove_members: [b],
    });
    expect(after.metadata).toMatchObject({ member_count: 1, suggested: [] });
    expect(
      (after.metadata as { unchanged?: string[] }).unchanged,
    ).toBeUndefined();

    // A dismissed memory can still be added on purpose.
    expect(
      (await ok("edit_subject", { id, add_members: [b] })).metadata,
    ).toMatchObject({ member_count: 2 });
  });

  it("lists an agent's unconfirmed membership as a suggestion, not a member", async () => {
    const id = (await ok("save_subject", { name: "Valise", kind: "topic" }))
      .id as string;
    const memory = await tagged("Unconfirmed claim", ["other"]);
    await db
      .prepare(
        "INSERT INTO memory_subject_members (subject_id, memory_id, asserted_by, created_at) VALUES (?, ?, 'model', 1)",
      )
      .bind(id.slice("subject:".length), memory.slice("memory:".length))
      .run();
    const fetched = await ok("fetch", { id });
    expect(fetched.metadata).toMatchObject({
      member_count: 0,
      members: [],
      suggested: [{ id: memory, reason: "suggested by an agent" }],
    });
  });
});
