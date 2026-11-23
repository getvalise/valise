import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveMemory, editMemory, saveMemory } from "~/concepts/memories";
import {
  fitLessonBatch,
  LESSON_BATCH,
  LESSON_SYSTEM,
  type LessonSource,
  lessonCoverage,
  validateLessons,
} from "~/concepts/memory-lessons";
import {
  DEFAULT_REVIEW_SETTINGS,
  listReviewGroups,
  overnightMemoryReview,
  readUpkeepStatus,
  reviewBudget,
  runLessonPass,
  runMemoryReview,
  writeReviewSettings,
} from "~/concepts/memory-review";

/**
 * Lesson lines (J-E, ADR-0012 amendment of 2026-11-08) and the review
 * selection without same-project filler. No live provider: drafts are
 * injected, as the review tests do.
 */
const db = env.DB;
const user = "local";
const author = {
  userId: user,
  agent: "test-author",
  client: "mcp",
  session: "synthetic-session",
};
const raw = (id: string) => id.slice("memory:".length);
const save = (title: string, body: string, project = "lesson-fixture") =>
  saveMemory(
    env,
    { type: "insight", title, body, tags: ["synthetic"], project },
    author,
  );
const nightly = (patch = {}) =>
  writeReviewSettings(db, user, {
    ...DEFAULT_REVIEW_SETTINGS,
    enabled: true,
    overnight: true,
    autoApply: true,
    ...patch,
  });
type LessonRequest = { task: string; memories: { id: string; body: string }[] };
/** Answers like a model: a lesson for each memory, none for one marked reference. */
const lessonDraft = vi.fn(async (_model: string, input: string) => {
  const { memories } = JSON.parse(input) as LessonRequest;
  return {
    lessons: memories.map((m) =>
      m.body.includes("referencemarker")
        ? { id: m.id, lesson: "", mechanism: ["ignored"], forward: "ignored" }
        : {
            id: m.id,
            lesson:
              "Concurrent workers sharing mutable state corrupt each other's output.",
            mechanism: ["Concurrency", "shared-state"],
            forward: "Give each worker its own state.",
          },
    ),
  };
});
const lessons = () =>
  db
    .prepare(
      "SELECT memory_id, revision, lesson, mechanism_json, forward, prompt_version FROM memory_lessons ORDER BY memory_id, revision",
    )
    .all<{
      memory_id: string;
      revision: number;
      lesson: string;
      mechanism_json: string;
      forward: string;
      prompt_version: string;
    }>()
    .then((r) => r.results);

afterEach(async () => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
  for (const table of [
    "memory_lessons",
    "memory_reflections",
    "memory_principles",
    "memory_review_events",
    "memory_review_groups",
    "memory_review_pending",
    "memory_review_budgets",
    "memory_review_settings",
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

describe("validating lesson lines", () => {
  const sources: LessonSource[] = [
    { id: "mem_a", revision: 1, type: "fact", title: "A", body: "a" },
    { id: "mem_b", revision: 1, type: "fact", title: "B", body: "b" },
  ];
  const line = (id: string, lesson = "A general lesson.") => ({
    id,
    lesson,
    mechanism: ["x"],
    forward: "",
  });

  it("keeps lines for sent ids and clears keywords on an empty lesson", () => {
    expect(
      validateLessons(
        { lessons: [line("mem_a"), { ...line("mem_b", ""), forward: "x" }] },
        sources,
      ),
    ).toEqual([
      line("mem_a"),
      { id: "mem_b", lesson: "", mechanism: [], forward: "" },
    ]);
  });

  it("refuses ids that were not sent, repeats, an empty answer and extra keys", () => {
    for (const [value, code] of [
      [{ lessons: [line("mem_z")] }, "invalid-evidence"],
      [{ lessons: [line("mem_a"), line("mem_a")] }, "invalid-evidence"],
      [{ lessons: [] }, "invalid-draft"],
      [{ lessons: [{ ...line("mem_a"), confidence: 1 }] }, "invalid-schema"],
      [[line("mem_a")], "invalid-schema"],
    ] as const)
      expect(() => validateLessons(value, sources)).toThrow(code);
  });

  it("fits a batch inside the shared input bound and the batch size", () => {
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `mem_${i}`,
      revision: 1,
      type: "fact",
      title: `Title ${i}`,
      body: "x".repeat(900),
    }));
    const batch = fitLessonBatch(many);
    expect(batch.length).toBeLessThanOrEqual(LESSON_BATCH);
    expect(batch.length).toBeGreaterThan(0);
    const huge = [{ ...many[0], body: "y".repeat(30_000) }];
    expect(fitLessonBatch(huge)).toEqual([]);
  });
});

