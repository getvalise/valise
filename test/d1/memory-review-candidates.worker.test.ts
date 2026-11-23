import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_REVIEW_SETTINGS,
  listReviewGroups,
  type ReviewSnapshot,
  reviewSnapshot,
  runMemoryReview,
  writeReviewSettings,
} from "~/concepts/memory-review";
import { search } from "~/search/query";
import { seedMemories } from "~/search/seed";
import {
  CANDIDATE_CASES,
  CANDIDATE_JEV_MODEL,
  candidateRankingRequest,
  candidateRankingScores,
  scoreCandidates,
} from "../../evals/memory-review/candidates";

// Real local D1/FTS and the unchanged production selector; never live inference.
afterEach(async () => {
  vi.unstubAllGlobals();
  for (const table of [
    "memory_review_groups",
    "memory_review_pending",
    "memory_review_budgets",
    "memory_review_settings",
    "search_docs",
    "memory_lessons",
    "memory_reflections",
    "memory_principles",
    "memory_revisions",
    "memories",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

describe("consolidation candidate benchmark", () => {
  it("measures cross-group reuse without treating it as missing exact-group history", async () => {
    const memories = Array.from({ length: 7 }, (_, i) => ({
      id: `mem_overlap_${i}`,
      type: "fact",
      title: "Kestrel recurring review",
      body: `Ada's unverified Kestrel pilot apple advice: cool, never frozen. Field note ${i}.`,
      project: "fictional-kestrel",
      updatedAt: 10 + i,
      tags: ["synthetic"],
    }));
    await seedMemories(env, memories);
    await writeReviewSettings(env.DB, "local", {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
      manualMemories: 8,
    });
    const draft = vi.fn(async () => ({
      kind: "noop",
      title: "",
      body: "",
      why: "Synthetic coverage observation only.",
      evidence: [],
    }));
    const passes = [
      await runMemoryReview(env, "local", draft),
      await runMemoryReview(env, "local", draft),
    ];
    const groups = await listReviewGroups(env.DB, "local");
    const sets = groups.map(
      (g) => JSON.parse(g.sources_json) as ReviewSnapshot[],
    );
    const counts = new Map<string, number>();
    for (const sources of sets)
      for (const s of sources) {
        expect(
          (await reviewSnapshot(env.DB, "local", s.source.id))?.fingerprint,
        ).toBe(s.fingerprint);
        counts.set(s.source.id, (counts.get(s.source.id) ?? 0) + 1);
      }
    // Exact group sets are unique even when individual unchanged sources recur.
    const keys = sets.map((s) =>
      s
        .map((m) => m.source.id)
        .sort()
        .join(","),
    );
    expect(new Set(keys).size).toBe(keys.length);
    console.log(
      JSON.stringify({
        coverageObservation: {
          passes,
          groups: groups.length,
          repeatedUnchangedSources: [...counts].filter(([, n]) => n > 1),
          sourceSets: keys,
        },
      }),
    );
  });

  for (const fixture of CANDIDATE_CASES) {
    it(`measures actual review selection: ${fixture.name}`, async () => {
      const external = vi.fn(() => {
        throw new Error("No external calls in candidate benchmark");
      });
      vi.stubGlobal("fetch", external);
      await seedMemories(
        env,
        [fixture.anchor, ...fixture.candidates].map((m) => ({
          ...m,
          type: "fact",
          tags: ["synthetic"],
        })),
      );
      // Isolate the single anchor. Seeding triggered eligibility for every row.
      await env.DB.prepare(
        "DELETE FROM memory_review_pending WHERE memory_id != ?",
      )
        .bind(fixture.anchor.id)
        .run();
      await writeReviewSettings(env.DB, "local", {
        ...DEFAULT_REVIEW_SETTINGS,
        enabled: true,
      });
      const report = await runMemoryReview(env, "local", async () => ({
        kind: "noop",
        title: "",
        body: "",
        why: "Provider-free candidate measurement, not a semantic decision.",
        evidence: [],
      }));
      const groups = await listReviewGroups(env.DB, "local");
      expect(groups).toHaveLength(1);
      const sources = JSON.parse(groups[0].sources_json) as ReviewSnapshot[];
      expect(sources[0].source.id).toBe(fixture.anchor.id);
      expect(sources.length).toBeLessThanOrEqual(4);
      expect(report.failed).toBe(0);
      const baseline = sources.slice(1).map((s) => s.source.id);
      const wide = (
        await search(env, {
          userId: "local",
          query: fixture.anchor.title,
          project: fixture.anchor.project,
          concepts: ["memory"],
          limit: 50,
        })
      )
        .map((h) => h.conceptId)
        .filter((id) => id !== fixture.anchor.id);
      // Print measurements, not floors that enshrine today's distractor selection.
      console.log(
        JSON.stringify({
          fixture: fixture.name,
          baseline,
          lexical50: wide,
          baselineScore: scoreCandidates(fixture, baseline),
          lexical50Score: scoreCandidates(fixture, wide),
          methods: sources.slice(1).map((s) => s.selection?.via),
        }),
      );
      expect(external).not.toHaveBeenCalled();
    });
  }

  it("scores abstention, positive recall, duplicate ids and unknown ids honestly", () => {
    const positive = CANDIDATE_CASES[0];
    expect(scoreCandidates(positive, [positive.anchor.id])).toMatchObject({
      recall: 0,
      precision: null,
      exact: false,
    });
    const target = positive.candidates.find((m) => m.label === "duplicate")!.id;
    expect(scoreCandidates(positive, [target, target])).toMatchObject({
      recall: 1,
      precision: 1,
      selected: 1,
      exact: true,
    });
    expect(scoreCandidates(CANDIDATE_CASES[4], [])).toMatchObject({
      recall: null,
      precision: null,
      exact: true,
    });
    expect(() => scoreCandidates(positive, ["unknown"])).toThrow(
      "Unknown candidate",
    );
  });

  it("keeps labels out of the matched Jev questions and full qualifier text intact", () => {
    for (const fixture of CANDIDATE_CASES) {
      const generic = candidateRankingRequest(fixture, "search-relevance");
      const joint = candidateRankingRequest(fixture, "joint-review");
      expect(generic.request.state).toEqual(joint.request.state);
      expect(JSON.stringify(joint.request.state)).not.toContain('"label"');
      expect(joint.request.state.anchor.body).toBe(fixture.anchor.body);
      const docs = Object.values(joint.request.state.documents);
      fixture.candidates.forEach((m, i) => expect(docs[i].body).toBe(m.body));
      const reverse = candidateRankingRequest(fixture, "joint-review", true);
      expect(reverse.candidateIds).toEqual([...joint.candidateIds].reverse());
    }
    const fixture = CANDIDATE_CASES[0];
    expect(() =>
      candidateRankingRequest(
        { ...fixture, anchor: { ...fixture.anchor, body: "x".repeat(24_000) } },
        "joint-review",
      ),
    ).toThrow("byte budget");
  });

  it("rejects missing, malformed, out-of-range or wrong-model scores", () => {
    const response = (n: unknown) => ({
      model: CANDIDATE_JEV_MODEL,
      answers: { D00: { type: "noul", noul: n } },
    });
    expect(candidateRankingScores(response(0.7), 1)).toEqual([0.7]);
    for (const n of [null, "0.5", NaN, Infinity, -0.1, 1.1])
      expect(() => candidateRankingScores(response(n), 1)).toThrow();
    expect(() => candidateRankingScores(response(0.7), 2)).toThrow();
    expect(() =>
      candidateRankingScores({ ...response(0.7), model: "jev-latest" }, 1),
    ).toThrow();
    expect(() => candidateRankingScores(null, 1)).toThrow();
    expect(() => candidateRankingScores(response(0.7), 0)).toThrow();
    expect(() => candidateRankingScores(response(0.7), 31)).toThrow();
    expect(() =>
      candidateRankingScores(
        {
          model: CANDIDATE_JEV_MODEL,
          answers: { D00: { type: "score", noul: 0.7 } },
        },
        1,
      ),
    ).toThrow();
  });
});
