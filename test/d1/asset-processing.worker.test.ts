import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import { strToU8, zipSync } from "fflate";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  extractAssetText,
  MAX_EXTRACTED_BYTES,
  MAX_PROCESSING_BYTES,
  PROCESSOR_VERSION,
  ProcessingRefused,
} from "~/concepts/asset-extraction";
import {
  acceptAssetSuggestion,
  dismissAssetSuggestion,
  listAssetProcessing,
  maintainAssetProcessing,
  normalizeSuggestions,
  processAsset,
  queueAssetProcessing,
  readAssetProcessing,
  runQueuedAsset,
} from "~/concepts/asset-processing";
import {
  passageCitations,
  readAsset,
  readAssetObject,
  setAssetArchived,
  updateAsset,
} from "~/concepts/assets";
import { deleteAsset, uploadAssetFile } from "~/concepts/library";
import { SUMMARY_MODEL } from "~/concepts/summary-model";
import { readVocabulary } from "~/concepts/vocabulary";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { fetchAsset } from "~/mcp/asset-tools";
import { action as uploadAction } from "~/routes/library";
import {
  assetTextChunks,
  assetVectorCandidates,
  assetVectorInvalidateStatement,
  backfillAssetVectors,
  maintainAssetVectors,
} from "~/search/asset-vectors";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";
import { rerankedSearch, rerankMode } from "~/search/rerank";
import { libraryStore } from "~/store/library.server";

// Real ZIP parsing, D1, R2, publication and retrieval. AI/Vectorize/Jev are
// contract doubles, not evidence of provider integration or semantic quality.
/** The library as an MCP request bound to `userId` would read it. */
const boundLibrary = (userId: string) =>
  libraryStore({ DB: env.DB, BUNDLES: env.BUNDLES }, userId, {
    userId,
    agent: "test",
    client: "test",
    session: null,
  });

const db = env.DB;
const provenance = {
  userId: "local",
  agent: "test",
  client: "test",
  session: null,
};
const embedding = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const vectors = new Map<string, VectorizeVector>();
const upsert = vi.fn<Vectorize["upsert"]>();
const deleteByIds = vi.fn<Vectorize["deleteByIds"]>();
const query = vi.fn<Vectorize["query"]>();
const bindings = {
  DB: db,
  BUNDLES: env.BUNDLES,
  TOKEN_PEPPER: "test",
  AI: env.AI,
  VALISE_VECTOR_NAMESPACE: "asset-test",
  VECTOR_INDEX: { upsert, deleteByIds, query },
  TYPESAFE_API_KEY: "test",
};
const suggestions = {
  title: "Orchard water plan",
  summary: "How to conserve water in fruit orchards.",
  tags: ["irrigation", "new-label"],
  project: "ORCHARD",
  concepts: ["water stewardship", "canopy microclimate"],
};
const conversion = vi.fn<() => Promise<ConversionResponse>>();

