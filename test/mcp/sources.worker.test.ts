import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpScope } from "~/auth/scopes";
import { mintBearerToken } from "~/concepts/tokens";

/**
 * ADR-0015's dogfood checks through the Worker's own MCP path, one bearer
 * token per call so each call is a separate authenticated client.
 */

const PDF = new TextEncoder().encode("%PDF-1.7\nheron whitepaper\n%%EOF\n");

/** An invited member on the free allowance; `local` is the owner. */
const MEMBER = "usr_member-limits";
async function member() {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO users (user_id, email, display_name, role, plan, created_at, email_verified)
     VALUES (?, 'member-limits@example.test', 'Member', 'member', 'free', 1, 1)`,
  )
    .bind(MEMBER)
    .run();
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    "search_docs",
    "source_articles",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?")
    .bind(MEMBER)
    .run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
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
): Promise<{ response: Response; result?: Result }> {
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
        method: "tools/call",
        params: { name, arguments: args },
      }),
    }),
  );
  const raw = await response.clone().text();
  const payload =
    raw
      .split("\n")
      .find((line) => line.startsWith("data:"))
      ?.slice(5)
      .trim() ?? raw;
  return { response, result: JSON.parse(payload).result };
}

function ok(call: { result?: Result }) {
  if (!call.result || call.result.isError)
    throw new Error(JSON.stringify(call.result));
  return call.result.structuredContent as Record<string, unknown>;
}

async function uploadPdf(): Promise<string> {
  const begun = ok(
    await tool(
      "upload_asset",
      {
        file_name: "heron-whitepaper.pdf",
        content_type: "application/pdf",
        size: PDF.byteLength,
      },
      ["assets:write"],
    ),
  ) as { id: string; upload: { url: string } };
  const put = await SELF.fetch(begun.upload.url, { method: "PUT", body: PDF });
  if (put.status !== 200) throw new Error(await put.text());
  return begun.id;
}

describe("save_source", () => {
  it("saves a bookmark with notes that another client finds", async () => {
    const saved = ok(
      await tool(
        "save_source",
        {
          kind: "bookmark",
          title: "Tern queue design notes",
          url: "https://example.com/tern",
          notes: "Lease renewals must outlive the slowest step.",
          tags: ["queues"],
        },
        ["sources:write"],
      ),
    );
    expect(saved).toMatchObject({ revision: 1, content_indexed: false });

    const found = await tool(
      "search",
      { query: "lease renewals", type: "source" },
      ["search:read"],
    );
    expect(ok(found).results).toEqual([
      expect.objectContaining({
        id: saved.id,
        type: "source",
        metadata: expect.objectContaining({
          created_at: expect.any(Number),
          saved_by: expect.any(String),
        }),
      }),
    ]);
    expect(found.result?.content?.at(-1)?.text).toContain("not indexed");

    const fetched = ok(await tool("fetch", { id: saved.id }, ["search:read"]));
    expect(fetched).toMatchObject({
      text: "Lease renewals must outlive the slowest step.",
      metadata: { url: "https://example.com/tern", revision: 1 },
    });
  });

  it("finds a PDF-backed source by its notes and downloads the unchanged original", async () => {
    const assetId = await uploadPdf();

    // Citing a file needs the right to read it.
    const denied = await tool(
      "save_source",
      {
        kind: "document",
        title: "Heron migration whitepaper",
        notes: "Section three covers the cutover window.",
        asset_ids: [assetId],
      },
      ["sources:write"],
    );
    expect(denied.response.status).toBe(403);
    expect(denied.response.headers.get("www-authenticate")).toContain(
      "assets:read",
    );

    const saved = ok(
      await tool(
        "save_source",
        {
          kind: "document",
          title: "Heron migration whitepaper",
          notes: "Section three covers the cutover window.",
          asset_ids: [assetId],
        },
        ["sources:write", "assets:read"],
      ),
    );
    expect(saved.assets).toEqual([
      expect.objectContaining({ id: assetId, available: true }),
    ]);

    const found = ok(
      await tool("search", { query: "cutover window", type: "source" }, [
        "search:read",
      ]),
    );
    expect(found.results).toEqual([expect.objectContaining({ id: saved.id })]);
    // The words inside the PDF are not searchable.
    const inside = ok(
      await tool("search", { query: "whitepaper", type: "asset" }, [
        "search:read",
      ]),
    );
    expect(inside.results).toEqual([
      expect.objectContaining({
        id: assetId,
        metadata: expect.objectContaining({
          created_at: expect.any(Number),
          saved_by: expect.any(String),
        }),
      }),
    ]);
    const notIndexed = ok(
      await tool("search", { query: "%%EOF", type: "asset" }, ["search:read"]),
    );
    expect(notIndexed.results).toEqual([]);

    const download = ok(
      await tool("get_asset_download", { id: assetId }, ["assets:read"]),
    ) as { url: string };
    const bytes = await SELF.fetch(download.url);
    expect(new Uint8Array(await bytes.arrayBuffer())).toEqual(PDF);
  });

  it("refuses a stale revision with the current one", async () => {
    const saved = ok(
      await tool(
        "save_source",
        { kind: "reference", title: "Gannet paper", notes: "v1" },
        ["sources:write"],
      ),
    );
    ok(
      await tool(
        "save_source",
        { id: saved.id, expected_revision: 1, notes: "v2" },
        ["sources:write"],
      ),
    );
    const stale = await tool(
      "save_source",
      { id: saved.id, expected_revision: 1, notes: "v2 from elsewhere" },
      ["sources:write"],
    );
    expect(stale.result?.isError).toBe(true);
    expect(stale.result?.content?.[0]?.text).toContain("revision 2");

    const missing = await tool(
      "save_source",
      { id: saved.id, notes: "no revision" },
      ["sources:write"],
    );
    expect(missing.result?.isError).toBe(true);
    expect(missing.result?.content?.[0]?.text).toContain("expected_revision");
  });

  it("versions a bookmark saved again at the same URL instead of duplicating it", async () => {
    const post = {
      kind: "bookmark",
      title: "@petrel: media post",
      url: "https://x.com/petrel/status/1",
      notes: "Saved from X bookmarks.",
      tags: ["x-bookmark"],
    };
    const first = ok(await tool("save_source", post, ["sources:write"]));

    // A rerun with nothing new changes nothing.
    const rerun = ok(await tool("save_source", post, ["sources:write"]));
    expect(rerun).toMatchObject({ id: first.id, revision: 1 });

    const revised = ok(
      await tool(
        "save_source",
        { ...post, title: "@petrel: Storm petrel field notes" },
        ["sources:write"],
      ),
    );
    expect(revised).toMatchObject({
      id: first.id,
      revision: 2,
      title: "@petrel: Storm petrel field notes",
      notes: "Saved from X bookmarks.",
    });
    const fetched = ok(await tool("fetch", { id: first.id }, ["search:read"]));
    expect(
      (fetched.metadata as { revisions: { title: string }[] }).revisions.map(
        (revision) => revision.title,
      ),
    ).toEqual(["@petrel: media post", "@petrel: Storm petrel field notes"]);

    // Highlights share their page's URL and stay separate sources.
    const highlight = {
      ...post,
      kind: "reference",
      title: "Petrel — Highlight",
    };
    const one = ok(await tool("save_source", highlight, ["sources:write"]));
    const two = ok(await tool("save_source", highlight, ["sources:write"]));
    expect(new Set([first.id, one.id, two.id]).size).toBe(3);

    // An archived bookmark is not revived; saving again starts a new one.
    await env.DB.prepare(
      "UPDATE sources SET archived_at = updated_at WHERE source_id = ?",
    )
      .bind(String(first.id).slice("source:".length))
      .run();
    const again = ok(await tool("save_source", post, ["sources:write"]));
    expect(again).toMatchObject({ revision: 1 });
    expect(again.id).not.toBe(first.id);
  });

  it("keeps when a post was published beside when it was saved, and a rerun adds it", async () => {
    const post = {
      kind: "bookmark",
      title: "@petrel: dawn count",
      url: "https://x.com/petrel/status/2",
      notes: "Forty petrels at dawn.",
    };
    const first = ok(await tool("save_source", post, ["sources:write"]));
    expect(first).toMatchObject({ revision: 1, published_at: null });

    // The capture rerun from the X recipe: same URL, now with a date.
    const dated = ok(
      await tool(
        "save_source",
        { ...post, published: "2026-10-12T06:40:00.000Z" },
        ["sources:write"],
      ),
    );
    expect(dated).toMatchObject({
      id: first.id,
      revision: 2,
      published_at: Date.parse("2026-10-12T06:40:00Z") / 1000,
    });
    expect(dated.created_at).toBe(first.created_at);

    // Omitted keeps it; a rerun with the same date changes nothing.
    const kept = ok(
      await tool(
        "save_source",
        {
          id: first.id,
          expected_revision: 2,
          title: "@petrel: dawn count, 40",
        },
        ["sources:write"],
      ),
    );
    expect(kept).toMatchObject({
      revision: 3,
      published_at: dated.published_at,
    });
    const same = ok(
      await tool(
        "save_source",
        {
          ...post,
          title: "@petrel: dawn count, 40",
          published: "2026-10-12T06:40:00Z",
        },
        ["sources:write"],
      ),
    );
    expect(same).toMatchObject({ revision: 3 });
    const { results } = await env.DB.prepare(
      "SELECT revision, published_at AS publishedAt FROM source_revisions WHERE source_id = ? ORDER BY revision",
    )
      .bind(String(first.id).slice("source:".length))
      .all();
    expect(results).toEqual([
      { revision: 1, publishedAt: null },
      { revision: 2, publishedAt: dated.published_at },
      { revision: 3, publishedAt: dated.published_at },
    ]);

    // An article's own date counts when no published is given.
    const article = ok(
      await tool(
        "save_source",
        {
          kind: "document",
          title: "Petrel survey",
          url: "https://example.org/petrels",
          article: {
            detected: true,
            markdown: "Survey.",
            text: "Survey.",
            word_count: 1,
            page_word_count: 1,
            extractor: "defuddle-0.19",
            published: "2025-03-01",
          },
        },
        ["sources:write"],
      ),
    );
    expect(article.published_at).toBe(Date.parse("2025-03-01") / 1000);

    const refused = await tool(
      "save_source",
      { ...post, published: "last Tuesday" },
      ["sources:write"],
    );
    expect(refused.result?.isError).toBe(true);
    expect(JSON.stringify(refused.result)).toContain(
      "Missing or invalid: published.",
    );
  });

  it("fetches a bookmark's images into linked files once, within the account's limits", async () => {
    await member();
    const png = (size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set([0x89, 0x50, 0x4e, 0x47]);
      bytes[size - 1] = size % 251;
      return bytes;
    };
    const site: Record<string, () => Response> = {
      "https://img.example/robots.txt": () =>
        new Response("User-agent: *\nAllow: /"),
      "https://img.example/media/dawn.jpg": () =>
        new Response(png(40_000), {
          headers: { "content-type": "image/jpeg" },
        }),
      "https://img.example/media/huge.png": () =>
        new Response(png(1_200_000), {
          headers: { "content-type": "image/png" },
        }),
      "https://img.example/post.html": () =>
        new Response("<p>hi</p>", { headers: { "content-type": "text/html" } }),
      "https://shy.example/robots.txt": () =>
        new Response("User-agent: *\nDisallow: /"),
    };
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (input) =>
        (site[String(input)] ?? (() => new Response("", { status: 404 })))(),
      );
    const post = {
      kind: "bookmark",
      title: "@petrel: dawn photos",
      url: "https://x.com/petrel/status/9",
      notes: "Four petrels at dawn.",
      images: [
        "https://img.example/media/dawn.jpg",
        "https://img.example/media/huge.png",
        "https://img.example/post.html",
        "https://shy.example/p.jpg",
      ],
    };
    const first = ok(
      await tool(
        "save_source",
        post,
        ["sources:write", "assets:write"],
        MEMBER,
      ),
    ) as {
      id: string;
      revision: number;
      assets: { id: string; file_name: string }[];
      images: { url: string; id: string | null; refused: string | null }[];
    };
    expect(first.images.map((image) => image.refused)).toEqual([
      null,
      "larger than the 1 MB this bookmark has left for images",
      "not a PNG, JPEG, GIF or WebP image (text/html)",
      "the site's robots.txt asks not to be fetched",
    ]);
    expect(first.assets).toEqual([
      expect.objectContaining({
        id: first.images[0].id,
        file_name: "dawn.jpg",
      }),
    ]);
    expect(http).not.toHaveBeenCalledWith(
      "https://shy.example/p.jpg",
      expect.anything(),
    );

    // The capture rerun: the same bytes are linked already, so nothing changes.
    const rerun = ok(
      await tool(
        "save_source",
        post,
        ["sources:write", "assets:write"],
        MEMBER,
      ),
    ) as typeof first;
    expect(rerun).toMatchObject({ id: first.id, revision: 1 });
    expect(rerun.images[0].id).toBe(first.images[0].id);
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM assets").first("n"),
    ).toBe(1);

    // Fetching images makes files, so it needs assets:write.
    const denied = await tool("save_source", post, ["sources:write"], MEMBER);
    expect(denied.response.status).toBe(403);
    expect(await denied.response.text()).toContain("assets:write");

    const reference = await tool(
      "save_source",
      { ...post, kind: "reference", title: "Petrel note" },
      ["sources:write", "assets:write"],
      MEMBER,
    );
    expect(reference.result?.isError).toBe(true);
  });

  it("holds a bookmark's linked files to the account's per-type and per-bookmark limits", async () => {
    await member();
    const upload = async (name: string, type: string, size: number) => {
      const bytes = new Uint8Array(size);
      bytes.set(PDF.subarray(0, Math.min(size, PDF.byteLength)));
      bytes[size - 1] = size % 251;
      const begun = ok(
        await tool(
          "upload_asset",
          { file_name: name, content_type: type, size },
          ["assets:write"],
          MEMBER,
        ),
      ) as { id: string; upload: { url: string } };
      const put = await SELF.fetch(begun.upload.url, {
        method: "PUT",
        body: bytes,
      });
      if (put.status !== 200) throw new Error(await put.text());
      return begun.id;
    };
    const large = await upload("survey.pdf", "application/pdf", 2_500_000);
    const refused = await tool(
      "save_source",
      {
        kind: "bookmark",
        title: "Petrel survey",
        url: "https://example.org/survey",
        asset_ids: [large],
      },
      ["sources:write", "assets:read"],
      MEMBER,
    );
    expect(refused.result?.isError).toBe(true);
    expect(JSON.stringify(refused.result)).toContain(
      "a bookmark's pdfs are limited to 2 MB each on this account",
    );
    // A document is its files; the bookmark allowance does not apply.
    ok(
      await tool(
        "save_source",
        { kind: "document", title: "Petrel survey", asset_ids: [large] },
        ["sources:write", "assets:read"],
        MEMBER,
      ),
    );
  });

  it("stores a captured article and its authors, and searches the article text", async () => {
    const markdown =
      "Kettering measured before she acted, and recorded when the floats went the other way.";
    const saved = ok(
      await tool(
        "save_source",
        {
          kind: "document",
          title: "The engineer who measured Wrenmouth harbour",
          url: "https://example.com/wrenmouth",
          authors: ["Mara Lindqvist", " Tomas  Oyelaran ", "mara lindqvist"],
          article: {
            detected: true,
            markdown,
            text: markdown,
            word_count: 418,
            page_word_count: 504,
            extractor: "defuddle-0.19",
            published: "2026-09-14T08:00:00Z",
            site_name: "Coastal Notes",
            canonical_url: "https://example.com/wrenmouth?ref=canonical",
            language: "en-GB",
          },
        },
        ["sources:write"],
      ),
    );
    expect(saved).toMatchObject({
      authors: ["Mara Lindqvist", "Tomas Oyelaran"],
      article: {
        detected: true,
        word_count: 418,
        site_name: "Coastal Notes",
        revision: 1,
      },
    });

    for (const query of ["floats went the other way", "Oyelaran"]) {
      const found = ok(
        await tool("search", { query, type: "source" }, ["search:read"]),
      );
      expect(found.results).toEqual([
        expect.objectContaining({ id: saved.id }),
      ]);
    }

    const fetched = ok(await tool("fetch", { id: saved.id }, ["search:read"]));
    expect(fetched.text).toContain(markdown);
    expect(fetched.metadata).toMatchObject({
      authors: ["Mara Lindqvist", "Tomas Oyelaran"],
      article: { canonical_url: "https://example.com/wrenmouth?ref=canonical" },
    });

    // A later edit without an article keeps the captured one searchable.
    ok(
      await tool(
        "save_source",
        { id: saved.id, expected_revision: 1, notes: "Read for the method." },
        ["sources:write"],
      ),
    );
    const again = ok(
      await tool("search", { query: "floats", type: "source" }, [
        "search:read",
      ]),
    );
    expect(again.results).toHaveLength(1);
  });

  it("keeps an undetected article as metadata only", async () => {
    const saved = ok(
      await tool(
        "save_source",
        {
          kind: "document",
          title: "Shop front",
          url: "https://example.com/shop",
          article: {
            detected: false,
            markdown: "Menu Cart Checkout",
            text: "Menu Cart Checkout",
            word_count: 3,
            page_word_count: 900,
            extractor: "defuddle-0.19",
          },
        },
        ["sources:write"],
      ),
    );
    expect(saved).toMatchObject({
      authors: [],
      article: { detected: false, word_count: 3 },
    });
    const found = ok(
      await tool("search", { query: "checkout", type: "source" }, [
        "search:read",
      ]),
    );
    expect(found.results).toEqual([]);
  });
});

describe("search by author", () => {
  async function source(title: string, authors: string[], notes: string) {
    return ok(
      await tool(
        "save_source",
        {
          kind: "bookmark",
          title,
          url: `https://example.com/${crypto.randomUUID()}`,
          authors,
          notes,
        },
        ["sources:write"],
      ),
    ).id as string;
  }

  it("narrows to one author's sources, grouping an abbreviated byline", async () => {
    const full = await source(
      "Mobile form design",
      ["Luke Wroblewski"],
      "Inline validation keeps forms short.",
    );
    const short = await source(
      "Web form best practices",
      ["Luke W"],
      "Labels above fields make forms faster to scan.",
    );
    const other = await source(
      "Usability of forms",
      ["Jakob Nielsen"],
      "Forms with fewer fields convert better.",
    );

    const unfiltered = ok(
      await tool("search", { query: "forms", type: "source" }, ["search:read"]),
    );
    expect(
      (unfiltered.results as { id: string }[]).map((r) => r.id).sort(),
    ).toEqual([full, short, other].sort());

    // The name repeated in the query must not drop the "Luke W" byline,
    // whose text never says Wroblewski.
    const named = ok(
      await tool(
        "search",
        { query: "Luke Wroblewski forms", author: "Luke Wroblewski" },
        ["search:read"],
      ),
    );
    expect((named.results as { id: string }[]).map((r) => r.id).sort()).toEqual(
      [full, short].sort(),
    );

    for (const author of ["Luke W", "luke wroblewski", "Luke Wroblewski"]) {
      const found = ok(
        await tool("search", { query: "forms", author }, ["search:read"]),
      );
      expect(
        (found.results as { id: string }[]).map((r) => r.id).sort(),
      ).toEqual([full, short].sort());
    }
  });

  it("answers no author with no results and says so, rather than every source", async () => {
    await source(
      "Mobile form design",
      ["Luke Wroblewski"],
      "Inline validation keeps forms short.",
    );
    const call = await tool(
      "search",
      { query: "forms", author: "Ada Lovelace" },
      ["search:read"],
    );
    expect(ok(call).results).toEqual([]);
    expect(call.result?.content?.at(-1)?.text).toContain(
      'No saved source names an author matching "Ada Lovelace"',
    );
  });

  it("refuses an author with a type that has no authors", async () => {
    const call = await tool(
      "search",
      { query: "forms", author: "Luke W", type: "memory" },
      ["search:read"],
    );
    expect(call.result?.isError).toBe(true);
    expect(call.result?.content?.[0]?.text).toContain(
      "only sources have authors",
    );
  });
});
