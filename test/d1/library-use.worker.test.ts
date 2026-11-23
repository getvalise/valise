import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  NEAR_TIE,
  orderByUse,
  readRating,
  recordUse,
  setRating,
  USE_HALF_LIFE_SECONDS,
  useReasons,
  useScore,
  useSignals,
} from "~/concepts/library-use";
import { deleteSource, saveSource } from "~/concepts/sources";

const db = env.DB;
const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};
const NOW = 1_800_000_000;

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_revisions",
    "sources",
    "library_use_events",
    "library_ratings",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

async function bookmark(extra: Record<string, unknown> = {}) {
  const saved = await saveSource(
    { DB: db },
    {
      kind: "bookmark",
      title: "Hedgerows",
      url: "https://example.org/hedgerows",
      notes: "",
      tags: [],
      ...extra,
    },
    provenance,
  );
  return saved.sourceId;
}

describe("recording use", () => {
  it("collapses repeats inside half an hour and keeps the next one", async () => {
    const id = await bookmark();
    await recordUse(db, "local", "source", id, "opened", NOW);
    await recordUse(db, "local", "source", id, "opened", NOW + 60);
    await recordUse(db, "local", "source", id, "fetched", NOW + 60);
    await recordUse(db, "local", "source", id, "opened", NOW + 31 * 60);
    const signals = (
      await useSignals(
        db,
        "local",
        [{ concept: "source", conceptId: id }],
        NOW + 31 * 60,
      )
    ).get(`source:${id}`);
    expect(signals?.opened).toEqual([0, 31 * 60]);
    expect(signals?.fetched).toEqual([30 * 60]);
  });

  it("never fails its caller, even when the write is refused", async () => {
    await expect(
      recordUse(db, "local", "source", "src_x", "bogus" as "opened", NOW),
    ).resolves.toBeUndefined();
  });

  it("sets, replaces and clears a rating, and forgets use with the item", async () => {
    const id = await bookmark();
    await setRating(db, "local", "source", id, 2, NOW);
    await setRating(db, "local", "source", id, 3, NOW);
    expect(await readRating(db, "local", "source", id)).toBe(3);
    await setRating(db, "local", "source", id, null, NOW);
    expect(await readRating(db, "local", "source", id)).toBeNull();
    await setRating(db, "local", "source", id, 1, NOW);
    await recordUse(db, "local", "source", id, "opened", NOW);
    await deleteSource(db, "local", id);
    const left = await db
      .prepare(
        "SELECT (SELECT COUNT(*) FROM library_ratings) + (SELECT COUNT(*) FROM library_use_events) AS n",
      )
      .first<{ n: number }>();
    expect(left?.n).toBe(0);
  });

  it("refuses a fourth star in the database", async () => {
    await expect(
      setRating(db, "local", "source", "src_x", 4 as 3, NOW),
    ).rejects.toThrow();
  });
});

describe("signals and score", () => {
  it("counts highlights saved from the same page, notes, and another owner's nothing", async () => {
    const page = await bookmark({
      notes: "Worth rereading for the windbreak bit.",
    });
    for (const text of ["first", "second"])
      await saveSource(
        { DB: db },
        {
          kind: "reference",
          title: `Highlight ${text}`,
          url: "https://example.org/hedgerows",
          notes: text,
          tags: [],
        },
        provenance,
      );
    const bare = await bookmark({ url: "https://example.org/other" });
    const signals = await useSignals(db, "local", [
      { concept: "source", conceptId: page },
      { concept: "source", conceptId: bare },
    ]);
    expect(signals.get(`source:${page}`)).toMatchObject({
      highlights: 2,
      noted: true,
    });
    expect(signals.get(`source:${bare}`)).toMatchObject({
      highlights: 0,
      noted: false,
    });
    expect(
      (
        await useSignals(db, "usr_other", [
          { concept: "source", conceptId: page },
        ])
      ).size,
    ).toBe(0);
    expect(useReasons(signals.get(`source:${page}`))).toEqual([
      "you highlighted this 2 times",
      "you wrote notes on this",
    ]);
  });

  it("halves a use's weight every 90 days and never reaches zero", () => {
    const at = (age: number) =>
      useScore({
        stars: null,
        highlights: 0,
        noted: false,
        opened: [age],
        fetched: [],
      });
    expect(at(0)).toBe(1);
    expect(at(USE_HALF_LIFE_SECONDS)).toBeCloseTo(0.5);
    expect(at(4 * USE_HALF_LIFE_SECONDS)).toBeCloseTo(1 / 16);
    expect(at(40 * USE_HALF_LIFE_SECONDS)).toBeGreaterThan(0);
    // A lasting mark outweighs a single old read.
    expect(
      useScore({
        stars: 1,
        highlights: 0,
        noted: false,
        opened: [],
        fetched: [],
      }),
    ).toBeGreaterThan(at(USE_HALF_LIFE_SECONDS));
  });

  it("only reports reads from the last 90 days", () => {
    expect(
      useReasons({
        stars: null,
        highlights: 0,
        noted: false,
        opened: [10, USE_HALF_LIFE_SECONDS + 1],
        fetched: [5, 6, 7],
      }),
    ).toEqual([
      "you opened this once in the last 90 days",
      "an agent fetched this 3 times in the last 90 days",
    ]);
  });
});

describe("near-tie ordering", () => {
  const hit = (id: string, score: number) => ({ id, score });
  const ids = (hits: { id: string }[]) => hits.map((h) => h.id);

  it("lifts a used hit over a close one, never over one 0.05 more relevant", () => {
    const hits = [hit("a", 0.9), hit("b", 0.87), hit("c", 0.86), hit("d", 0.7)];
    const use = { c: 5, d: 9 } as Record<string, number>;
    const ordered = orderByUse(hits, (h) => use[h.id] ?? 0, NEAR_TIE);
    // c is within 0.05 of a and joins its run; d is 0.2 below and stays last.
    expect(ids(ordered)).toEqual(["c", "a", "b", "d"]);
    for (const [index, h] of ordered.entries())
      for (const later of ordered.slice(index + 1))
        expect(later.score - h.score).toBeLessThan(NEAR_TIE);
  });

  it("keeps relevance order when nothing is used, and orders exact ties at tolerance 0", () => {
    const hits = [hit("a", -3), hit("b", -3), hit("c", -2)];
    expect(ids(orderByUse(hits, () => 0, NEAR_TIE))).toEqual(["a", "b", "c"]);
    expect(
      ids(orderByUse(hits, (h) => (h.id === "b" || h.id === "c" ? 1 : 0), 0)),
    ).toEqual(["b", "a", "c"]);
  });
});
