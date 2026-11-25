import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { MCP_SCOPES } from "~/auth/scopes";
import { mintBearerToken } from "~/concepts/tokens";

const db = env.DB;
const MISSING_ASSET = "asset:ast_00000000-0000-4000-8000-000000000000";

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_updates",
    "todos",
    "memory_revisions",
    "skill_versions",
    "skills",
    "memories",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
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

describe("MCP scopes", () => {
  it.each(["prompts/list", "prompts/get"])(
    "requires skills:read for %s",
    async (method) => {
      const request = async (scope: string) =>
        SELF.fetch(
          new Request("http://localhost/mcp", {
            method: "POST",
            headers: {
              accept: "application/json, text/event-stream",
              authorization: `Bearer ${await bearerFor(scope)}`,
              host: "localhost",
              "content-type": "application/json",
              "mcp-protocol-version": "2025-11-25",
            },
            body: JSON.stringify({
              jsonrpc: "2.0",
              id: 1,
              method,
              params: method === "prompts/get" ? { name: "missing" } : {},
            }),
          }),
        );
      const denied = await request("search:read");
      expect(denied.status).toBe(403);
      expect(denied.headers.get("www-authenticate")).toContain("skills:read");
      const allowed = await request("skills:read");
      expect(allowed.status).toBe(200);
    },
  );
  it.each([
    ["search", { query: "duckdb" }, "search:read"],
    ["fetch", { id: "memory:missing" }, "search:read"],
    ["create_todo", { title: "Scope test", project: "valise" }, "todos:write"],
    ["list_ready", {}, "todos:read"],
    ["list_todos", {}, "todos:read"],
    ["get_brief", {}, "search:read"],
    ["claim_todo", { id: "todo:missing" }, "todos:write"],
    [
      "update_todo",
      { id: "todo:missing", token: 1, body: "Scope test" },
      "todos:write",
    ],
    [
      "complete_todo",
      { id: "todo:missing", token: 1, summary: "Scope test" },
      "todos:write",
    ],
    ["comment_todo", { id: "todo:missing", body: "Scope test" }, "todos:write"],
    [
      "edit_todo_tags",
      { id: "todo:missing", add_tags: ["priority:2"] },
      "todos:write",
    ],
    [
      "save_memory",
      {
        type: "fact",
        title: "Scope test",
        body: "Scope test",
        tags: ["scope"],
      },
      "memories:write",
    ],
    ["list_skills", {}, "skills:read"],
    [
      "edit_memory",
      { id: "memory:missing", title: "Scope test" },
      "memories:write",
    ],
    ["list_subjects", {}, "memories:read"],
    ["list_memories", {}, "memories:read"],
    ["save_subject", { name: "Scope test", kind: "topic" }, "memories:write"],
    [
      "edit_subject",
      {
        id: "subject:sub_00000000-0000-0000-0000-000000000000",
        name: "Scope test",
      },
      "memories:write",
    ],
    ["get_skill", { name: "missing" }, "skills:read"],
    [
      "read_skill_file",
      { name: "missing", path: "references/guide.md" },
      "skills:read",
    ],
    [
      "publish_skill",
      {
        body: "---\nname: scope-test\ndescription: Scope test.\n---\n\nUse scope tests.\n",
      },
      "skills:write",
    ],
    ["list_hooks", {}, "config:read"],
    ["edit_hook", { action: "remove", id: "custom-0" }, "config:write"],
    [
      "propose_hook",
      { name: "scope-test", event: "Stop", argv: ["true"] },
      "config:write",
    ],
    ["upload_asset", { file_name: "scope.png", size: 1 }, "assets:write"],
    ["update_asset", { id: MISSING_ASSET, title: "Scope" }, "assets:write"],
    ["get_asset_download", { id: MISSING_ASSET }, "assets:read"],
    [
      "save_source",
      { kind: "bookmark", title: "Scope", url: "https://example.com/" },
      "sources:write",
    ],
    ["list_sources", {}, "sources:read"],
  ] as const)("requires %s", async (name, args, scope) => {
    const deniedToken = await bearerFor(
      MCP_SCOPES.find((candidate) => candidate !== scope) ?? "search:read",
    );
    const denied = await callTool(name, args, deniedToken);
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain(scope);
    expect(await denied.json()).toMatchObject({
      result: { isError: true, error: "insufficient_scope" },
    });

    const allowed = await callTool(name, args, await bearerFor(scope));
    expect(allowed.status, await allowed.text()).toBe(200);
  });

  it("returns specific repair fields for invalid tool input", async () => {
    const response = await callTool(
      "save_memory",
      { body: "Missing fields" },
      await bearerFor("memories:write"),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: {
        isError: true,
        error: "invalid_input",
        content: [
          {
            text: expect.stringContaining("type, title, tags"),
          },
        ],
      },
    });
  });
});

function callTool(
  name: string,
  args: Record<string, unknown>,
  accessToken: string,
): Promise<Response> {
  return SELF.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${accessToken}`,
        "content-type": "application/json",
        host: "localhost",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
}

async function bearerFor(scope: string): Promise<string> {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId: "local", label: `scope test ${scope}`, scopes: [scope] },
  );
  return minted.token;
}
