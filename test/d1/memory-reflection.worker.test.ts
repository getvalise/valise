import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { archiveMemory, saveMemory } from "~/concepts/memories";
import { listMemoryLinks, MemoryLinkError } from "~/concepts/memory-links";
import {
  adoptPrinciple,
  type CandidateMeta,
  CLUSTER_SYSTEM,
  DRAFT_SYSTEM,
  draftCandidates,
  getPrinciple,
  latestReflection,
  listPrinciples,
  PrincipleError,
  type ReflectionLine,
  rejectPrinciple,
  validateCluster,
  validateDraft,
} from "~/concepts/memory-reflection";
import {
  DEFAULT_REVIEW_SETTINGS,
  overnightMemoryReview,
  readUpkeepStatus,
  reflectNow,
  reviewBudget,
  runLessonPass,
  runReflectionStep,
  writeReviewSettings,
} from "~/concepts/memory-review";

/**
 * The weekly reflection and principle cards (J-E slice 2; ADR-0012
 * amendment of 2026-11-08). No live provider: drafts are injected.
 */
const db = env.DB;
const user = "local";
const raw = (id: string) => id.slice("memory:".length);
const save = (title: string, project: string, session: string) =>
  saveMemory(
    env,
    {
      type: "insight",
      title,
      body: `${title}: parallel workers overwrote each other's output.`,
      tags: ["synthetic"],
      project,
    },
    { userId: user, agent: "test-author", client: "mcp", session },
  );
const nightly = () =>
  writeReviewSettings(db, user, {
    ...DEFAULT_REVIEW_SETTINGS,
    enabled: true,
    overnight: true,
    autoApply: true,
  });
const lesson =
  "Concurrent workers sharing mutable state corrupt each other's output.";