function pptx(text = "Drip irrigation reduces evaporation") {
  return zipSync({
    "ppt/slides/slide2.xml": strToU8(
      "<p:sld><a:p><a:t>Second slide</a:t></a:p></p:sld>",
    ),
    "ppt/slides/slide1.xml": strToU8(
      `<p:sld><a:p><a:t>${text}</a:t></a:p></p:sld>`,
    ),
    "ppt/vbaProject.bin": new Uint8Array([0, 1, 2]),
  });
}
function epub(text = "Drip irrigation reduces evaporation") {
  return zipSync({
    mimetype: strToU8("application/epub+zip"),
    "META-INF/container.xml": strToU8(
      '<container><rootfiles><rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    ),
    "OEBPS/content.opf": strToU8(
      '<package><manifest><item id="two" href="two.xhtml"/><item id="one" href="one.xhtml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>',
    ),
    "OEBPS/one.xhtml": strToU8(
      `<html><body><p>${text}</p><script>do not index executable script</script><img src="https://untrusted.invalid/image"/></body></html>`,
    ),
    "OEBPS/two.xhtml": strToU8("<p>Second chapter &amp; trees</p>"),
  });
}
function buffer(bytes: Uint8Array): ArrayBuffer {
  return new Uint8Array(bytes).buffer;
}
async function upload(
  name = "original.pptx",
  bytes = pptx(),
  userId = "local",
) {
  return uploadAssetFile(
    bindings,
    new File([buffer(bytes)], name),
    {},
    { ...provenance, userId },
  );
}
async function hits(term: string, userId = "local") {
  return (
    await search(bindings, { query: term, userId, concepts: ["asset"] })
  ).map((hit) => hit.conceptId);
}

beforeEach(() => {
  vectors.clear();
  conversion.mockReset().mockResolvedValue({
    id: "test",
    name: "converted",
    format: "markdown",
    data: "Drip irrigation reduces evaporation",
    mimeType: "text/plain",
    tokens: 6,
  });
  vi.spyOn(env.AI, "toMarkdown").mockImplementation(conversion);
  vi.spyOn(env.AI, "run").mockImplementation(async (model) =>
    model === SUMMARY_MODEL.id
      ? { response: JSON.stringify(suggestions) }
      : { data: [embedding] },
  );
  upsert.mockReset().mockImplementation(async (rows) => {
    for (const row of rows) vectors.set(row.id, row);
    return { mutationId: crypto.randomUUID() };
  });
  deleteByIds.mockReset().mockImplementation(async (ids) => {
    for (const id of ids) vectors.delete(id);
    return { mutationId: crypto.randomUUID() };
  });
  query.mockReset().mockImplementation(async (_vector, options) => {
    const matches = [...vectors.values()]
      .filter((row) => row.namespace === options?.namespace)
      .map((row) => ({
        id: row.id,
        namespace: row.namespace,
        metadata: row.metadata,
        score: 0.9,
      }));
    return { matches, count: matches.length };
  });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await db.prepare("DROP TRIGGER IF EXISTS fail_processing_projection").run();
  await db.batch(
    [
      "search_docs",
      "asset_vector_pending",
      "assets",
      "objects",
      "sources",
      "asset_processing_admissions",
      "asset_drain_state",
      "embedding_usage_daily",
      "spend_daily",
    ].map((table) => db.prepare(`DELETE FROM ${table}`)),
  );
  await db
    .prepare(
      "DELETE FROM users WHERE user_id IN ('usr_alice', 'usr_bob', 'usr_pending_processing')",
    )
    .run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

describe("bounded original-file extraction", () => {
  it("extracts PPTX in numeric slide order without running Office content", async () => {
    const result = await extractAssetText(
      undefined,
      "deck.pptx",
      buffer(pptx("Tree &amp; water &#x1f333;")),
    );
    expect(result.text).toMatch(
      /§ slide 1\nTree & water 🌳[\s\S]*§ slide 2\nSecond slide/,
    );
    expect(result.extractor).toBe("bounded-pptx-text-2");
    expect(conversion).not.toHaveBeenCalled();
  });
  it("follows an EPUB spine, strips scripts and never fetches embedded URLs", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const result = await extractAssetText(
      undefined,
      "book.epub",
      buffer(epub()),
    );
    expect(result.text).toMatch(/irrigation[\s\S]*Second chapter & trees/);
    expect(result.text).not.toContain("executable script");
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each(["pdf", "png", "xlsx"])(
    "uses the documented toMarkdown boundary for %s",
    async (format) => {
      const bytes = buffer(new Uint8Array([1, 2, 3]));
      expect(
        (await extractAssetText(env.AI, `original.${format}`, bytes)).text,
      ).toContain("irrigation");
      expect(conversion).toHaveBeenCalledOnce();
      const document = vi.mocked(env.AI.toMarkdown).mock.calls[0][0];
      expect(document).toMatchObject({ name: `original.${format}` });
    },
  );
  it("rejects oversize, unsupported, archive-bomb and empty conversions honestly", async () => {
    await expect(
      extractAssetText(
        env.AI,
        "large.pdf",
        new ArrayBuffer(MAX_PROCESSING_BYTES + 1),
      ),
    ).rejects.toMatchObject({ code: "processing_size_limit" });
    await expect(
      extractAssetText(env.AI, "macro.xlsm", new ArrayBuffer(1)),
    ).rejects.toMatchObject({ code: "unsupported_format" });
    const bomb = zipSync({
      "ppt/slides/slide1.xml": new Uint8Array(4 * 1024 * 1024 + 1),
    });
    await expect(
      extractAssetText(undefined, "bomb.pptx", buffer(bomb)),
    ).rejects.toMatchObject({ code: "archive_limit" });
    conversion.mockResolvedValue({
      id: "test",
      name: "scan",
      format: "markdown",
      mimeType: "application/pdf",
      data: "",
      tokens: 0,
    });
    await expect(
      extractAssetText(env.AI, "scan.pdf", new ArrayBuffer(1)),
    ).rejects.toMatchObject({ code: "no_text" });
  });
  it("caps Unicode text on UTF-8 boundaries and reports partial coverage", async () => {
    conversion.mockResolvedValue({
      id: "test",
      name: "long",
      format: "markdown",
      mimeType: "application/pdf",
      data: "🌳".repeat(300000),
      tokens: 300000,
    });
    const result = await extractAssetText(
      env.AI,
      "long.pdf",
      new ArrayBuffer(1),
    );
    expect(result.truncated).toBe(true);
    expect(new TextEncoder().encode(result.text).length).toBe(
      MAX_EXTRACTED_BYTES,
    );
    expect(result.text).not.toContain("�");
    expect(result.text.startsWith(assetTextChunks(result.text).join(""))).toBe(
      true,
    );
  });
  it("bounds aggregate selected archive text before retaining multi-entry expansion", async () => {
    const archive = zipSync({
      "ppt/slides/slide1.xml": new Uint8Array(4 * 1024 * 1024),
      "ppt/slides/slide2.xml": new Uint8Array(4 * 1024 * 1024),
      "ppt/slides/slide3.xml": new Uint8Array(4 * 1024 * 1024),
      "ppt/slides/slide4.xml": new Uint8Array(1),
    });
    await expect(
      extractAssetText(undefined, "wide.pptx", buffer(archive)),
    ).rejects.toMatchObject({ code: "archive_limit" });
  });
});

describe("derived publication and provisional metadata", () => {
  it("admits and converts an extensionless PDF using its MIME without changing its name, bytes or metadata", async () => {
    const bytes = new TextEncoder().encode(
      "%PDF-1.7\nSynthetic non-private PDF fixture\n%%EOF",
    );
    const name = "A long saved book name -- without an extension --";
    const asset = await uploadAssetFile(
      bindings,
      new File([bytes], name, { type: "application/pdf" }),
      {},
      provenance,
    );
    const original = await readAsset(db, "local", asset.assetId);
    expect(await readAssetProcessing(db, "local", asset.assetId)).toMatchObject(
      { state: "queued" },
    );
    const output = await processAsset(bindings, "local", asset.assetId);
    expect(output?.state).toBe("ready");
    expect(conversion).toHaveBeenCalledOnce();
    expect(env.AI.toMarkdown).toHaveBeenCalledWith(
      expect.objectContaining({ name: "original.pdf" }),
    );
    // A PDF converts free; its summary call reported no usage, so it counts
    // its prompt and output cap. docs/design/spend.md.
    const { results: spend } = await db
      .prepare(
        "SELECT category, calls, unpriced_calls, microusd > 0 AS priced FROM spend_daily WHERE user_id = 'local' ORDER BY category",
      )
      .all();
    expect(spend).toEqual([
      { category: "file_conversion", calls: 1, unpriced_calls: 0, priced: 0 },
      { category: "file_summary", calls: 1, unpriced_calls: 0, priced: 1 },
    ]);
    expect(await readAsset(db, "local", asset.assetId)).toMatchObject({
      fileName: name,
      contentType: "application/pdf",
      title: name,
      sha256: original?.sha256,
      tags: [],
      description: "",
    });
  });
  it("returns successful upload before delayed suggestions, then publishes only provisional metadata", async () => {
    const settings = {
      ...env,
      TOKEN_PEPPER: "test",
      SESSION_SECRET: "asset-upload-route-secret",
    };
    const ctx = createExecutionContext();
    const context = new RouterContextProvider();
    context.set(consoleContext, { env: settings, ctx });
    const url = new URL("https://valise.test/library");
    const cookie = await createSessionCookie(
      settings,
      new Request(url),
      "local",
    );
    let finish: (value: { response: string }) => void = () => {};
    vi.spyOn(env.AI, "run").mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const body = new FormData();
    body.set("intent", "upload");
    body.set("via", "fetcher");
    body.set("file", new File([buffer(pptx())], "delayed.pptx"));
    const response = await uploadAction({
      context,
      request: new Request(url, {
        method: "POST",
        headers: { cookie, origin: url.origin },
        body,
      }),
      params: {},
      url,
      pattern: "/library",
    });
    expect(response).toMatchObject({
      data: {
        uploads: [{ name: "delayed.pptx", assetId: expect.any(String) }],
      },
    });
    const asset = await db
      .prepare(
        "SELECT asset_id AS id FROM assets WHERE file_name = 'delayed.pptx'",
      )
      .first<{ id: string }>();
    expect(asset).not.toBeNull();
    expect((await readAsset(db, "local", asset?.id ?? ""))?.state).toBe(
      "ready",
    );
    // Wait until the background call is held at the synthetic provider boundary.
    await vi.waitFor(() => expect(env.AI.run).toHaveBeenCalled());
    expect((await readAsset(db, "local", asset?.id ?? ""))?.title).toBe(
      "delayed.pptx",
    );
    finish({ response: JSON.stringify(suggestions) });
    await waitOnExecutionContext(ctx);
    const view = await readAssetProcessing(db, "local", asset?.id ?? "");
    expect(view).toMatchObject({ state: "ready", suggestions });
    expect(await readAsset(db, "local", asset?.id ?? "")).toMatchObject({
      title: "delayed.pptx",
      tags: [],
      project: null,
      description: "",
    });
  });

  it("automatically queues uploads, bounds per-tenant pending work, and recovers through minute maintenance", async () => {
    const first = await upload("first.pptx");
    const second = await upload("second.pptx");
    const third = await upload("third.pptx");
    expect(await readAssetProcessing(db, "local", first.assetId)).toMatchObject(
      { state: "queued" },
    );
    expect(
      await readAssetProcessing(db, "local", second.assetId),
    ).toMatchObject({ state: "queued" });
    expect(await readAssetProcessing(db, "local", third.assetId)).toMatchObject(
      { state: "unprocessed" },
    );
    expect(env.AI.run).not.toHaveBeenCalled();
    await expect(
      queueAssetProcessing(bindings, "local", third.assetId),
    ).rejects.toMatchObject({ code: "processing_limit" });
    await maintainAssetProcessing(bindings);
    expect(await readAssetProcessing(db, "local", first.assetId)).toMatchObject(
      { state: "ready" },
    );
    await queueAssetProcessing(bindings, "local", third.assetId);
    expect((await readAsset(db, "local", third.assetId))?.state).toBe("ready");
  });

  it("keeps daily admission limits after explicit original deletion", async () => {
    const first = await upload();
    await deleteAsset(bindings, "local", first.assetId);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM asset_processing_admissions")
          .first()
      )?.n,
    ).toBe(1);
    await db.batch(
      Array.from({ length: 19 }, () =>
        db
          .prepare(
            "INSERT INTO asset_processing_admissions(processing_id,user_id,created_at) VALUES (?, 'local', unixepoch())",
          )
          .bind(crypto.randomUUID()),
      ),
    );
    const later = await upload("later.pptx");
    await expect(
      queueAssetProcessing(bindings, "local", later.assetId),
    ).rejects.toMatchObject({ code: "processing_limit" });
    expect((await readAsset(db, "local", later.assetId))?.state).toBe("ready");
  });

  it("retains uncertain provider admission and spent attempts across original deletion", async () => {
    const asset = await upload();
    vi.spyOn(env.AI, "run").mockRejectedValueOnce(
      new Error("binding aborted without provider confirmation"),
    );
    const view = await processAsset(bindings, "local", asset.assetId);
    expect(view).toMatchObject({
      state: "ready",
      suggestionError: "suggestion_failed",
      suggestions: null,
    });
    expect(view?.retryAfter).toBeGreaterThan(Math.floor(Date.now() / 1000));
    await expect(
      queueAssetProcessing(bindings, "local", asset.assetId, true),
    ).rejects.toMatchObject({ code: "processing_limit" });
    await deleteAsset(bindings, "local", asset.assetId);
    const receipt = await db
      .prepare(
        "SELECT attempts, lease_until AS leaseUntil, lease_token AS token FROM asset_processing_admissions WHERE processing_id = ?",
      )
      .bind(view?.processingId ?? "")
      .first<{ attempts: number; leaseUntil: number; token: string | null }>();
    expect(receipt?.attempts).toBe(1);
    expect(receipt?.leaseUntil).toBeGreaterThan(Math.floor(Date.now() / 1000));
    expect(receipt?.token).toBeNull();
    await upload("second.pptx");
    const third = await upload("third.pptx");
    expect(await readAssetProcessing(db, "local", third.assetId)).toMatchObject(
      { state: "unprocessed" },
    );
    expect((await readAsset(db, "local", third.assetId))?.state).toBe("ready");
  });

  it("does not start a fourth interrupted attempt", async () => {
    const asset = await upload();
    await db.batch([
      db
        .prepare(
          "UPDATE asset_processing SET state = 'running', attempts = 3, lease_until = 0 WHERE asset_id = ?",
        )
        .bind(asset.assetId),
      db.prepare(
        "UPDATE asset_processing_admissions SET attempts = 3, lease_until = 0",
      ),
    ]);
    await maintainAssetProcessing(bindings);
    expect(await readAssetProcessing(db, "local", asset.assetId)).toMatchObject(
      { state: "failed", errorCode: "interrupted" },
    );
    expect(env.AI.run).not.toHaveBeenCalled();
  });

  it("persists individual dismissals and rejects discarded, stale-field and cross-owner acceptance", async () => {
    const asset = await upload();
    const view = await processAsset(bindings, "local", asset.assetId);
    const output = view?.outputId ?? "";
    await dismissAssetSuggestion(
      bindings,
      "local",
      asset.assetId,
      output,
      "tag",
      "new-label",
    );
    expect(await readAssetProcessing(db, "local", asset.assetId)).toMatchObject(
      {
        decisions: [
          { field: "tag", value: "new-label", decision: "dismissed" },
        ],
      },
    );
    await expect(
      acceptAssetSuggestion(
        bindings,
        "local",
        asset.assetId,
        output,
        "tag",
        "new-label",
      ),
    ).rejects.toMatchObject({ code: "stale_suggestion" });
    await updateAsset(bindings, "local", asset.assetId, {
      title: "Human update",
    });
    await expect(
      acceptAssetSuggestion(
        bindings,
        "local",
        asset.assetId,
        output,
        "title",
        undefined,
        "original.pptx",
      ),
    ).rejects.toMatchObject({ code: "stale_suggestion" });
    await expect(
      dismissAssetSuggestion(
        bindings,
        "another-owner",
        asset.assetId,
        output,
        "summary",
      ),
    ).rejects.toMatchObject({ code: "stale_suggestion" });
    await acceptAssetSuggestion(
      bindings,
      "local",
      asset.assetId,
      output,
      "summary",
      undefined,
      "",
    );
    expect(await readAsset(db, "local", asset.assetId)).toMatchObject({
      title: "Human update",
      description: suggestions.summary,
      tags: [],
    });
  });
  it.each(["parsed", "choices"])(
    "accepts the live JSON-mode %s envelope without persisting suggestions",
    async (envelope) => {
      const asset = await upload();
      vi.spyOn(env.AI, "run").mockResolvedValue(
        envelope === "parsed"
          ? { response: suggestions }
          : {
              choices: [{ message: { content: JSON.stringify(suggestions) } }],
            },
      );
      expect(
        await processAsset(bindings, "local", asset.assetId),
      ).toMatchObject({ state: "ready", suggestionError: null, suggestions });
      expect(await readAsset(db, "local", asset.assetId)).toMatchObject({
        title: "original.pptx",
        tags: [],
      });
    },
  );
  it("refuses an unverified or deleted account and rejects its existing semantic hints immediately", async () => {
    const userId = "usr_pending_processing";
    await db
      .prepare(`INSERT INTO users (user_id, email, display_name, role, plan, email_verified, created_at)
      VALUES (?, 'pending-processing@example.test', 'Pending processing', 'member', 'free', 0, 1)`)
      .bind(userId)
      .run();
    const asset = await upload("pending.pptx", pptx(), userId);
    await expect(
      processAsset(bindings, userId, asset.assetId),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await readAssetProcessing(db, userId, asset.assetId)).toBeNull();
    expect(env.AI.run).not.toHaveBeenCalled();
    await db
      .prepare("UPDATE users SET email_verified = 1 WHERE user_id = ?")
      .bind(userId)
      .run();
    await processAsset(bindings, userId, asset.assetId);
    await maintainAssetVectors(bindings);
    expect(vectors.size).toBe(2); // one vector per slide
    await db.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
    expect(
      await assetVectorCandidates(bindings, {
        userId,
        concepts: ["asset"],
        query: "fruit gardens",
      }),
    ).toEqual([]);
    await db
      .prepare(
        "UPDATE asset_vector_pending SET next_attempt_at = 0, lease_until = 0",
      )
      .run();
    await maintainAssetVectors(bindings);
    expect(vectors.size).toBe(0);
  });
  it("isolates two non-local owners across processing, suggestions, exact/vector search, fetch and delivery repair", async () => {
    await db.batch(
      ["usr_alice", "usr_bob"].map((userId) =>
        db
          .prepare(
            `INSERT INTO users (user_id, email, display_name, role, plan, email_verified, created_at)
       VALUES (?, ?, ?, 'member', 'free', 1, 1)`,
          )
          .bind(userId, `${userId}@example.test`, userId),
      ),
    );
    const alice = await upload(
      "alice.pptx",
      pptx("saffron alice-private"),
      "usr_alice",
    );
    const bob = await upload("bob.pptx", pptx("cobalt bob-private"), "usr_bob");
    await updateAsset(bindings, "usr_alice", alice.assetId, {
      tags: ["alice-only-label"],
      project: "alice-project",
    });
    await updateAsset(bindings, "usr_bob", bob.assetId, {
      tags: ["bob-only-label"],
      project: "bob-project",
    });
    const prompts: string[] = [];
    vi.spyOn(env.AI, "run").mockImplementation(async (model, input) => {
      if (model === SUMMARY_MODEL.id) {
        prompts.push(JSON.stringify(input));
        return { response: JSON.stringify(suggestions) };
      }
      return { data: [embedding] };
    });
    const aliceResult = await processAsset(
      bindings,
      "usr_alice",
      alice.assetId,
    );
    const bobResult = await processAsset(bindings, "usr_bob", bob.assetId);
    expect(prompts[0]).toContain("alice-only-label");
    expect(prompts[0]).not.toContain("bob-only-label");
    expect(prompts[1]).toContain("bob-only-label");
    expect(prompts[1]).not.toContain("alice-only-label");
    expect(await hits("saffron", "usr_alice")).toEqual([alice.assetId]);
    expect(await hits("cobalt", "usr_alice")).toEqual([]);
    expect(await hits("saffron", "usr_bob")).toEqual([]);
    expect(await hits("cobalt", "usr_bob")).toEqual([bob.assetId]);
    expect(await readAssetProcessing(db, "usr_alice", bob.assetId)).toBeNull();
    expect(
      await fetchAsset(boundLibrary("usr_alice"), `asset:${bob.assetId}`),
    ).toBeNull();
    await expect(
      processAsset(bindings, "usr_alice", bob.assetId),
    ).rejects.toMatchObject({ code: "not_found" });
    await expect(
      acceptAssetSuggestion(
        bindings,
        "usr_alice",
        bob.assetId,
        bobResult?.outputId ?? "",
        "title",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
    await maintainAssetVectors(bindings);
    expect(
      await assetVectorCandidates(bindings, {
        query: "fruit gardens",
        concepts: ["asset"],
        userId: "usr_alice",
      }),
    ).toMatchObject([
      { userId: "usr_alice", conceptId: alice.assetId },
      { userId: "usr_alice", conceptId: alice.assetId },
    ]);
    expect(
      await assetVectorCandidates(bindings, {
        query: "fruit gardens",
        concepts: ["asset"],
        userId: "usr_bob",
      }),
    ).toMatchObject([
      { userId: "usr_bob", conceptId: bob.assetId },
      { userId: "usr_bob", conceptId: bob.assetId },
    ]);
    await db.batch([
      assetVectorInvalidateStatement(db, "usr_alice", bob.assetId),
    ]);
    expect(await readAssetProcessing(db, "usr_bob", bob.assetId)).toMatchObject(
      { semanticPending: 0 },
    );
    expect(
      (
        await db
          .prepare(
            "SELECT DISTINCT user_id FROM asset_processing_outputs ORDER BY user_id",
          )
          .all()
      ).results,
    ).toEqual([{ user_id: "usr_alice" }, { user_id: "usr_bob" }]);
    await acceptAssetSuggestion(
      bindings,
      "usr_alice",
      alice.assetId,
      aliceResult?.outputId ?? "",
      "title",
    );
    expect((await readAsset(db, "usr_bob", bob.assetId))?.title).toBe(
      "bob.pptx",
    );
  });
  it("indexes extracted terms beyond the old 16 KiB projection boundary", async () => {
    const asset = await upload("long.pdf");
    conversion.mockResolvedValue({
      id: "long",
      name: "long",
      format: "markdown",
      mimeType: "application/pdf",
      tokens: 12000,
      data: `${"ordinary text ".repeat(3000)}\ncapillary-action`,
    });
    await processAsset(bindings, "local", asset.assetId);
    expect(await hits("capillary-action")).toEqual([asset.assetId]);
    await reindex(bindings, ["asset"]);
    expect(await hits("capillary-action")).toEqual([asset.assetId]);
  });

  it("fences duplicate work and a late caller after interrupted-request recovery", async () => {
    const asset = await upload();
    let finishOld: (result: { response: string }) => void = () => {
      throw new Error("not started");
    };
    let started: () => void = () => {};
    const inModel = new Promise<void>((resolve) => {
      started = resolve;
    });
    vi.spyOn(env.AI, "run").mockImplementationOnce(async () => {
      started();
      return new Promise<{ response: string }>((resolve) => {
        finishOld = resolve;
      });
    });
    const old = processAsset(bindings, "local", asset.assetId);
    await inModel;
    await expect(
      processAsset(bindings, "local", asset.assetId),
    ).rejects.toMatchObject({ code: "processing_limit" });
    const before = await readAssetProcessing(db, "local", asset.assetId);
    await db.batch([
      db.prepare("UPDATE asset_processing SET lease_until = 0"),
      db.prepare("UPDATE asset_processing_admissions SET lease_until = 0"),
    ]);
    await runQueuedAsset(bindings, "local", before?.processingId ?? "");
    const newest = await readAssetProcessing(db, "local", asset.assetId);
    finishOld({
      response: JSON.stringify({
        ...suggestions,
        title: "Outdated suggestion",
      }),
    });
    await old;
    expect(
      (await readAssetProcessing(db, "local", asset.assetId))?.outputId,
    ).toBe(newest?.outputId);
    expect(newest?.suggestions?.title).not.toBe("Outdated suggestion");
    expect((await readAsset(db, "local", asset.assetId))?.title).toBe(
      "original.pptx",
    );
  });
  it.each(["pdf", "png", "epub", "pptx", "xlsx"])(
    "publishes exact terms from %s, survives rebuild, preserves byte-identical original",
    async (format) => {
      const bytes = format === "epub" ? epub() : pptx();
      const asset = await upload(`opaque.${format}`, bytes);
      expect(await hits("evaporation")).toEqual([]);
      const processing = await processAsset(bindings, "local", asset.assetId);
      expect(processing).toMatchObject({
        state: "ready",
        originalSha256: asset.sha256,
        processorVersion: PROCESSOR_VERSION,
      });
      expect(await hits("evaporation")).toEqual([asset.assetId]);
      const stored = await readAssetObject(bindings, asset);
      expect(
        new Uint8Array(
          (await stored?.object.arrayBuffer()) ?? new ArrayBuffer(0),
        ),
      ).toEqual(bytes);
      await reindex(bindings, ["asset"]);
      expect(await hits("evaporation")).toEqual([asset.assetId]);
      expect(await readAsset(db, "local", asset.assetId)).toMatchObject({
        title: `opaque.${format}`,
        description: "",
        tags: [],
        project: null,
      });
      expect(
        await fetchAsset(boundLibrary("local"), `asset:${asset.assetId}`),
      ).toMatchObject({
        metadata: {
          extracted_content_indexed: true,
          extraction: { original_sha256: asset.sha256 },
        },
        text: expect.stringContaining("evaporation"),
      });
    },
  );
  it("reuses matching existing labels and only persists the selected accepted field", async () => {
    const known = await upload("known.pptx");
    await updateAsset(bindings, "local", known.assetId, {
      project: "orchard",
      tags: ["Irrigation"],
    });
    const asset = await upload();
    const processing = await processAsset(bindings, "local", asset.assetId);
    expect(processing?.suggestions).toMatchObject({
      project: "orchard",
      tags: ["Irrigation", "new-label"],
    });
    expect((await readVocabulary(db, "local")).tags).not.toContain("new-label");
    const id = processing?.outputId ?? "";
    await acceptAssetSuggestion(
      bindings,
      "local",
      asset.assetId,
      id,
      "tag",
      "Irrigation",
    );
    expect(await readAsset(db, "local", asset.assetId)).toMatchObject({
      title: "original.pptx",
      description: "",
      tags: ["Irrigation"],
      project: null,
    });
    await acceptAssetSuggestion(
      bindings,
      "local",
      asset.assetId,
      id,
      "project",
    );
    expect((await readAsset(db, "local", asset.assetId))?.project).toBe(
      "orchard",
    );
    await expect(
      acceptAssetSuggestion(
        bindings,
        "local",
        asset.assetId,
        id,
        "tag",
        "forged",
      ),
    ).rejects.toBeInstanceOf(ProcessingRefused);
    await expect(
      acceptAssetSuggestion(bindings, "intruder", asset.assetId, id, "title"),
    ).rejects.toMatchObject({ code: "not_found" });
    expect(await listAssetProcessing(db, "intruder", [asset.assetId])).toEqual(
      {},
    );
    await acceptAssetSuggestion(
      bindings,
      "local",
      asset.assetId,
      id,
      "summary",
    );
    expect((await readAsset(db, "local", asset.assetId))?.description).toBe(
      suggestions.summary,
    );
  });
  it("keeps upload success and previous extraction through parsing or suggestion failures", async () => {
    const broken = await upload("broken.pptx", new Uint8Array([1, 2, 3]));
    expect(await processAsset(bindings, "local", broken.assetId)).toMatchObject(
      { state: "failed", errorCode: "processing_failed", outputId: null },
    );
    expect((await readAsset(db, "local", broken.assetId))?.state).toBe("ready");
    const asset = await upload();
    vi.spyOn(env.AI, "run").mockRejectedValue(
      new Error("provider text must not leak"),
    );
    expect(await processAsset(bindings, "local", asset.assetId)).toMatchObject({
      state: "ready",
      suggestionError: "suggestion_failed",
      suggestions: null,
    });
    expect(await hits("evaporation")).toContain(asset.assetId);
  });
  it("does not overwrite edits made while metadata generation is in flight", async () => {
    const asset = await upload();
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      await updateAsset(bindings, "local", asset.assetId, {
        title: "Human title",
        tags: ["human"],
      });
      return { response: JSON.stringify(suggestions) };
    });
    await processAsset(bindings, "local", asset.assetId);
    expect(await readAsset(db, "local", asset.assetId)).toMatchObject({
      title: "Human title",
      tags: ["human"],
    });
  });
  it("rolls outputs and projection back together if publication fails", async () => {
    const asset = await upload();
    await db.exec(
      `CREATE TRIGGER fail_processing_projection BEFORE UPDATE ON search_docs BEGIN SELECT RAISE(ABORT, 'test rollback'); END`,
    );
    expect(await processAsset(bindings, "local", asset.assetId)).toMatchObject({
      state: "failed",
      outputId: null,
    });
    expect(await hits("evaporation")).toEqual([]);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM asset_processing_outputs")
          .first()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM asset_vector_pending")
          .first()
      )?.n,
    ).toBe(0);
  });
  it("retains immutable processing generations and rejects stale suggestion acceptance", async () => {
    const asset = await upload();
    const first = await processAsset(bindings, "local", asset.assetId);
    const second = await processAsset(bindings, "local", asset.assetId);
    expect(second?.outputId).not.toBe(first?.outputId);
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM asset_processing_outputs")
          .first()
      )?.n,
    ).toBe(2);
    await expect(
      acceptAssetSuggestion(
        bindings,
        "local",
        asset.assetId,
        first?.outputId ?? "",
        "title",
      ),
    ).rejects.toMatchObject({ code: "stale_suggestion" });
  });
});

