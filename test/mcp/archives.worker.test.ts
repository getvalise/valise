import { createExecutionContext, env, SELF } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpScope } from "~/auth/scopes";
import { mintBearerToken } from "~/concepts/tokens";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { loader as archiveRoute } from "~/routes/library-archive";

/**
 * Archived pages as folders, ADR-0015 amendment of 2026-10-30: upload_asset's
 * folder, save_source's check, the signed viewer and its console redirect.
 */

const ORIGIN = "http://localhost";
const PEPPER = "local-test-token-pepper";
const HTML =
  '<!doctype html><link rel="stylesheet" href="page.css"><p>Wren</p>';

beforeEach(async () => {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO users (user_id, email, display_name, created_at, email_verified) VALUES ('other', 'other@example.test', 'Other', unixepoch(), 1)",
  ).run();
});

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "asset_folder_files",
    "assets",
    "asset_folders",
    "objects",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
  await env.DB.prepare("DELETE FROM users WHERE user_id = 'other'").run();
});

type Result = {
  isError?: boolean;
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
};

async function tool(
  name: string,
  args: Record<string, unknown>,
  scopes: McpScope[],
  userId = "local",
): Promise<Result> {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: PEPPER },
    { userId, label: crypto.randomUUID(), scopes },
  );
  const response = await SELF.fetch(
    new Request(`${ORIGIN}/mcp`, {
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
        id: 1,
        method: "tools/call",
        params: { name, arguments: args },
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
  const value = JSON.parse(payload) as { result?: Result; error?: unknown };
  if (!value.result) throw new Error(raw);
  return value.result;
}

function text(result: Result): string {
  return result.content?.map((part) => part.text).join("\n") ?? "";
}

/** Begins an upload; with `put`, sends the bytes so the asset is ready. */
async function upload(
  fileName: string,
  contentType: string,
  body: string | Uint8Array,
  options: { folder?: string; userId?: string; put?: boolean } = {},
) {
  const bytes =
    typeof body === "string" ? new TextEncoder().encode(body) : body;
  const begun = await tool(
    "upload_asset",
    {
      file_name: fileName,
      content_type: contentType,
      size: bytes.byteLength,
      ...(options.folder ? { folder: options.folder } : {}),
    },
    ["assets:write"],
    options.userId,
  );
  if (begun.isError) return { begun, id: "", folder: undefined };
  const out = begun.structuredContent as {
    id: string;
    folder?: string;
    upload: { url: string; headers: Record<string, string> };
  };
  if (options.put !== false) {
    const put = await SELF.fetch(out.upload.url, {
      method: "PUT",
      headers: out.upload.headers,
      body: bytes,
    });
    expect(put.status, await put.clone().text()).toBe(200);
  }
  return { begun, id: out.id, folder: out.folder };
}

async function count(table: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

function bare(ref: string): string {
  return ref.replace(/^asset:/, "");
}

async function sign(folderId: string, expires: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(PEPPER),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`asset-archive:${folderId}:${expires}`),
    ),
  );
  return btoa(String.fromCharCode(...signature))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

async function openArchive(assetId: string, userId = "local") {
  const url = new URL(`${ORIGIN}/library/archive/${assetId}`);
  const cookie = await createSessionCookie(
    { DB: env.DB, SESSION_SECRET: "local-test-session-secret" },
    new Request(url),
    userId,
  );
  const provider = new RouterContextProvider();
  provider.set(consoleContext, { env, ctx: createExecutionContext() });
  try {
    return (await archiveRoute({
      context: provider,
      request: new Request(url, { headers: { cookie: cookie.split(";")[0] } }),
      params: { assetId },
      url,
      pattern: "/library/archive/:assetId",
    } as Parameters<typeof archiveRoute>[0])) as Response;
  } catch (thrown) {
    if (thrown instanceof Response) return thrown;
    throw thrown;
  }
}

describe("upload_asset folder", () => {
  it("files the new upload in the named asset's folder and reports it", async () => {
    const page = await upload("page.html", "text/html", HTML);
    const css = await upload("page.css", "text/css", "p{color:red}", {
      folder: page.id,
    });
    expect(css.folder).toBe(page.id);
    const members = await env.DB.prepare(
      "SELECT asset_id FROM asset_folder_files WHERE folder_id = ? ORDER BY asset_id",
    )
      .bind(bare(page.id))
      .all<{ asset_id: string }>();
    expect(members.results.map((row) => row.asset_id).sort()).toEqual(
      [bare(page.id), bare(css.id)].sort(),
    );
    expect(
      await env.DB.prepare("SELECT 1 FROM asset_folders WHERE folder_id = ?")
        .bind(bare(css.id))
        .first(),
    ).toBeNull();
    const plain = await upload("note.png", "image/png", new Uint8Array([1]));
    expect(plain.begun.structuredContent).not.toHaveProperty("folder");
  });

  it("refuses another user's asset, a pending one, and a full folder before writing a row", async () => {
    const theirs = await upload("theirs.html", "text/html", HTML, {
      userId: "other",
    });
    const pending = await upload("pending.html", "text/html", HTML, {
      put: false,
    });
    const page = await upload("page.html", "text/html", HTML);
    const folderId = bare(page.id);
    const statements = [];
    for (let index = 1; index < 100; index++) {
      const assetId = `ast_${crypto.randomUUID()}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO assets (asset_id, user_id, state, title, description, file_name, content_type,
             declared_size, tags_json, source_agent, source_client, created_at, updated_at)
           VALUES (?, 'local', 'pending', 'x', '', ?, 'text/css', 1, '[]', 'test', 'test', 0, 0)`,
        ).bind(assetId, `f-${index}.css`),
        env.DB.prepare(
          "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = ?",
        ).bind(folderId, assetId),
      );
    }
    await env.DB.batch(statements);
    const before = await count("assets");
    for (const [folder, message] of [
      [theirs.id, "No ready asset exists"],
      [pending.id, "No ready asset exists"],
      [page.id, "100 files"],
    ] as const) {
      const refused = await upload("page.css", "text/css", "p{}", {
        folder,
      });
      expect(refused.begun.isError).toBe(true);
      expect(text(refused.begun)).toContain(message);
    }
    expect(await count("assets")).toBe(before);
  });
});

