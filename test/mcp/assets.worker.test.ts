import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import type { McpScope } from "~/auth/scopes";
import { passageIndex } from "~/concepts/asset-passages";
import { assetSearchStatements } from "~/concepts/assets";
import { mintBearerToken } from "~/concepts/tokens";
import { sha256Hex } from "~/r2/objects";

/**
 * The asset tools end to end through the deployed Worker's own paths: a
 * bearer-token MCP call, the HTTP upload and download routes, and the asset
 * resource. Each call mints its own token, so "machine A" and "machine B"
 * are different authenticated clients of the same user. ADR-0015.
 */

const SCREENSHOT = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 9, 9, 9,
]);

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "memory_links",
    "memory_revisions",
    "memories",
    "assets",
    "objects",
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

type Rpc = {
  response: Response;
  value: {
    result?: {
      isError?: boolean;
      content?: { type: string; text: string }[];
      structuredContent?: Record<string, unknown>;
      contents?: { uri: string; mimeType: string; blob?: string }[];
      tools?: {
        name: string;
        description: string;
        inputSchema: {
          properties: Record<string, unknown>;
          required: string[];
        };
      }[];
    };
    error?: { code: number; message: string };
  };
};

async function rpc(
  method: string,
  params: Record<string, unknown>,
  scopes: McpScope[],
  label = crypto.randomUUID(),
  userId = "local",
): Promise<Rpc> {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId, label, scopes },
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
  return { response, value: JSON.parse(payload) };
}

function tool(
  name: string,
  args: Record<string, unknown>,
  scopes: McpScope[],
  label?: string,
  userId?: string,
) {
  return rpc("tools/call", { name, arguments: args }, scopes, label, userId);
}

function structured(call: Rpc): Record<string, unknown> {
  const result = call.value.result;
  if (!result || result.isError) throw new Error(JSON.stringify(call.value));
  return result.structuredContent ?? {};
}

/** Machine A: ask for an upload, then PUT the bytes over HTTP. */
async function upload(extra: Record<string, unknown> = {}) {
  const started = await tool(
    "upload_asset",
    {
      file_name: "kingfisher.png",
      content_type: "image/png",
      size: SCREENSHOT.byteLength,
      sha256: await sha256Hex(SCREENSHOT.buffer),
      title: "Kingfisher deploy screenshot",
      description: "The failing build log, step four",
      project: "valise",
      tags: ["screenshot"],
      ...extra,
    },
    ["assets:write"],
    "machine-a",
  );
  const begun = structured(started) as {
    id: string;
    upload: { url: string; headers: Record<string, string>; command: string };
  };
  const put = await SELF.fetch(begun.upload.url, {
    method: "PUT",
    headers: begun.upload.headers,
    body: SCREENSHOT,
  });
  expect(put.status, await put.clone().text()).toBe(200);
  const stored = (await put.json()) as Record<string, unknown>;
  return { begun, started, stored };
}