describe("passages of long files", () => {
  // The page shape Workers AI toMarkdown returned for a real PDF on 2026-10-29.
  const book = [
    "# book.pdf\n## Metadata\n- Author=Ada Synthetic\n- Title=Orchard Notes\n\n## Contents",
    "### Page 1\nOrchard Notes",
    `### Page 2\n${"Drip lines run along each row of trees. ".repeat(80)}\n1`,
    `### Page 3\n${"Mulch keeps soil moisture through dry summers. ".repeat(80)}\n2`,
    `### Page 4\n${"Kestrels nest in old pear trees and hunt voles. ".repeat(80)}\n3`,
  ].join("\n");
  async function processedBook() {
    conversion.mockResolvedValue({
      id: "test",
      name: "book",
      format: "markdown",
      mimeType: "application/pdf",
      data: book,
      tokens: 4000,
    });
    const asset = await uploadAssetFile(
      bindings,
      new File([new TextEncoder().encode("%PDF-1.7 synthetic")], "book.pdf", {
        type: "application/pdf",
      }),
      { title: "Orchard Notes" },
      provenance,
    );
    await updateAsset(bindings, "local", asset.assetId, { project: "orchard" });
    const view = await processAsset(bindings, "local", asset.assetId);
    return { assetId: asset.assetId, view };
  }
  async function passageRows(assetId: string) {
    const { results } = await db
      .prepare(
        "SELECT doc_key AS docKey, title, project FROM search_docs WHERE concept_id = ? ORDER BY id",
      )
      .bind(assetId)
      .all<{ docKey: string; title: string; project: string | null }>();
    return results.filter((row) => row.docKey.includes("#"));
  }

  it("indexes every page as a passage that cites its printed page", async () => {
    const { assetId, view } = await processedBook();
    expect(view).toMatchObject({ state: "ready", passageKind: "page" });
    expect(view?.passages).toBeGreaterThanOrEqual(4);
    const found = await search(bindings, {
      query: "kestrels voles",
      userId: "local",
      concepts: ["asset"],
      project: "orchard",
    });
    expect(found[0]).toMatchObject({
      concept: "asset",
      conceptId: assetId,
      title: "p. 3",
    });
    const citations = await passageCitations(db, "local", [found[0].docKey]);
    expect(citations.get(found[0].docKey)).toEqual({
      title: "Orchard Notes · p. 3",
      locator: "p. 3",
      first: 3,
      last: 3,
      citation: "Ada Synthetic, Orchard Notes, p. 3",
    });
    // Another owner never hydrates this asset's passage.
    expect(
      (await passageCitations(db, "usr_bob", [found[0].docKey])).size,
    ).toBe(0);
  });

  it("keeps one of each concept regardless of case", () => {
    expect(
      normalizeSuggestions(
        { ...suggestions, concepts: ["Jevons paradox", "jevons Paradox"] },
        { projects: [], tags: [] },
      ).concepts,
    ).toEqual(["Jevons paradox"]);
  });

  it("keeps passages in step with metadata edits, archive, concepts and reindex", async () => {
    const { assetId } = await processedBook();
    const before = await passageRows(assetId);
    expect(before.length).toBeGreaterThanOrEqual(4);

    await updateAsset(bindings, "local", assetId, {
      title: "Orchard field notes",
      project: "farm",
    });
    const edited = await passageRows(assetId);
    expect(edited.map((row) => row.docKey)).toEqual(
      before.map((row) => row.docKey),
    );
    expect(edited.every((row) => row.project === "farm")).toBe(true);
    expect(edited.at(-1)?.title).toBe("p. 3");
    // The title finds the book once, not once per page.
    expect(await hits("field notes")).toEqual([assetId]);

    await setAssetArchived(db, "local", assetId, true);
    expect(await passageRows(assetId)).toEqual([]);
    await setAssetArchived(db, "local", assetId, false);
    expect(await passageRows(assetId)).toHaveLength(before.length);

    await reindex(bindings);
    expect(await passageRows(assetId)).toHaveLength(before.length);

    // Concepts are derived text: searchable until the person dismisses one.
    const view = await readAssetProcessing(db, "local", assetId);
    expect(view?.suggestions?.concepts).toEqual([
      "water stewardship",
      "canopy microclimate",
    ]);
    expect(await hits("stewardship")).toEqual([assetId]);
    await dismissAssetSuggestion(
      bindings,
      "local",
      assetId,
      view?.outputId ?? "",
      "concept",
      "water stewardship",
    );
    expect(await hits("stewardship")).toEqual([]);
    expect(await hits("microclimate")).toEqual([assetId]);

    await deleteAsset(bindings, "local", assetId);
    expect(await passageRows(assetId)).toEqual([]);
  });
});

