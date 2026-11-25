import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpScope } from "~/auth/scopes";
import { AssetRefused, MAX_ASSET_BYTES } from "~/concepts/assets";
import {
  type AttachedFile,
  storeAttachedFile,
} from "~/concepts/attached-files";
import { mintBearerToken } from "~/concepts/tokens";
import { sha256Hex } from "~/r2/objects";

/**
 * A file the MCP client attached to `upload_asset`, which Valise downloads
 * itself: ChatGPT's `openai/fileParams`. ADR-0015, amendment of 2026-11-25.
 * The download is injected, so these tests never leave the Worker.
 */

const PNG = new Uint8Array([
  137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 1, 2, 3,
]);
const ATTACHED: AttachedFile = {
  download_url: "https://files.example.com/download/file_abc?sig=secret",
  file_id: "file_abc",
  mime_type: "image/png",
  file_name: "whiteboard.png",
};
const assetEnv = {
  DB: env.DB,
  BUNDLES: env.BUNDLES,
  TOKEN_PEPPER: "local-test-token-pepper",
};
const provenance = {
  userId: "local",
  agent: "chatgpt",
  client: "oauth",
  session: null,
};

afterEach(async () => {
  for (const table of [
    "asset_processing",
    "search_docs",
    "assets",
    "objects",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

function serving(body: BodyInit | null, init: ResponseInit = {}) {
  return vi.fn(async (_input: string, _init?: RequestInit) => {
    return new Response(body, init);
  });
}

async function assetCount(): Promise<number> {
  const row = await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first<{
    n: number;
  }>();
  return row?.n ?? 0;
}

describe("storeAttachedFile", () => {
  it("downloads the attachment and stores it ready, keeping no link", async () => {
    const fetcher = serving(PNG, {
      headers: { "content-type": "application/octet-stream" },
    });
    const asset = await storeAttachedFile(
      assetEnv,
      ATTACHED,
      { title: "Whiteboard after planning", project: "valise" },
      provenance,
      fetcher,
    );
    expect(asset).toMatchObject({
      state: "ready",
      fileName: "whiteboard.png",
      // The client's type wins over the download's generic one.
      contentType: "image/png",
      size: PNG.byteLength,
      sha256: await sha256Hex(PNG.buffer),
      title: "Whiteboard after planning",
      project: "valise",
    });
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe(ATTACHED.download_url);
    // No Valise credential, cookie or bearer goes to someone else's host.
    const headers = new Headers(init?.headers);
    expect(headers.has("authorization")).toBe(false);
    expect(headers.has("cookie")).toBe(false);

    const row = await env.DB.prepare("SELECT * FROM assets WHERE asset_id = ?")
      .bind(asset.assetId)
      .first();
    expect(JSON.stringify(row)).not.toContain("sig=secret");
    expect(JSON.stringify(row)).not.toContain("files.example.com");
  });

  it("falls back to the download's type and the URL's file name", async () => {
    const asset = await storeAttachedFile(
      assetEnv,
      {
        download_url: "https://files.example.com/d/notes.pdf",
        file_id: "file_def",
      },
      {},
      provenance,
      serving("%PDF-1.7\n%%EOF\n", {
        headers: { "content-type": "application/pdf; charset=binary" },
      }),
    );
    expect(asset).toMatchObject({
      fileName: "notes.pdf",
      contentType: "application/pdf",
    });
  });

  it("refuses an expired link and writes nothing", async () => {
    const attempt = storeAttachedFile(
      assetEnv,
      ATTACHED,
      {},
      provenance,
      serving("gone", { status: 403 }),
    );
    await expect(attempt).rejects.toThrow(AssetRefused);
    await expect(attempt).rejects.toThrow(/expired\. Attach the file again/);
    expect(await assetCount()).toBe(0);
  });

  it("refuses a download over the size limit before reading it", async () => {
    const attempt = storeAttachedFile(
      assetEnv,
      ATTACHED,
      {},
      provenance,
      serving(PNG, {
        headers: { "content-length": String(MAX_ASSET_BYTES + 1) },
      }),
    );
    await expect(attempt).rejects.toThrow(/limit is 26214400 bytes/);
    expect(await assetCount()).toBe(0);
  });

  it("refuses an empty download", async () => {
    await expect(
      storeAttachedFile(
        assetEnv,
        ATTACHED,
        {},
        provenance,
        serving(new Uint8Array()),
      ),
    ).rejects.toThrow("The attached file is empty.");
    expect(await assetCount()).toBe(0);
  });

  it("refuses a mismatched checksum before any row is written", async () => {
    await expect(
      storeAttachedFile(
        assetEnv,
        ATTACHED,
        { sha256: "0".repeat(64) },
        provenance,
        serving(PNG),
      ),
    ).rejects.toThrow(/not the declared 0000/);
    expect(await assetCount()).toBe(0);
  });

  it.each([
    "http://files.example.com/file_abc",
    "https://localhost/file_abc",
    "https://127.0.0.1/file_abc",
    "https://user:pass@files.example.com/file_abc",
    "file:///etc/passwd",
  ])("never fetches %s", async (download_url) => {
    const fetcher = serving(PNG);
    await expect(
      storeAttachedFile(
        assetEnv,
        { ...ATTACHED, download_url },
        {},
        provenance,
        fetcher,
      ),
    ).rejects.toThrow(/not a public https URL/);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refuses a redirect to a private host", async () => {
    const fetcher = vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest" },
        }),
    );
    await expect(
      storeAttachedFile(assetEnv, ATTACHED, {}, provenance, fetcher),
    ).rejects.toThrow(/could not download/);
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await assetCount()).toBe(0);
  });
});

