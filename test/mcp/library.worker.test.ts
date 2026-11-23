import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import type { McpScope } from "~/auth/scopes";
import { uploadAssetFile } from "~/concepts/library";
import { saveSource } from "~/concepts/sources";
import { mintBearerToken } from "~/concepts/tokens";
import { sha256Hex } from "~/r2/objects";
import { search } from "~/search/query";

/**
 * ADR-0015's portability check: export a bookmark with history and a
 * PDF-backed source, lose the database rows and the bucket, import, and get
 * the same ids, notes, revisions, links and byte-identical originals back.
 * Through the Worker's own HTTP routes, as `scripts/library.mjs` calls them.
 */

const TABLES = [
  "search_docs",
  "source_revision_assets",
  "source_revisions",
  "sources",
  "assets",
  "objects",
];
const PDF = new TextEncoder().encode("%PDF-1.7\nkittiwake survey\n%%EOF\n");
const assetEnv = {
  DB: env.DB,
  BUNDLES: env.BUNDLES,
  TOKEN_PEPPER: "local-test-token-pepper",
};
const provenance = {
  userId: "local",
  agent: "machine-a",
  client: "bearer",
  session: null,
};

async function wipe() {
  for (const table of TABLES)
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
}

afterEach(async () => {
  await wipe();
  for (const table of [
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

async function token(scopes: McpScope[]) {
  return (
    await mintBearerToken(
      { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
      { userId: "local", label: crypto.randomUUID(), scopes },
    )
  ).token;
}

function call(
  path: string,
  bearer: string,
  init: RequestInit = {},
): Promise<Response> {
  return SELF.fetch(`http://localhost${path}`, {
    ...init,
    headers: { authorization: `Bearer ${bearer}`, ...init.headers },
  });
}

describe("library export and import", () => {
  it("restores sources, revisions, links and byte-identical originals", async () => {
    const pdf = await uploadAssetFile(
      assetEnv,
      new File([PDF], "kittiwake.pdf", { type: "application/pdf" }),
      { title: "Kittiwake survey" },
      provenance,
    );
    const bookmark = await saveSource(
      env,
      {
        kind: "bookmark",
        title: "Seabird counts",
        url: "https://example.com/seabirds",
        notes: "First pass",
      },
      provenance,
    );
    await saveSource(
      env,
      {
        sourceId: bookmark.sourceId,
        expectedRevision: 1,
        notes: "Counts dropped after 2019; see the survey.",
      },
      provenance,
    );
    const document = await saveSource(
      env,
      {
        kind: "document",
        title: "Kittiwake survey, annotated",
        notes: "Table 2 is the one to cite.",
        assetIds: [pdf.assetId],
      },
      provenance,
    );

    const reader = await token(["assets:read", "sources:read"]);
    const exported = await call("/library/export", reader);
    expect(exported.status).toBe(200);
    const manifest = (await exported.json()) as {
      format: string;
      assets: { id: string; file: string; sha256: string }[];
      sources: {
        id: string;
        revisions: { notes: string; assets: string[] }[];
      }[];
    };
    expect(manifest.format).toBe("valise-library");
    expect(JSON.stringify(manifest)).not.toContain("u/local/");
    const files = new Map<string, ArrayBuffer>();
    for (const asset of manifest.assets) {
      const response = await call(
        `/library/export/files/${asset.id.slice("asset:".length)}`,
        reader,
      );
      const bytes = await response.arrayBuffer();
      expect(await sha256Hex(bytes)).toBe(asset.sha256);
      files.set(asset.id, bytes);
    }

    await wipe();
    expect(
      await search(env, {
        userId: "local",
        query: "seabird",
        concepts: ["source"],
      }),
    ).toEqual([]);

    const writer = await token([
      "assets:write",
      "assets:read",
      "sources:write",
    ]);
    const restore = async () => {
      for (const asset of manifest.assets) {
        const response = await call(
          `/library/import/assets/${asset.id.slice("asset:".length)}`,
          writer,
          {
            method: "PUT",
            headers: {
              "x-valise-asset": btoa(JSON.stringify(asset))
                .replace(/\+/g, "-")
                .replace(/\//g, "_")
                .replace(/=+$/, ""),
            },
            body: files.get(asset.id),
          },
        );
        expect(response.status, await response.clone().text()).toBe(200);
      }
      const sources = await call("/library/import/sources", writer, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sources: manifest.sources }),
      });
      expect(sources.status).toBe(200);
      return sources.json();
    };
    expect(await restore()).toEqual({ imported: 2, existing: 0 });
    // A rerun skips what is there.
    expect(await restore()).toEqual({ imported: 0, existing: 2 });

    const again = (await (
      await call("/library/export", reader)
    ).json()) as typeof manifest;
    const comparable = (m: typeof manifest) =>
      JSON.stringify({ ...m, exported_at: 0 });
    expect(comparable(again)).toBe(
      comparable({ ...manifest } as typeof manifest),
    );

    expect(
      (
        await search(env, {
          userId: "local",
          query: "dropped",
          concepts: ["source"],
        })
      ).map((hit) => hit.docKey),
    ).toEqual([`source:${bookmark.sourceId}`]);
    expect(
      (
        await search(env, {
          userId: "local",
          query: "kittiwake",
          concepts: ["asset"],
        })
      ).map((hit) => hit.docKey),
    ).toEqual([`asset:${pdf.assetId}`]);
    const restored = manifest.sources.find(
      (source) => source.id === `source:${document.sourceId}`,
    );
    expect(restored?.revisions[0]?.assets).toEqual([`asset:${pdf.assetId}`]);
    const original = await call(`/library/export/files/${pdf.assetId}`, reader);
    expect(new Uint8Array(await original.arrayBuffer())).toEqual(PDF);
  });

  it("needs both read scopes to export, and refuses bytes that do not match", async () => {
    const asset = await uploadAssetFile(
      assetEnv,
      new File(["abc"], "abc.txt", { type: "text/plain" }),
      {},
      provenance,
    );
    const narrow = await call("/library/export", await token(["assets:read"]));
    expect(narrow.status).toBe(403);
    expect(narrow.headers.get("www-authenticate")).toContain("sources:read");

    const manifest = (await (
      await call(
        "/library/export",
        await token(["assets:read", "sources:read"]),
      )
    ).json()) as { assets: Record<string, unknown>[] };
    await wipe();
    const tampered = await call(
      `/library/import/assets/${asset.assetId}`,
      await token(["assets:write"]),
      {
        method: "PUT",
        headers: {
          "x-valise-asset": btoa(JSON.stringify(manifest.assets[0])).replace(
            /=+$/,
            "",
          ),
        },
        body: "abd",
      },
    );
    expect(tampered.status).toBe(400);
    expect(await tampered.text()).toContain("hashing to");
  });
});
