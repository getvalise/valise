import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { authorLabel, byline, clientName } from "~/concepts/agent-names";
import { callMcp } from "./fixture-worker";

const db = env.DB;
const CLAUDE_CODE = "https://claude.ai/oauth/claude-code-client-metadata";
const SESSION = "mcp-guides-improvements-1a";

afterEach(async () => {
  for (const table of [
    "search_index",
    "search_docs",
    "todo_comments",
    "todo_updates",
    "todos",
    "memories",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_fts(search_fts) VALUES('rebuild')")
    .run();
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

async function tool(
  name: string,
  args: Record<string, unknown>,
  sessionName: string | null = SESSION,
) {
  const { response, raw, value } = await callMcp(
    "tools/call",
    { name, arguments: args },
    CLAUDE_CODE,
    undefined,
    sessionName === null ? {} : { "x-valise-session-name": sessionName },
  );
  expect(response.status, raw).toBe(200);
  expect(value.result.isError, raw).not.toBe(true);
  return value.result as { structuredContent: Record<string, unknown> };
}

describe("session names in provenance", () => {
  it("stores the session name beside the client on every to-do write, and keeps the lease on the client", async () => {
    const created = await tool("create_todo", {
      title: "Name the session",
      project: "valise",
    });
    const id = created.structuredContent.id as string;
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 });
    const token = claimed.structuredContent.token as number;
    await tool("update_todo", { id, token, body: "Found it." });
    await tool("comment_todo", { id, body: "From another session." }, "other");
    await tool("comment_todo", { id, body: "No name sent." }, null);
    await tool("complete_todo", { id, token, summary: "Done." });

    const fetched = await tool("fetch", { id });
    const metadata = fetched.structuredContent.metadata as {
      source_agent: string;
      source_session_name: string | null;
      updates: { kind: string; author?: string; session_name?: string }[];
    };
    // An entry by the to-do's own author leaves the author off.
    expect(metadata.updates.some((update) => "author" in update)).toBe(false);
    expect(metadata.source_agent).toBe(CLAUDE_CODE);
    expect(metadata.source_session_name).toBe(SESSION);
    const byKind = metadata.updates.map((update) => [
      update.kind,
      update.author ?? metadata.source_agent,
      update.session_name ?? null,
    ]);
    expect(byKind).toEqual(
      expect.arrayContaining([
        ["claim", CLAUDE_CODE, SESSION],
        ["progress", CLAUDE_CODE, SESSION],
        ["comment", CLAUDE_CODE, "other"],
        ["comment", CLAUDE_CODE, null],
        ["complete", CLAUDE_CODE, SESSION],
      ]),
    );
    expect(byKind).toHaveLength(5);
  });

  it("stores the session name on a saved memory", async () => {
    const saved = await tool("save_memory", {
      type: "insight",
      title: "Session names reach memories",
      body: "The header becomes source_session_name.",
      project: "valise",
      tags: ["provenance"],
    });
    const fetched = await tool("fetch", {
      id: saved.structuredContent.id as string,
    });
    expect(fetched.structuredContent.metadata).toMatchObject({
      source_agent: CLAUDE_CODE,
      source_session_name: SESSION,
    });
  });
});

describe("author labels", () => {
  it("names known clients by product and leaves plain names alone", () => {
    expect(clientName(CLAUDE_CODE)).toBe("Claude Code");
    expect(clientName("https://opencode.ai/oauth/opencode/client.json")).toBe(
      "OpenCode",
    );
    expect(clientName("https://example.test/oauth/acme/client.json")).toBe(
      "acme",
    );
    expect(clientName("https://example.test/oauth/acme-client-metadata")).toBe(
      "acme",
    );
    expect(clientName("ci-runner")).toBe("ci-runner");
  });

  it("puts the session name first and the client second", () => {
    expect(authorLabel(CLAUDE_CODE, SESSION)).toEqual({
      name: SESSION,
      client: "Claude Code",
    });
    expect(byline(CLAUDE_CODE, SESSION)).toBe(`${SESSION} · Claude Code`);
    expect(byline(CLAUDE_CODE, null)).toBe("Claude Code");
  });

  it("dates and attributes every search hit and similar memory, so staleness needs no fetch", async () => {
    const before = Math.floor(Date.now() / 1000);
    const memory = await tool("save_memory", {
      title: "Pelican caching needs a warm start",
      body: "Measured on staging.",
      type: "insight",
      tags: ["caching"],
    });
    await tool(
      "create_todo",
      { title: "Warm the pelican cache", project: "valise" },
      null,
    );

    const found = await tool("search", { query: "pelican" });
    const hits = found.structuredContent.results as {
      type: string;
      metadata: { created_at: number; saved_by: string };
    }[];
    const byType = Object.fromEntries(
      hits.map((hit) => [hit.type, hit.metadata]),
    );
    expect(byType.memory.saved_by).toBe(`${SESSION} · Claude Code`);
    expect(byType.todo.saved_by).toBe("Claude Code");
    for (const metadata of Object.values(byType))
      expect(metadata.created_at).toBeGreaterThanOrEqual(before);

    const restated = await tool(
      "save_memory",
      {
        title: "Pelican caching needs a warm start, again",
        body: "Restated.",
        type: "insight",
        tags: ["caching"],
      },
      "other-session",
    );
    expect(restated.structuredContent.similar).toEqual([
      {
        id: memory.structuredContent.id,
        title: "Pelican caching needs a warm start",
        created_at: expect.any(Number),
        saved_by: `${SESSION} · Claude Code`,
      },
    ]);
  });
});
