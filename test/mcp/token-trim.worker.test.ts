import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SKILL_TOOL_LIMIT } from "~/concepts/skills";
import { callMcp } from "./fixture-worker";

const db = env.DB;

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_relations",
    "todo_updates",
    "todos",
    "skill_versions",
    "skills",
    "mcp_calls",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length) {
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
  }
});

// ADR-0005, amendment of 2026-11-15.
describe("skill tools in tools/list", () => {
  it("lists the most loaded skills up to the limit and still answers a call to any skill's tool", async () => {
    const names = Array.from(
      { length: SKILL_TOOL_LIMIT + 2 },
      (_, n) => `ranked-${String(n).padStart(2, "0")}`,
    );
    for (const name of names)
      await tool("publish_skill", { body: skillBody(name) });
    // While there are only twelve, nothing has loads, so ten get a tool.
    expect(await skillTools()).toHaveLength(SKILL_TOOL_LIMIT);

    // Load ten of them in the window, through either door.
    const loaded = names.slice(2);
    for (const [index, name] of loaded.entries())
      await tool(
        index % 2 ? `skill_${name}` : "get_skill",
        index % 2 ? {} : { name },
      );
    // A load from before the window does not count.
    await db
      .prepare(
        `INSERT INTO mcp_calls (call_id, at, transport, user_id, method, tool, args_json, outcome, status, duration_ms)
         VALUES ('old-load', ?, 'loopback', 'local', 'tools/call', 'skill_ranked-00', '{}', 'ok', 200, 1)`,
      )
      .bind(Math.floor(Date.now() / 1000) - 31 * 86400)
      .run();

    expect((await skillTools()).sort()).toEqual(
      loaded.map((name) => `skill_${name}`),
    );

    // A client holding an older list can still call a skill it no longer sees.
    const unlisted = await tool("skill_ranked-00", {});
    expect(unlisted.isError).not.toBe(true);
    expect(unlisted.structuredContent).toMatchObject({ name: "ranked-00" });
  });
});

// ADR-0003, amendment of 2026-11-15.
describe("to-do results leave out what says nothing", () => {
  it("sends a fresh to-do's fetch without nulls, empty lists, relations or a token", async () => {
    const created = await tool("create_todo", {
      title: "Bare to-do",
      project: "valise",
    });
    const id = created.structuredContent?.id as string;
    const metadata = (await tool("fetch", { id })).structuredContent
      ?.metadata as Record<string, unknown>;
    expect(metadata).toMatchObject({
      project: "valise",
      state: "pending",
      created_at: expect.any(Number),
    });
    for (const key of [
      "status",
      "status_at",
      "tags",
      "files",
      "refs",
      "lease_holder",
      "lease_expires_at",
      "fencing_token",
      "blocked_on",
      "relations",
      "updated_at",
      "completed_at",
      "update_count",
      "last_update_at",
      "updates",
      "next_cursor",
    ])
      expect(metadata, key).not.toHaveProperty(key);
  });

  it("keeps relations a to-do has, with only the lists that hold something", async () => {
    const parent = (
      await tool("create_todo", { title: "Parent", project: "valise" })
    ).structuredContent?.id as string;
    await tool("create_todo", { title: "Child", project: "valise", parent });
    const relations = (
      (await tool("fetch", { id: parent })).structuredContent?.metadata as {
        relations: Record<string, unknown>;
      }
    ).relations;
    expect(relations).toMatchObject({
      children: [expect.objectContaining({ title: "Child" })],
      child_progress: { done: 0, total: 1 },
      note: expect.any(String),
    });
    for (const key of [
      "parent",
      "depends_on",
      "blocks",
      "children_truncated",
      "blocks_truncated",
    ])
      expect(relations, key).not.toHaveProperty(key);
  });

  it("lists to-dos without refs, and without the project the call filtered on", async () => {
    await tool("create_todo", {
      title: "Pointed",
      project: "valise",
      tags: ["tokens"],
      refs: [{ kind: "repo", value: "getvalise/valise" }],
    });
    const listed = (await tool("list_todos", { project: "valise" }))
      .structuredContent as { todos: Record<string, unknown>[] };
    expect(listed.todos).toEqual([
      {
        id: expect.any(String),
        title: "Pointed",
        state: "pending",
        created_at: expect.any(Number),
        tags: ["tokens"],
      },
    ]);
    const everywhere = (await tool("list_todos", {})).structuredContent as {
      todos: Record<string, unknown>[];
    };
    expect(everywhere.todos[0]).toMatchObject({ project: "valise" });
  });
});

async function tool(name: string, args: Record<string, unknown>) {
  const { response, raw, value } = await callMcp("tools/call", {
    name,
    arguments: args,
  });
  expect(response.status, raw).toBe(200);
  return value.result;
}

async function skillTools(): Promise<string[]> {
  const { value } = await callMcp("tools/list", {});
  return (value.result.tools as { name: string }[])
    .map((entry) => entry.name)
    .filter((name) => name.startsWith("skill_"));
}

function skillBody(name: string): string {
  return `---
name: ${name}
description: Ranking test subject.
---

Do the ranked thing.
`;
}