describe("shared semantic candidate and delivery architecture", () => {
  it("parks a spent owner's passages until the next UTC day, metering what it embeds", async () => {
    const asset = await upload();
    await processAsset(bindings, "local", asset.assetId);
    await db
      .prepare(`INSERT INTO embedding_usage_daily (user_id, day, kind, calls, input_bytes)
        VALUES ('local', date('now'), 'query', 1, 64)`)
      .run();
    vi.mocked(env.AI.run).mockClear();
    const spent = { ...bindings, VALISE_EMBEDDING_DAILY_BYTES: "64" };
    const report = await maintainAssetVectors(spent);
    expect(report).toMatchObject({ delivered: 0, failed: 0 });
    expect("budgetDeferred" in report && report.budgetDeferred).toBeGreaterThan(
      0,
    );
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(
      (
        await db
          .prepare(`SELECT DISTINCT error_code, attempts,
            next_attempt_at = unixepoch(date('now', '+1 day')) AS tomorrow
            FROM asset_vector_pending WHERE mutation_id IS NULL`)
          .all()
      ).results,
    ).toEqual([{ error_code: "daily_budget", attempts: 0, tomorrow: 1 }]);

    await db.prepare("DELETE FROM embedding_usage_daily").run();
    await db
      .prepare("UPDATE asset_vector_pending SET next_attempt_at = 0")
      .run();
    // Two slide passages; a one-byte budget admits the first call only.
    const delivered = await maintainAssetVectors({
      ...bindings,
      VALISE_EMBEDDING_DAILY_BYTES: "1",
    });
    expect(delivered).toMatchObject({ delivered: 1, budgetDeferred: 1 });
    const metered = await db
      .prepare(`SELECT calls, input_bytes > 0 AS bytes FROM embedding_usage_daily
        WHERE user_id = 'local' AND kind = 'asset' AND day = date('now')`)
      .first();
    expect(metered).toEqual({ calls: 1, bytes: 1 });
  });

  it("rebuilds a fresh delivery ledger from immutable current output without extraction, inference or enabling hybrid", async () => {
    const asset = await upload();
    await processAsset(bindings, "local", asset.assetId);
    const current = await processAsset(bindings, "local", asset.assetId);
    await maintainAssetVectors(bindings);
    const originals = (
      await db
        .prepare(
          "SELECT * FROM asset_processing_outputs ORDER BY processing_id",
        )
        .all()
    ).results;
    const decisions = (
      await db.prepare("SELECT * FROM asset_suggestion_decisions").all()
    ).results;
    await db.batch([
      db.prepare("DELETE FROM asset_vector_pending"),
      db.prepare("DELETE FROM asset_drain_state"),
    ]);
    vi.mocked(env.AI.run).mockClear();
    conversion.mockClear();
    upsert.mockClear();
    query.mockClear();
    const paused = {
      ...bindings,
      VALISE_VECTOR_NAMESPACE: "",
      VALISE_RERANK: "off",
    };
    expect(rerankMode(paused)).toBeNull();
    expect(await maintainAssetVectors(paused)).toMatchObject({
      configured: false,
      delivered: 0,
    });
    expect(await hits("evaporation")).toContain(asset.assetId);
    expect(
      await backfillAssetVectors({
        DB: db,
        VALISE_VECTOR_NAMESPACE: "fresh-recovery-v1",
      }),
    ).toMatchObject({
      outputs: 1,
      queuedChunks: 2,
      done: true,
      delivered: false,
      visibilityVerified: false,
    });
    expect(
      await backfillAssetVectors({
        DB: db,
        VALISE_VECTOR_NAMESPACE: "fresh-recovery-v1",
      }),
    ).toMatchObject({ queuedChunks: 0 });
    expect(
      (
        await db
          .prepare(
            "SELECT DISTINCT namespace, processing_id AS processingId, mutation_id AS mutationId FROM asset_vector_pending",
          )
          .all()
      ).results,
    ).toEqual([
      {
        namespace: "a:fresh-recovery-v1",
        processingId: current?.outputId,
        mutationId: null,
      },
    ]);
    expect(
      (
        await db
          .prepare(
            "SELECT * FROM asset_processing_outputs ORDER BY processing_id",
          )
          .all()
      ).results,
    ).toEqual(originals);
    expect(
      (await db.prepare("SELECT * FROM asset_suggestion_decisions").all())
        .results,
    ).toEqual(decisions);
    expect(paused.VALISE_VECTOR_NAMESPACE).toBe("");
    expect(env.AI.run).not.toHaveBeenCalled();
    expect(conversion).not.toHaveBeenCalled();
    expect(upsert).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it("gives a small second tenant a vector turn beside a multi-chunk first tenant", async () => {
    await db.batch(
      ["usr_alice", "usr_bob"].map((userId) =>
        db
          .prepare(`INSERT INTO users(user_id,email,display_name,role,plan,email_verified,created_at)
      VALUES (?, ?, ?, 'member', 'free', 1, 1)`)
          .bind(userId, `${userId}@example.test`, userId),
      ),
    );
    const alice = await upload(
      "large.pptx",
      pptx("water ".repeat(11000)),
      "usr_alice",
    );
    const bob = await upload("small.pptx", pptx(), "usr_bob");
    await processAsset(bindings, "usr_alice", alice.assetId);
    await processAsset(bindings, "usr_bob", bob.assetId);
    await maintainAssetVectors(bindings);
    expect(upsert.mock.calls).toHaveLength(4);
    const delivered = [...vectors.values()];
    expect(
      delivered.some((row) => row.metadata?.docKey === `asset:${bob.assetId}`),
    ).toBe(true);
    const aliceNamespace = delivered.find(
      (row) => row.metadata?.docKey === `asset:${alice.assetId}`,
    )?.namespace;
    const bobNamespace = delivered.find(
      (row) => row.metadata?.docKey === `asset:${bob.assetId}`,
    )?.namespace;
    expect(aliceNamespace).not.toBe(bobNamespace);
    expect(aliceNamespace).toMatch(/^a:t:/);
  });
  it("keeps publication changes dirty when archive races an acknowledged upsert, and restores through the same ledger", async () => {
    const asset = await upload();
    await processAsset(bindings, "local", asset.assetId);
    upsert.mockImplementationOnce(async (rows) => {
      await setAssetArchived(db, "local", asset.assetId, true);
      for (const row of rows) vectors.set(row.id, row);
      return { mutationId: "late-upsert" };
    });
    await maintainAssetVectors(bindings);
    const pending = await db
      .prepare(
        "SELECT epoch, next_attempt_at, mutation_id FROM asset_vector_pending",
      )
      .first();
    expect(pending).toMatchObject({
      epoch: 2,
      next_attempt_at: 0,
      mutation_id: null,
    });
    await maintainAssetVectors(bindings);
    expect(vectors.size).toBe(0);
    await setAssetArchived(db, "local", asset.assetId, false);
    expect(await maintainAssetVectors(bindings)).toMatchObject({
      delivered: 2,
    });
    expect(vectors.size).toBe(2);
    // Restore drops external acknowledgements; maintenance rebuilds from the
    // immutable current output, not an unrecorded direct provider write.
    await db.prepare("DELETE FROM asset_vector_pending").run();
    expect(await maintainAssetVectors(bindings)).toMatchObject({
      delivered: 2,
    });
  });
  it.each(["pdf", "png", "epub", "pptx", "xlsx"])(
    "delivers %s chunks and retrieves an exact-term-free query from the current output",
    async (format) => {
      const asset = await upload(
        `opaque.${format}`,
        format === "epub" ? epub() : pptx(),
      );
      await processAsset(bindings, "local", asset.assetId);
      // One vector per passage: a slide or chapter each in the archive
      // fixtures, one passage for the converted formats.
      const passages = format === "epub" || format === "pptx" ? 2 : 1;
      expect(await maintainAssetVectors(bindings)).toMatchObject({
        delivered: passages,
        failed: 0,
      });
      expect(await hits("conserve moisture among orchards")).toEqual([]);
      const filters = {
        query: "conserve moisture among orchards",
        concepts: ["asset" as const],
        userId: "local",
      };
      const candidates = await assetVectorCandidates(bindings, filters);
      expect(candidates).toHaveLength(passages);
      expect(candidates).toContainEqual(
        expect.objectContaining({
          conceptId: asset.assetId,
          docKey: `asset:${asset.assetId}#0`,
          body: expect.stringContaining("irrigation"),
        }),
      );
      // Model double chooses the only relevant candidate; this establishes
      // union wiring, not a ranking-quality measurement.
      vi.stubGlobal("fetch", async () =>
        Response.json({
          answers: { D00: { noul: 0.99 }, D01: { noul: 0.1 } },
        }),
      );
      expect(
        (await rerankedSearch(bindings, "hybrid", filters)).hits[0],
      ).toMatchObject({ conceptId: asset.assetId });
      expect(
        await assetVectorCandidates(bindings, {
          ...filters,
          userId: "intruder",
        }),
      ).toEqual([]);
      expect(
        await assetVectorCandidates(bindings, { ...filters, project: "wrong" }),
      ).toEqual([]);
      expect(
        await assetVectorCandidates(bindings, { ...filters, tags: ["wrong"] }),
      ).toEqual([]);
    },
  );
  it("rejects stale processing heads, archives, expiry and missing assets before reranking", async () => {
    const asset = await upload();
    await processAsset(bindings, "local", asset.assetId);
    await maintainAssetVectors(bindings);
    const filters = {
      query: "fruit trees",
      concepts: ["asset" as const],
      userId: "local",
    };
    await processAsset(bindings, "local", asset.assetId);
    expect(await assetVectorCandidates(bindings, filters)).toEqual([]);
    await maintainAssetVectors(bindings);
    expect(await assetVectorCandidates(bindings, filters)).toHaveLength(2);
    await setAssetArchived(db, "local", asset.assetId, true);
    expect(await assetVectorCandidates(bindings, filters)).toEqual([]);
    await setAssetArchived(db, "local", asset.assetId, false);
    expect(await assetVectorCandidates(bindings, filters)).toHaveLength(2);
    await db
      .prepare("UPDATE assets SET expires_at = 1 WHERE asset_id = ?")
      .bind(asset.assetId)
      .run();
    expect(await assetVectorCandidates(bindings, filters)).toEqual([]);
    await deleteAsset(bindings, "local", asset.assetId);
    expect(await assetVectorCandidates(bindings, filters)).toEqual([]);
    // Tombstones outlive the deleted originals/outputs and can delete vectors.
    expect(
      (
        await db
          .prepare("SELECT COUNT(*) AS n FROM asset_vector_pending")
          .first()
      )?.n,
    ).toBe(4); // two generations, two slides each
    await db
      .prepare("UPDATE asset_vector_pending SET next_attempt_at = 0")
      .run();
    await maintainAssetVectors(bindings);
    expect(vectors.size).toBe(0);
  });
  it("records retryable vector failure without failing extracted search", async () => {
    const asset = await upload();
    await processAsset(bindings, "local", asset.assetId);
    upsert.mockRejectedValueOnce(new Error("provider failure"));
    expect(await maintainAssetVectors(bindings)).toMatchObject({ failed: 1 });
    expect(await readAssetProcessing(db, "local", asset.assetId)).toMatchObject(
      { state: "ready", semanticFailed: 1, semanticPending: 1 },
    );
    expect(await hits("evaporation")).toContain(asset.assetId);
    await db
      .prepare(
        "UPDATE asset_vector_pending SET next_attempt_at = 0, lease_until = 0",
      )
      .run();
    expect(await maintainAssetVectors(bindings)).toMatchObject({
      delivered: 2,
    });
  });
});