/** Lesson lines for everything sent, then reflection answers chosen by the test. */
function model(principle: (ids: string[]) => unknown) {
  return vi.fn(async (_model: string, input: string, system: string) => {
    const request = JSON.parse(input);
    if (request.task === "lessons")
      return {
        lessons: request.memories.map((m: { id: string }) => ({
          id: m.id,
          lesson,
          mechanism: ["concurrency", "shared-state"],
          forward: "Give each worker its own state.",
        })),
      };
    if (system === CLUSTER_SYSTEM)
      return {
        mechanisms: [
          {
            name: "Parallel workers share state",
            keywords: ["concurrency"],
            memories: request.lines.map((l: { id: string }) => l.id),
          },
        ],
      };
    expect(system).toBe(DRAFT_SYSTEM);
    return {
      principle: principle(request.memories.map((m: { id: string }) => m.id)),
    };
  });
}
const card = (ids: string[]) => ({
  rule: "Design every shared script for parallel agents.",
  appliesWhen: "A script or resource is used by more than one agent session.",
  mechanism: "Concurrent workers corrupt shared mutable state.",
  exceptions: "",
  change: { kind: "agents", text: "Add a rule: shared resources need a lock." },
  evidence: ids,
  counter: [],
});
/** Three memories from two sessions in two projects: the evidence rule holds. */
async function threeAcrossProjects() {
  return [
    await save("Verify lock", "valise", "s1"),
    await save("Playwright build dir", "valise", "s2"),
    await save("Stash is shared", "stash-tool", "s2"),
  ].map((m) => raw(m.id));
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    "memory_principles",
    "memory_reflections",
    "memory_lessons",
    "todo_updates",
    "todos",
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

describe("validating a reflection", () => {
  const line = (id: string): ReflectionLine => ({
    id,
    revision: 1,
    lesson,
    mechanism: ["concurrency"],
    created_at: 1,
  });
  const sent = ["a", "b", "c", "d"].map(line);
  const meta = (
    rows: [string, string | null, string][],
  ): Map<string, CandidateMeta> =>
    new Map(
      rows.map(([id, project, session]) => [
        id,
        { id, title: id.toUpperCase(), project, session },
      ]),
    );

  it("keeps mechanisms with three sent ids and drops ids it never sent", () => {
    expect(
      validateCluster(
        {
          mechanisms: [
            { name: "x", keywords: ["k"], memories: ["a", "b", "c", "z"] },
            { name: "y", keywords: ["k"], memories: ["a", "b", "z", "q"] },
          ],
        },
        sent,
      ),
    ).toEqual([{ name: "x", keywords: ["k"], memories: ["a", "b", "c"] }]);
    expect(() => validateCluster({ mechanisms: "x" }, sent)).toThrow(
      "invalid-schema",
    );
  });

  it("enforces three memories, two sessions and two projects in code", () => {
    const draft = (evidence: string[]) => ({
      principle: { ...card(evidence), counter: [] },
    });
    const spread = meta([
      ["a", "p1", "s1"],
      ["b", "p1", "s2"],
      ["c", "p2", "s2"],
    ]);
    expect(validateDraft(draft(["a", "b", "c"]), sent, spread)).toMatchObject({
      evidence: [{ id: "a" }, { id: "b" }, { id: "c" }],
    });
    expect(validateDraft(draft(["a", "b"]), sent, spread)).toBeNull();
    const oneProject = meta([
      ["a", "p1", "s1"],
      ["b", "p1", "s2"],
      ["c", "p1", "s2"],
    ]);
    expect(validateDraft(draft(["a", "b", "c"]), sent, oneProject)).toBeNull();
    const oneSession = meta([
      ["a", "p1", "s1"],
      ["b", "p2", "s1"],
      ["c", "p2", "s1"],
    ]);
    expect(validateDraft(draft(["a", "b", "c"]), sent, oneSession)).toBeNull();
    expect(validateDraft({ principle: null }, sent, spread)).toBeNull();
  });

  it("refuses ids it never sent and a memory that is both evidence and counterexample", () => {
    const spread = meta([]);
    expect(() =>
      validateDraft({ principle: card(["a", "b", "z"]) }, sent, spread),
    ).toThrow("invalid-evidence");
    expect(() =>
      validateDraft(
        { principle: { ...card(["a", "b", "c"]), counter: ["a"] } },
        sent,
        spread,
      ),
    ).toThrow("invalid-evidence");
  });

  it("reads the mechanism's own lines first, then older lines by keyword", () => {
    const all: ReflectionLine[] = [
      { ...line("own"), mechanism: [] },
      { ...line("strong"), mechanism: ["locking", "concurrency"] },
      { ...line("weak"), lesson: "concurrency is mentioned", mechanism: [] },
      { ...line("none"), lesson: "unrelated", mechanism: ["taste"] },
    ];
    const order = draftCandidates(
      { name: "m", keywords: ["concurrency", "locking"], memories: ["own"] },
      all,
    ).map((l) => l.id);
    expect(order).toEqual(["own", "strong", "weak"]);
  });
});

describe("a reflection", () => {
  it("clusters the week's lines, drafts one card per mechanism, then is not due for a week", async () => {
    const ids = await threeAcrossProjects();
    await nightly();
    const draft = model(card);
    await runLessonPass(env, user, draft);

    const first = await runReflectionStep(env, user, draft);
    expect(first).toMatchObject({ calls: 1, proposed: 0, more: true });
    const second = await runReflectionStep(env, user, draft);
    expect(second).toMatchObject({ calls: 1, proposed: 1, more: false });

    const [principle] = await listPrinciples(db, user, "proposal");
    expect(principle).toMatchObject({
      rule: "Design every shared script for parallel agents.",
      change_kind: "agents",
      prompt_version: "memory-reflection-1",
    });
    expect(principle.evidence.map((e) => e.id).sort()).toEqual([...ids].sort());
    expect(await latestReflection(db, user)).toMatchObject({
      calls: 2,
      proposed: 1,
      ended: "done",
    });
    // Lesson, cluster and draft: three nightly calls.
    expect((await reviewBudget(db, user)).upkeep_calls).toBe(3);
    expect(await runReflectionStep(env, user, draft)).toMatchObject({
      calls: 0,
      more: false,
    });
    expect(draft).toHaveBeenCalledTimes(3);
  });

  it("drafts no card when the evidence rule fails, and ends done", async () => {
    await save("One", "valise", "s1");
    await save("Two", "valise", "s1");
    await save("Three", "valise", "s1");
    await nightly();
    const draft = model(card);
    await runLessonPass(env, user, draft);
    await runReflectionStep(env, user, draft);
    expect(await runReflectionStep(env, user, draft)).toMatchObject({
      proposed: 0,
      more: false,
    });
    expect(await listPrinciples(db, user, "proposal")).toEqual([]);
    expect(await latestReflection(db, user)).toMatchObject({ ended: "done" });
  });

  it("ends on a failed answer, counting the call", async () => {
    await threeAcrossProjects();
    await nightly();
    await runLessonPass(env, user, model(card));
    const report = await runReflectionStep(env, user, async () => ({
      mechanisms: "not a list",
    }));
    expect(report).toMatchObject({
      calls: 1,
      failed: 1,
      stopped: "invalid-schema",
      more: false,
    });
    expect(await latestReflection(db, user)).toMatchObject({
      ended: "invalid-schema",
    });
  });

  it("runs only under nightly upkeep, and Reflect now needs it on", async () => {
    await threeAcrossProjects();
    await writeReviewSettings(db, user, {
      ...DEFAULT_REVIEW_SETTINGS,
      enabled: true,
    });
    const draft = model(card);
    expect((await runReflectionStep(env, user, draft)).stopped).toBe("off");
    await expect(reflectNow(db, user)).rejects.toThrow("nightly upkeep");
    expect(draft).not.toHaveBeenCalled();
  });

  it("Reflect now starts one within the week over every line and makes the run due", async () => {
    await threeAcrossProjects();
    await nightly();
    const draft = model(card);
    await runLessonPass(env, user, draft);
    await runReflectionStep(env, user, draft);
    await runReflectionStep(env, user, draft);
    await db
      .prepare(
        "UPDATE memory_review_settings SET next_run_at = unixepoch() + 9999 WHERE user_id = ?",
      )
      .bind(user)
      .run();
    await reflectNow(db, user);
    expect(await latestReflection(db, user)).toMatchObject({
      requested_by: "person",
      finished_at: null,
    });
    expect((await readUpkeepStatus(db, user)).nextRunAt).toBeLessThanOrEqual(
      Math.floor(Date.now() / 1000),
    );
  });

  it("follows lesson lines in a night's run, one call a minute", async () => {
    await threeAcrossProjects();
    await nightly();
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        const request = JSON.parse(String(init?.body)) as {
          messages: { role: string; content: string }[];
        };
        const system = request.messages[0].content;
        const input = request.messages[1].content;
        const answer = await model(card)("m", input, system);
        return Response.json({
          choices: [{ message: { content: JSON.stringify(answer) } }],
        });
      });
    const bindings = { DB: db, OPENROUTER_API_KEY: "synthetic-not-a-real-key" };
    let run = null;
    for (let minute = 0; minute < 10 && !run?.finishedAt; minute++) {
      await db
        .prepare(
          "UPDATE memory_review_settings SET next_run_at = 0 WHERE user_id = ?",
        )
        .bind(user)
        .run();
      await overnightMemoryReview(bindings);
      run = (await readUpkeepStatus(db, user)).run;
    }
    expect(run).toMatchObject({
      lessonCalls: 1,
      reflectionCalls: 2,
      principles: 1,
      ended: "done",
    });
    expect(http).toHaveBeenCalledTimes(3);
  });
});

