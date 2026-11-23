import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginAssetUpload,
  finalizeAssetUpload,
  receiveAssetUpload,
  updateAsset,
} from "~/concepts/assets";
import {
  listSourceRevisions,
  readSource,
  SourceRefused,
  saveSource,
  setSourceArchived,
} from "~/concepts/sources";
import { MAX_BODY_BYTES } from "~/search/project";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";

const assetEnv = { DB: env.DB, BUNDLES: env.BUNDLES, TOKEN_PEPPER: "pepper" };
const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj << >> endobj\n%%EOF\n");

afterEach(async () => {
  vi.unstubAllGlobals();
  for (const table of [
    "search_docs",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

async function readyPdf(expiresInSeconds?: number) {
  const { asset, token } = await beginAssetUpload(
    assetEnv,
    {
      fileName: "paper.pdf",
      contentType: "application/pdf",
      size: PDF.byteLength,
      expiresInSeconds,
    },
    provenance,
  );
  await receiveAssetUpload(
    assetEnv,
    asset.assetId,
    new Request(`http://127.0.0.1/uploads/${asset.assetId}?token=${token}`, {
      method: "PUT",
      body: PDF,
    }),
  );
  const finalized = await finalizeAssetUpload(assetEnv, "local", asset.assetId);
  if (!finalized.ok) throw new Error(finalized.reason);
  return finalized.asset;
}

async function hits(query: string) {
  return (
    await search(env, { userId: "local", query, concepts: ["source"] })
  ).map((hit) => hit.docKey);
}

describe("sources", () => {
  it("saves a bookmark with notes and never fetches the URL", async () => {
    const fetchSpy = vi.fn(async () => new Response("should not be called"));
    vi.stubGlobal("fetch", fetchSpy);
    const source = await saveSource(
      env,
      {
        kind: "bookmark",
        title: "Partitioned writes in DuckLake",
        url: "https://example.com/ducklake-partitions",
        notes: "Explains why small appends compact nightly.",
        tags: ["ducklake"],
      },
      provenance,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(source.revision).toBe(1);
    for (const term of ["partitioned", "compact", "ducklake-partitions"]) {
      expect(await hits(term)).toEqual([`source:${source.sourceId}`]);
    }
  });

  it("requires a URL, an asset, or notes", async () => {
    await expect(
      saveSource(env, { kind: "reference", title: "Empty" }, provenance),
    ).rejects.toBeInstanceOf(SourceRefused);
  });

  it("appends revisions and refuses a stale expected revision", async () => {
    const created = await saveSource(
      env,
      { kind: "reference", title: "Kestrel talk", notes: "First take" },
      provenance,
    );
    const second = await saveSource(
      env,
      {
        sourceId: created.sourceId,
        expectedRevision: 1,
        notes: "Second take",
      },
      provenance,
    );
    expect(second).toMatchObject({ revision: 2, notes: "Second take" });
    // Omitted fields keep the head's values.
    expect(second.title).toBe("Kestrel talk");

    await expect(
      saveSource(
        env,
        { sourceId: created.sourceId, expectedRevision: 1, notes: "Stale" },
        provenance,
      ),
    ).rejects.toThrow(/revision 2/);

    // Two saves from the same revision: one lands, one is refused.
    const raced = await Promise.allSettled([
      saveSource(
        env,
        { sourceId: created.sourceId, expectedRevision: 2, notes: "A" },
        provenance,
      ),
      saveSource(
        env,
        { sourceId: created.sourceId, expectedRevision: 2, notes: "B" },
        provenance,
      ),
    ]);
    expect(raced.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const revisions = await listSourceRevisions(
      env.DB,
      "local",
      created.sourceId,
    );
    expect(revisions.map((r) => [r.revision, r.notes])).toEqual([
      [1, "First take"],
      [2, "Second take"],
      [3, expect.stringMatching(/^[AB]$/)],
    ]);
    expect(await hits("take")).toEqual([]);
  });

  it("links a ready PDF and protects it from expiry, history included", async () => {
    const pdf = await readyPdf();
    const source = await saveSource(
      env,
      {
        kind: "document",
        title: "Heron migration whitepaper",
        notes: "Section 3 covers the cutover.",
        assetIds: [pdf.assetId],
      },
      provenance,
    );
    expect(source.assets).toEqual([
      expect.objectContaining({ assetId: pdf.assetId, available: true }),
    ]);
    await expect(
      updateAsset(assetEnv, "local", pdf.assetId, { expiresInSeconds: 600 }),
    ).rejects.toThrow(`source:${source.sourceId}`);

    // Unlinked from the head, the old revision still protects it.
    await saveSource(
      env,
      {
        sourceId: source.sourceId,
        expectedRevision: 1,
        assetIds: [],
      },
      provenance,
    );
    await expect(
      updateAsset(assetEnv, "local", pdf.assetId, { expiresInSeconds: 600 }),
    ).rejects.toThrow(`source:${source.sourceId}`);
  });

  it("refuses to link an expiring asset or one that is not ready", async () => {
    const expiring = await readyPdf(3600);
    await expect(
      saveSource(
        env,
        {
          kind: "document",
          title: "Temporary",
          assetIds: [expiring.assetId],
        },
        provenance,
      ),
    ).rejects.toThrow(/expires/);
    await expect(
      saveSource(
        env,
        {
          kind: "document",
          title: "Missing",
          assetIds: ["ast_00000000-0000-4000-8000-000000000000"],
        },
        provenance,
      ),
    ).rejects.toThrow(/not a ready asset/);
  });

  it("keeps long notes whole while search stops at the projection cap", async () => {
    const tail = "osprey";
    const notes = `${"filler ".repeat(MAX_BODY_BYTES / 7 + 10)}${tail}`;
    const source = await saveSource(
      env,
      { kind: "reference", title: "Long read", notes },
      provenance,
    );
    expect((await readSource(env.DB, "local", source.sourceId))?.notes).toBe(
      notes.trim(),
    );
    expect(await hits(tail)).toEqual([]);
    expect(await hits("long")).toEqual([`source:${source.sourceId}`]);
  });

  it("archives out of search, restores, and rebuilds from the rows", async () => {
    const source = await saveSource(
      env,
      { kind: "bookmark", title: "Plover notes", url: "https://example.com/p" },
      provenance,
    );
    await setSourceArchived(env.DB, "local", source.sourceId, true);
    expect(await hits("plover")).toEqual([]);
    await setSourceArchived(env.DB, "local", source.sourceId, false);
    expect(await hits("plover")).toEqual([`source:${source.sourceId}`]);

    await env.DB.prepare("DELETE FROM search_docs").run();
    const report = await reindex(env, ["source"]);
    expect(report.published.source).toBe(1);
    expect(await hits("plover")).toEqual([`source:${source.sourceId}`]);
  });
});