describe("update_asset folder", () => {
  type Folder = {
    name: string | null;
    count: number;
    files: { id: string; title: string; file_name: string }[];
  };
  const folderOf = async (id: string, userId = "local") =>
    (
      (await tool("fetch", { id }, ["search:read"], userId))
        .structuredContent as { metadata: { folder: Folder | null } }
    ).metadata.folder;

  it("moves a file into another file's folder, renames it, and fetch lists the members", async () => {
    const page = await upload("page.html", "text/html", HTML);
    const css = await upload("style.css", "text/css", "p{}");
    const moved = await tool(
      "update_asset",
      { id: css.id, folder: page.id, folder_name: "Public page, saved" },
      ["assets:write"],
    );
    expect(moved.isError, text(moved)).toBeFalsy();
    expect(moved.structuredContent).toMatchObject({
      id: css.id,
      folder: { name: "Public page, saved", count: 2 },
    });
    const listed = await folderOf(page.id);
    expect(listed?.files.map((file) => file.id).sort()).toEqual(
      [page.id, css.id].sort(),
    );
    // The stylesheet's own folder emptied and went away; nothing else moved.
    expect(
      await env.DB.prepare("SELECT 1 FROM asset_folders WHERE folder_id = ?")
        .bind(bare(css.id))
        .first(),
    ).toBeNull();
    // The same call again is a no-op success: safe to retry.
    const again = await tool(
      "update_asset",
      { id: css.id, folder: page.id, folder_name: "Public page, saved" },
      ["assets:write"],
    );
    expect(again.isError, text(again)).toBeFalsy();
    expect((await folderOf(page.id))?.count).toBe(2);
  });

  it("keeps metadata and refuses another owner's, a pending or a full folder without changing anything", async () => {
    const theirs = await upload("theirs.html", "text/html", HTML, {
      userId: "other",
    });
    const pending = await upload("pending.html", "text/html", HTML, {
      put: false,
    });
    const page = await upload("page.html", "text/html", HTML);
    const loose = await upload("loose.css", "text/css", "p{}");
    const statements = [];
    for (let index = 1; index < 100; index++) {
      const assetId = `ast_${crypto.randomUUID()}`;
      statements.push(
        env.DB.prepare(
          `INSERT INTO assets (asset_id, user_id, state, title, description, file_name, content_type,
             declared_size, tags_json, source_agent, source_client, created_at, updated_at)
           VALUES (?, 'local', 'pending', 'x', '', ?, 'text/css', 1, '[]', 'test', 'test', 0, 0)`,
        ).bind(assetId, `f-${index}.css`),
        env.DB.prepare(
          "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = ?",
        ).bind(bare(page.id), assetId),
      );
    }
    await env.DB.batch(statements);
    for (const [folder, message] of [
      [theirs.id, "No ready asset exists"],
      [pending.id, "No ready asset exists"],
      [page.id, "100 files"],
    ] as const) {
      const refused = await tool(
        "update_asset",
        { id: loose.id, folder, title: "Should not apply" },
        ["assets:write"],
      );
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain(message);
    }
    const unchanged = (await tool("fetch", { id: loose.id }, ["search:read"]))
      .structuredContent as {
      title: string;
      metadata: { folder: Folder };
    };
    expect(unchanged.title).not.toBe("Should not apply");
    expect(unchanged.metadata.folder.files.map((file) => file.id)).toEqual([
      loose.id,
    ]);
    // Another owner cannot rename or move this owner's files either.
    const foreign = await tool(
      "update_asset",
      { id: loose.id, folder_name: "Mine now" },
      ["assets:write"],
      "other",
    );
    expect(foreign.isError).toBe(true);
    expect((await folderOf(loose.id))?.name).not.toBe("Mine now");
  });
});

