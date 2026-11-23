import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { editMemory, saveMemory } from "~/concepts/memories";
import {
  acceptMemoryReview,
  countReviewGroups,
  DEFAULT_REVIEW_SETTINGS,
  listReviewGroups,
  patchReviewSetting,
  type ReviewSource,
  reviewSnapshot,
  runMemoryReview,
  writeReviewSettings,
} from "~/concepts/memory-review";
import {
  reviewPairKey,
  reviewSourceHistory,
} from "~/concepts/memory-review-history";
import {
  DEFAULT_RANKING_MICROUSD,
  DEFAULT_REVIEW_MICROUSD,
  writeReviewCaps,
} from "~/concepts/memory-review-limits";
import {
  DEFAULT_REVIEW_MODEL,
  reviewFailureLabel,
} from "~/concepts/memory-review-model";
import {
  currentRankingStop,
  REVIEW_JEV_MODEL,
  REVIEW_RANK_DESTINATION,
  rankingAuthorization,
  rankingBudget,
  rankingFailureLabel,
  readRankingSettings,
  setRankingEnabled,
} from "~/concepts/memory-review-ranking";
import {
  decodeOutcome,
  encodeOutcome,
  outcomeText,
  reviewOutcome,
} from "~/concepts/memory-review-report";
import {
  createSubject,
  getSubject,
  setSubjectDeleted,
} from "~/concepts/memory-subjects";
import type { ProjectionRow } from "~/search/project";
import { memoryVectorStamp, tenantVectorNamespace } from "~/search/vectors";

