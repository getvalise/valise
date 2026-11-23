import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { recordUse } from "~/concepts/library-use";
import {
  type RankedSearch,
  RECENT_USE_DAYS,
  RELATED_BAR,
  relatedLibraryItem,
} from "~/concepts/related-library";
import { saveSource } from "~/concepts/sources";
import type { SearchHit } from "~/search/query";

// The ranked search is a double: this checks the selection rules, not
// whether the reranker's scores mean anything.
const db = env.DB;
const NOW = 1_800_000_000;

afterEach(async () => {
  for (const table of [
    "library_use_events",
    "search_docs",
    "source_revisions",
    "sources",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

async function source(title: string) {
  const saved = await saveSource(
    { DB: db },
    {
      kind: "bookmark",
      title,
      url: `https://example.org/${crypto.randomUUID()}`,
      notes: "",
      tags: [],
    },
    { userId: "local", agent: "vitest", client: "test", session: null },
  );
  return saved.sourceId;
}

/** A passage hit, titled by its locator as search titles one: often empty. */
function hit(conceptId: string, score: number, concept = "source"): SearchHit {
  return {
    docKey: `${concept}:${conceptId}#0`,
    concept: concept as SearchHit["concept"],
    conceptId,
    project: null,
    title: "",
    snippet: "…hawthorn [hedges] shelter [bees] early in spring…",
    score,
    updatedAt: 1,
  };
}

function ranked(hits: SearchHit[], reranked = true): RankedSearch {
  return async () => ({
    hits,
    rerank: reranked
      ? { backend: "jev", reranked: true, ms: 1 }
      : { backend: "jev", reranked: false, ms: 1, fallback: "timeout" },
  });
}

const about = "Plant a hedge for the orchard's pollinators";

describe("one related library item", () => {
  it("offers the best item over the bar, named by the item, with a one-line reason and a quote", async () => {
    const a = await source("Why hedgerows matter");
    const b = await source("Orchard windbreaks");
    const item = await relatedLibraryItem(
      db,
      "local",
      ranked([hit(a, 0.9), hit(b, 0.85)]),
      about,
      NOW,
    );
    expect(item).toEqual({
      id: `source:${a}`,
      title: "Why hedgerows matter",
      reason: `Related to "${about}"; not opened or fetched since it was saved.`,
      quote: "…hawthorn hedges shelter bees early in spring…",
    });
  });

  it("offers nothing under the bar, including the 0.65 that let noise through, or when not reranked", async () => {
    const a = await source("Cookbook: RAG Agent");
    for (const score of [RELATED_BAR - 0.01, 0.65])
      expect(
        await relatedLibraryItem(
          db,
          "local",
          ranked([hit(a, score)]),
          about,
          NOW,
        ),
      ).toBeNull();
    expect(
      await relatedLibraryItem(
        db,
        "local",
        ranked([hit(a, 0.95)], false),
        about,
        NOW,
      ),
    ).toBeNull();
    expect(
      await relatedLibraryItem(db, "local", ranked([]), about, NOW),
    ).toBeNull();
  });

  it("skips an item with no title, and one that is not this owner's", async () => {
    // Saving refuses a blank title; an older or imported row may still lack one.
    const untitled = await source("Soon blank");
    await db
      .prepare("UPDATE sources SET title = '' WHERE source_id = ?")
      .bind(untitled)
      .run();
    const named = await source("Hedge laying");
    expect(
      await relatedLibraryItem(
        db,
        "local",
        ranked([hit(untitled, 0.95), hit(named, 0.9)]),
        about,
        NOW,
      ),
    ).toMatchObject({ id: `source:${named}`, title: "Hedge laying" });
    expect(
      await relatedLibraryItem(
        db,
        "usr_other",
        ranked([hit(named, 0.95)]),
        about,
        NOW,
      ),
    ).toBeNull();
  });

  it("skips an item used in the last 30 days and says when the pick was last used", async () => {
    const a = await source("Recently read");
    const b = await source("Read long ago");
    await recordUse(db, "local", "source", a, "opened", NOW - 86_400);
    await recordUse(
      db,
      "local",
      "source",
      b,
      "fetched",
      NOW - (RECENT_USE_DAYS + 10) * 86_400,
    );
    const item = await relatedLibraryItem(
      db,
      "local",
      ranked([hit(a, 0.95), hit(b, 0.9)]),
      about,
      NOW,
    );
    expect(item?.id).toBe(`source:${b}`);
    expect(item?.reason).toContain("last opened or fetched 40 days ago");
  });

  it("ignores hits that are not library items and never throws", async () => {
    expect(
      await relatedLibraryItem(
        db,
        "local",
        ranked([hit("mem_a", 0.99, "memory")]),
        about,
        NOW,
      ),
    ).toBeNull();
    expect(
      await relatedLibraryItem(
        db,
        "local",
        async () => {
          throw new Error("provider down");
        },
        about,
        NOW,
      ),
    ).toBeNull();
  });
});
