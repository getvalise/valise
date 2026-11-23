import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  beginAssetUpload,
  passageCitations,
  receiveAssetUpload,
} from "~/concepts/assets";
import { readSourceArticle } from "~/concepts/source-articles";
import {
  dismissSourceTag,
  enrichmentStatus,
  enrichSource,
  ITEM_CEILING_MICROUSD,
  maintainSourceEnrichment,
  readSourceEnrichment,
  SOURCE_IMAGE_INSTRUCTIONS,
  SOURCE_SUMMARY_INSTRUCTIONS,
  SOURCE_TAG_INSTRUCTIONS,
} from "~/concepts/source-enrichment";
import {
  extractPage,
  FETCH_EXTRACTOR,
  fetchableUrl,
  robotsAllows,
} from "~/concepts/source-fetch";
import {
  deleteSource,
  saveSource,
  setSourceArchived,
} from "~/concepts/sources";
import { SUMMARY_IMAGE_BYTES, SUMMARY_MODEL } from "~/concepts/summary-model";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";

// Real D1, HTMLRewriter and projection. The page fetch and Workers AI are
// doubles: this is no evidence about real sites or summary quality.
const db = env.DB;
const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};
const run = vi.fn();
const ai = { run } as unknown as Pick<Ai, "run">;
const bindings = { DB: db, AI: ai, BUNDLES: env.BUNDLES };
const reply = {
  summary: "Hedgerows shelter pollinators and slow wind across orchards.",
  concepts: ["hedgerow ecology", "pollinator habitat", "windbreak"],
};

function article(paragraphs = 40) {
  const body = Array.from(
    { length: paragraphs },
    (_, i) =>
      `<p>Paragraph ${i}: hawthorn hedgerows give bumblebees shelter and nectar early in spring, and slow the wind that dries the soil between fruit trees.</p>`,
  ).join("");
  return `<!doctype html><html lang="en"><head><title>Why hedgerows matter</title>
    <meta name="author" content="Ada Synthetic"><meta property="og:site_name" content="Field Notes">
    <link rel="canonical" href="https://example.org/hedgerows"></head>
    <body><nav>Home Subscribe Login</nav><article><h1>Why hedgerows matter</h1>${body}</article>
    <footer>Copyright cookie banner</footer><script>track()</script></body></html>`;
}

function site(
  pages: Record<string, { status?: number; body: string; type?: string }>,
) {
  const calls: string[] = [];
  const fetcher = async (input: string) => {
    calls.push(input);
    const page = pages[input];
    if (!page) return new Response("missing", { status: 404 });
    return new Response(page.body, {
      status: page.status ?? 200,
      headers: { "content-type": page.type ?? "text/html; charset=utf-8" },
    });
  };
  return { calls, fetcher };
}

async function bookmark(url: string | null, extra = {}) {
  return saveSource(
    { DB: db },
    {
      kind: "bookmark",
      title: "Hedgerows",
      url,
      notes: url ? "" : "n",
      tags: ["ecology"],
      ...extra,
    },
    provenance,
  );
}

async function rows(sourceId: string) {
  const { results } = await db
    .prepare(
      "SELECT doc_key AS docKey, title, body FROM search_docs WHERE concept_id = ? ORDER BY id",
    )
    .bind(sourceId)
    .all<{ docKey: string; title: string; body: string }>();
  return results;
}

beforeEach(() => {
  run.mockReset().mockResolvedValue({
    response: JSON.stringify(reply),
    usage: { prompt_tokens: 3000, completion_tokens: 100 },
  });
});
afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_enrichments",
    "spend_daily",
    "source_articles",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
    "asset_drain_state",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

