import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedRpc, authenticatedTool } from "./authenticated-call";

const OWNER = "local";
const OTHER = "usr_mcp_skill_other";
const SCOPES = [
  "skills:read",
  "skills:write",
  "config:read",
  "config:write",
  "search:read",
];

const tool = (userId: string, name: string, args: Record<string, unknown>) =>
  authenticatedTool(userId, SCOPES, name, args);
const rpc = (userId: string, method: string, params: Record<string, unknown>) =>
  authenticatedRpc(userId, SCOPES, method, params);

const body = (name: string, text: string) =>
  `---\nname: ${name}\ndescription: Tenant-local instructions.\n---\n${text}`;

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
    "search_docs",
    "vector_pending",
    "skill_versions",
    "skills",
    "hook_configs",
    "mcp_calls",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

async function seed() {
  const theirs = await tool(OTHER, "publish_skill", {
    body: body("member-only", "Member private instructions."),
    files: [{ path: "guide.md", content: "Member private attachment." }],
  });
  const mine = await tool(OWNER, "publish_skill", {
    body: body("owner-only", "Owner instructions."),
  });
  expect(theirs.isError).toBeFalsy();
  expect(mine.isError).toBeFalsy();
  return { theirId: String(theirs.structuredContent?.id) };
}

describe("MCP skill and hook surfaces on the tenant store", () => {
  it("lists, reads and fetches only the tenant's own skills through tools", async () => {
    const { theirId } = await seed();
    const listed = await tool(OWNER, "list_skills", {});
    expect(
      (listed.structuredContent?.skills as { name: string }[]).map(
        (s) => s.name,
      ),
    ).toEqual(["owner-only"]);
    expect(
      (await tool(OWNER, "get_skill", { name: "member-only" })).isError,
    ).toBe(true);
    expect(
      (
        await tool(OWNER, "read_skill_file", {
          name: "member-only",
          path: "guide.md",
        })
      ).isError,
    ).toBe(true);
    expect((await tool(OWNER, "fetch", { id: theirId })).isError).toBe(true);
    expect(
      (
        await tool(OTHER, "read_skill_file", {
          name: "member-only",
          path: "guide.md",
        })
      ).structuredContent,
    ).toMatchObject({ text: "Member private attachment." });

    // Per-skill tools are registered from the caller's own catalog only.
    const tools = (await rpc(OWNER, "tools/list", {})).result?.tools as {
      name: string;
    }[];
    const names = tools.map((t) => t.name);
    expect(names).toContain("skill_owner-only");
    expect(names).not.toContain("skill_member-only");
  });

  it("keeps a same-name publish independent per tenant", async () => {
    await seed();
    const mine = await tool(OWNER, "publish_skill", {
      body: body("member-only", "Owner's own copy."),
    });
    expect(mine.structuredContent).toMatchObject({ version: 1 });
    expect(
      (await tool(OTHER, "get_skill", { name: "member-only" }))
        .structuredContent,
    ).toMatchObject({
      version: 1,
      body: body("member-only", "Member private instructions."),
    });
  });

  it("serves resources, SEP-2640 skill requests and prompts from the tenant's catalog only", async () => {
    await seed();
    const index = await rpc(OWNER, "resources/read", {
      uri: "skill://index.json",
    });
    expect(JSON.stringify(index.result)).toContain("owner-only");
    expect(JSON.stringify(index.result)).not.toContain("member-only");
    const file = await rpc(OWNER, "resources/read", {
      uri: "skill://member-only/guide.md",
    });
    expect(file.error).toBeDefined();
    expect(JSON.stringify(file)).not.toContain("Member private");

    const listed = await rpc(OWNER, "skills/list", {});
    expect(JSON.stringify(listed.result)).not.toContain("member-only");
    expect(
      (await rpc(OWNER, "skills/get", { uri: "skill://member-only/SKILL.md" }))
        .error?.code,
    ).toBe(-32602);

    const prompts = await rpc(OWNER, "prompts/list", {});
    expect(JSON.stringify(prompts.result)).not.toContain("member-only");
    expect(
      (await rpc(OWNER, "prompts/get", { name: "member-only" })).error,
    ).toBeDefined();
  });

  it("keeps hook configuration per tenant through list_hooks and edit_hook", async () => {
    const before = await tool(OWNER, "list_hooks", {});
    const added = await tool(OTHER, "edit_hook", {
      action: "add",
      event: "Stop",
      text: "Member-only reminder.",
    });
    expect(added.isError).toBeFalsy();
    const after = await tool(OWNER, "list_hooks", {});
    expect(after.structuredContent?.entries).toEqual(
      before.structuredContent?.entries,
    );
    expect(JSON.stringify(after.structuredContent)).not.toContain(
      "Member-only reminder",
    );
    expect(
      JSON.stringify((await tool(OTHER, "list_hooks", {})).structuredContent),
    ).toContain("Member-only reminder");
  });
});
