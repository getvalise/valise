import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpScope } from "~/auth/scopes";
import {
  attachMemoryFile,
  attachTodoFile,
  setFileAttached,
} from "~/concepts/attachments";
import { archiveMemory, saveMemory } from "~/concepts/memories";
import { createTodo } from "~/concepts/todos";
import { mintBearerToken } from "~/concepts/tokens";
import { attachmentUri } from "~/mcp/attachment-resources";

const provenance = {
  userId: "local",
  agent: "test",
  client: "test",
  session: null,
};

afterEach(async () => {
  for (const table of [
    "memory_attachments",
    "todo_attachments",
    "objects",
    "search_docs",
    "memory_revisions",
    "memories",
    "todo_updates",
    "todos",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
  await env.DB.prepare("DELETE FROM users WHERE user_id = 'other'").run();
});

describe("MCP attachment resources", () => {
  it("uses the same canonical URI for scope preflight and resource dispatch", async () => {
    const { target, file } = await fixture("todo");
    const uri = attachmentUri(target, file.objectId);
    for (const alias of [
      uri.replace("valise:", "VaLiSe:"),
      uri.replace("/files/", "/ignored/../files/"),
    ]) {
      const denied = await rpc("resources/read", { uri: alias }, [
        "skills:read",
      ]);
      expect(denied.response.status).toBe(403);
      expect(denied.response.headers.get("www-authenticate")).toContain(
        "todos:read",
      );
    }
    for (const malformed of [
      `${uri}?raw=1`,
      `${uri}#fragment`,
      uri.replace("/files/", "/%66iles/"),
      uri.replace("/files/", "/files/u/local/objects/"),
    ]) {
      const read = await rpc("resources/read", { uri: malformed }, [
        "skills:read",
      ]);
      expect(read.value.error).toBeDefined();
    }
  });
  it.each(["todo", "memory"] as const)(
    "discovers %s files through fetch and reads with only its concept scope",
    async (concept) => {
      const { target, file } = await fixture(concept);
      const fetched = await rpc(
        "tools/call",
        { name: "fetch", arguments: { id: `${concept}:${target.id}` } },
        ["search:read"],
      );
      expect(fetched.value).toMatchObject({
        result: {
          structuredContent: {
            metadata: {
              files: [
                {
                  id: file.objectId,
                  name: "evidence.txt",
                  type: "text/plain",
                  size: 12,
                  uri: attachmentUri(target, file.objectId),
                },
              ],
            },
          },
        },
      });
      const uri = attachmentUri(target, file.objectId);
      const scope = concept === "todo" ? "todos:read" : "memories:read";
      for (const deniedScope of [
        "search:read",
        "skills:read",
        concept === "todo" ? "memories:read" : "todos:read",
      ] satisfies McpScope[]) {
        const denied = await rpc("resources/read", { uri }, [deniedScope]);
        expect(denied.response.status).toBe(403);
        expect(denied.response.headers.get("www-authenticate")).toContain(
          scope,
        );
        expect(denied.value).toMatchObject({
          result: { isError: true, error: "insufficient_scope" },
        });
      }
      const read = await rpc("resources/read", { uri }, [scope]);
      expect(read.response.status).toBe(200);
      expect(read.value).toMatchObject({
        result: {
          contents: [{ uri, mimeType: "text/plain", text: "line one\nλ\n" }],
        },
      });
      await expect
        .poll(
          async () =>
            await env.DB.prepare(
              "SELECT count(*) AS n FROM mcp_calls WHERE method = 'resources/read' AND required_scope = ? AND outcome = 'ok'",
            )
              .bind(scope)
              .first<number>("n"),
        )
        .toBe(1);
      expect(
        await env.DB.prepare(
          "SELECT count(*) AS n FROM mcp_calls WHERE method = 'resources/read' AND required_scope = ? AND outcome = 'insufficient_scope'",
        )
          .bind(scope)
          .first("n"),
      ).toBe(3);
    },
  );

  it("does not disclose another owner's file metadata or bytes", async () => {
    // Reach row isolation as an admitted member, not an invalid credential.
    await env.DB.prepare(
      "INSERT INTO users (user_id, email, display_name, created_at, email_verified) VALUES ('other', 'other@example.test', 'Other', unixepoch(), 1)",
    ).run();
    const { target, file } = await fixture("todo");
    const uri = attachmentUri(target, file.objectId);
    const fetched = await rpc(
      "tools/call",
      { name: "fetch", arguments: { id: `todo:${target.id}` } },
      ["search:read"],
      "other",
    );
    // Another user's to-do is not theirs to fetch at all (ADR-0016), so the
    // file list is never reached.
    expect(fetched.response.status).toBe(200);
    expect(fetched.value).toMatchObject({ result: { isError: true } });
    const foreign = await rpc(
      "resources/read",
      { uri },
      ["todos:read"],
      "other",
    );
    const absent = await rpc(
      "resources/read",
      { uri: attachmentUri(target, "obj_missing") },
      ["todos:read"],
      "other",
    );
    expect(foreign.value).toMatchObject({
      error: { code: -32602, message: "Attached file not found." },
    });
    expect(foreign.value.error).toEqual(absent.value.error);
  });

  it("requires the named link, and detachment stops MCP reads without deleting bytes", async () => {
    const { target, file } = await fixture("todo");
    const other = await createTodo(
      env,
      { title: "Unrelated", project: "valise" },
      provenance,
    );
    const uri = attachmentUri(target, file.objectId);
    const wrong = await rpc(
      "resources/read",
      {
        uri: attachmentUri(
          { concept: "todo", id: other.id.slice("todo:".length) },
          file.objectId,
        ),
      },
      ["todos:read"],
    );
    expect(wrong.value.error?.code).toBe(-32602);
    await setFileAttached(env.DB, "local", target, file.objectId, false);
    const detached = await rpc("resources/read", { uri }, ["todos:read"]);
    expect(detached.value.error?.code).toBe(-32602);
    expect((await env.BUNDLES.list()).objects).toHaveLength(1);
    await setFileAttached(env.DB, "local", target, file.objectId, true);
    expect(
      (await rpc("resources/read", { uri }, ["todos:read"])).value.error,
    ).toBeUndefined();
  });

  it("does not read attachments from an archived memory", async () => {
    const { target, file } = await fixture("memory");
    await archiveMemory(env, "local", target.id);
    const read = await rpc(
      "resources/read",
      { uri: attachmentUri(target, file.objectId) },
      ["memories:read"],
    );
    expect(read.value.error?.code).toBe(-32602);
  });

  it("preserves binary bytes and invalid UTF-8 through the MCP blob representation", async () => {
    const todo = await createTodo(
      env,
      { title: "Binary", project: "valise" },
      provenance,
    );
    const target = {
      concept: "todo",
      id: todo.id.slice("todo:".length),
    } as const;
    const bytes = new Uint8Array(Array.from({ length: 256 }, (_, i) => i));
    for (const type of ["image/png", "text/plain"]) {
      const file = await attachTodoFile(
        env,
        "local",
        target.id,
        new File([bytes], "binary", { type }),
      );
      if (file === null) throw new Error("fixture upload failed");
      const read = await rpc(
        "resources/read",
        { uri: attachmentUri(target, file.objectId) },
        ["todos:read"],
      );
      const schema = z.object({
        result: z.object({ contents: z.array(z.object({ blob: z.string() })) }),
      });
      const parsed = schema.parse(read.value);
      expect(
        Uint8Array.from(atob(parsed.result.contents[0].blob), (c) =>
          c.charCodeAt(0),
        ),
      ).toEqual(bytes);
    }
  });
});

async function fixture(concept: "todo" | "memory") {
  const created =
    concept === "todo"
      ? await createTodo(env, { title: "Files", project: "valise" }, provenance)
      : await saveMemory(
          env,
          { type: "fact", title: "Files", body: "Evidence.", tags: ["file"] },
          provenance,
        );
  const target = { concept, id: created.id.slice(`${concept}:`.length) };
  const input = new File(["line one\nλ\n"], "evidence.txt", {
    type: "text/plain",
  });
  const file =
    concept === "todo"
      ? await attachTodoFile(env, "local", target.id, input)
      : await attachMemoryFile(env, "local", target.id, input);
  if (file === null) throw new Error("fixture upload failed");
  return { target, file };
}

async function rpc(
  method: string,
  params: Record<string, unknown>,
  scopes: McpScope[],
  userId = "local",
) {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId, label: crypto.randomUUID(), scopes },
  );
  const response = await SELF.fetch(
    new Request("http://localhost/mcp", {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${minted.token}`,
        "content-type": "application/json",
        host: "localhost",
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params,
      }),
    }),
  );
  const raw = await response.text();
  const payload =
    raw
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim() ?? raw;
  const value: { result?: unknown; error?: { code: number; message: string } } =
    JSON.parse(payload);
  return { response, value };
}
