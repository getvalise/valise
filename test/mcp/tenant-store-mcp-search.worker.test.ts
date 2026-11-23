import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CAPTURE_NUDGE } from "~/mcp/tools";
import { authenticatedTool } from "./authenticated-call";

const OWNER = "local";
const OTHER = "usr_mcp_search_other";
const SCOPES = [
  "search:read",
  "memories:read",
  "memories:write",
  "todos:read",
  "todos:write",
  "sources:read",
  "sources:write",
];

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
    "library_use_events",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "memory_links",
    "memory_revisions",
    "memories",
    "todo_updates",
    "todos",
    "search_docs",
    "vector_pending",
    "mcp_calls",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

describe("MCP search, use recording and the capture nudge on the tenant store", () => {
  it("returns only the caller's own memories and bookmarks, with or without the library", async () => {
    for (const [userId, title] of [
      [OTHER, "Zanzibar member memory"],
      [OWNER, "Zanzibar owner memory"],
    ])
      expect(
        (
          await tool(userId, "save_memory", {
            type: "fact",
            title,
            body: `Evidence for ${title}`,
            tags: ["zanzibar"],
          })
        ).isError,
      ).toBeFalsy();
    const bookmark = await tool(OTHER, "save_source", {
      kind: "bookmark",
      title: "Zanzibar member bookmark",
      url: "https://example.test/zanzibar",
      notes: "Zanzibar notes only the member saved.",
    });
    expect(bookmark.isError).toBeFalsy();

    for (const args of [
      { query: "Zanzibar" },
      { query: "Zanzibar", include_library: true },
      { query: "Zanzibar", type: "source" },
    ]) {
      const found = await tool(OWNER, "search", args);
      const titles = (
        found.structuredContent?.results as { title: string }[]
      ).map((hit) => hit.title);
      expect(titles.join(" | ")).not.toMatch(/member/);
      if (args.type === undefined)
        expect(titles).toContain("Zanzibar owner memory");
    }
    const theirs = await tool(OTHER, "search", {
      query: "Zanzibar",
      include_library: true,
    });
    expect(
      (theirs.structuredContent?.results as { title: string }[]).map(
        (hit) => hit.title,
      ),
    ).toEqual(
      expect.arrayContaining([
        "Zanzibar member memory",
        "Zanzibar member bookmark",
      ]),
    );

    // Fetching another tenant's bookmark fails and records no use for anyone.
    const sourceId = String(bookmark.structuredContent?.id);
    expect((await tool(OWNER, "fetch", { id: sourceId })).isError).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM library_use_events",
      ).first("n"),
    ).toBe(0);
    expect((await tool(OTHER, "fetch", { id: sourceId })).isError).toBeFalsy();
    expect(
      await env.DB.prepare(
        "SELECT user_id, kind FROM library_use_events",
      ).all(),
    ).toMatchObject({ results: [{ user_id: OTHER, kind: "fetched" }] });
  });

  it("nudges once per session per tenant, not once per session id across tenants", async () => {
    const session = { "x-valise-session": "shared-session-id" };
    async function completeOne(userId: string) {
      const created = await tool(userId, "create_todo", {
        title: `Nudge check for ${userId}`,
        project: "nudge",
      });
      const id = String(created.structuredContent?.id);
      const claimed = await tool(userId, "claim_todo", { id }, session);
      const done = await tool(
        userId,
        "complete_todo",
        { id, token: claimed.structuredContent?.token, summary: "Done." },
        session,
      );
      expect(done.isError).toBeFalsy();
      return done.content.map((block) => block.text).join("\n");
    }
    expect(await completeOne(OTHER)).toContain(CAPTURE_NUDGE);
    // The member's completion in the same session id is not the owner's.
    expect(await completeOne(OWNER)).toContain(CAPTURE_NUDGE);
    expect(await completeOne(OWNER)).not.toContain(CAPTURE_NUDGE);
  });
});
