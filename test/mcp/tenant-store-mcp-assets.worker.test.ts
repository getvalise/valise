import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedRpc, authenticatedTool } from "./authenticated-call";

const OWNER = "local";
const OTHER = "usr_mcp_asset_other";
const SCOPES = [
  "assets:read",
  "assets:write",
  "memories:read",
  "memories:write",
  "search:read",
];
const THEIRS = "ast_00000000-0000-4000-8000-0000000000b1";
const THEIR_OBJECT = "obj_00000000-0000-4000-8000-0000000000b1";
const BYTES = "member private bytes";

const tool = (userId: string, name: string, args: Record<string, unknown>) =>
  authenticatedTool(userId, SCOPES, name, args);
const rpc = (userId: string, method: string, params: Record<string, unknown>) =>
  authenticatedRpc(userId, SCOPES, method, params);

beforeEach(async () => {
  const key = `u/${OTHER}/objects/${THEIR_OBJECT}`;
  await env.BUNDLES.put(key, BYTES);
  const sha = [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(BYTES)),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, display_name, created_at, email_verified)
       VALUES (?, ?, unixepoch(), 1)`,
    ).bind(OTHER, OTHER),
    env.DB.prepare(
      `INSERT INTO objects (object_id, user_id, r2_key, name, content_type, size, sha256, created_at)
       VALUES (?, ?, ?, 'notes.txt', 'text/plain', ?, ?, 1)`,
    ).bind(THEIR_OBJECT, OTHER, key, BYTES.length, sha),
    env.DB.prepare(
      `INSERT INTO assets (asset_id, user_id, state, object_id, title, file_name, content_type,
         declared_size, tags_json, source_agent, source_client,
         created_at, updated_at, finalized_at)
       VALUES (?, ?, 'ready', ?, 'Member notes', 'notes.txt', 'text/plain', ?, '[]',
         'fixture', 'test', 1, 1, 1)`,
    ).bind(THEIRS, OTHER, THEIR_OBJECT, BYTES.length),
  ]);
});

afterEach(async () => {
  for (const table of [
    "memory_attachments",
    "asset_folder_files",
    "asset_folders",
    "assets",
    "objects",
    "memory_revisions",
    "memories",
    "search_docs",
    "vector_pending",
    "mcp_calls",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

describe("MCP asset tools and attachment resources on the tenant store", () => {
  it("refuses another tenant's file to download, update, fetch, resource read and folder join", async () => {
    const id = `asset:${THEIRS}`;
    expect((await tool(OWNER, "get_asset_download", { id })).isError).toBe(
      true,
    );
    expect(
      (await tool(OWNER, "update_asset", { id, title: "stolen" })).isError,
    ).toBe(true);
    expect((await tool(OWNER, "fetch", { id })).isError).toBe(true);
    const read = await rpc(OWNER, "resources/read", {
      uri: `valise://asset/${THEIRS}`,
    });
    expect(read.error).toBeDefined();
    expect(JSON.stringify(read)).not.toContain(BYTES);
    const joined = await tool(OWNER, "upload_asset", {
      file_name: "style.css",
      content_type: "text/css",
      size: 10,
      folder: id,
    });
    expect(joined.isError).toBe(true);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE user_id = ?")
        .bind(OWNER)
        .first("n"),
    ).toBe(0);
    expect(
      await env.DB.prepare("SELECT title FROM assets WHERE asset_id = ?")
        .bind(THEIRS)
        .first("title"),
    ).toBe("Member notes");

    // The owner of the file still gets every one of them.
    expect(
      (await tool(OTHER, "get_asset_download", { id })).structuredContent,
    ).toMatchObject({ id, file_name: "notes.txt" });
    expect(
      (
        await rpc(OTHER, "resources/read", {
          uri: `valise://asset/${THEIRS}`,
        })
      ).result,
    ).toMatchObject({ contents: [{ text: BYTES }] });
    expect(
      (await tool(OTHER, "fetch", { id })).structuredContent,
    ).toMatchObject({ title: "Member notes" });
  });

  it("starts an upload under the authenticated principal", async () => {
    const begun = await tool(OTHER, "upload_asset", {
      file_name: "screenshot.png",
      content_type: "image/png",
      size: 4,
    });
    expect(begun.isError).toBeFalsy();
    const assetId = String(begun.structuredContent?.id).slice("asset:".length);
    expect(
      await env.DB.prepare(
        "SELECT user_id, source_agent FROM assets WHERE asset_id = ?",
      )
        .bind(assetId)
        .first(),
    ).toEqual({ user_id: OTHER, source_agent: `client-${OTHER}` });
  });

  it("serves a memory's attached file only to the memory's tenant", async () => {
    const saved = await tool(OTHER, "save_memory", {
      type: "fact",
      title: "Member memory with a file",
      body: "Evidence.",
      tags: ["files"],
    });
    const memoryId = String(saved.structuredContent?.id).slice(
      "memory:".length,
    );
    await env.DB.prepare(
      "INSERT INTO memory_attachments (memory_id, object_id, created_at) VALUES (?, ?, unixepoch())",
    )
      .bind(memoryId, THEIR_OBJECT)
      .run();
    const uri = `valise://memory/${memoryId}/files/${THEIR_OBJECT}`;
    const stolen = await rpc(OWNER, "resources/read", { uri });
    expect(stolen.error).toBeDefined();
    expect(JSON.stringify(stolen)).not.toContain(BYTES);
    expect((await rpc(OTHER, "resources/read", { uri })).result).toMatchObject({
      contents: [{ text: BYTES }],
    });
  });
});