describe("save_source check", () => {
  const URL_SAVED = "https://example.org/wren";

  it("lists unarchived sources at the exact URL with their archive, and writes nothing", async () => {
    const empty = await tool("save_source", { check: true, url: URL_SAVED }, [
      "sources:write",
    ]);
    expect(empty.structuredContent).toEqual({
      saved: [],
      vocabulary: { projects: [], tags: [] },
    });

    const bookmark = await tool(
      "save_source",
      {
        kind: "bookmark",
        title: "Wren bookmark",
        url: URL_SAVED,
        notes: "Nests under the harbour wall.",
        project: "coast",
        tags: ["harbour", "wren"],
      },
      ["sources:write"],
    );
    const page = await upload("page.html", "text/html", HTML);
    const css = await upload("page.css", "text/css", "p{}", {
      folder: page.id,
    });
    const document = await tool(
      "save_source",
      {
        kind: "document",
        title: "Wren page",
        url: URL_SAVED,
        asset_ids: [css.id, page.id],
      },
      ["sources:write", "assets:read"],
    );
    const archived = await tool(
      "save_source",
      { kind: "reference", title: "Archived wren", url: URL_SAVED },
      ["sources:write"],
    );
    await env.DB.prepare(
      "UPDATE sources SET archived_at = unixepoch() WHERE source_id = ?",
    )
      .bind(String(archived.structuredContent?.id).replace(/^source:/, ""))
      .run();
    await tool(
      "save_source",
      {
        kind: "bookmark",
        title: "Their wren",
        url: URL_SAVED,
        project: "their-project",
        tags: ["their-tag"],
      },
      ["sources:write"],
      "other",
    );
    await tool(
      "save_source",
      {
        kind: "bookmark",
        title: "Other page",
        url: `${URL_SAVED}/`,
        tags: ["harbour"],
      },
      ["sources:write"],
    );
    await env.DB.prepare(
      "UPDATE sources SET updated_at = updated_at + 10 WHERE source_id = ?",
    )
      .bind(String(document.structuredContent?.id).replace(/^source:/, ""))
      .run();

    const tables = [
      "sources",
      "source_revisions",
      "source_revision_assets",
      "assets",
      "search_docs",
    ];
    const before = await Promise.all(tables.map(count));
    const checked = await tool("save_source", { check: true, url: URL_SAVED }, [
      "sources:write",
    ]);
    expect(checked.isError).toBeFalsy();
    const saved = (
      checked.structuredContent as { saved: Record<string, unknown>[] }
    ).saved;
    expect(saved).toHaveLength(2);
    expect(saved[0]).toMatchObject({
      id: document.structuredContent?.id,
      kind: "document",
      title: "Wren page",
      revision: 1,
      notes: "",
      archive_asset_id: page.id,
    });
    // The note comes whole, so the popup can show it before a save again.
    expect(saved[1]).toMatchObject({
      id: bookmark.structuredContent?.id,
      kind: "bookmark",
      notes: "Nests under the harbour wall.",
      archive_asset_id: null,
    });
    expect(typeof saved[0].updated_at).toBe("number");
    // Names only, most used first, never another owner's.
    expect(checked.structuredContent?.vocabulary).toEqual({
      projects: ["coast"],
      tags: ["harbour", "wren"],
    });
    expect(await Promise.all(tables.map(count))).toEqual(before);
  });

  it("offers at most 50 projects and 50 tags", async () => {
    for (let page = 0; page < 3; page++)
      await tool(
        "save_source",
        {
          kind: "bookmark",
          title: `Page ${page}`,
          url: `https://example.org/page-${page}`,
          project: `project-${page}`,
          tags: [
            "common",
            ...Array.from(
              { length: 19 },
              (_, index) => `tag-${page}-${String(index).padStart(2, "0")}`,
            ),
          ],
        },
        ["sources:write"],
      );
    const checked = await tool("save_source", { check: true, url: URL_SAVED }, [
      "sources:write",
    ]);
    const vocabulary = checked.structuredContent?.vocabulary as {
      projects: string[];
      tags: string[];
    };
    expect(vocabulary.projects).toEqual([
      "project-0",
      "project-1",
      "project-2",
    ]);
    expect(vocabulary.tags).toHaveLength(50);
    expect(vocabulary.tags[0]).toBe("common");
  });

  it("requires a url in check mode", async () => {
    const call = await tool("save_source", { check: true }, ["sources:write"]);
    expect(call.isError).toBe(true);
    expect(text(call)).toContain("Missing or invalid: url");
  });
});

