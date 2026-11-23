import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedTool } from "./authenticated-call";

const OWNER = "local";
const OTHER = "usr_mcp_memory_other";
const SCOPES = ["memories:read", "memories:write", "search:read"];

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
    "memory_attachments",
    "objects",
    "memory_links",
    "memory_revisions",
    "search_docs",
    "vector_pending",
    "memories",
    "mcp_calls",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

const tool = (
  userId: string,
  name: string,
  args: Record<string, unknown>,
  headers?: Record<string, string>,
) => authenticatedTool(userId, SCOPES, name, args, headers);

const memory = (title: string, extra: Record<string, unknown> = {}) => ({
  type: "insight",
  title,
  body: `Evidence for ${title}`,
  tags: ["tenant-check"],
  project: "shared-project",
  ...extra,
});

describe("MCP memory tools on the tenant store", () => {
  it("saves under the authenticated principal and its plugin session, not a forged header", async () => {
    const saved = await tool(OTHER, "save_memory", memory("Member insight"), {
      "x-valise-session": "plugin-session",
      "x-valise-session-name": "worktree-b",
    });
    expect(saved.isError).toBeFalsy();
    const id = String(saved.structuredContent?.id).slice("memory:".length);
    expect(
      await env.DB.prepare(
        "SELECT user_id, source_agent, source_client, source_session, source_session_name FROM memories WHERE memory_id = ?",
      )
        .bind(id)
        .first(),
    ).toEqual({
      user_id: OTHER,
      source_agent: `client-${OTHER}`,
      source_client: "oauth",
      source_session: "plugin-session",
      source_session_name: "worktree-b",
    });
  });

  it("keeps similar-memory hints, fetch, edits and links inside one tenant", async () => {
    const theirs = await tool(OTHER, "save_memory", memory("Shared title"));
    const theirId = String(theirs.structuredContent?.id);
    const mine = await tool(OWNER, "save_memory", memory("Shared title"));
    const myId = String(mine.structuredContent?.id);

    // The same title in the same project is not "similar" across tenants.
    expect(mine.structuredContent?.similar).toEqual([]);
    expect((await tool(OWNER, "fetch", { id: theirId })).isError).toBe(true);
    expect(
      (await tool(OWNER, "edit_memory", { id: theirId, title: "stolen" }))
        .isError,
    ).toBe(true);
    const linked = await tool(OWNER, "edit_memory", {
      id: myId,
      relates: [{ id: theirId, kind: "related" }],
    });
    expect(linked.isError).toBe(true);
    expect(linked.content[0].text).toMatch(/no active memory/);

    const fetched = await tool(OTHER, "fetch", { id: theirId });
    expect(fetched.structuredContent).toMatchObject({
      title: "Shared title",
      metadata: { links: [], files: [] },
    });
    expect(
      (await tool(OWNER, "fetch", { id: myId })).structuredContent,
    ).toMatchObject({ title: "Shared title", metadata: { links: [] } });
  });
});
