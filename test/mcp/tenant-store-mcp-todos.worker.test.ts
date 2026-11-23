import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedTool } from "./authenticated-call";

const OWNER = "local";
const OTHER = "usr_mcp_todo_other";
const SCOPES = ["todos:read", "todos:write", "search:read"];

const tool = (
  userId: string,
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
) => authenticatedTool(userId, SCOPES, name, args, headers);

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, created_at, email_verified)
     VALUES (?, ?, unixepoch(), 1)`,
  )
    .bind(OTHER, OTHER)
    .run();
});

afterEach(async () => {
  for (const userId of [OWNER, OTHER])
    await env.TODO_COORDINATOR.getByName(
      `todos:${userId}`,
    ).resetForDevelopment();
  for (const table of [
    "todo_attachments",
    "todo_relations",
    "todo_relation_fences",
    "todo_comments",
    "todo_updates",
    "search_docs",
    "vector_pending",
    "todos",
    "mcp_calls",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

async function seed() {
  const theirs = await tool(OTHER, "create_todo", {
    title: "Member ranking work",
    project: "shared-project",
    tags: ["owner:theirs"],
  });
  const mine = await tool(OWNER, "create_todo", {
    title: "Owner ranking work",
    project: "shared-project",
  });
  return {
    theirs: String(theirs.structuredContent?.id),
    mine: String(mine.structuredContent?.id),
  };
}

describe("MCP to-do tools on the tenant store", () => {
  it("creates under the authenticated principal and its plugin session", async () => {
    const created = await tool(
      OTHER,
      "create_todo",
      { title: "Session-stamped work", project: "p" },
      { "x-valise-session": "s-1", "x-valise-session-name": "worktree-c" },
    );
    const id = String(created.structuredContent?.id).slice("todo:".length);
    expect(
      await env.DB.prepare(
        "SELECT user_id, source_agent, source_session, source_session_name FROM todos WHERE todo_id = ?",
      )
        .bind(id)
        .first(),
    ).toEqual({
      user_id: OTHER,
      source_agent: `client-${OTHER}`,
      source_session: "s-1",
      source_session_name: "worktree-c",
    });
  });

  it("lists, pages, briefs and fetches only the tenant's own to-dos", async () => {
    const { theirs, mine } = await seed();
    const ids = (result: Awaited<ReturnType<typeof tool>>) =>
      (result.structuredContent?.todos as { id: string }[]).map((t) => t.id);

    expect(ids(await tool(OWNER, "list_ready", {}))).toEqual([mine]);
    expect(ids(await tool(OWNER, "list_ready", { activity: true }))).toEqual([
      mine,
    ]);
    expect(ids(await tool(OWNER, "list_todos", {}))).toEqual([mine]);
    const brief = await tool(OWNER, "get_brief", {});
    expect(JSON.stringify(brief.structuredContent)).not.toContain(theirs);
    expect((await tool(OWNER, "fetch", { id: theirs })).isError).toBe(true);
    expect(
      (await tool(OTHER, "fetch", { id: theirs })).structuredContent,
    ).toMatchObject({ title: "Member ranking work" });
  });

  it("refuses claims, updates, completion, tags, comments and relations across tenants", async () => {
    const { theirs, mine } = await seed();
    const before = await env.DB.prepare(
      "SELECT state, fencing_token, tags_json FROM todos WHERE todo_id = ?",
    )
      .bind(theirs.slice("todo:".length))
      .first();

    for (const [name, args] of [
      ["claim_todo", { id: theirs }],
      ["update_todo", { id: theirs, token: 1, body: "stolen" }],
      ["complete_todo", { id: theirs, token: 1, summary: "stolen" }],
      ["edit_todo_tags", { id: theirs, add_tags: ["stolen"] }],
      ["comment_todo", { id: theirs, body: "stolen" }],
      ["update_todo", { id: mine, relations: { add_depends_on: [theirs] } }],
      ["update_todo", { id: theirs, relations: { parent: mine } }],
    ] as const)
      expect((await tool(OWNER, name, args)).isError, name).toBe(true);

    expect(
      await env.DB.prepare(
        "SELECT state, fencing_token, tags_json FROM todos WHERE todo_id = ?",
      )
        .bind(theirs.slice("todo:".length))
        .first(),
    ).toEqual(before);
    for (const table of ["todo_comments", "todo_relations"])
      expect(
        await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first("n"),
      ).toBe(0);
    // The owner's own claim still works through the same store.
    expect((await tool(OWNER, "claim_todo", { id: mine })).isError).toBeFalsy();
  });
});