describe("archive viewer", () => {
  const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1]);
  const FONT = new Uint8Array([119, 79, 70, 50, 0, 1]);

  async function archive() {
    const page = await upload("page.html", "text/html", HTML);
    for (const [name, type, body] of [
      ["page.css", "text/css", "p{color:red}"],
      ["img-001.png", "image/png", PNG],
      ["font-001.woff2", "font/woff2", FONT],
      ["run.js", "text/javascript", "alert(1)"],
    ] as const)
      await upload(name, type, body, { folder: page.id });
    const opened = await openArchive(page.id);
    expect(opened.status).toBe(303);
    const location = opened.headers.get("location") ?? "";
    return { page, location, prefix: location.replace(/page\.html$/, "") };
  }

  it("serves each folder member under the capability prefix with the sandbox headers", async () => {
    const { page, location, prefix } = await archive();
    expect(location).toMatch(
      new RegExp(
        `^${ORIGIN}/archives/${bare(page.id)}/\\d+/[\\w-]{43}/page\\.html$`,
      ),
    );
    const csp = `sandbox; default-src 'none'; img-src ${prefix} data:; style-src ${prefix} 'unsafe-inline'; font-src ${prefix} data:; base-uri 'none'; form-action 'none'`;
    for (const [name, type, body] of [
      ["page.html", "text/html; charset=utf-8", HTML],
      ["page.css", "text/css; charset=utf-8", "p{color:red}"],
      ["img-001.png", "image/png", null],
      ["font-001.woff2", "font/woff2", null],
    ] as const) {
      const response = await SELF.fetch(`${prefix}${name}`);
      expect(response.status, name).toBe(200);
      const headers = Object.fromEntries(response.headers);
      expect(headers).toMatchObject({
        "content-type": type,
        "x-content-type-options": "nosniff",
        "referrer-policy": "no-referrer",
        "cache-control": "private, no-store",
        "cross-origin-resource-policy": "cross-origin",
        "content-security-policy": csp,
      });
      expect(headers["content-disposition"]).toBeUndefined();
      expect(headers["access-control-allow-origin"]).toBe(
        type.startsWith("font/") ? "*" : undefined,
      );
      if (body !== null) expect(await response.text()).toBe(body);
      else await response.arrayBuffer();
    }
  });

  it("answers 403 for a bad or expired signature and 404 for a wrong name, type or folder", async () => {
    const { page, prefix } = await archive();
    const folderId = bare(page.id);
    const [, , , expires, signature] = new URL(prefix).pathname.split("/");
    const forged = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    const past = Math.floor(Date.now() / 1000) - 10;
    const far = Math.floor(Date.now() / 1000) + 2 * 60 * 60;
    for (const path of [
      `/archives/${folderId}/${expires}/${forged}/page.html`,
      `/archives/${folderId}/${past}/${await sign(folderId, past)}/page.html`,
      `/archives/${folderId}/${far}/${await sign(folderId, far)}/page.html`,
      `/archives/${folderId}/${expires}/page.html`,
      `/archives/ast_00000000-0000-0000-0000-000000000001/${expires}/${signature}/page.html`,
    ]) {
      const response = await SELF.fetch(`${ORIGIN}${path}`);
      expect(response.status, path).toBe(403);
      await response.arrayBuffer();
    }
    const elsewhere = await upload("stray.png", "image/png", PNG);
    expect(elsewhere.folder).toBeUndefined();
    for (const name of ["missing.css", "run.js", "stray.png"]) {
      const response = await SELF.fetch(`${prefix}${name}`);
      expect(response.status, name).toBe(404);
      await response.arrayBuffer();
    }
    const post = await SELF.fetch(`${prefix}page.html`, { method: "POST" });
    expect(post.status).toBe(405);
  });

  it("redirects only the owner, and only for an HTML asset", async () => {
    const page = await upload("page.html", "text/html", HTML);
    const image = await upload("img.png", "image/png", PNG);
    expect((await openArchive(page.id)).status).toBe(303);
    expect((await openArchive(page.id, "other")).status).toBe(404);
    expect((await openArchive(image.id)).status).toBe(404);
  });
});