describe("the lesson pass", () => {
  it("runs only with nightly upkeep on", async () => {
    await save("Parallel builds", "Builds overwrite each other.");
    await writeReviewSettings(db, user, {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
    });
    expect((await runLessonPass(env, user, lessonDraft)).stopped).toBe("off");
    expect(lessonDraft).not.toHaveBeenCalled();
  });

  it("writes one line per memory revision under the nightly count, then has nothing left", async () => {
    const a = await save("Parallel builds", "Builds overwrite each other.");
    const b = await save("Hostname", "referencemarker dumbook lives here.");
    const archived = await save("Gone", "This one is archived.");
    await archiveMemory(env, user, raw(archived.id));
    await nightly();

    const first = await runLessonPass(env, user, lessonDraft);
    expect(first).toEqual({ calls: 1, written: 2, failed: 0, stopped: null });
    expect(lessonDraft).toHaveBeenCalledWith(
      DEFAULT_REVIEW_SETTINGS.model,
      expect.any(String),
      LESSON_SYSTEM,
    );
    const sent = JSON.parse(lessonDraft.mock.calls[0][1]) as LessonRequest;
    expect(sent.task).toBe("lessons");
    expect(sent.memories.map((m) => m.id).sort()).toEqual(
      [raw(a.id), raw(b.id)].sort(),
    );
    expect((await reviewBudget(db, user)).upkeep_calls).toBe(1);
    expect(await lessons()).toEqual(
      [
        {
          memory_id: raw(a.id),
          revision: 1,
          lesson:
            "Concurrent workers sharing mutable state corrupt each other's output.",
          mechanism_json: '["concurrency","shared-state"]',
          forward: "Give each worker its own state.",
          prompt_version: "memory-lessons-1",
        },
        {
          memory_id: raw(b.id),
          revision: 1,
          lesson: "",
          mechanism_json: "[]",
          forward: "",
          prompt_version: "memory-lessons-1",
        },
      ].sort((x, y) => x.memory_id.localeCompare(y.memory_id)),
    );
    expect(await lessonCoverage(db, user)).toEqual({
      memories: 2,
      written: 2,
      withLesson: 1,
    });

    const second = await runLessonPass(env, user, lessonDraft);
    expect(second).toEqual({ calls: 0, written: 0, failed: 0, stopped: null });
    expect(lessonDraft).toHaveBeenCalledTimes(1);
  });

  it("sends an edited memory again for its new revision", async () => {
    const a = await save("Parallel builds", "Builds overwrite each other.");
    await nightly();
    await runLessonPass(env, user, lessonDraft);
    await editMemory(
      env,
      raw(a.id),
      { body: "Builds overwrite each other's output directory." },
      author,
    );
    expect((await lessonCoverage(db, user)).written).toBe(0);
    expect((await runLessonPass(env, user, lessonDraft)).written).toBe(1);
    expect((await lessons()).map((l) => l.revision)).toEqual([1, 2]);
  });

  it("does not write a line for a memory edited while the call was out", async () => {
    const a = await save("Parallel builds", "Builds overwrite each other.");
    await nightly();
    const report = await runLessonPass(env, user, async (model, input) => {
      await editMemory(env, raw(a.id), { body: "Changed mid-call." }, author);
      return lessonDraft(model, input);
    });
    expect(report.written).toBe(0);
    expect(await lessons()).toEqual([]);
  });

  it("counts a failed call against the night and writes nothing", async () => {
    await save("Parallel builds", "Builds overwrite each other.");
    await nightly();
    const report = await runLessonPass(env, user, async () => ({
      lessons: [
        { id: "mem_not_sent", lesson: "x", mechanism: [], forward: "" },
      ],
    }));
    expect(report).toEqual({
      calls: 1,
      written: 0,
      failed: 1,
      stopped: "invalid-evidence",
    });
    expect((await reviewBudget(db, user)).upkeep_calls).toBe(1);
    expect(await lessons()).toEqual([]);
  });

  it("stops at the nightly count without calling the model", async () => {
    await save("Parallel builds", "Builds overwrite each other.");
    await nightly({ upkeepMemories: 1 });
    await db
      .prepare(
        "INSERT INTO memory_review_budgets(user_id, day, calls, reserved_microusd, manual_calls, upkeep_calls) VALUES (?, CAST(unixepoch() / 86400 AS INTEGER), 1, 0, 0, 1)",
      )
      .bind(user)
      .run();
    const report = await runLessonPass(env, user, lessonDraft);
    expect(report.stopped).toBe("daily budget");
    expect(lessonDraft).not.toHaveBeenCalled();
  });

  it("keeps another account's memories out of the batch", async () => {
    await saveMemory(
      env,
      {
        type: "fact",
        title: "Other account",
        body: "Not yours.",
        tags: [],
        project: "other-fixture",
      },
      { ...author, userId: "someone-else" },
    );
    const mine = await save("Parallel builds", "Builds overwrite each other.");
    await nightly();
    await runLessonPass(env, user, lessonDraft);
    const sent = JSON.parse(lessonDraft.mock.calls[0][1]) as LessonRequest;
    expect(sent.memories.map((m) => m.id)).toEqual([raw(mine.id)]);
  });
});

