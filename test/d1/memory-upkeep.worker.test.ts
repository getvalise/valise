import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getMemory, saveMemory } from "~/concepts/memories";
import { listMemoryLinks } from "~/concepts/memory-links";
import {
  acceptMemoryReview,
  countReviewGroups,
  listReviewGroups,
  nextUpkeepAt,
  overnightMemoryReview,
  parseUpkeepRun,
  patchReviewSetting,
  readReviewSettings,
  readUpkeepStatus,
  reviewBudget,
  runMemoryReview,
  setNightlyUpkeep,
  UPKEEP_AGENT,
  undoAutoApplied,
} from "~/concepts/memory-review";
import {
  DEFAULT_REVIEW_MODEL,
  NEW_REVIEW_MODELS,
  type ReviewProposal,
} from "~/concepts/memory-review-model";

/**
 * Nightly upkeep (ADR-0012, 2026-11-04; J-0 in docs/design/memory-consolidation.md):
 * one switch, a run that drains the queue a pass at a time, additive results
 * applied, conflicts and duplicate merges asked. No live provider: a fake
 * OpenRouter answers from the request it receives.
 */
const db = env.DB;
const user = "local";
const author = {
  userId: user,
  agent: "test-author",
  client: "mcp",
  session: "synthetic-session",
};
const bindings = { DB: db, OPENROUTER_API_KEY: "synthetic-not-a-real-key" };
const raw = (id: string) => id.slice("memory:".length);

const save = (title: string, body: string, project: string) =>
  saveMemory(
    env,
    { type: "fact", title, body, tags: ["synthetic"], project },
    author,
  );

/** Answers like a model: a conflict when a source says so, a duplicate when asked, else a summary. */
function fakeProvider(
  kindFor: (bodies: string[]) => ReviewProposal["kind"] = (bodies) =>
    bodies.some((b) => b.includes("conflictmarker"))
      ? "contradiction"
      : bodies.some((b) => b.includes("duplicatemarker"))
        ? "consolidation"
        : "summary",
) {
  return vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (_url, init) => {
      const request = JSON.parse(String(init?.body)) as {
        messages: { role: string; content: string }[];
      };
      const content = JSON.parse(
        request.messages.find((m) => m.role === "user")!.content,
      ) as
        | { id: string; title: string; body: string }[]
        | { task: "lessons"; memories: { id: string }[] }
        | { task: "reflect" | "principle" };
      // The weekly reflection (J-E): nothing recurs in these fixtures.
      if (!Array.isArray(content) && content.task !== "lessons")
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify(
                  content.task === "reflect"
                    ? { mechanisms: [] }
                    : { principle: null },
                ),
              },
            },
          ],
        });
      // The lesson pass (J-E): one line per memory sent.
      if (!Array.isArray(content))
        return Response.json({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  lessons: content.memories.map((m) => ({
                    id: m.id,
                    lesson: "A synthetic transferable lesson.",
                    mechanism: ["synthetic"],
                    forward: "",
                  })),
                }),
              },
            },
          ],
        });
      const sources = content;
      const kind = kindFor(sources.map((s) => s.body));
      const used = kind === "contradiction" ? sources.slice(0, 2) : sources;
      const proposal: ReviewProposal = {
        why: `Synthetic ${kind} of ${used.map((s) => s.title).join(" and ")}.`,
        kind,
        title: kind === "contradiction" ? "" : `Upkeep ${used[0].title}`,
        body:
          kind === "contradiction"
            ? ""
            : `upkeepmarker ${used.map((s) => s.body).join(" ")}`,
        evidence: used.map((s) => ({ id: s.id, quote: s.body.slice(0, 40) })),
      };
      return Response.json({
        choices: [{ message: { content: JSON.stringify(proposal) } }],
      });
    });
}

