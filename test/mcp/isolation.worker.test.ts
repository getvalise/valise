import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { callMcp } from "./fixture-worker";

/**
 * Two users, one store: nothing one writes is visible to the other through
 * any door, and a write aimed at the other's id fails the way a missing id
 * fails. The loopback transport picks the user from `x-valise-user`.
 * ADR-0016.
 */

const db = env.DB;
const OWNER = "local";
const OTHER = "usr_other";

afterEach(async () => {
  for (const table of [
    "search_index",
    "memory_links",
    "memory_revisions",
    "memories",
    "todo_comments",
    "todo_updates",
    "todos",
    "skill_versions",
    "skills",
    "mcp_calls",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  await db
    .prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')")
    .run();
});

async function tool(user: string, name: string, args: Record<string, unknown>) {
  const { response, raw, value } = await callMcp(
    "tools/call",
    { name, arguments: args },
    "vitest",
    "application/json, text/event-stream",
    { "x-valise-user": user },
  );
  expect(response.status, raw).toBe(200);
  return value.result;
}

function ids(
  result: { structuredContent?: Record<string, unknown> },
  key: string,
): string[] {
  const rows = (result.structuredContent?.[key] ?? []) as { id: string }[];
  return rows.map((row) => row.id);
}

describe("user isolation", () => {
  it("keeps to-dos, memories and skills to the user that wrote them", async () => {
    const mine = await tool(OWNER, "create_todo", {
      title: "Owner ships the isolation cardigan",
      project: "valise",
    });
    const theirs = await tool(OTHER, "create_todo", {
      title: "Other knits a cardigan too",
      project: "valise",
    });
    const myTodo = mine.structuredContent?.id as string;
    const theirTodo = theirs.structuredContent?.id as string;

    expect(ids(await tool(OWNER, "list_ready", {}), "todos")).toEqual([myTodo]);
    expect(ids(await tool(OTHER, "list_ready", {}), "todos")).toEqual([
      theirTodo,
    ]);
    // The project status read is per user too.
    expect(
      ids(await tool(OWNER, "list_ready", { activity: true }), "todos"),
    ).toEqual([myTodo]);
    expect(
      ids(await tool(OTHER, "list_ready", { activity: true }), "todos"),
    ).toEqual([theirTodo]);

    const myMemory = (
      await tool(OWNER, "save_memory", {
        type: "insight",
        title: "Cardigans are warm",
        body: "An owner-only claim about cardigans.",
        tags: ["cardigan"],
      })
    ).structuredContent?.id as string;
    const theirMemory = (
      await tool(OTHER, "save_memory", {
        type: "insight",
        title: "Cardigans are itchy",
        body: "An other-only claim about cardigans.",
        tags: ["cardigan"],
      })
    ).structuredContent?.id as string;

    const mySkill = await tool(OWNER, "publish_skill", {
      body: "---\nname: owner-cardigan\ndescription: Owner's cardigan skill\n---\nKnit.",
      files: [],
    });
    expect(mySkill.isError, JSON.stringify(mySkill)).toBeFalsy();

    expect(
      ids(await tool(OWNER, "search", { query: "cardigan" }), "results").sort(),
    ).toEqual([myMemory, mySkill.structuredContent?.id, myTodo].sort());
    expect(
      ids(await tool(OTHER, "search", { query: "cardigan" }), "results").sort(),
    ).toEqual([theirMemory, theirTodo].sort());

    expect(ids(await tool(OTHER, "list_skills", {}), "skills").length).toBe(0);
    expect(
      (await tool(OTHER, "get_skill", { name: "owner-cardigan" })).isError,
    ).toBe(true);

    for (const id of [myTodo, myMemory, mySkill.structuredContent?.id]) {
      expect((await tool(OWNER, "fetch", { id })).isError).toBeFalsy();
      expect((await tool(OTHER, "fetch", { id })).isError).toBe(true);
    }
    for (const id of [theirTodo, theirMemory]) {
      expect((await tool(OTHER, "fetch", { id })).isError).toBeFalsy();
      expect((await tool(OWNER, "fetch", { id })).isError).toBe(true);
    }
  });

  it("refuses writes aimed at another user's rows", async () => {
    const theirTodo = (
      await tool(OTHER, "create_todo", {
        title: "Other's private to-do",
        project: "valise",
      })
    ).structuredContent?.id as string;
    const theirMemory = (
      await tool(OTHER, "save_memory", {
        type: "insight",
        title: "Other's private memory",
        body: "Nobody else edits this.",
        tags: ["cardigan"],
      })
    ).structuredContent?.id as string;

    const claim = await tool(OWNER, "claim_todo", { id: theirTodo });
    expect(claim.isError).toBe(true);
    const comment = await tool(OWNER, "comment_todo", {
      id: theirTodo,
      body: "Can I have this?",
    });
    expect(comment.isError).toBe(true);
    const edit = await tool(OWNER, "edit_memory", {
      id: theirMemory,
      title: "Rewritten by the owner",
    });
    expect(edit.isError).toBe(true);

    const untouched = await db
      .prepare("SELECT title FROM memories WHERE memory_id = ?")
      .bind(theirMemory.slice("memory:".length))
      .first<{ title: string }>();
    expect(untouched?.title).toBe("Other's private memory");
    const comments = await db
      .prepare("SELECT COUNT(*) AS n FROM todo_comments")
      .first<{ n: number }>();
    expect(comments?.n).toBe(0);

    // The other user still holds their own rows.
    expect(
      (await tool(OTHER, "claim_todo", { id: theirTodo })).isError,
    ).toBeFalsy();
  });
});