/** A ready PNG asset of `size` bytes, as a bookmark's client would link one. */
async function imageAsset(size = 12) {
  const bytes = new Uint8Array(size);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const assetEnv = { DB: db, BUNDLES: env.BUNDLES, TOKEN_PEPPER: "pepper" };
  const { asset, token } = await beginAssetUpload(
    assetEnv,
    {
      fileName: "photo.png",
      contentType: "image/png",
      size,
      title: "Photo from x.example",
    },
    provenance,
  );
  const put = await receiveAssetUpload(
    assetEnv,
    asset.assetId,
    new Request(`http://127.0.0.1/uploads/${asset.assetId}?token=${token}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body: bytes,
    }),
  );
  expect(put.status).toBe(200);
  return asset.assetId;
}

describe("fetching a bookmarked page", () => {
  it("keeps only public http(s) URLs by host name", () => {
    expect(fetchableUrl("https://example.org/a")).not.toBeNull();
    for (const bad of [
      "ftp://example.org",
      "http://localhost/x",
      "http://10.0.0.1/",
      "https://user:pw@example.org/",
      "https://example.org:8443/",
      "http://intranet/",
    ])
      expect(fetchableUrl(bad)).toBeNull();
  });

  it("follows the longest robots.txt rule for our agent, else for *", () => {
    const robots =
      "User-agent: *\nDisallow: /private\nAllow: /private/open\n\nUser-agent: GPTBot\nDisallow: /";
    expect(robotsAllows(robots, "/private/x")).toBe(false);
    expect(robotsAllows(robots, "/private/open/x")).toBe(true);
    expect(robotsAllows(robots, "/blog")).toBe(true);
    expect(robotsAllows("User-agent: ValiseBot\nDisallow: /", "/a")).toBe(
      false,
    );
    expect(robotsAllows("User-agent: *\nDisallow: /*.pdf$", "/a.pdf")).toBe(
      false,
    );
  });

  it("cuts the article out of the page chrome and reads its metadata", async () => {
    const { article: page, paywalled } = await extractPage(article());
    expect(paywalled).toBe(false);
    expect(page.text).toContain("hawthorn hedgerows");
    expect(page.text).not.toMatch(/Subscribe|cookie banner|track\(\)/);
    expect(page).toMatchObject({
      authors: ["Ada Synthetic"],
      siteName: "Field Notes",
      canonicalUrl: "https://example.org/hedgerows",
      language: "en",
    });
    expect(
      (
        await extractPage(
          `<html><head><script type="application/ld+json">{"isAccessibleForFree": false}</script></head><body><article>${"word ".repeat(300)}</article></body></html>`,
        )
      ).paywalled,
    ).toBe(true);
  });

  it("keeps the text of a page that carries JSON-LD", async () => {
    // Two end-tag handlers on one <script> left the skip counter stuck, so
    // every page with structured data read as zero words.
    const { article: page } = await extractPage(
      `<html><head><script type="application/ld+json">{"@type": "Article"}</script></head><body><article>${"word ".repeat(200)}</article></body></html>`,
    );
    expect(page.wordCount).toBe(200);
  });
});

describe("source enrichment", () => {
  it("fetches once, keeps the article, summarises, splits and records cost", async () => {
    const source = await bookmark("https://example.org/hedgerows");
    const { calls, fetcher } = site({
      "https://example.org/robots.txt": { body: "User-agent: *\nAllow: /" },
      "https://example.org/hedgerows": { body: article(80) },
    });
    const enriched = await enrichSource(
      bindings,
      "local",
      source.sourceId,
      fetcher,
    );
    expect(calls).toEqual([
      "https://example.org/robots.txt",
      "https://example.org/hedgerows",
    ]);
    expect(enriched).toMatchObject({
      state: "ready",
      fetchStatus: "fetched",
      summary: reply.summary,
      concepts: reply.concepts,
      model: SUMMARY_MODEL.id,
      inputTokens: 3000,
      outputTokens: 100,
      costMicrousd: Math.ceil(
        3000 * SUMMARY_MODEL.inputUsdPerMillion +
          100 * SUMMARY_MODEL.outputUsdPerMillion,
      ),
    });
    expect(enriched?.passages).toBeGreaterThan(1);
    expect(
      await db
        .prepare(
          "SELECT calls, units, microusd FROM spend_daily WHERE user_id = 'local' AND category = 'bookmark_summary'",
        )
        .first(),
    ).toEqual({ calls: 1, units: 3100, microusd: enriched?.costMicrousd });
    expect(await readSourceArticle(db, "local", source.sourceId)).toMatchObject(
      { detected: true, extractor: FETCH_EXTRACTOR },
    );
    // The row carries summary and concepts; the article text lives in passages.
    const published = await rows(source.sourceId);
    expect(published[0].body).toContain("pollinator habitat");
    expect(published[0].body).not.toContain("hawthorn");
    expect(published.length).toBe(1 + (enriched?.passages ?? 0));
    const hits = await search(
      { DB: db },
      {
        query: "bumblebees nectar",
        userId: "local",
        concepts: ["source"],
        tags: ["ecology"],
      },
    );
    expect(hits[0]).toMatchObject({ conceptId: source.sourceId });
    expect(hits[0].docKey).toMatch(/#\d+$/);
    expect(
      (await passageCitations(db, "local", [hits[0].docKey])).get(
        hits[0].docKey,
      ),
    ).toMatchObject({ citation: "Hedgerows" });
    expect(
      await search(
        { DB: db },
        { query: "windbreak", userId: "local", concepts: ["source"] },
      ),
    ).toHaveLength(1);

    // Never fetched twice, and nothing is owed until a newer article arrives.
    expect(await maintainSourceEnrichment(bindings, fetcher)).toMatchObject({
      attempted: 0,
    });
    expect(calls).toHaveLength(2);

    // Edits, archive, reindex and delete keep the extra rows in step.
    const edited = await saveSource(
      { DB: db },
      { sourceId: source.sourceId, expectedRevision: 1, notes: "edited" },
      provenance,
    );
    expect(await rows(edited.sourceId)).toHaveLength(published.length);
    await setSourceArchived(db, "local", source.sourceId, true);
    expect(await rows(source.sourceId)).toEqual([]);
    await setSourceArchived(db, "local", source.sourceId, false);
    await reindex({ DB: db });
    expect(await rows(source.sourceId)).toHaveLength(published.length);
    await deleteSource(db, "local", source.sourceId);
    expect(await rows(source.sourceId)).toEqual([]);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM source_enrichments")
        .first("n"),
    ).toBe(0);
  });

  it("keeps nothing from a paywalled page or one robots.txt disallows", async () => {
    const paid = await bookmark("https://paper.example/story");
    const blocked = await bookmark("https://shy.example/post");
    const { calls, fetcher } = site({
      "https://paper.example/robots.txt": { body: "" },
      "https://paper.example/story": { status: 402, body: "subscribe" },
      "https://shy.example/robots.txt": {
        body: "User-agent: *\nDisallow: /",
      },
    });
    expect(
      await enrichSource(bindings, "local", paid.sourceId, fetcher),
    ).toMatchObject({ state: "skipped", fetchStatus: "paywalled" });
    expect(
      await enrichSource(bindings, "local", blocked.sourceId, fetcher),
    ).toMatchObject({ state: "skipped", fetchStatus: "robots_disallowed" });
    expect(calls).not.toContain("https://shy.example/post");
    expect(await readSourceArticle(db, "local", paid.sourceId)).toBeNull();
    expect(run).not.toHaveBeenCalled();
  });

  it("asks only for tags on short saved text, and nothing for an import receipt", async () => {
    // An X post saved with its text as notes: robots.txt refuses the fetch.
    const post = await bookmark("https://x.example/ada/status/1", {
      notes: "My Saturday! Hedgerow walk, three bumblebee species before ten.",
    });
    const receipt = await saveSource(
      { DB: db },
      {
        kind: "bookmark",
        title: "Imported",
        url: null,
        notes: `Imported from Raindrop.io bookmark 7.\n\n${"Collection: Unsorted. ".repeat(30)}`,
      },
      { ...provenance, agent: "raindrop-import", client: "raindrop.io" },
    );
    const { fetcher } = site({
      "https://x.example/robots.txt": { body: "User-agent: *\nDisallow: /" },
    });
    run.mockResolvedValue({
      response: JSON.stringify({
        tags: [
          "ecology",
          "Bumblebees",
          "Bumblebees",
          "project:valise",
          "walks",
        ],
      }),
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    });
    expect(
      await enrichSource(bindings, "local", post.sourceId, fetcher),
    ).toMatchObject({
      state: "ready",
      fetchStatus: "robots_disallowed",
      summary: null,
      concepts: [],
      suggestedTags: ["ecology", "Bumblebees", "walks"],
    });
    expect(run).toHaveBeenCalledTimes(1);
    const [, request] = run.mock.calls[0];
    expect(request.messages[0].content).toBe(SOURCE_TAG_INSTRUCTIONS);
    // The owner's own tags are offered for reuse.
    expect(JSON.parse(request.messages[1].content).known_tags).toContain(
      "ecology",
    );
    // The import receipt is provenance, so 600 characters of it are not text.
    expect(
      await enrichSource(bindings, "local", receipt.sourceId, fetcher),
    ).toMatchObject({ state: "skipped", errorCode: "no_text" });
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("suggests tags with a summary, and a dismissed one stays dismissed", async () => {
    run.mockResolvedValue({
      response: JSON.stringify({
        ...reply,
        tags: ["hedgerows", "pollinators", "a", "b", "c", "d"],
      }),
      usage: { prompt_tokens: 3000, completion_tokens: 100 },
    });
    const source = await bookmark(null, {
      notes: "Notes long enough to summarise. ".repeat(20),
    });
    const done = await enrichSource(bindings, "local", source.sourceId);
    expect(done?.suggestedTags).toEqual([
      "hedgerows",
      "pollinators",
      "a",
      "b",
      "c",
    ]);
    const id = done?.enrichmentId ?? "";
    expect(
      await dismissSourceTag(db, "local", source.sourceId, id, "pollinators"),
    ).toBe(true);
    expect(
      await dismissSourceTag(db, "local", source.sourceId, id, "pollinators"),
    ).toBe(false);
    expect(
      await dismissSourceTag(db, "local", source.sourceId, id, "never-said"),
    ).toBe(false);
    expect(
      await dismissSourceTag(db, "other", source.sourceId, id, "hedgerows"),
    ).toBe(false);
    expect(
      (await readSourceEnrichment(db, "local", source.sourceId))?.suggestedTags,
    ).toEqual(["hedgerows", "a", "b", "c"]);
  });

  it("gives a short post skipped before tag suggestions one more attempt, once", async () => {
    const post = await bookmark(null, { notes: "My Saturday! Hedgerows." });
    await db
      .prepare(
        `INSERT INTO source_enrichments (enrichment_id, user_id, source_id, revision, state,
           concepts_json, created_at) VALUES ('sen_old', 'local', ?, 1, 'skipped', '[]', unixepoch() - 3600)`,
      )
      .bind(post.sourceId)
      .run();
    run.mockResolvedValue({
      response: JSON.stringify({ tags: ["hedgerows"] }),
      usage: { prompt_tokens: 200, completion_tokens: 30 },
    });
    expect(
      await maintainSourceEnrichment(bindings, site({}).fetcher),
    ).toMatchObject({ attempted: 1 });
    expect(
      await maintainSourceEnrichment(bindings, site({}).fetcher),
    ).toMatchObject({ attempted: 0 });
    expect(
      (await readSourceEnrichment(db, "local", post.sourceId))?.suggestedTags,
    ).toEqual(["hedgerows"]);
  });

  it("uses a captured article instead of fetching", async () => {
    const text = "Captured while signed in. ".repeat(200);
    const source = await bookmark("https://paper.example/story", {
      article: {
        detected: true,
        markdown: text,
        text,
        truncated: false,
        wordCount: 800,
        pageWordCount: 1200,
        extractor: "defuddle",
        published: null,
        siteName: null,
        canonicalUrl: null,
        leadImage: null,
        description: null,
        language: null,
      },
    });
    const { calls, fetcher } = site({});
    expect(
      await enrichSource(bindings, "local", source.sourceId, fetcher),
    ).toMatchObject({ state: "ready", fetchStatus: null, articleRevision: 1 });
    expect(calls).toEqual([]);
  });

  it("stays inside the daily budget, newest first, two a tick", async () => {
    const fetcher = site({}).fetcher;
    const long = "Notes long enough to summarise. ".repeat(20);
    const sources = [];
    for (let i = 0; i < 4; i++) {
      sources.push(await bookmark(null, { notes: `${long}${i}` }));
      await db
        .prepare("UPDATE sources SET created_at = ? WHERE source_id = ?")
        .bind(1000 + i, sources[i].sourceId)
        .run();
    }
    // A budget below one item's ceiling admits nothing.
    expect(
      await maintainSourceEnrichment(
        { ...bindings, VALISE_SOURCE_DAILY_USD: "0.001" },
        fetcher,
      ),
    ).toMatchObject({ attempted: 0 });
    expect(
      await maintainSourceEnrichment(
        { ...bindings, VALISE_SOURCE_DAILY_USD: "0" },
        fetcher,
      ),
    ).toMatchObject({ configured: false });
    const tick = await maintainSourceEnrichment(bindings, fetcher);
    // Each reply reports 3000 input and 100 output tokens.
    const each = Math.ceil(
      3000 * SUMMARY_MODEL.inputUsdPerMillion +
        100 * SUMMARY_MODEL.outputUsdPerMillion,
    );
    expect(tick).toMatchObject({ attempted: 2, costMicrousd: 2 * each });
    const done = await Promise.all(
      sources.map((s) => readSourceEnrichment(db, "local", s.sourceId)),
    );
    expect(done.map((row) => row?.state ?? null)).toEqual([
      null,
      null,
      "ready",
      "ready",
    ]);
    expect(await enrichmentStatus(bindings, "local")).toEqual({
      spentMicrousd: 2 * each,
      budgetMicrousd: 250_000,
      waiting: 2,
      done: 2,
    });
  });

  it("records a failed summary at its ceiling cost and retries later", async () => {
    run.mockRejectedValue(new Error("provider down"));
    const source = await bookmark(null, {
      notes: "Notes long enough to summarise. ".repeat(20),
    });
    expect(
      await enrichSource(bindings, "local", source.sourceId),
    ).toMatchObject({
      state: "failed",
      errorCode: "summary_failed",
      costMicrousd: ITEM_CEILING_MICROUSD,
    });
    // Not again within the day.
    expect(
      await maintainSourceEnrichment(bindings, site({}).fetcher),
    ).toMatchObject({ attempted: 0 });
  });

  describe("with images", () => {
    it("shows the model a short post's image and summarises both", async () => {
      const assetId = await imageAsset();
      const post = await bookmark("https://x.example/ada/status/2", {
        notes: "My Saturday!",
        assetIds: [assetId],
      });
      const { fetcher } = site({
        "https://x.example/robots.txt": { body: "User-agent: *\nDisallow: /" },
      });
      const outcome = await enrichSource(
        bindings,
        "local",
        post.sourceId,
        fetcher,
      );
      expect(outcome).toMatchObject({
        state: "ready",
        summary: reply.summary,
        imagesLinked: 1,
        imagesRead: 1,
      });
      const [, request] = run.mock.calls[0];
      expect(request.messages[0].content).toBe(
        SOURCE_SUMMARY_INSTRUCTIONS + SOURCE_IMAGE_INSTRUCTIONS,
      );
      const [text, image] = request.messages[1].content;
      expect(JSON.parse(text.text).text).toBe("My Saturday!");
      expect(image.image_url.url).toMatch(
        /^data:image\/png;base64,iVBORw0KGgo/,
      );
    });

    it("summarises an image with no text, and leaves a too-large one out without asking again", async () => {
      const small = await bookmark(null, {
        title: "Photo only",
        notes: "",
        assetIds: [await imageAsset()],
      });
      expect(
        await enrichSource(bindings, "local", small.sourceId),
      ).toMatchObject({ state: "ready", imagesRead: 1 });
      expect(run).toHaveBeenCalledTimes(1);

      const large = await bookmark(null, {
        title: "Big photo",
        notes: "",
        assetIds: [await imageAsset(SUMMARY_IMAGE_BYTES + 1)],
      });
      expect(
        await enrichSource(bindings, "local", large.sourceId),
      ).toMatchObject({
        state: "skipped",
        errorCode: "no_text",
        imagesLinked: 1,
        imagesRead: 0,
      });
      expect(run).toHaveBeenCalledTimes(1);
      // Linked, though not read: nothing more is owed until an image is added.
      expect((await enrichmentStatus(bindings, "local")).waiting).toBe(0);
    });

    it("owes a summarised source another attempt once an image is linked", async () => {
      const post = await bookmark("https://x.example/ada/status/3", {
        notes: "Hedgerow walk.",
      });
      await enrichSource(bindings, "local", post.sourceId, site({}).fetcher);
      expect((await enrichmentStatus(bindings, "local")).waiting).toBe(0);
      await saveSource(
        { DB: db },
        {
          kind: "bookmark",
          title: "Hedgerows",
          url: "https://x.example/ada/status/3",
          notes: "Hedgerow walk.",
          assetIds: [await imageAsset()],
        },
        provenance,
      );
      expect((await enrichmentStatus(bindings, "local")).waiting).toBe(1);
    });
  });
});