/** Run minutes until the run finishes, as the minute cron would. */
async function runNight(maxMinutes = 20) {
  for (let minute = 0; minute < maxMinutes; minute++) {
    await db
      .prepare(
        "UPDATE memory_review_settings SET next_run_at = 0 WHERE user_id = ? AND next_run_at > unixepoch() AND next_run_at < unixepoch() + 400",
      )
      .bind(user)
      .run();
    await overnightMemoryReview(bindings);
    const { run } = await readUpkeepStatus(db, user);
    if (run?.finishedAt) return run;
  }
  throw new Error("The run did not finish.");
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    "memory_review_events",
    "memory_review_groups",
    "memory_review_pending",
    "memory_review_budgets",
    "memory_review_settings",
    "search_docs",
    "memory_links",
    "memory_lessons",
    "memory_reflections",
    "memory_principles",
    "memory_revisions",
    "memories",
    "mcp_calls",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

describe("the nightly upkeep switch", () => {
  it("turns on reviews, nightly runs and applying together, due at once, at the stated limit", async () => {
    await setNightlyUpkeep(db, user, true, DEFAULT_REVIEW_MODEL);
    expect(await readReviewSettings(db, user)).toMatchObject({
      enabled: true,
      overnight: true,
      autoApply: true,
      upkeepMemories: 50,
    });
    expect((await readUpkeepStatus(db, user)).nextRunAt).toBe(0);
    await setNightlyUpkeep(db, user, false);
    expect(await readReviewSettings(db, user)).toMatchObject({
      enabled: true,
      overnight: false,
      autoApply: false,
    });
    expect((await readUpkeepStatus(db, user)).nextRunAt).toBeNull();
  });

  it("refuses a form that names another model, and a model change clears all three", async () => {
    const other = NEW_REVIEW_MODELS.find((m) => m !== DEFAULT_REVIEW_MODEL)!;
    await expect(setNightlyUpkeep(db, user, true, other)).rejects.toThrow(
      "The selected model changed",
    );
    await expect(setNightlyUpkeep(db, user, true)).rejects.toThrow(
      "must name the selected model",
    );
    expect((await readReviewSettings(db, user)).enabled).toBe(false);
    await setNightlyUpkeep(db, user, true, DEFAULT_REVIEW_MODEL);
    await patchReviewSetting(db, user, "model", other);
    expect(await readReviewSettings(db, user)).toMatchObject({
      model: other,
      enabled: false,
      overnight: false,
      autoApply: false,
    });
  });

  it("no longer needs a manual check before nightly drafts", async () => {
    await patchReviewSetting(db, user, "enabled", "on", DEFAULT_REVIEW_MODEL);
    await patchReviewSetting(db, user, "overnight", "on", DEFAULT_REVIEW_MODEL);
    expect((await readReviewSettings(db, user)).overnight).toBe(true);
  });
});

describe("a night's run", () => {
  it("applies the summary, asks about the conflict, keeps originals, and is next due at 02:00 UTC", async () => {
    const http = fakeProvider();
    const apples = await save(
      "Orchard apples",
      "Ada stores apples cool and never frozen.",
      "upkeep-orchard",
    );
    const pears = await save(
      "Orchard pears",
      "Ada ships pears dry, in crates.",
      "upkeep-orchard",
    );
    await save(
      "Crate colour",
      "conflictmarker Bo says the crates are blue.",
      "upkeep-crates",
    );
    await save(
      "Crate colour",
      "conflictmarker Cy says the crates are green.",
      "upkeep-crates",
    );
    await setNightlyUpkeep(db, user, true, DEFAULT_REVIEW_MODEL);
    const before = await getMemory(db, user, raw(apples.id));

    const run = await runNight();
    // Two review calls, one lesson call for the five live memories, then the
    // first reflection, which finds nothing recurring (J-E).
    expect(http).toHaveBeenCalledTimes(4);
    expect(run).toMatchObject({
      calls: 4,
      lessonCalls: 1,
      lessons: 5,
      reflectionCalls: 1,
      principles: 0,
      applied: 1,
      questions: 1,
      failed: 0,
      ended: "done",
    });
    expect(run.passes).toBeGreaterThanOrEqual(1);
    const { nextRunAt } = await readUpkeepStatus(db, user);
    expect(nextRunAt).toBe(nextUpkeepAt(run.finishedAt!));
    expect(new Date(nextRunAt! * 1000).getUTCHours()).toBe(2);

    const counts = await countReviewGroups(db, user);
    expect(counts).toMatchObject({ applied: 1, proposal: 1, accepted: 0 });
    const [applied] = await listReviewGroups(db, user, 30, false, false, {
      view: "applied",
    });
    expect(applied).toMatchObject({ state: "accepted", applied_by: "auto" });
    const added = await getMemory(db, user, applied.result_memory_id!);
    expect(added).toMatchObject({
      tags: ["rollup"],
      sourceAgent: UPKEEP_AGENT,
    });
    expect(added?.body).toContain("upkeepmarker");
    expect(added?.body).toContain("no person checked it");
    // Model-asserted, not confirmed by a person.
    const links = await listMemoryLinks(db, user, applied.result_memory_id!);
    expect(links.length).toBe(2);
    for (const link of links)
      expect(link).toMatchObject({
        kind: "related",
        asserted_by: "model",
        confirmed: false,
      });
    // The originals are untouched.
    expect(await getMemory(db, user, raw(apples.id))).toEqual(before);
    expect(await getMemory(db, user, raw(pears.id))).not.toBeNull();

    const questions = await listReviewGroups(db, user, 30, false, false, {
      view: "questions",
    });
    expect(questions).toHaveLength(1);
    expect(JSON.parse(questions[0].proposal_json!).kind).toBe("contradiction");
  });

  it("leaves a duplicate merge as a question", async () => {
    fakeProvider();
    await save("Deploy rule", "duplicatemarker Merge with squash.", "upkeep-d");
    await save("Deploy rule", "duplicatemarker Squash-merge PRs.", "upkeep-d");
    await setNightlyUpkeep(db, user, true, DEFAULT_REVIEW_MODEL);
    const run = await runNight();
    expect(run).toMatchObject({ applied: 0, questions: 1 });
    expect((await countReviewGroups(db, user)).proposal).toBe(1);
  });

  it("drains more than one pass, and stops at the nightly count, which leaves checks by hand their own", async () => {
    const http = fakeProvider();
    for (let i = 0; i < 4; i++) {
      await save(`Topic ${i} alpha`, `Fact ${i} one.`, `upkeep-${i}`);
      await save(`Topic ${i} alpha`, `Fact ${i} two.`, `upkeep-${i}`);
    }
    await setNightlyUpkeep(db, user, true, DEFAULT_REVIEW_MODEL);
    await patchReviewSetting(db, user, "upkeepMemories", "3");
    const run = await runNight();
    expect(http).toHaveBeenCalledTimes(3);
    expect(run).toMatchObject({ calls: 3, applied: 3, ended: "limit" });
    expect(run.passes).toBe(2);
    expect(await reviewBudget(db, user)).toMatchObject({
      calls: 3,
      upkeep_calls: 3,
      manual_calls: 0,
    });
    // A check by hand the same day counts against its own limit, not the night's.
    expect((await runMemoryReview(bindings, user)).calls).toBe(1);
    expect(await reviewBudget(db, user)).toMatchObject({
      calls: 4,
      upkeep_calls: 3,
      manual_calls: 1,
    });
  });

  it("drafts without applying for a row that opted into overnight drafts before upkeep existed", async () => {
    fakeProvider();
    await save("Legacy apples", "Apples keep cool.", "upkeep-legacy");
    await save("Legacy apples", "Pears keep dry.", "upkeep-legacy");
    await patchReviewSetting(db, user, "enabled", "on", DEFAULT_REVIEW_MODEL);
    await patchReviewSetting(db, user, "overnight", "on", DEFAULT_REVIEW_MODEL);
    const run = await runNight();
    expect(run).toMatchObject({ applied: 0, questions: 1 });
  });

  it("does not apply once the person turned upkeep off, even from a draft already made", async () => {
    fakeProvider();
    await save("Late apples", "Apples keep cool.", "upkeep-late");
    await save("Late apples", "Pears keep dry.", "upkeep-late");
    await patchReviewSetting(db, user, "enabled", "on", DEFAULT_REVIEW_MODEL);
    await runMemoryReview(bindings, user);
    const [group] = await listReviewGroups(db, user);
    expect(group.state).toBe("proposal");
    await expect(
      acceptMemoryReview(
        bindings,
        group.group_id,
        {
          automatic: true,
          draftTitle: group.draft_title ?? "",
          draftBody: group.draft_body ?? "",
        },
        { userId: user, agent: UPKEEP_AGENT, client: "nightly", session: null },
      ),
    ).rejects.toThrow("changed");
    expect((await listReviewGroups(db, user))[0].state).toBe("proposal");
  });
});

describe("no summary of a summary", () => {
  it("never groups an added rollup with a memory it already links to", async () => {
    fakeProvider();
    const a = await save("Shed tools", "Spades hang left.", "upkeep-shed");
    const b = await save("Shed tools", "Rakes hang right.", "upkeep-shed");
    await setNightlyUpkeep(db, user, true, DEFAULT_REVIEW_MODEL);
    await runNight();
    const [applied] = await listReviewGroups(db, user, 30, false, false, {
      view: "applied",
    });
    const rollup = applied.result_memory_id!;
    await save("Shed tools", "Hoes hang in the middle.", "upkeep-shed");
    await db
      .prepare(
        "UPDATE memory_review_settings SET next_run_at = 0, last_run_json = NULL",
      )
      .run();
    await runNight();
    for (const group of await listReviewGroups(db, user)) {
      const ids = (
        JSON.parse(group.sources_json) as { source: { id: string } }[]
      ).map((s) => s.source.id);
      if (ids.includes(rollup)) {
        expect(ids).not.toContain(raw(a.id));
        expect(ids).not.toContain(raw(b.id));
      }
    }
  });
});

describe("undo", () => {
  it("archives the added memory, keeps the pair covered and refuses a person's own acceptance", async () => {
    fakeProvider();
    await save("Undo apples", "Apples keep cool.", "upkeep-undo");
    await save("Undo apples", "Pears keep dry.", "upkeep-undo");
    await setNightlyUpkeep(db, user, true, DEFAULT_REVIEW_MODEL);
    await runNight();
    const [applied] = await listReviewGroups(db, user, 30, false, false, {
      view: "applied",
    });
    await undoAutoApplied(bindings, user, applied.group_id);
    expect(await getMemory(db, user, applied.result_memory_id!)).toBeNull();
    const counts = await countReviewGroups(db, user);
    expect(counts).toMatchObject({ applied: 0, undone: 1, dismissed: 0 });
    await expect(
      undoAutoApplied(bindings, user, applied.group_id),
    ).rejects.toThrow("Only an automatic change");
    // The unchanged pair is not proposed again.
    await db
      .prepare(
        "UPDATE memory_review_settings SET next_run_at = 0, last_run_json = NULL",
      )
      .run();
    const again = await runNight();
    expect(again).toMatchObject({ calls: 0, applied: 0 });
  });
});

describe("run records", () => {
  it("parses only well-formed records and schedules the next 02:00 UTC at least an hour out", () => {
    expect(parseUpkeepRun("{")).toBeNull();
    const at = Date.UTC(2026, 10, 4, 1, 30) / 1000;
    expect(nextUpkeepAt(at)).toBe(Date.UTC(2026, 10, 5, 2) / 1000);
    expect(nextUpkeepAt(Date.UTC(2026, 10, 4, 0, 30) / 1000)).toBe(
      Date.UTC(2026, 10, 4, 2) / 1000,
    );
  });
});