const db = env.DB;
const provenance = {
  userId: "local",
  agent: "synthetic",
  client: "test",
  session: null,
};
const vector = Array.from({ length: 1024 }, (_, i) => (i === 0 ? 1 : 0));
const query = vi.fn().mockResolvedValue({ matches: [], count: 0 });
const bindings = {
  DB: db,
  AI: env.AI,
  VECTOR_INDEX: { query },
  VALISE_VECTOR_NAMESPACE: "valise-prod-v1",
  TYPESAFE_API_KEY: "synthetic-key",
};
const noop = async () => ({
  kind: "noop",
  title: "",
  body: "",
  why: "Synthetic no change",
  evidence: [],
});
const draft = async (_model: string, input: string) => {
  const sources = JSON.parse(input) as ReviewSource[];
  return {
    kind: "summary",
    title: "Kestrel pilot context",
    body: "Ada and Bo's unverified Kestrel pilot advice; no rollout is approved.",
    why: "Preserves both attributed claims.",
    evidence: sources.slice(0, 2).map((s) => ({ id: s.id, quote: s.body })),
  };
};
async function add(i: number, title = "Kestrel pilot context") {
  return saveMemory(
    { DB: db },
    {
      type: "fact",
      title,
      body: `Fictional Kestrel pilot note ${i}: Ada says ripe fruit stays cool, never frozen. Unverified.`,
      project: "fictional-kestrel",
      tags: ["synthetic"],
    },
    provenance,
  );
}
async function enabledRanking() {
  await writeReviewSettings(db, "local", {
    ...DEFAULT_REVIEW_SETTINGS,
    enabled: true,
  });
  await setRankingEnabled(
    db,
    "local",
    "on",
    0,
    REVIEW_RANK_DESTINATION,
    DEFAULT_REVIEW_MODEL,
  );
}
async function group() {
  return (await listReviewGroups(db, "local")).find(
    (g) => g.state === "proposal",
  )!;
}
beforeEach(() => {
  query.mockReset().mockResolvedValue({ matches: [], count: 0 });
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const table of [
    "memory_subject_members",
    "memory_subjects",
    "memory_review_events",
    "memory_review_groups",
    "memory_review_pending",
    "memory_review_budgets",
    "memory_review_settings",
    "memory_review_ranking",
    "memory_review_ranking_budgets",
    "memory_review_cost_caps",
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});
function mockProviders(status = 200, malformed = false) {
  const ai = vi.spyOn(env.AI, "run").mockResolvedValue({ data: [vector] });
  const http = vi.fn(async (url: string, init: RequestInit) => {
    // workerd validates fetch options here, as production does: redirect
    // "error" throws a TypeError before any request leaves the Worker.
    new Request(url, init);
    const r = JSON.parse(String(init.body));
    return Response.json(
      {
        model: REVIEW_JEV_MODEL,
        answers: Object.fromEntries(
          Object.keys(r.state.documents).map((id) => [
            id,
            { type: "noul", noul: malformed ? 1.1 : 0.98 },
          ]),
        ),
      },
      { status },
    );
  });
  vi.stubGlobal("fetch", http);
  return { ai, http };
}

describe("review progression and subject approval", () => {
  it("checks one memory now: that memory starts, the queue and retry wait, and the list narrows to it", async () => {
    const a = await add(0);
    const b = await add(1);
    const c = await add(2, "Kestrel pilot context, later note");
    await writeReviewSettings(db, "local", {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
      manualMemories: 8,
    });
    const starts: string[] = [];
    const report = await runMemoryReview(
      { DB: db },
      "local",
      async (model, input) => {
        starts.push((JSON.parse(input) as ReviewSource[])[0].id);
        return draft(model, input);
      },
      false,
      c.id.slice(7),
    );
    expect(report).toMatchObject({ scanned: 1, calls: 1, proposed: 1 });
    expect(starts).toEqual([c.id.slice(7)]);
    const [made] = await listReviewGroups(db, "local");
    const sources = JSON.parse(made.sources_json);
    expect(sources[0].selection).toMatchObject({
      via: "starting-memory",
      anchorId: c.id.slice(7),
    });
    // Only the checked memory leaves the queue; the others keep their own turn.
    const waiting = (
      await db
        .prepare(
          "SELECT memory_id FROM memory_review_pending WHERE user_id = 'local' ORDER BY memory_id",
        )
        .all<{ memory_id: string }>()
    ).results.map((r) => r.memory_id);
    expect(waiting).not.toContain(c.id.slice(7));
    for (const other of [a, b].filter(
      (m) =>
        !sources.some(
          (s: { source: { id: string } }) => s.source.id === m.id.slice(7),
        ),
    ))
      expect(waiting).toContain(other.id.slice(7));
    // The same check again sends nothing: every pair it would form is covered.
    expect(
      (await runMemoryReview({ DB: db }, "local", draft, false, c.id.slice(7)))
        .calls,
    ).toBe(0);
    const outside = (await add(3, "Unrelated orchard ledger")).id.slice(7);
    expect(
      await listReviewGroups(db, "local", 30, true, true, {
        memoryId: c.id.slice(7),
      }),
    ).toHaveLength(1);
    expect(
      await listReviewGroups(db, "local", 30, true, true, {
        memoryId: outside,
      }),
    ).toHaveLength(0);
    expect(
      await listReviewGroups(db, "foreign", 30, true, true, {
        memoryId: c.id.slice(7),
      }),
    ).toHaveLength(0);
    expect((await countReviewGroups(db, "local", c.id.slice(7))).proposal).toBe(
      1,
    );
    expect(
      await listReviewGroups(db, "local", 30, true, true, {
        hideDecided: true,
      }),
    ).toHaveLength(1);
    // A memory the person does not own is never a starting memory.
    expect(
      (await runMemoryReview({ DB: db }, "local", draft, false, "mem_absent"))
        .calls,
    ).toBe(0);
  });
  it("never resends an unchanged compared pair merely because other neighbors rotate", async () => {
    for (let i = 0; i < 7; i++) await add(i);
    await writeReviewSettings(db, "local", {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
      manualMemories: 8,
    });
    const pairs = new Set<string>();
    let calls = 0;
    for (let pass = 0; pass < 8; pass++) {
      const r = await runMemoryReview(
        { DB: db },
        "local",
        async (_m, input) => {
          const sources = JSON.parse(input) as ReviewSource[];
          for (let a = 0; a < sources.length; a++)
            for (let b = a + 1; b < sources.length; b++) {
              const key = reviewPairKey(sources[a].id, sources[b].id);
              expect(pairs.has(key), `repeated pair ${key}`).toBe(false);
              pairs.add(key);
            }
          calls++;
          return noop();
        },
      );
      if (r.stopped === "daily budget") break;
    }
    expect(calls).toBeGreaterThan(1);
    expect(pairs.size).toBeGreaterThan(6);
    expect((await runMemoryReview({ DB: db }, "local", noop)).calls).toBe(0);
  });
  it("keeps indexed compared/cited/incorporated history and admits genuinely changed evidence", async () => {
    const a = await add(0);
    await add(1);
    await writeReviewSettings(db, "local", {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
      manualMemories: 8,
    });
    await runMemoryReview({ DB: db }, "local", draft);
    const g = await group();
    const snapshots = JSON.parse(g.sources_json);
    expect(await reviewSourceHistory(db, "foreign", a.id.slice(7), "")).toEqual(
      [],
    );
    const prior = await reviewSourceHistory(db, "local", a.id.slice(7), "");
    expect(prior[0]).toMatchObject({ state: "proposal", cited: 1 });
    await acceptMemoryReview(
      { DB: db },
      g.group_id,
      {
        draftTitle: g.draft_title!,
        draftBody: g.draft_body!,
        subject: {
          name: "Kestrel transport",
          members: snapshots
            .slice(0, 1)
            .map((s: { source: ReviewSource }) => s.source.id),
          setSummary: true,
          expectedSummary: null,
        },
      },
      provenance,
    );
    const subject = (await db
      .prepare("SELECT * FROM memory_subjects")
      .first())!;
    expect(
      (await getSubject(db, "local", String(subject.subject_id)))?.summaryId,
    ).toBe(
      (await listReviewGroups(db, "local")).find(
        (x) => x.group_id === g.group_id,
      )?.result_memory_id,
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_subject_members")
        .first(),
    ).toEqual({ n: 1 });
    expect(
      (await reviewSourceHistory(db, "local", a.id.slice(7), ""))[0],
    ).toMatchObject({ state: "accepted", cited: 1 });
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM memory_links WHERE kind='supersedes'",
        )
        .first(),
    ).toEqual({ n: 0 });
    await editMemory(
      { DB: db },
      a.id.slice(7),
      {
        body: "Kestrel pilot advice changed: never freeze ripe fruit; Bo adds dry packaging.",
      },
      provenance,
    );
    expect(
      (await runMemoryReview({ DB: db }, "local", noop)).calls,
    ).toBeGreaterThan(0);
  });
  it("refuses foreign/stale subjects and invalid memberships without partial acceptance", async () => {
    await add(0);
    await add(1);
    await writeReviewSettings(db, "local", {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
    });
    await runMemoryReview({ DB: db }, "local", draft);
    const g = await group();
    const sources = JSON.parse(g.sources_json);
    const { id: target } = await createSubject(db, "local", {
      name: "Pilot",
      kind: "topic",
      description: "Synthetic",
    });
    const accept = { draftTitle: g.draft_title!, draftBody: g.draft_body! };
    await expect(
      acceptMemoryReview(
        { DB: db },
        g.group_id,
        {
          ...accept,
          subject: {
            id: "sub_foreign",
            members: [sources[0].source.id],
            setSummary: true,
            expectedSummary: null,
          },
        },
        provenance,
      ),
    ).rejects.toThrow("subject");
    // A new subject may not repeat a live subject's name.
    await expect(
      acceptMemoryReview(
        { DB: db },
        g.group_id,
        {
          ...accept,
          subject: {
            name: " pilot ",
            members: [sources[0].source.id],
            setSummary: false,
            expectedSummary: null,
          },
        },
        provenance,
      ),
    ).rejects.toThrow("already exists");
    // Nor organize into a deleted subject.
    await setSubjectDeleted(db, "local", target, true);
    await expect(
      acceptMemoryReview(
        { DB: db },
        g.group_id,
        {
          ...accept,
          subject: {
            id: target,
            members: [sources[0].source.id],
            setSummary: false,
            expectedSummary: null,
          },
        },
        provenance,
      ),
    ).rejects.toThrow("subject");
    await setSubjectDeleted(db, "local", target, false);
    await expect(
      acceptMemoryReview(
        { DB: db },
        g.group_id,
        {
          ...accept,
          subject: {
            id: target,
            members: ["mem_foreign"],
            setSummary: false,
            expectedSummary: null,
          },
        },
        provenance,
      ),
    ).rejects.toThrow("sources");
    await db
      .prepare(
        "UPDATE memory_subjects SET summary_memory_id=? WHERE subject_id=?",
      )
      .bind(sources[0].source.id, target)
      .run();
    await expect(
      acceptMemoryReview(
        { DB: db },
        g.group_id,
        {
          ...accept,
          subject: {
            id: target,
            members: [sources[1].source.id],
            setSummary: true,
            expectedSummary: null,
          },
        },
        provenance,
      ),
    ).rejects.toThrow("changed");
    expect((await group()).state).toBe("proposal");
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 2 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_review_events")
        .first(),
    ).toEqual({ n: 0 });
  });
  it("rolls the entire approval back when a subject pointer changes after preflight", async () => {
    await add(0);
    await add(1);
    await writeReviewSettings(db, "local", {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
    });
    await runMemoryReview({ DB: db }, "local", draft);
    const g = await group();
    const sources = JSON.parse(g.sources_json);
    const { id: target } = await createSubject(db, "local", {
      name: "Pilot",
      kind: "topic",
      description: "",
    });
    const raced = new Proxy(db, {
      get(t, p) {
        if (p === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await db
              .prepare(
                "UPDATE memory_subjects SET summary_memory_id=? WHERE subject_id=?",
              )
              .bind(sources[0].source.id, target)
              .run();
            return t.batch(statements);
          };
        const v = Reflect.get(t, p);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    await expect(
      acceptMemoryReview(
        { DB: raced },
        g.group_id,
        {
          draftTitle: g.draft_title!,
          draftBody: g.draft_body!,
          subject: {
            id: target,
            members: [sources[1].source.id],
            setSummary: true,
            expectedSummary: null,
          },
        },
        provenance,
      ),
    ).rejects.toThrow("changed");
    expect((await group()).state).toBe("proposal");
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 2 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_subject_members")
        .first(),
    ).toEqual({ n: 0 });
  });
});

