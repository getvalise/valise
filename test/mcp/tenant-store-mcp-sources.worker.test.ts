import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedTool } from "./authenticated-call";

const OWNER = "local";
const OTHER = "usr_mcp_source_other";
const SCOPES = ["sources:read", "sources:write", "assets:read", "search:read"];
const URL_ = "https://example.test/shared-article";

const tool = (userId: string, name: string, args: Record<string, unknown>) =>
  authenticatedTool(userId, SCOPES, name, args);

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, created_at, email_verified)
     VALUES (?, ?, unixepoch(), 1)`,
  )
    .bind(OTHER, OTHER)
    .run();
});

afterEach(async () => {
  for (const table of [
    "library_use_events",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
    "search_docs",
    "vector_pending",
    "mcp_calls",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

const bookmark = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: "bookmark",
  title,
  url: URL_,
  notes: `Notes for ${title}`,
  tags: [title.toLowerCase().replaceAll(" ", "-")],
  ...extra,
});

describe("MCP source tools on the tenant store", () => {
  it("saves a bookmark per tenant even at the same URL, and checks only the caller's", async () => {
    const theirs = await tool(OTHER, "save_source", bookmark("Member copy"));
    expect(theirs.isError).toBeFalsy();
    // Same URL, other tenant: a new source, not a revision of theirs.
    const mine = await tool(OWNER, "save_source", bookmark("Owner copy"));
    expect(mine.structuredContent).toMatchObject({ revision: 1 });
    expect(mine.structuredContent?.id).not.toEqual(
      theirs.structuredContent?.id,
    );

    const check = await tool(OWNER, "save_source", { check: true, url: URL_ });
    expect(check.structuredContent).toMatchObject({
      saved: [{ id: mine.structuredContent?.id, title: "Owner copy" }],
      vocabulary: { tags: ["owner-copy"] },
    });
    expect(
      await env.DB.prepare(
        "SELECT user_id, title FROM sources ORDER BY user_id",
      ).all(),
    ).toMatchObject({
      results: [
        { user_id: OWNER, title: "Owner copy" },
        { user_id: OTHER, title: "Member copy" },
      ],
    });
  });

  it("refuses revisions of, and fetches of, another tenant's source", async () => {
    const theirs = await tool(OTHER, "save_source", bookmark("Member copy"));
    const id = String(theirs.structuredContent?.id);
    const revised = await tool(OWNER, "save_source", {
      id,
      expected_revision: 1,
      title: "stolen",
    });
    expect(revised.isError).toBe(true);
    expect((await tool(OWNER, "fetch", { id })).isError).toBe(true);
    expect(
      (await tool(OTHER, "fetch", { id })).structuredContent,
    ).toMatchObject({ title: "Member copy", metadata: { revision: 1 } });
  });
});