describe("deciding a card", () => {
  const person = {
    userId: user,
    agent: "console",
    client: "console",
    session: null,
  };
  async function proposed() {
    const ids = await threeAcrossProjects();
    await nightly();
    const draft = model(card);
    await runLessonPass(env, user, draft);
    await runReflectionStep(env, user, draft);
    await runReflectionStep(env, user, draft);
    const [principle] = await listPrinciples(db, user, "proposal");
    return { ids, principle };
  }

  it("adopts a card as a decision with its evidence part-of it and a to-do", async () => {
    const { ids, principle } = await proposed();
    const result = await adoptPrinciple(
      env,
      principle.principle_id,
      { rule: "Design shared scripts for N agents.", fileTodo: true },
      person,
    );
    const memory = await db
      .prepare(
        "SELECT memory_type, title, tags_json, project, body FROM memories WHERE memory_id = ?",
      )
      .bind(result.memoryId)
      .first<{
        memory_type: string;
        title: string;
        tags_json: string;
        project: string | null;
        body: string;
      }>();
    expect(memory).toMatchObject({
      memory_type: "decision",
      title: "Design shared scripts for N agents.",
      tags_json: '["principle"]',
      project: null,
    });
    expect(memory!.body).toContain(`memory:${ids[0]}`);
    const links = await listMemoryLinks(db, user, result.memoryId);
    expect(
      links
        .filter((l) => l.kind === "has-part")
        .map((l) => l.id)
        .sort(),
    ).toEqual(ids.map((id) => `memory:${id}`).sort());
    expect(links.every((l) => l.asserted_by === "person")).toBe(true);
    const todo = await db
      .prepare("SELECT title, body FROM todos WHERE todo_id = ?")
      .bind(result.todoId)
      .first<{ title: string; body: string }>();
    expect(todo!.title).toBe(
      "Apply principle: Design shared scripts for N agents.",
    );
    expect(todo!.body).toContain(`memory:${result.memoryId}`);
    expect(await getPrinciple(db, user, principle.principle_id)).toMatchObject({
      state: "adopted",
      result_memory_id: result.memoryId,
    });
    // Adopting again returns the same result and writes nothing new.
    expect(
      await adoptPrinciple(
        env,
        principle.principle_id,
        { rule: "Other", fileTodo: true },
        person,
      ),
    ).toEqual(result);
  });

  it("adopts without a to-do when asked", async () => {
    const { principle } = await proposed();
    const result = await adoptPrinciple(
      env,
      principle.principle_id,
      { rule: principle.rule, fileTodo: false },
      person,
    );
    expect(result.todoId).toBeNull();
    expect(
      (await db
        .prepare("SELECT COUNT(*) AS n FROM todos")
        .first<{ n: number }>())!.n,
    ).toBe(0);
  });

  it("writes nothing when an evidence memory was archived", async () => {
    const { ids, principle } = await proposed();
    await archiveMemory(env, user, ids[1]);
    await expect(
      adoptPrinciple(
        env,
        principle.principle_id,
        { rule: principle.rule, fileTodo: true },
        person,
      ),
    ).rejects.toThrow(MemoryLinkError);
    expect((await getPrinciple(db, user, principle.principle_id))!.state).toBe(
      "proposal",
    );
    expect(
      (await db
        .prepare(
          "SELECT COUNT(*) AS n FROM memories WHERE memory_type = 'decision'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(0);
  });

  it("keeps a rejected card's reason, refuses to adopt it, and tells the next reflection", async () => {
    const { principle } = await proposed();
    await rejectPrinciple(db, user, principle.principle_id, "Too obvious.");
    expect(await getPrinciple(db, user, principle.principle_id)).toMatchObject({
      state: "rejected",
      reason: "Too obvious.",
    });
    await expect(
      adoptPrinciple(
        env,
        principle.principle_id,
        { rule: principle.rule, fileTodo: false },
        person,
      ),
    ).rejects.toThrow(PrincipleError);

    await reflectNow(db, user);
    const draft = model(card);
    await runReflectionStep(env, user, draft);
    const sent = JSON.parse(draft.mock.calls[0][1]);
    expect(sent.known).toEqual([{ rule: principle.rule, state: "rejected" }]);
  });

  it("never reads or decides another account's card", async () => {
    const { principle } = await proposed();
    expect(
      await getPrinciple(db, "someone-else", principle.principle_id),
    ).toBeNull();
    await expect(
      rejectPrinciple(db, "someone-else", principle.principle_id, ""),
    ).rejects.toThrow(PrincipleError);
  });
});
