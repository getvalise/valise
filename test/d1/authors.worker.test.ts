import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorSlug,
  groupAuthors,
  highlightQuote,
  listAuthors,
  readAuthor,
} from "~/concepts/authors";
import { saveSource, setSourceArchived } from "~/concepts/sources";

const provenance = (userId = "local") => ({
  userId,
  agent: "vitest",
  client: "test",
  session: null,
});

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_articles",
    "source_revision_assets",
    "source_revisions",
    "sources",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

describe("groupAuthors", () => {
  it("merges case, accents and abbreviations into one author", () => {
    const grouped = groupAuthors([
      { name: "Luke Wroblewski", sources: 3 },
      { name: "Luke W", sources: 2 },
      { name: "luke wroblewski", sources: 1 },
      { name: "L. Wroblewski", sources: 1 },
      { name: "Vaclav Smil", sources: 1 },
      { name: "Václav Smil", sources: 4 },
    ]);
    expect(grouped).toEqual([
      expect.objectContaining({
        name: "Luke Wroblewski",
        slug: "luke-wroblewski",
        sources: 7,
      }),
      expect.objectContaining({ slug: "vaclav-smil", sources: 5 }),
    ]);
    expect(grouped[0].spellings.sort()).toEqual([
      "L. Wroblewski",
      "Luke W",
      "Luke Wroblewski",
      "luke wroblewski",
    ]);
  });

  it("leaves an abbreviation that fits two people on its own", () => {
    const grouped = groupAuthors([
      { name: "John Smith", sources: 1 },
      { name: "Jane Smith", sources: 1 },
      { name: "J Smith", sources: 1 },
      { name: "Wittgenstein", sources: 1 },
    ]);
    expect(grouped.map((author) => author.name).sort()).toEqual([
      "J Smith",
      "Jane Smith",
      "John Smith",
      "Wittgenstein",
    ]);
  });
});

describe("author view", () => {
  it("collects an author's items and the highlights saved from their pages", async () => {
    const url = "https://example.com/wardley-maps";
    const article = await saveSource(
      env,
      {
        kind: "document",
        title: "On being lost",
        url,
        authors: ["Simon Wardley"],
        article: {
          detected: true,
          markdown: "Maps, not stories.",
          text: "Maps, not stories.",
          truncated: false,
          wordCount: 2400,
          pageWordCount: 3000,
          extractor: "defuddle-0.19",
          published: null,
          siteName: "Medium",
          canonicalUrl: null,
          leadImage: null,
          description: "Why a map beats a story when you plan strategy.",
          language: "en",
        },
      },
      provenance(),
    );
    await saveSource(
      env,
      {
        kind: "bookmark",
        title: "Wardley maps chapter two",
        url: "https://example.com/chapter-two",
        authors: ["S Wardley"],
      },
      provenance(),
    );
    await saveSource(
      env,
      {
        kind: "reference",
        title: "On being lost — Highlight",
        url,
        notes:
          "Captured text selection from the page.\n\nSelected text:\nAll models are wrong.\n\nContext before:\nAs ever,",
      },
      provenance(),
    );
    const archived = await saveSource(
      env,
      {
        kind: "bookmark",
        title: "Archived Wardley",
        url: "https://example.com/old",
        authors: ["Simon Wardley"],
      },
      provenance(),
    );
    await setSourceArchived(env.DB, "local", archived.sourceId, true);
    // Another tenant's author never shows up.
    await saveSource(
      env,
      {
        kind: "bookmark",
        title: "Elsewhere",
        url,
        authors: ["Simon Wardley"],
      },
      provenance("someone-else"),
    );

    expect(await listAuthors(env.DB, "local")).toEqual([
      expect.objectContaining({ name: "Simon Wardley", sources: 2 }),
    ]);
    const view = await readAuthor(env.DB, "local", authorSlug("Simon Wardley"));
    // Saved in the same second, so order between them is not asserted.
    expect(view?.items.map((item) => item.title).sort()).toEqual([
      "On being lost",
      "Wardley maps chapter two",
    ]);
    expect(
      view?.items.find((item) => item.sourceId === article.sourceId),
    ).toMatchObject({
      sourceId: article.sourceId,
      siteName: "Medium",
      description: "Why a map beats a story when you plan strategy.",
      wordCount: 2400,
      detected: true,
    });
    expect(view?.highlights.map((h) => highlightQuote(h.notes))).toEqual([
      "All models are wrong.",
    ]);
    expect(await readAuthor(env.DB, "local", "nobody")).toBeNull();
  });
});