describe("lesson lines in a night's run", () => {
  it("counts a failed lesson call, sends no second one that minute, and still ends done", async () => {
    await save("Kestrel orchard frost", "Cover the saplings below zero.");
    await nightly();
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async () =>
        Response.json({ choices: [{ message: { content: "not json" } }] }),
      );
    const bindings = { DB: db, OPENROUTER_API_KEY: "synthetic-not-a-real-key" };
    let run = null;
    for (let minute = 0; minute < 5 && !run?.finishedAt; minute++) {
      await db
        .prepare(
          "UPDATE memory_review_settings SET next_run_at = 0 WHERE user_id = ?",
        )
        .bind(user)
        .run();
      await overnightMemoryReview(bindings);
      run = (await readUpkeepStatus(db, user)).run;
    }
    expect(http).toHaveBeenCalledTimes(1);
    expect(run).toMatchObject({
      lessonCalls: 1,
      lessons: 0,
      failed: 1,
      ended: "done",
    });
    expect(await lessons()).toEqual([]);
  });
});

describe("review selection without same-project filler", () => {
  it("records a memory with no linked or matching neighbour without a model call", async () => {
    await save("Kestrel orchard frost", "Cover the saplings below zero.");
    await save("Quartz invoice rounding", "Round half to even on totals.");
    await writeReviewSettings(db, user, {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
    });
    const draft = vi.fn();
    const report = await runMemoryReview(env, user, draft);
    expect(draft).not.toHaveBeenCalled();
    expect(report.calls).toBe(0);
    const groups = await listReviewGroups(db, user);
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      expect(group.state).toBe("noop");
      const sources = JSON.parse(group.sources_json) as {
        selection?: { via: string };
      }[];
      expect(sources.map((s) => s.selection?.via)).not.toContain(
        "same-project",
      );
    }
  });
});