async function call(
  method: string,
  params: Record<string, unknown>,
  scopes: McpScope[],
) {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId: "local", label: crypto.randomUUID(), scopes },
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
  return JSON.parse(payload) as {
    result?: {
      isError?: boolean;
      content?: { type: string; text: string }[];
      tools?: {
        name: string;
        _meta?: Record<string, unknown>;
        inputSchema: {
          properties: Record<string, Record<string, unknown>>;
          required?: string[];
        };
      }[];
    };
  };
}

describe("upload_asset with an attached file", () => {
  it("declares file as an OpenAI file parameter with all four properties", async () => {
    const listed = await call("tools/list", {}, ["assets:write"]);
    const upload = listed.result?.tools?.find(
      (entry) => entry.name === "upload_asset",
    );
    expect(upload?._meta).toMatchObject({ "openai/fileParams": ["file"] });
    const file = upload?.inputSchema.properties.file;
    expect(file).toMatchObject({
      type: "object",
      required: ["download_url", "file_id"],
    });
    expect(Object.keys(file?.properties as object).sort()).toEqual([
      "download_url",
      "file_id",
      "file_name",
      "mime_type",
    ]);
    // A ChatGPT call can carry only file; the PUT path checks its own two.
    expect(upload?.inputSchema.required ?? []).not.toContain("file_name");
    expect(upload?.inputSchema.required ?? []).not.toContain("size");
  });

  it("answers a link it will not fetch as a tool error and stores nothing", async () => {
    const answer = await call(
      "tools/call",
      {
        name: "upload_asset",
        arguments: {
          file: { download_url: "https://localhost/x", file_id: "file_x" },
        },
      },
      ["assets:write"],
    );
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toMatch(/not a public https URL/);
    expect(await assetCount()).toBe(0);
  });

  it("still asks a PUT upload for its name and size", async () => {
    const answer = await call(
      "tools/call",
      { name: "upload_asset", arguments: { title: "No file at all" } },
      ["assets:write"],
    );
    expect(answer.result?.isError).toBe(true);
    expect(answer.result?.content?.[0]?.text).toContain(
      "Give file_name and size",
    );
    expect(await assetCount()).toBe(0);
  });
});