describe("asset tools", () => {
  it("advertises broad library opt-in and distinguishes processed from unprocessed coverage", async () => {
    const listed = await rpc("tools/list", {}, ["search:read"]);
    const search = listed.value.result?.tools?.find(
      (entry) => entry.name === "search",
    );
    expect(search?.description).toContain("include_library: true");
    expect(search?.description).toContain("available processed text");
    expect(search?.description).toContain(
      "unprocessed file contents are not indexed",
    );
    // Captured page text is searched now; the description no longer says
    // page contents never are.
    expect(search?.description).toContain(
      "Sources match notes, authors and captured page text",
    );
    expect(search?.description).not.toContain("page contents are not indexed");
    expect(search?.inputSchema.properties.author).toMatchObject({
      type: "string",
    });
    expect(search?.inputSchema.properties.include_library).toMatchObject({
      type: "boolean",
    });
    expect(search?.inputSchema.required).not.toContain("include_library");
  });

  it("opts broad searches into the library without changing default or typed searches", async () => {
    const { begun } = await upload({
      title: "Vaclav Smil: Energy and Civilization",
      description: "An uploaded book about energy transitions",
      tags: ["books"],
    });
    const source = structured(
      await tool(
        "save_source",
        {
          kind: "reference",
          title: "Vaclav Smil reading notes",
          notes: "Energy transitions bibliography",
          project: "valise",
          tags: ["books"],
        },
        ["sources:write"],
      ),
    );
    const memory = structured(
      await tool(
        "save_memory",
        {
          type: "reference",
          title: "Vaclav Smil reading list",
          body: "Books about energy transitions",
          project: "valise",
          tags: ["books"],
        },
        ["memories:write"],
      ),
    );
    const args = { query: "Vaclav Smil", project: "valise", tags: ["books"] };
    const broad = await tool("search", { ...args, include_library: true }, [
      "search:read",
    ]);
    expect(structured(broad).results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: begun.id, type: "asset" }),
        expect.objectContaining({ id: source.id, type: "source" }),
        expect.objectContaining({ id: memory.id, type: "memory" }),
      ]),
    );
    expect(
      broad.value.result?.content?.map((block) => block.text).join("\n"),
    ).toContain("contents are not indexed");

    // Frozen pre-library enum: an old client can still validate its default
    // results, even while matching assets and sources exist in the corpus.
    const cachedTypes = z.array(
      z.object({ type: z.enum(["skill", "memory", "todo"]) }),
    );
    for (const extra of [{}, { include_library: false }]) {
      const legacy = structured(
        await tool("search", { ...args, ...extra }, ["search:read"]),
      );
      expect(cachedTypes.safeParse(legacy.results).success).toBe(true);
      expect(legacy.results).toEqual([
        expect.objectContaining({ id: memory.id, type: "memory" }),
      ]);
    }
    for (const [type, id] of [
      ["asset", begun.id],
      ["source", source.id],
      ["memory", memory.id],
    ]) {
      const precise = structured(
        await tool("search", { ...args, type, include_library: true }, [
          "search:read",
        ]),
      );
      expect(precise.results).toEqual([expect.objectContaining({ id, type })]);
    }
    for (const extra of [{ project: "other" }, { tags: ["missing"] }]) {
      expect(
        structured(
          await tool("search", { ...args, include_library: true, ...extra }, [
            "search:read",
          ]),
        ).results,
      ).toEqual([]);
    }
    const limited = structured(
      await tool("search", { ...args, include_library: true, limit: 1 }, [
        "search:read",
      ]),
    );
    expect(limited.results).toHaveLength(1);
  });

  it("returns a book passage with its page and a citation, fetchable as its asset", async () => {
    const { begun } = await upload({ title: "Orchard Notes", tags: ["books"] });
    const assetId = begun.id.slice("asset:".length);
    const text = [
      "## Metadata\n- Author=Ada Synthetic\n## Contents",
      `### Page 1\n${"Drip lines run along each row. ".repeat(100)}\n1`,
      `### Page 2\n${"Kestrels nest in old pear trees. ".repeat(100)}\n2`,
      `### Page 3\n${"Voles run under the grass. ".repeat(100)}\n3`,
    ].join("\n");
    const object = await env.DB.prepare(
      "SELECT object_id AS objectId, sha256 FROM objects JOIN assets USING (object_id) WHERE asset_id = ?",
    )
      .bind(assetId)
      .first<{ objectId: string; sha256: string }>();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO asset_processing (processing_id, user_id, asset_id, generation, processor_version, state, created_at)
         VALUES ('apr_book', 'local', ?, 99, 'test', 'ready', 1)`,
      ).bind(assetId),
      env.DB.prepare(
        `INSERT INTO asset_processing_outputs (processing_id, user_id, asset_id, object_id, original_sha256,
           processor_version, extractor, text, truncated, passages_json, suggestions_json, created_at)
         VALUES ('apr_book', 'local', ?, ?, ?, 'test', 'test', ?, 0, ?, 'null', 1)`,
      ).bind(
        assetId,
        object?.objectId,
        object?.sha256,
        text,
        JSON.stringify(passageIndex(text)),
      ),
      env.DB.prepare(
        `INSERT INTO asset_processing_heads (user_id, asset_id, processing_id) VALUES ('local', ?, 'apr_book')
         ON CONFLICT(asset_id) DO UPDATE SET processing_id = excluded.processing_id`,
      ).bind(assetId),
      ...assetSearchStatements(env.DB, assetId, "local"),
    ]);
    const searched = structured(
      await tool(
        "search",
        { query: "kestrels pear", type: "asset", tags: ["books"] },
        ["search:read"],
      ),
    ) as { results: { id: string; title: string; metadata: unknown }[] };
    expect(searched.results).toEqual([
      expect.objectContaining({
        id: begun.id,
        title: "Orchard Notes · p. 2",
        metadata: expect.objectContaining({
          passage: {
            locator: "p. 2",
            first: 2,
            last: 2,
            citation: "Ada Synthetic, Orchard Notes, p. 2",
          },
        }),
      }),
    ]);
    // The id fetches the whole asset.
    expect(
      structured(
        await tool("fetch", { id: searched.results[0].id }, ["search:read"]),
      ),
    ).toMatchObject({ id: begun.id });
    await env.DB.batch(
      [
        "asset_processing_heads",
        "asset_processing_outputs",
        "asset_processing",
      ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
    );
  });

  it("hands a screenshot from one authenticated client to another, byte for byte", async () => {
    const { begun, started, stored } = await upload();
    expect(begun.upload.command).toContain("--data-binary @kingfisher.png");
    expect(stored).toMatchObject({
      id: begun.id,
      state: "ready",
      size: SCREENSHOT.byteLength,
    });
    expect(started.value.result?.content?.at(-1)?.text).toContain(
      "not indexed",
    );

    // Machine B finds it by its metadata, only when it asks for assets.
    const unfiltered = structured(
      await tool(
        "search",
        { query: "kingfisher" },
        ["search:read"],
        "machine-b",
      ),
    );
    expect(unfiltered.results).toEqual([]);
    const searched = await tool(
      "search",
      { query: "kingfisher build", type: "asset" },
      ["search:read"],
      "machine-b",
    );
    expect(structured(searched).results).toEqual([
      expect.objectContaining({ id: begun.id, type: "asset" }),
    ]);
    expect(searched.value.result?.content?.at(-1)?.text).toContain(
      "contents are not indexed",
    );

    const fetched = structured(
      await tool("fetch", { id: begun.id }, ["search:read"], "machine-b"),
    );
    expect(fetched).toMatchObject({
      id: begun.id,
      title: "Kingfisher deploy screenshot",
      metadata: {
        content_indexed: false,
        uri: `valise://asset/${begun.id.slice("asset:".length)}`,
      },
    });
    expect(JSON.stringify(fetched)).not.toContain("u/local/");

    const download = structured(
      await tool(
        "get_asset_download",
        { id: begun.id },
        ["assets:read"],
        "machine-b",
      ),
    ) as { url: string; sha256: string };
    const bytes = await SELF.fetch(download.url);
    expect(bytes.status).toBe(200);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(SCREENSHOT);
    expect(download.sha256).toBe(await sha256Hex(SCREENSHOT.buffer));

    const read = await rpc(
      "resources/read",
      { uri: fetched.metadata && (fetched.metadata as { uri: string }).uri },
      ["assets:read"],
      "machine-b",
    );
    const blob = read.value.result?.contents?.[0]?.blob ?? "";
    expect(Uint8Array.from(atob(blob), (c) => c.charCodeAt(0))).toEqual(
      SCREENSHOT,
    );
  });

  it("separates read scopes: search:read sees metadata, only assets:read reaches bytes", async () => {
    const { begun } = await upload();
    const denied = await tool("get_asset_download", { id: begun.id }, [
      "search:read",
    ]);
    expect(denied.response.status).toBe(403);
    expect(denied.response.headers.get("www-authenticate")).toContain(
      "assets:read",
    );
    const resource = await rpc(
      "resources/read",
      { uri: `valise://asset/${begun.id.slice("asset:".length)}` },
      ["search:read", "skills:read"],
    );
    expect(resource.response.status).toBe(403);
    expect(resource.response.headers.get("www-authenticate")).toContain(
      "assets:read",
    );
  });

  it("keeps archived, expired and pending files out of broad discovery", async () => {
    const { begun } = await upload();
    structured(
      await tool(
        "upload_asset",
        { file_name: "kingfisher-pending.pdf", size: 10 },
        ["assets:write"],
      ),
    );
    for (const column of ["archived_at", "expires_at"]) {
      await env.DB.prepare(`UPDATE assets SET ${column} = 1 WHERE asset_id = ?`)
        .bind(begun.id.slice("asset:".length))
        .run();
      expect(
        structured(
          await tool("search", { query: "kingfisher", include_library: true }, [
            "search:read",
          ]),
        ).results,
      ).toEqual([]);
      await env.DB.prepare(
        `UPDATE assets SET ${column} = NULL WHERE asset_id = ?`,
      )
        .bind(begun.id.slice("asset:".length))
        .run();
    }
  });

  it("answers another user's asset id like a missing one", async () => {
    // This is an admitted second account, not an unverified or nonexistent principal.
    await env.DB.prepare(
      "INSERT INTO users (user_id, email, display_name, created_at, email_verified) VALUES ('other', 'other@example.test', 'Other', unixepoch(), 1)",
    ).run();
    const { begun } = await upload();
    for (const [name, scope, extra] of [
      ["fetch", "search:read", {}],
      ["get_asset_download", "assets:read", {}],
      ["update_asset", "assets:write", { title: "Taken" }],
    ] as const) {
      const call = await tool(
        name,
        { id: begun.id, ...extra },
        [scope],
        "other",
        "other",
      );
      expect(call.response.status).toBe(200);
      expect(call.value.result?.isError).toBe(true);
    }
    for (const extra of [{ type: "asset" }, { include_library: true }]) {
      const searched = structured(
        await tool(
          "search",
          { query: "kingfisher", ...extra },
          ["search:read"],
          "other",
          "other",
        ),
      );
      expect(searched.results).toEqual([]);
    }
  });

  it("refuses a repeated PUT without a second object, and hides an upload that never came", async () => {
    const { begun } = await upload();
    const again = await SELF.fetch(begun.upload.url, {
      method: "PUT",
      headers: begun.upload.headers,
      body: SCREENSHOT,
    });
    expect(again.status).toBe(401);
    expect(await again.text()).toContain("fetch the asset id");
    const { results } = await env.DB.prepare("SELECT 1 FROM objects").all();
    expect(results).toHaveLength(1);

    const pending = structured(
      await tool("upload_asset", { file_name: "never.pdf", size: 10 }, [
        "assets:write",
      ]),
    ) as { id: string };
    const hidden = await tool("fetch", { id: pending.id }, ["search:read"]);
    expect(hidden.value.result?.isError).toBe(true);
  });

  it("edits metadata and retention, never bytes, and expiry closes the download", async () => {
    const { begun } = await upload();
    const download = structured(
      await tool("get_asset_download", { id: begun.id }, ["assets:read"]),
    ) as { url: string };
    const updated = structured(
      await tool(
        "update_asset",
        { id: begun.id, description: "Step five", expires_in_seconds: 600 },
        ["assets:write"],
      ),
    );
    expect(updated).toMatchObject({ description: "Step five" });
    expect(updated.expires_at).toEqual(expect.any(Number));

    await env.DB.prepare("UPDATE assets SET expires_at = 1").run();
    expect((await SELF.fetch(download.url)).status).toBe(404);
    const fetched = await tool("fetch", { id: begun.id }, ["search:read"]);
    expect(fetched.value.result?.isError).toBe(true);
  });
});