describe("separately consented candidate ranking", () => {
  it("admits a current vector-only neighbor but never hydrates stale or foreign hints for Jev", async () => {
    const { http } = mockProviders();
    const anchor = await saveMemory(
      { DB: db },
      {
        type: "fact",
        title: "Orchard routing",
        body: "Ada handles dispatch.",
        tags: [],
      },
      provenance,
    );
    const neighbor = await saveMemory(
      { DB: db },
      {
        type: "fact",
        title: "Kestrel transport",
        body: "Bo checks packaging.",
        tags: [],
      },
      provenance,
    );
    await db
      .prepare("DELETE FROM memory_review_pending WHERE memory_id<>?")
      .bind(anchor.id.slice(7))
      .run();
    const projection = await db
      .prepare(
        "SELECT doc_key AS docKey,user_id AS userId,concept,concept_id AS conceptId,project,title,body,tags,updated_at AS updatedAt FROM search_docs WHERE doc_key=?",
      )
      .bind(neighbor.id)
      .first<ProjectionRow>();
    const stamp = await memoryVectorStamp(bindings.VALISE_VECTOR_NAMESPACE, {
      projection: projection!,
      generation: 1,
    });
    const partition = await tenantVectorNamespace(
      bindings.VALISE_VECTOR_NAMESPACE,
      "local",
    );
    query.mockResolvedValue({
      matches: [
        {
          id: stamp,
          namespace: partition,
          score: 0.99,
          metadata: { docKey: neighbor.id, stamp },
        },
        {
          id: "f".repeat(64),
          namespace: partition,
          score: 1,
          metadata: { docKey: anchor.id, stamp: "f".repeat(64) },
        },
        {
          id: stamp,
          namespace: "foreign",
          score: 1,
          metadata: { docKey: anchor.id, stamp },
        },
      ],
      count: 3,
    });
    await enabledRanking();
    expect((await runMemoryReview(bindings, "local", draft)).calls).toBe(1);
    const snapshots = JSON.parse((await group()).sources_json);
    expect(snapshots[0].selection.ranking.candidates).toEqual([
      { id: neighbor.id.slice(7), score: 0.98, via: "vector-match" },
    ]);
    expect(http).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][1]).toMatchObject({
      namespace: partition,
      topK: 50,
    });
  });
  it.each(["requests", "cost"])(
    "cannot borrow synthesis budget when the ranking %s cap is exhausted",
    async (kind) => {
      const { ai, http } = mockProviders();
      await add(0);
      await add(1);
      await enabledRanking();
      await db
        .prepare(
          "INSERT INTO memory_review_ranking_budgets(user_id,day,requests,reserved_microusd,manual_requests) VALUES('local',CAST(unixepoch()/86400 AS INTEGER),?,?,?)",
        )
        .bind(
          kind === "requests" ? 50 : 0,
          kind === "cost" ? DEFAULT_RANKING_MICROUSD : 0,
          kind === "requests" ? 50 : 0,
        )
        .run();
      const infer = vi.fn(draft);
      expect((await runMemoryReview(bindings, "local", infer)).stopped).toBe(
        kind === "requests" ? "ranking-daily-limit" : "ranking-cost-limit",
      );
      expect(ai).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(infer).not.toHaveBeenCalled();
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM memory_review_budgets")
          .first(),
      ).toEqual({ n: 0 });
    },
  );
  it.each(["account", "lease", "model", "overnight", "destination"])(
    "refuses the %s race immediately before external admission",
    async (kind) => {
      await enabledRanking();
      await db
        .prepare(
          "UPDATE memory_review_settings SET lock_token='synthetic-lease',lock_until=unixepoch()+60,overnight=1 WHERE user_id='local'",
        )
        .run();
      const setting = await readRankingSettings(db, "local");
      if (kind === "account")
        await db
          .prepare(
            "UPDATE users SET role='member',email_verified=0 WHERE user_id='local'",
          )
          .run();
      if (kind === "lease")
        await db
          .prepare(
            "UPDATE memory_review_settings SET lock_token='new-owner' WHERE user_id='local'",
          )
          .run();
      if (kind === "model")
        await patchReviewSetting(
          db,
          "local",
          "model",
          "anthropic/claude-sonnet-5.5",
        );
      if (kind === "overnight")
        await db
          .prepare(
            "UPDATE memory_review_settings SET overnight=0 WHERE user_id='local'",
          )
          .run();
      if (kind === "destination")
        await db
          .prepare(
            "UPDATE memory_review_ranking SET destination='retired-destination' WHERE user_id='local'",
          )
          .run();
      try {
        await expect(
          rankingAuthorization(
            db,
            { userId: "local", token: "synthetic-lease", overnight: true },
            setting,
            DEFAULT_REVIEW_MODEL,
          )("ranking", 1000),
        ).rejects.toThrow("ranking-permission");
        expect((await rankingBudget(db, "local")).requests).toBe(0);
      } finally {
        if (kind === "account")
          await db
            .prepare(
              "UPDATE users SET role='owner',email_verified=1 WHERE user_id='local'",
            )
            .run();
      }
    },
  );
  it("requires a successful manual hybrid synthesis before overnight opt-in", async () => {
    await enabledRanking();
    await add(0);
    await add(1);
    mockProviders();
    await expect(
      patchReviewSetting(db, "local", "overnight", "on", DEFAULT_REVIEW_MODEL),
    ).rejects.toThrow();
    await runMemoryReview(bindings, "local", draft);
    await patchReviewSetting(
      db,
      "local",
      "overnight",
      "on",
      DEFAULT_REVIEW_MODEL,
    );
    expect(
      await db
        .prepare(
          "SELECT overnight FROM memory_review_settings WHERE user_id='local'",
        )
        .first(),
    ).toEqual({ overnight: 1 });
    await expect(
      setRankingEnabled(
        db,
        "local",
        "on",
        0,
        REVIEW_RANK_DESTINATION,
        DEFAULT_REVIEW_MODEL,
      ),
    ).rejects.toThrow();
    expect(
      await db
        .prepare(
          "SELECT overnight FROM memory_review_settings WHERE user_id='local'",
        )
        .first(),
    ).toEqual({ overnight: 1 });
  });
  it("does no embedding or Jev work by default", async () => {
    const { ai, http } = mockProviders();
    await add(0);
    await add(1);
    await writeReviewSettings(db, "local", {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
    });
    await runMemoryReview(bindings, "local", draft);
    expect(ai).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect((await readRankingSettings(db, "local")).enabled).toBe(false);
  });
  it("records separate reservations, full evidence and provenance before synthesis", async () => {
    const { ai, http } = mockProviders();
    await add(0);
    await add(1);
    await enabledRanking();
    const r = await runMemoryReview(bindings, "local", draft);
    expect(r.calls).toBe(1);
    expect(ai).toHaveBeenCalledTimes(1);
    expect(http).toHaveBeenCalledTimes(1);
    const b = await rankingBudget(db, "local");
    expect(b.requests).toBe(2);
    expect(b.reserved_microusd).toBeGreaterThan(0);
    const g = await group();
    const sources = JSON.parse(g.sources_json);
    expect(sources[0].selection.ranking.model).toBe(REVIEW_JEV_MODEL);
    expect(sources[1].selection.via).toBe("hybrid-ranking");
    expect(sources[1].selection.score).toBe(0.98);
    expect((await readRankingSettings(db, "local")).manualModel).toBe(
      DEFAULT_REVIEW_MODEL,
    );
    expect(
      (await reviewSnapshot(db, "local", sources[0].source.id))?.fingerprint,
    ).toBe(sources[0].fingerprint);
  });
  it.each([
    ["HTTP 401", 401, false, "ranking-http-401"],
    ["HTTP 400", 400, false, "ranking-http-400"],
    ["a redirect", 302, false, "ranking-http-302"],
    ["an out-of-range probability", 200, true, "ranking-invalid-response"],
  ] as const)(
    "pauses on %s with a code that names it, without clearing pending sources or falling back",
    async (_name, status, malformed, code) => {
      const { http } = mockProviders(status, malformed);
      await add(0);
      await add(1);
      await enabledRanking();
      const infer = vi.fn(draft);
      const r = await runMemoryReview(bindings, "local", infer);
      expect(r.stopped).toBe(code);
      expect(infer).not.toHaveBeenCalled();
      expect(http).toHaveBeenCalledTimes(1);
      expect(await rankingBudget(db, "local")).toMatchObject({
        requests: 2,
        last_error: code,
      });
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM memory_review_pending")
          .first(),
      ).toEqual({ n: 2 });
      expect(await listReviewGroups(db, "local")).toEqual([]);
      expect(rankingFailureLabel(code)).not.toMatch(/unrecorded/);
    },
  );
  it("drops a recorded limit stop once the limit no longer holds", () => {
    const limits = {
      manualMemories: 25,
      upkeepMemories: 50,
      rankingMicrousd: 200_000,
    };
    const budget = {
      manual_requests: 0,
      upkeep_requests: 0,
      reserved_microusd: 2050,
      last_error: "ranking-daily-limit",
    };
    // Recorded under the old 4-request counter, read against 50 by hand.
    expect(currentRankingStop(budget, limits)).toBeNull();
    expect(currentRankingStop({ ...budget, manual_requests: 49 }, limits)).toBe(
      "ranking-daily-limit",
    );
    expect(
      currentRankingStop(
        { ...budget, last_error: "ranking-cost-limit" },
        limits,
      ),
    ).toBeNull();
    expect(
      currentRankingStop(
        {
          ...budget,
          last_error: "ranking-cost-limit",
          reserved_microusd: 199_500,
        },
        limits,
      ),
    ).toBe("ranking-cost-limit");
    expect(
      currentRankingStop({ ...budget, last_error: "ranking-timeout" }, limits),
    ).toBe("ranking-timeout");
    expect(
      currentRankingStop({ ...budget, last_error: null }, limits),
    ).toBeNull();
  });
  it("labels a cancelled retry, including rows stored before codes existed", () => {
    for (const code of [
      "sources-changed",
      "selection-changed",
      "Sources changed; retry cancelled",
      "Provider or prompt selection changed; retry cancelled",
    ])
      expect(reviewFailureLabel(code)).toMatch(/retry was cancelled/);
  });
  it("retries Jev on 429 inside the deadline, on the one reserved request", async () => {
    const { http } = mockProviders();
    const ok = http.getMockImplementation()!;
    http.mockImplementationOnce(
      async () => new Response(null, { status: 429 }),
    );
    http.mockImplementation(ok);
    await add(0);
    await add(1);
    await enabledRanking();
    const r = await runMemoryReview(bindings, "local", draft);
    expect(r.calls).toBe(1);
    expect(http).toHaveBeenCalledTimes(2);
    expect((await rankingBudget(db, "local")).requests).toBe(2);
  });
  it("names a Jev timeout and a network failure apart", async () => {
    const { http } = mockProviders();
    await add(0);
    await add(1);
    await enabledRanking();
    http.mockRejectedValueOnce(
      new DOMException("The operation timed out.", "TimeoutError"),
    );
    expect((await runMemoryReview(bindings, "local", draft)).stopped).toBe(
      "ranking-timeout",
    );
    await db.prepare("DELETE FROM memory_review_ranking_budgets").run();
    http.mockRejectedValueOnce(new TypeError("Network connection lost."));
    expect((await runMemoryReview(bindings, "local", draft)).stopped).toBe(
      "ranking-unreachable",
    );
  });
  it("names an embedding failure as Workers AI, not as Jev", async () => {
    const { ai, http } = mockProviders();
    ai.mockRejectedValueOnce(new Error("AiError: 3040: capacity"));
    await add(0);
    await add(1);
    await enabledRanking();
    const r = await runMemoryReview(bindings, "local", draft);
    expect(r.stopped).toBe("embedding-failed");
    expect(http).not.toHaveBeenCalled();
    expect((await rankingBudget(db, "local")).requests).toBe(1);
  });
  it("does not spend the last ranking request on an embedding Jev cannot follow", async () => {
    const { ai, http } = mockProviders();
    await add(0);
    await add(1);
    await enabledRanking();
    await db
      .prepare(
        // One short of two requests for each of the 25 memories by hand.
        "INSERT INTO memory_review_ranking_budgets(user_id,day,requests,reserved_microusd,manual_requests) VALUES('local',CAST(unixepoch()/86400 AS INTEGER),49,0,49)",
      )
      .run();
    const r = await runMemoryReview(bindings, "local", draft);
    expect(r.stopped).toBe("ranking-daily-limit");
    expect(reviewOutcome(r)).toMatchObject({
      stop: "ranking",
      reason: "ranking-daily-limit",
    });
    expect(
      outcomeText(decodeOutcome(encodeOutcome(reviewOutcome(r)))!),
    ).toMatch(/two for each memory checked, are used up/);
    expect(ai).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(await rankingBudget(db, "local")).toMatchObject({
      requests: 49,
      manual_requests: 49,
      last_error: "ranking-daily-limit",
    });
  });
  it("counts ranking requests by hand and at night apart, and names an admin's cost cap when it stops ranking", async () => {
    const { ai, http } = mockProviders();
    await add(0);
    await add(1);
    await enabledRanking();
    // The night's requests do not use up the day's requests by hand.
    await db
      .prepare(
        "INSERT INTO memory_review_ranking_budgets(user_id,day,requests,reserved_microusd,upkeep_requests) VALUES('local',CAST(unixepoch()/86400 AS INTEGER),100,1000,100)",
      )
      .run();
    await writeReviewCaps(
      db,
      "local",
      { reviewMicrousd: DEFAULT_REVIEW_MICROUSD, rankingMicrousd: 1000 },
      "admin-test",
    );
    const r = await runMemoryReview(bindings, "local", draft);
    expect(r.stopped).toBe("ranking-cost-limit");
    expect(outcomeText(reviewOutcome(r))).toMatch(
      /ranking cost cap is used up/,
    );
    expect(ai).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
    expect(await rankingBudget(db, "local")).toMatchObject({
      requests: 100,
      manual_requests: 0,
      last_error: "ranking-cost-limit",
    });
  });
  it("revokes delayed ranking dispatch after an off switch, retaining the spent embedding", async () => {
    const { ai, http } = mockProviders();
    await add(0);
    await add(1);
    await enabledRanking();
    ai.mockImplementation(async () => {
      await setRankingEnabled(
        db,
        "local",
        "off",
        0,
        REVIEW_RANK_DESTINATION,
        DEFAULT_REVIEW_MODEL,
      );
      return { data: [vector] };
    });
    const r = await runMemoryReview(bindings, "local", draft);
    expect(r.stopped).toBe("ranking-permission");
    expect(http).not.toHaveBeenCalled();
    expect((await rankingBudget(db, "local")).requests).toBe(1);
    expect((await readRankingSettings(db, "local")).manualModel).toBeNull();
  });
  it("stops before ranking when generation budget is exhausted and refuses stale consent forms", async () => {
    const { ai, http } = mockProviders();
    await add(0);
    await add(1);
    await enabledRanking();
    await expect(
      setRankingEnabled(
        db,
        "local",
        "on",
        0,
        REVIEW_RANK_DESTINATION,
        DEFAULT_REVIEW_MODEL,
      ),
    ).rejects.toThrow("Reload");
    await db
      .prepare(
        "INSERT INTO memory_review_budgets(user_id,day,calls,reserved_microusd,manual_calls) VALUES('local',CAST(unixepoch()/86400 AS INTEGER),25,10000,25)",
      )
      .run();
    expect((await runMemoryReview(bindings, "local", draft)).stopped).toBe(
      "daily budget",
    );
    expect(ai).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });
  it("clears ranking permission and manual eligibility on a model destination change", async () => {
    await enabledRanking();
    await patchReviewSetting(
      db,
      "local",
      "model",
      "anthropic/claude-sonnet-5.5",
    );
    expect(await readRankingSettings(db, "local")).toMatchObject({
      enabled: false,
      manualModel: null,
      revision: 2,
    });
  });
});
