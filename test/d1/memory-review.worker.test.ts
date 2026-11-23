import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveMemory,
  editMemory,
  getMemory,
  listMemoryRevisions,
  saveMemory,
} from "~/concepts/memories";
import {
  assertPersonMemoryLink,
  listMemoryLinks,
} from "~/concepts/memory-links";
import {
  acceptMemoryReview,
  DEFAULT_REVIEW_SETTINGS,
  dismissReview,
  editReviewDraft,
  getReviewGroup,
  listReviewGroups,
  overnightMemoryReview,
  patchReviewSetting,
  type ReviewAcceptance,
  type ReviewSource,
  readReviewSettings,
  reviewBudget,
  reviewSnapshot,
  runMemoryReview,
  validateReviewProposal,
  writeReviewSettings,
} from "~/concepts/memory-review";
import {
  DEFAULT_RANKING_MICROUSD,
  DEFAULT_REVIEW_MICROUSD,
  writeReviewCaps,
} from "~/concepts/memory-review-limits";
import {
  DEFAULT_REVIEW_MODEL,
  draftMemoryReview,
  LEGACY_REVIEW_MODELS,
  NEW_REVIEW_MODELS,
  REVIEW_INPUT_BYTES,
  REVIEW_MODELS,
  REVIEW_OUTPUT_TOKENS,
  REVIEW_PROMPT_VERSION,
  REVIEW_SYSTEM,
  ReviewFailure,
  type ReviewModel,
  type ReviewProposal,
  reviewFailureLabel,
  reviewMaxCallMicrousd,
  reviewModelChoices,
  reviewProviderAvailable,
  reviewProviderUnavailable,
  reviewReservation,
} from "~/concepts/memory-review-model";
import { accountAdmitted, createInvite, revokeInvite } from "~/concepts/users";
import { consoleContext } from "~/console/context.server";
import { action, loader } from "~/console/memory-review.server";
import { createSessionCookie } from "~/lib/auth.server";
import {
  action as memoriesAction,
  loader as memoriesLoader,
} from "~/routes/memories";
import { search } from "~/search/query";

const db = env.DB;
const WORKERS_AI_REVIEW_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
const person = {
  userId: "local",
  agent: "console",
  client: "web",
  session: null,
};
const model = {
  userId: "local",
  agent: "test-author",
  client: "mcp",
  session: "synthetic-session",
};
const raw = (id: string) => id.slice("memory:".length);
const noop: ReviewProposal = {
  kind: "noop",
  title: "",
  body: "",
  why: "These claims need no change.",
  evidence: [],
};
const save = (
  body: string,
  userId = "local",
  title = "Orchard storage review",
) =>
  saveMemory(
    env,
    {
      type: "fact",
      title,
      body,
      tags: ["synthetic"],
      project: "review-fixture",
    },
    { ...model, userId },
  );
const enable = (userId = "local", patch = {}) =>
  writeReviewSettings(db, userId, {
    ...DEFAULT_REVIEW_SETTINGS,
    enabled: true,
    ...patch,
  });
const seededAccounts = new Set<string>();
async function seedAccount(
  userId: string,
  verified = true,
  inviteId: string | null = null,
) {
  seededAccounts.add(userId);
  await db
    .prepare(
      `INSERT INTO users(user_id, email, display_name, role, created_at, email_verified, invite_id)
    VALUES (?, ?, 'Synthetic review member', 'member', 1, ?, ?)`,
    )
    .bind(userId, `${userId}@example.test`, +verified, inviteId)
    .run();
}
const firstGroup = async () => (await listReviewGroups(db, "local"))[0];
const acceptance = (
  g: Awaited<ReturnType<typeof firstGroup>>,
  patch: Partial<ReviewAcceptance> = {},
): ReviewAcceptance => ({
  draftTitle: g.draft_title ?? "",
  draftBody: g.draft_body ?? "",
  ...patch,
});
const proposal = (
  input: string,
  kind: ReviewProposal["kind"] = "summary",
): ReviewProposal => {
  const sources = JSON.parse(input) as ReviewSource[];
  return {
    kind,
    title: "Orchard storage synthesis",
    body:
      kind === "consolidation"
        ? sources.map((s) => s.body).join("\n\n")
        : "claimmarker: Store apples cool; keep pears dry. Only ripe fruit, per the grower.",
    why: "Combines compatible attributed storage claims without dropping their scope.",
    evidence: sources.map((s) => ({ id: s.id, quote: s.body.slice(0, 80) })),
  };
};

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    "memory_review_events",
    "memory_review_groups",
    "memory_review_pending",
    "memory_review_budgets",
    "memory_review_settings",
    "sessions",
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
  for (const userId of seededAccounts)
    await db.prepare("DELETE FROM users WHERE user_id = ?").bind(userId).run();
  seededAccounts.clear();
  await db
    .prepare(
      "DELETE FROM invites WHERE label = 'review-account-policy-fixture'",
    )
    .run();
});

/** Delay a real D1 response after its read/write committed. The competing pass
 * uses the unwrapped binding, so no sleeps, fake timers or production test hooks.
 */
function delayFirstResponse(
  matches: (sql: string) => boolean,
  handoff: () => Promise<void>,
) {
  let delayed = false;
  const sqlOf = new WeakMap<object, string>();
  const statement = (
    original: D1PreparedStatement,
    sql: string,
  ): D1PreparedStatement => {
    const wrapped = new Proxy(original, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) =>
            statement(target.bind(...values), sql);
        if (property === "first")
          return async (column?: string) => {
            const result =
              column === undefined
                ? await target.first()
                : await target.first(column);
            if (!delayed && matches(sql)) {
              delayed = true;
              await handoff();
            }
            return result;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    sqlOf.set(wrapped, sql);
    return wrapped;
  };
  return {
    DB: new Proxy(db, {
      get(target, property) {
        if (property === "prepare")
          return (sql: string) => statement(target.prepare(sql), sql);
        // A reservation is batched with its spend row; delay after the batch.
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            const results = await target.batch(statements);
            if (
              !delayed &&
              statements.some((s) => matches(sqlOf.get(s) ?? ""))
            ) {
              delayed = true;
              await handoff();
            }
            return results;
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
    delayed: () => delayed,
  };
}

const storedReview = (id: string) =>
  db
    .prepare("SELECT * FROM memory_review_groups WHERE group_id = ?")
    .bind(id)
    .first();

async function reservedCalls() {
  const row = await db
    .prepare(
      "SELECT COALESCE(SUM(calls), 0) AS n FROM memory_review_budgets WHERE user_id = 'local'",
    )
    .first<{ n: number }>();
  return row?.n ?? 0;
}

async function winningPass(
  state: "accepted" | "dismissed" | "noop",
  retry = false,
) {
  // Simulate elapsed leases/backoff directly in D1, without waiting for wall time.
  await db
    .prepare(
      "UPDATE memory_review_settings SET lock_until = 0 WHERE user_id = 'local'",
    )
    .run();
  if (retry)
    await db
      .prepare(
        "UPDATE memory_review_groups SET retry_at = 0 WHERE user_id = 'local' AND state = 'running'",
      )
      .run();
  const winner = await runMemoryReview(env, "local", async (_model, input) =>
    state === "noop" ? noop : proposal(input),
  );
  expect(winner.calls).toBe(1);
  const group = await firstGroup();
  if (state === "accepted")
    await acceptMemoryReview(env, group.group_id, acceptance(group), person);
  else if (state === "dismissed")
    await dismissReview(db, "local", group.group_id);
  const committed = await storedReview(group.group_id);
  return { group, committed };
}

describe("review admission fencing", () => {
  it.each(["paid", "local"] as const)(
    "rejects expired %s admission even when no competing group exists",
    async (kind) => {
      await save("claimmarker Apples cool.");
      if (kind === "paid") await save("claimmarker Pears dry.");
      await enable("local", { manualMemories: 8 });
      const delayed = delayFirstResponse(
        (sql) =>
          kind === "paid"
            ? sql.includes("INSERT INTO memory_review_budgets")
            : sql.includes("WHERE user_id = ? AND fingerprint = ?"),
        async () => {
          // The token is still ours, but the lease itself has elapsed. Admission
          // must consult expiry at write time, not only token equality or uniqueness.
          await db
            .prepare(
              "UPDATE memory_review_settings SET lock_until = 0 WHERE user_id = 'local'",
            )
            .run();
        },
      );
      const infer = vi.fn(async () => noop);
      expect(
        await runMemoryReview({ DB: delayed.DB }, "local", infer),
      ).toMatchObject({ calls: 0, stopped: "admission lost" });
      expect(delayed.delayed()).toBe(true);
      expect(infer).not.toHaveBeenCalled();
      expect(await listReviewGroups(db, "local")).toEqual([]);
      expect(
        await db
          .prepare("SELECT COUNT(*) AS n FROM memory_review_pending")
          .first(),
      ).toEqual({ n: kind === "paid" ? 2 : 1 });
      expect(await reservedCalls()).toBe(kind === "paid" ? 1 : 0);
    },
  );

  it.each(["accepted", "dismissed", "noop"] as const)(
    "cannot revive %s coverage after an old pass reserved budget but lost its lease",
    async (state) => {
      await save("claimmarker Apples cool.");
      await save("claimmarker Pears dry.");
      await enable("local", { manualMemories: 8 });
      let winning: Awaited<ReturnType<typeof winningPass>> | undefined;
      const delayed = delayFirstResponse(
        (sql) => sql.includes("INSERT INTO memory_review_budgets"),
        async () => {
          winning = await winningPass(state);
        },
      );
      const staleInfer = vi.fn(async (_model: string, input: string) =>
        proposal(input),
      );
      const stale = await runMemoryReview(
        { DB: delayed.DB },
        "local",
        staleInfer,
      );
      expect(delayed.delayed()).toBe(true);
      expect(stale).toMatchObject({
        calls: 0,
        proposed: 0,
        failed: 0,
        stopped: "admission lost",
      });
      expect(staleInfer).not.toHaveBeenCalled();
      expect(winning).toBeDefined();
      expect(await storedReview(winning?.group.group_id ?? "")).toEqual(
        winning?.committed,
      );
      expect((await firstGroup()).state).toBe(state);
      expect((await firstGroup()).attempts).toBe(1);
      // Conservatively retain the old reservation; it is not an inference receipt.
      expect(await reservedCalls()).toBe(2);
    },
  );

  it("fences local no-op insertion too, preserving a winner's no-op without a budget write", async () => {
    await save("One isolated source.");
    await enable();
    let winning: unknown;
    let id = "";
    const delayed = delayFirstResponse(
      (sql) => sql.includes("WHERE user_id = ? AND fingerprint = ?"),
      async () => {
        await db
          .prepare(
            "UPDATE memory_review_settings SET lock_until = 0 WHERE user_id = 'local'",
          )
          .run();
        expect(
          (await runMemoryReview(env, "local", async () => noop)).calls,
        ).toBe(0);
        id = (await firstGroup()).group_id;
        winning = await storedReview(id);
      },
    );
    const infer = vi.fn(async () => noop);
    expect(
      await runMemoryReview({ DB: delayed.DB }, "local", infer),
    ).toMatchObject({ calls: 0, stopped: "admission lost" });
    expect(delayed.delayed()).toBe(true);
    expect(infer).not.toHaveBeenCalled();
    expect(await storedReview(id)).toEqual(winning);
    expect((await firstGroup()).state).toBe("noop");
    expect((await firstGroup()).attempts).toBe(1);
    expect(await reservedCalls()).toBe(0);
  });

  it("does not dispatch an admitted attempt whose response arrived after a newer attempt completed", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable("local", { manualMemories: 8 });
    let winning: Awaited<ReturnType<typeof winningPass>> | undefined;
    const delayed = delayFirstResponse(
      (sql) =>
        sql.includes("INSERT INTO memory_review_groups") &&
        sql.includes("RETURNING group_id, attempts"),
      async () => {
        winning = await winningPass("dismissed", true);
      },
    );
    const infer = vi.fn(async (_model: string, input: string) =>
      proposal(input),
    );
    expect(
      await runMemoryReview({ DB: delayed.DB }, "local", infer),
    ).toMatchObject({ calls: 0, stopped: "admission lost" });
    expect(delayed.delayed()).toBe(true);
    expect(infer).not.toHaveBeenCalled();
    expect((await firstGroup()).attempts).toBe(2);
    expect(await storedReview(winning?.group.group_id ?? "")).toEqual(
      winning?.committed,
    );
    expect(await reservedCalls()).toBe(2);
  });

  it.each(["accepted", "dismissed"] as const)(
    "compares expected retry state atomically even when its lock is still current (%s)",
    async (state) => {
      await save("claimmarker Apples cool.");
      await save("claimmarker Pears dry.");
      await enable("local", { manualMemories: 8 });
      await runMemoryReview(env, "local", async () => {
        throw new Error("Synthetic initial failure");
      });
      const group = await firstGroup();
      await db
        .prepare(
          "UPDATE memory_review_groups SET retry_at = 0 WHERE group_id = ?",
        )
        .bind(group.group_id)
        .run();
      let terminal: unknown;
      const delayed = delayFirstResponse(
        (sql) => sql.includes("WHERE user_id = ? AND fingerprint = ?"),
        async () => {
          // Adversarial state transition in the read/write gap, independently of
          // lease expiry: publish a competing draft and apply a real human action.
          const sources = JSON.parse(group.sources_json) as {
            source: ReviewSource;
          }[];
          const draft = proposal(JSON.stringify(sources.map((s) => s.source)));
          await db
            .prepare(
              "UPDATE memory_review_groups SET state = 'proposal', proposal_json = ?, draft_title = ?, draft_body = ? WHERE group_id = ?",
            )
            .bind(
              JSON.stringify(draft),
              draft.title,
              draft.body,
              group.group_id,
            )
            .run();
          const current = await firstGroup();
          if (state === "accepted")
            await acceptMemoryReview(
              env,
              group.group_id,
              acceptance(current),
              person,
            );
          else await dismissReview(db, "local", group.group_id);
          terminal = await storedReview(group.group_id);
        },
      );
      const infer = vi.fn(async () => noop);
      expect(
        await runMemoryReview({ DB: delayed.DB }, "local", infer),
      ).toMatchObject({ calls: 0, stopped: "admission lost" });
      expect(delayed.delayed()).toBe(true);
      expect(infer).not.toHaveBeenCalled();
      expect(await storedReview(group.group_id)).toEqual(terminal);
      expect((await firstGroup()).attempts).toBe(1);
    },
  );

  it("cannot cancel a human decision from a stale provider-change retry snapshot", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable("local", { manualMemories: 8 });
    await runMemoryReview(env, "local", async () => {
      throw new Error("Synthetic first attempt");
    });
    const group = await firstGroup();
    await db
      .prepare(
        "UPDATE memory_review_groups SET retry_at = 0 WHERE group_id = ?",
      )
      .bind(group.group_id)
      .run();
    await enable("local", {
      manualMemories: 8,
      model: REVIEW_MODELS[1],
    });
    let terminal: unknown;
    const delayed = delayFirstResponse(
      (sql) => sql.includes("WHERE user_id = ? AND fingerprint = ?"),
      async () => {
        const sources = JSON.parse(group.sources_json) as {
          source: ReviewSource;
        }[];
        const draft = proposal(JSON.stringify(sources.map((s) => s.source)));
        await db
          .prepare(
            "UPDATE memory_review_groups SET state = 'proposal', proposal_json = ?, draft_title = ?, draft_body = ? WHERE group_id = ?",
          )
          .bind(JSON.stringify(draft), draft.title, draft.body, group.group_id)
          .run();
        await dismissReview(db, "local", group.group_id);
        terminal = await storedReview(group.group_id);
      },
    );
    const infer = vi.fn(async () => noop);
    expect(
      await runMemoryReview({ DB: delayed.DB }, "local", infer),
    ).toMatchObject({ calls: 0, stopped: "admission lost" });
    expect(delayed.delayed()).toBe(true);
    expect(infer).not.toHaveBeenCalled();
    expect(await storedReview(group.group_id)).toEqual(terminal);
    expect((await firstGroup()).attempts).toBe(1);
    expect(await reservedCalls()).toBe(1);
  });

  it.each(["success", "failure"] as const)(
    "ignores a late model %s after a new attempt and human dismissal",
    async (outcome) => {
      const source = await save("claimmarker Apples cool.");
      await save("claimmarker Pears dry.");
      await enable("local", { manualMemories: 8 });
      let winning: Awaited<ReturnType<typeof winningPass>> | undefined;
      const infer = vi.fn(async (_model: string, input: string) => {
        winning = await winningPass("dismissed", true);
        // A new owner's progress must not be deleted by an old completion either.
        await db
          .prepare(
            "INSERT OR REPLACE INTO memory_review_pending VALUES (?, 'local', 99)",
          )
          .bind(raw(source.id))
          .run();
        if (outcome === "failure") throw new Error("Synthetic delayed failure");
        return proposal(input);
      });
      expect(await runMemoryReview(env, "local", infer)).toMatchObject({
        calls: 1,
        proposed: 0,
        failed: 0,
        stopped: "admission lost",
      });
      expect(infer).toHaveBeenCalledTimes(1);
      expect(await storedReview(winning?.group.group_id ?? "")).toEqual(
        winning?.committed,
      );
      expect((await firstGroup()).attempts).toBe(2);
      expect(
        await db
          .prepare(
            "SELECT memory_id, enqueued_at FROM memory_review_pending WHERE user_id = 'local'",
          )
          .first(),
      ).toEqual({ memory_id: raw(source.id), enqueued_at: 99 });
    },
  );
});

describe.each([REVIEW_MODELS[0], REVIEW_MODELS[2]])(
  "account admission (%s)",
  (selectedModel) => {
    const suffix = selectedModel.startsWith("@cf/") ? "cf" : "or";
    const bindings = () => ({
      DB: db,
      AI: env.AI,
      OPENROUTER_API_KEY: "synthetic-not-a-real-key",
    });
    function providers() {
      const ai = vi
        .spyOn(env.AI, "run")
        .mockResolvedValue({ response: JSON.stringify(noop) });
      const http = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(
          new Error("No live provider calls in account regressions"),
        );
      return { ai, http };
    }

    it.each(["unknown", "deleted", "withdrawn", "unverified"] as const)(
      "refuses %s accounts despite opted-in settings and stored memories",
      async (state) => {
        const user = `review-account-${state}-${suffix}`;
        if (state !== "unknown")
          await seedAccount(user, state !== "unverified");
        await save("Synthetic inadmitted apples claim.", user);
        await save("Synthetic inadmitted pears claim.", user);
        await enable(user, { model: selectedModel, overnight: true });
        if (state === "deleted")
          await db
            .prepare("DELETE FROM users WHERE user_id = ?")
            .bind(user)
            .run();
        if (state === "withdrawn")
          await db
            .prepare("UPDATE users SET email_verified = 0 WHERE user_id = ?")
            .bind(user)
            .run();
        expect(await accountAdmitted(db, user)).toBe(false);
        const mock = providers();
        expect(await runMemoryReview(bindings(), user)).toMatchObject({
          stopped: "account not admitted",
          calls: 0,
        });
        expect(await overnightMemoryReview(bindings())).toEqual({
          users: 0,
          calls: 0,
          applied: 0,
          failed: 0,
        });
        expect(mock.ai).not.toHaveBeenCalled();
        expect(mock.http).not.toHaveBeenCalled();
        expect((await reviewBudget(db, user)).calls).toBe(0);
        expect(await listReviewGroups(db, user)).toEqual([]);
        expect((await readReviewSettings(db, user)).enabled).toBe(true);
      },
    );

    it.each([
      "before-reservation",
      "after-reservation",
      "before-dispatch",
    ] as const)("rechecks withdrawal atomically %s", async (phase) => {
      const user = `review-revoked-${phase}-${suffix}`;
      await seedAccount(user);
      await save("Synthetic authorized apples claim.", user);
      await save("Synthetic authorized pears claim.", user);
      await enable(user, {
        model: selectedModel,
        manualMemories: 8,
      });
      const mock = providers();
      let budgetAtWithdrawal: unknown;
      const delayed = delayFirstResponse(
        (sql) =>
          phase === "before-reservation"
            ? sql.includes("WHERE user_id = ? AND fingerprint = ?")
            : phase === "after-reservation"
              ? sql.includes("INSERT INTO memory_review_budgets")
              : sql.includes("INSERT INTO memory_review_groups") &&
                sql.includes("RETURNING group_id, attempts"),
        async () => {
          budgetAtWithdrawal = (
            await db
              .prepare("SELECT * FROM memory_review_budgets WHERE user_id = ?")
              .bind(user)
              .all()
          ).results;
          await db
            .prepare("UPDATE users SET email_verified = 0 WHERE user_id = ?")
            .bind(user)
            .run();
        },
      );
      expect(
        (await runMemoryReview({ ...bindings(), DB: delayed.DB }, user)).calls,
      ).toBe(0);
      expect(delayed.delayed()).toBe(true);
      expect(await accountAdmitted(db, user)).toBe(false);
      expect(mock.ai).not.toHaveBeenCalled();
      expect(mock.http).not.toHaveBeenCalled();
      expect(
        (
          await db
            .prepare("SELECT * FROM memory_review_budgets WHERE user_id = ?")
            .bind(user)
            .all()
        ).results,
      ).toEqual(budgetAtWithdrawal);
      expect((await reviewBudget(db, user)).calls).toBe(
        phase === "before-reservation" ? 0 : 1,
      );
    });

    it("retains decisions and reservations after withdrawal, without another background call", async () => {
      const user = `review-history-${suffix}`;
      await seedAccount(user);
      await save("Synthetic admitted apples.", user);
      await save("Synthetic admitted pears.", user);
      await enable(user, { model: selectedModel, overnight: true });
      await runMemoryReview(bindings(), user, async (_model, input) =>
        proposal(input),
      );
      const group = (await listReviewGroups(db, user))[0];
      await dismissReview(db, user, group.group_id);
      const original = await storedReview(group.group_id);
      const budget = await reviewBudget(db, user);
      await db
        .prepare("UPDATE users SET email_verified = 0 WHERE user_id = ?")
        .bind(user)
        .run();
      const mock = providers();
      expect((await runMemoryReview(bindings(), user)).stopped).toBe(
        "account not admitted",
      );
      expect((await overnightMemoryReview(bindings())).calls).toBe(0);
      expect(await storedReview(group.group_id)).toEqual(original);
      expect(await reviewBudget(db, user)).toEqual(budget);
      expect(mock.ai).not.toHaveBeenCalled();
      expect(mock.http).not.toHaveBeenCalled();
    });

    it("does not reinterpret invite revocation as revoking an already-admitted verified account", async () => {
      const invite = await createInvite(db, {
        createdBy: "local",
        label: "review-account-policy-fixture",
        reusable: true,
      });
      const user = `review-invite-policy-${suffix}`;
      await seedAccount(user, true, invite.inviteId);
      await save("Synthetic authorized apples.", user);
      await save("Synthetic authorized pears.", user);
      await enable(user, { model: selectedModel });
      expect(await revokeInvite(db, invite.inviteId)).toBe(true);
      expect(await accountAdmitted(db, user)).toBe(true);
      const infer = vi.fn(async () => noop);
      expect((await runMemoryReview(bindings(), user, infer)).calls).toBe(1);
      expect(infer).toHaveBeenCalledTimes(1);
    });
  },
);

it("bounded nightly inspection defers invalid settings so they cannot permanently starve admitted accounts", async () => {
  for (let i = 0; i < 20; i++)
    await enable(`orphan-night-${String(i).padStart(2, "0")}`, {
      overnight: true,
    });
  const user = "zz-admitted-night";
  await seedAccount(user);
  await save("Synthetic valid-night apples.", user);
  await save("Synthetic valid-night pears.", user);
  await enable(user, { overnight: true });
  await db
    .prepare(
      "UPDATE memory_review_settings SET next_run_at = 1 WHERE user_id = ?",
    )
    .bind(user)
    .run();
  const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
    Response.json({
      choices: [{ message: { content: JSON.stringify(noop) } }],
    }),
  );
  const bindings = { DB: db, OPENROUTER_API_KEY: "synthetic-not-a-real-key" };
  expect(await overnightMemoryReview(bindings)).toEqual({
    users: 0,
    calls: 0,
    applied: 0,
    failed: 0,
  });
  expect(http).not.toHaveBeenCalled();
  expect(
    await db
      .prepare(
        "SELECT COUNT(*) AS n FROM memory_review_settings WHERE user_id LIKE 'orphan-night-%' AND next_run_at > unixepoch()",
      )
      .first(),
  ).toEqual({ n: 20 });
  expect(await overnightMemoryReview(bindings)).toEqual({
    users: 1,
    calls: 1,
    applied: 0,
    failed: 0,
  });
  expect(http).toHaveBeenCalledTimes(1);
  expect((await reviewBudget(db, user)).calls).toBe(1);
});

describe("Haiku selection and provider consent", () => {
  it("uses Haiku for new settings while leaving both execution flags off", async () => {
    expect(DEFAULT_REVIEW_SETTINGS.model).toBe("anthropic/claude-haiku-5.5");
    expect(await readReviewSettings(db, "local")).toEqual(
      DEFAULT_REVIEW_SETTINGS,
    );
    await patchReviewSetting(db, "local", "manualMemories", "3");
    expect(await readReviewSettings(db, "local")).toEqual({
      ...DEFAULT_REVIEW_SETTINGS,
      manualMemories: 3,
    });
    expect(
      await db
        .prepare(
          "SELECT model, enabled, overnight FROM memory_review_settings WHERE user_id='local'",
        )
        .first(),
    ).toEqual({ model: DEFAULT_REVIEW_MODEL, enabled: 0, overnight: 0 });
    expect(reviewModelChoices(DEFAULT_REVIEW_MODEL)).toEqual([
      "anthropic/claude-haiku-5.5",
      "anthropic/claude-sonnet-5.5",
      "deepseek/deepseek-v4.1-flash-1017",
      "@cf/deepseek-ai/deepseek-v4.1-flash-1017",
    ]);
  });

  it.each(LEGACY_REVIEW_MODELS)(
    "keeps saved %s permission and destination unchanged, never upgrading implicitly",
    async (selected) => {
      await save("claimmarker Legacy apples cool.");
      await save("claimmarker Legacy pears dry.");
      await enable("local", { model: selected, overnight: true });
      const ai = vi
        .spyOn(env.AI, "run")
        .mockResolvedValue({ response: JSON.stringify(noop) });
      const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify(noop) } }],
        }),
      );
      expect(await readReviewSettings(db, "local")).toMatchObject({
        model: selected,
        enabled: true,
        overnight: true,
      });
      expect(reviewModelChoices(selected)).toEqual([
        ...NEW_REVIEW_MODELS,
        selected,
      ]);
      await patchReviewSetting(db, "local", "model", selected);
      expect(await readReviewSettings(db, "local")).toMatchObject({
        model: selected,
        enabled: true,
        overnight: true,
      });
      const result = await runMemoryReview(
        {
          DB: db,
          AI: env.AI,
          OPENROUTER_API_KEY: "synthetic-not-a-real-key",
        },
        "local",
      );
      if (selected.startsWith("@cf/")) {
        // Every legacy Workers AI choice was retired on 2026-11-20: the run
        // stops before admission and sends nothing, and the setting stays.
        expect(result).toMatchObject({
          calls: 0,
          stopped: reviewProviderUnavailable(selected),
        });
        expect(result.stopped).toContain("Cloudflare retired");
        expect(ai).not.toHaveBeenCalled();
        expect(http).not.toHaveBeenCalled();
        expect(await listReviewGroups(db, "local")).toEqual([]);
        expect(await readReviewSettings(db, "local")).toMatchObject({
          model: selected,
          enabled: true,
          overnight: true,
        });
        return;
      }
      expect(result.calls).toBe(1);
      {
        expect(ai).not.toHaveBeenCalled();
        expect(http).toHaveBeenCalledTimes(1);
        expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toMatchObject({
          model: selected,
          provider: { max_price: { prompt: 0.1, completion: 0.4 } },
        });
      }
      expect((await firstGroup()).model).toBe(selected);
    },
  );

  it("never lets a new selection choose a legacy model", async () => {
    await enable("local", { overnight: true });
    const before = await readReviewSettings(db, "local");
    for (const legacy of LEGACY_REVIEW_MODELS)
      await expect(
        patchReviewSetting(db, "local", "model", legacy),
      ).rejects.toThrow("Legacy choices can only be retained unchanged");
    expect(await readReviewSettings(db, "local")).toEqual(before);
    await patchReviewSetting(db, "local", "model", DEFAULT_REVIEW_MODEL);
    expect(await readReviewSettings(db, "local")).toEqual(before);
  });

  it("an explicit legacy-to-Haiku change revokes execution flags, preserves spent budget/history and needs fresh consent for overnight", async () => {
    const a = await save("claimmarker Legacy apples cool.");
    await save("claimmarker Legacy pears dry.");
    await enable("local", {
      model: LEGACY_REVIEW_MODELS[0],
      overnight: true,
      manualMemories: 8,
    });
    await runMemoryReview(env, "local", async () => noop);
    const history = await firstGroup();
    const budget = await reviewBudget(db, "local");
    await patchReviewSetting(db, "local", "model", DEFAULT_REVIEW_MODEL);
    expect(await readReviewSettings(db, "local")).toMatchObject({
      model: DEFAULT_REVIEW_MODEL,
      enabled: false,
      overnight: false,
    });
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No live inference"));
    expect(
      (
        await runMemoryReview(
          { DB: db, OPENROUTER_API_KEY: "synthetic-key" },
          "local",
        )
      ).stopped,
    ).toBe("off");
    expect(
      await overnightMemoryReview({
        DB: db,
        OPENROUTER_API_KEY: "synthetic-key",
      }),
    ).toEqual({ users: 0, calls: 0, applied: 0, failed: 0 });
    expect(http).not.toHaveBeenCalled();
    expect(await reviewBudget(db, "local")).toEqual(budget);
    expect(await getReviewGroup(db, "local", history.group_id)).toEqual(
      history,
    );
    // Since 2026-11-04 nightly runs need no manual check first (ADR-0012), only consent naming the model.
    await expect(
      patchReviewSetting(
        db,
        "local",
        "overnight",
        "on",
        LEGACY_REVIEW_MODELS[0],
      ),
    ).rejects.toThrow("Reload review settings");
    await patchReviewSetting(
      db,
      "local",
      "enabled",
      "on",
      DEFAULT_REVIEW_MODEL,
    );
    await editMemory(
      env,
      raw(a.id),
      { body: "claimmarker New explicit apple qualification." },
      model,
    );
    const infer = vi.fn(async (_selected: ReviewModel, _input: string) => noop);
    expect((await runMemoryReview(env, "local", infer)).calls).toBe(1);
    expect(infer.mock.calls[0][0]).toBe(DEFAULT_REVIEW_MODEL);
    await patchReviewSetting(
      db,
      "local",
      "overnight",
      "on",
      DEFAULT_REVIEW_MODEL,
    );
    expect((await readReviewSettings(db, "local")).overnight).toBe(true);
    expect((await getReviewGroup(db, "local", history.group_id))?.model).toBe(
      LEGACY_REVIEW_MODELS[0],
    );
  });

  it.each([undefined, "", "   "])(
    "missing/blank OpenRouter key stops before budget/group admission without Workers AI fallback (%s)",
    async (key) => {
      await save("claimmarker Apples cool.");
      await save("claimmarker Pears dry.");
      await enable();
      const ai = vi
        .spyOn(env.AI, "run")
        .mockRejectedValue(new Error("No fallback"));
      const http = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new Error("No live inference"));
      const result = await runMemoryReview(
        { DB: db, AI: env.AI, OPENROUTER_API_KEY: key },
        "local",
      );
      expect(result).toMatchObject({
        calls: 0,
        stopped: reviewProviderUnavailable(DEFAULT_REVIEW_MODEL),
      });
      expect(result.stopped).toContain("OPENROUTER_API_KEY");
      expect(ai).not.toHaveBeenCalled();
      expect(http).not.toHaveBeenCalled();
      expect(await reviewBudget(db, "local")).toEqual({
        calls: 0,
        manual_calls: 0,
        upkeep_calls: 0,
        reserved_microusd: 0,
      });
      expect(await listReviewGroups(db, "local")).toEqual([]);
    },
  );

  it("stale or unbound permission forms cannot grant consent to a changed provider; off remains usable", async () => {
    await enable("local", { model: LEGACY_REVIEW_MODELS[0], enabled: false });
    await patchReviewSetting(db, "local", "model", DEFAULT_REVIEW_MODEL);
    await expect(
      patchReviewSetting(db, "local", "enabled", "on", LEGACY_REVIEW_MODELS[0]),
    ).rejects.toThrow("provider or model changed");
    await expect(
      patchReviewSetting(db, "local", "enabled", "on"),
    ).rejects.toThrow("permission must name");
    expect(await readReviewSettings(db, "local")).toMatchObject({
      model: DEFAULT_REVIEW_MODEL,
      enabled: false,
      overnight: false,
    });
    await patchReviewSetting(
      db,
      "local",
      "enabled",
      "on",
      DEFAULT_REVIEW_MODEL,
    );
    expect((await readReviewSettings(db, "local")).enabled).toBe(true);
    await patchReviewSetting(
      db,
      "local",
      "enabled",
      "off",
      LEGACY_REVIEW_MODELS[0],
    );
    expect((await readReviewSettings(db, "local")).enabled).toBe(false);
  });

  it("a provider change after reservation fences dispatch without refunding the old attempt or sending to either provider", async () => {
    await save("claimmarker Legacy apples cool.");
    await save("claimmarker Legacy pears dry.");
    await enable("local", { model: WORKERS_AI_REVIEW_MODEL });
    const delayed = delayFirstResponse(
      (sql) => sql.includes("INSERT INTO memory_review_budgets"),
      async () => {
        await patchReviewSetting(db, "local", "model", DEFAULT_REVIEW_MODEL);
      },
    );
    const ai = vi
      .spyOn(env.AI, "run")
      .mockRejectedValue(new Error("No old destination dispatch"));
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No new destination dispatch"));
    expect(
      await runMemoryReview(
        { DB: delayed.DB, AI: env.AI, OPENROUTER_API_KEY: "synthetic-key" },
        "local",
      ),
    ).toMatchObject({ calls: 0, stopped: "admission lost" });
    expect(delayed.delayed()).toBe(true);
    expect((await reviewBudget(db, "local")).calls).toBe(1);
    expect(await listReviewGroups(db, "local")).toEqual([]);
    expect(await readReviewSettings(db, "local")).toMatchObject({
      model: DEFAULT_REVIEW_MODEL,
      enabled: false,
      overnight: false,
    });
    expect(ai).not.toHaveBeenCalled();
    expect(http).not.toHaveBeenCalled();
  });

  it("sends the bounded Haiku JSON request with model-specific price caps, no temperature/tools/reasoning/fallback", async () => {
    const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify(noop) } }],
      }),
    );
    const timeout = vi.spyOn(AbortSignal, "timeout");
    const ai = vi
      .spyOn(env.AI, "run")
      .mockRejectedValue(new Error("No fallback"));
    expect(
      await draftMemoryReview(
        { AI: env.AI, OPENROUTER_API_KEY: "synthetic-key" },
        DEFAULT_REVIEW_MODEL,
        "[]",
      ),
    ).toEqual(noop);
    expect(http).toHaveBeenCalledTimes(1);
    expect(http.mock.calls[0][0]).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    const body = JSON.parse(String(http.mock.calls[0][1]?.body));
    expect(body).toEqual({
      model: DEFAULT_REVIEW_MODEL,
      messages: [
        { role: "system", content: REVIEW_SYSTEM },
        { role: "user", content: "[]" },
      ],
      max_tokens: REVIEW_OUTPUT_TOKENS,
      response_format: { type: "json_object" },
      reasoning: { enabled: false },
      provider: {
        allow_fallbacks: false,
        require_parameters: true,
        data_collection: "deny",
        max_price: { prompt: 0.1, completion: 0.5 },
      },
    });
    expect(timeout).toHaveBeenCalledWith(30000);
    expect(ai).not.toHaveBeenCalled();
  });

  it.each([
    [
      "anthropic/claude-sonnet-5.5",
      { reasoning: { effort: "low" } },
      { prompt: 2, completion: 10 },
    ],
    [
      "deepseek/deepseek-v4.1-flash-1017",
      { temperature: 0.1, reasoning: { enabled: false } },
      { prompt: 0.3, completion: 1.2 },
    ],
  ] as const)(
    "sends %s through the same bounded OpenRouter request with its own price cap",
    async (model, extra, max_price) => {
      const http = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
        Response.json({
          choices: [{ message: { content: JSON.stringify(noop) } }],
        }),
      );
      expect(
        await draftMemoryReview(
          { OPENROUTER_API_KEY: "synthetic-key" },
          model,
          "[]",
        ),
      ).toEqual(noop);
      expect(JSON.parse(String(http.mock.calls[0][1]?.body))).toEqual({
        model,
        messages: [
          { role: "system", content: REVIEW_SYSTEM },
          { role: "user", content: "[]" },
        ],
        max_tokens: REVIEW_OUTPUT_TOKENS,
        response_format: { type: "json_object" },
        ...extra,
        provider: {
          allow_fallbacks: false,
          require_parameters: true,
          data_collection: "deny",
          max_price,
        },
      });
    },
  );

  it("lets a person switch between offered models, revoking execution flags each time", async () => {
    await enable("local", { overnight: true });
    for (const model of [...NEW_REVIEW_MODELS.slice(1), DEFAULT_REVIEW_MODEL]) {
      await patchReviewSetting(db, "local", "model", model);
      expect(await readReviewSettings(db, "local")).toMatchObject({
        model,
        enabled: false,
        overnight: false,
      });
      await patchReviewSetting(db, "local", "enabled", "on", model);
    }
  });

  it("reserves each exact model's bounded rates and fails closed for unsupported model ids and oversized input", async () => {
    const input = "x".repeat(
      REVIEW_INPUT_BYTES - new TextEncoder().encode(REVIEW_SYSTEM).byteLength,
    );
    expect(reviewReservation(DEFAULT_REVIEW_MODEL, input)).toBe(3168);
    expect(reviewReservation(LEGACY_REVIEW_MODELS[0], input)).toBe(5568);
    expect(reviewReservation(LEGACY_REVIEW_MODELS[1], input)).toBe(5568);
    expect(reviewReservation(LEGACY_REVIEW_MODELS[2], input)).toBe(3015);
    expect(reviewReservation("anthropic/claude-sonnet-5.5", input)).toBe(63360);
    expect(reviewReservation("deepseek/deepseek-v4.1-flash-1017", input)).toBe(
      9044,
    );
    for (const model of REVIEW_MODELS)
      expect(reviewMaxCallMicrousd(model)).toBe(
        reviewReservation(model, input),
      );
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new Error("No live inference"));
    const invalid = "openai/not-allowlisted" as ReviewModel;
    expect(() => reviewReservation(invalid, "[]")).toThrow(
      "Unsupported memory review model",
    );
    await expect(
      draftMemoryReview({ OPENROUTER_API_KEY: "synthetic-key" }, invalid, "[]"),
    ).rejects.toThrow("Unsupported memory review model");
    await expect(
      draftMemoryReview(
        { OPENROUTER_API_KEY: "synthetic-key" },
        DEFAULT_REVIEW_MODEL,
        `${input}袋`,
      ),
    ).rejects.toThrow("byte budget");
    expect(http).not.toHaveBeenCalled();
  });

  it.each(["HTTP refusal", "timeout"])(
    "retains Haiku failed-attempt reservations without fallback for %s",
    async (failure) => {
      await save("claimmarker Apples cool.");
      await save("claimmarker Pears dry.");
      await enable();
      const http = vi.spyOn(globalThis, "fetch");
      if (failure === "timeout")
        http.mockRejectedValue(
          new DOMException("Synthetic deadline", "TimeoutError"),
        );
      else
        http.mockImplementation(async () =>
          Response.json(
            { error: { message: "PRIVATE provider payload" } },
            { status: 429 },
          ),
        );
      const ai = vi
        .spyOn(env.AI, "run")
        .mockRejectedValue(new Error("No fallback"));
      const bindings = {
        DB: db,
        AI: env.AI,
        OPENROUTER_API_KEY: "synthetic-key",
      };
      expect(await runMemoryReview(bindings, "local")).toMatchObject({
        calls: 1,
        failed: 1,
      });
      const spent = await reviewBudget(db, "local");
      expect(spent.calls).toBe(1);
      expect(spent.reserved_microusd).toBeGreaterThan(0);
      expect((await firstGroup()).model).toBe(DEFAULT_REVIEW_MODEL);
      expect((await firstGroup()).error).not.toContain("PRIVATE");
      expect((await runMemoryReview(bindings, "local")).calls).toBe(0);
      expect(await reviewBudget(db, "local")).toEqual(spent);
      expect(http).toHaveBeenCalledTimes(1);
      expect(ai).not.toHaveBeenCalled();
    },
  );

  it("rejects an oversized Haiku response without accepting a proposal", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response(" ".repeat(65537)),
    );
    await expect(
      draftMemoryReview(
        { OPENROUTER_API_KEY: "synthetic-key" },
        DEFAULT_REVIEW_MODEL,
        "[]",
      ),
    ).rejects.toThrow("response-too-large");
  });
});

describe("safe review failure categories", () => {
  it.each([
    "provider-http-429",
    "provider-timeout",
    "provider-unavailable",
    "provider-response",
    "response-too-large",
    "invalid-json",
    "invalid-schema",
    "invalid-evidence",
    "invalid-draft",
  ])("records %s without source, credential or provider text", async (code) => {
    await save("claimmarker PRIVATE source apples.");
    await save("claimmarker PRIVATE source pears.");
    await enable();
    const http = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (_url, init) => {
        if (code === "provider-http-429")
          return new Response("PRIVATE provider body", { status: 429 });
        if (code === "provider-timeout")
          throw new DOMException("PRIVATE provider timeout", "TimeoutError");
        if (code === "provider-unavailable")
          throw new Error("PRIVATE credentials");
        if (code === "provider-response") return Response.json({ choices: [] });
        if (code === "response-too-large")
          return new Response("PRIVATE".repeat(10000));
        const input = JSON.parse(String(init?.body)).messages[1].content;
        const value = proposal(input);
        if (code === "invalid-schema")
          return Response.json({
            choices: [{ message: { content: '{"kind":"noop"}' } }],
          });
        if (code === "invalid-evidence")
          value.evidence[0].quote = "PRIVATE invented evidence";
        if (code === "invalid-draft") value.body = "";
        return Response.json({
          choices: [
            {
              message: {
                content:
                  code === "invalid-json"
                    ? "PRIVATE not JSON"
                    : JSON.stringify(value),
              },
            },
          ],
        });
      });
    const pass = await runMemoryReview(
      { DB: db, OPENROUTER_API_KEY: "PRIVATE-key" },
      "local",
    );
    expect(pass).toMatchObject({ calls: 1, failed: 1, proposed: 0 });
    const g = await firstGroup();
    expect(g.error).toBe(code);
    expect(g.state).toBe("failed");
    expect(reviewFailureLabel(code)).not.toContain("PRIVATE");
    expect((await reviewBudget(db, "local")).calls).toBe(1);
    expect(
      (
        await runMemoryReview(
          { DB: db, OPENROUTER_API_KEY: "PRIVATE-key" },
          "local",
        )
      ).calls,
    ).toBe(0);
    expect(http).toHaveBeenCalledTimes(1);
  });

  it("unknown historical failures never echo arbitrary stored error text", () => {
    expect(reviewFailureLabel("PRIVATE old provider error")).toContain(
      "older attempt",
    );
    expect(reviewFailureLabel("PRIVATE old provider error")).not.toContain(
      "PRIVATE",
    );
    expect(new ReviewFailure("invalid-json").message).toBe("invalid-json");
  });

  it("sends DeepSeek on Workers AI only to Workers AI with reasoning off and the same bounded JSON contract", async () => {
    const ai = vi.spyOn(env.AI, "run").mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(noop) } }],
    } as never);
    const http = vi.spyOn(globalThis, "fetch");
    expect(await draftMemoryReview(env, WORKERS_AI_REVIEW_MODEL, "[]")).toEqual(
      noop,
    );
    expect(ai).toHaveBeenCalledWith(
      WORKERS_AI_REVIEW_MODEL,
      expect.objectContaining({
        reasoning_effort: "none",
        max_tokens: 1536,
        response_format: { type: "json_object" },
      }),
      expect.anything(),
    );
    expect(http).not.toHaveBeenCalled();
    expect(reviewMaxCallMicrousd(WORKERS_AI_REVIEW_MODEL)).toBe(9044);
  });

  it("refuses a retired Workers AI model before any call, and names a model the provider retires later", async () => {
    const ai = vi.spyOn(env.AI, "run");
    await expect(
      draftMemoryReview(env, "@cf/zai-org/glm-5.3-flash", "[]"),
    ).rejects.toThrow("Cloudflare retired @cf/zai-org/glm-5.3-flash");
    expect(ai).not.toHaveBeenCalled();
    expect(reviewProviderAvailable(env, "@cf/zai-org/glm-5.3-flash")).toBe(
      false,
    );
    // The message Workers AI threw for glm-5.3-flash on 2026-11-23.
    ai.mockRejectedValue(
      new Error(
        "5028: @cf/x was deprecated on 2026-11-20. See the model catalog for alternatives: https://developers.cloudflare.com/workers-ai/models/",
      ),
    );
    await expect(
      draftMemoryReview(env, WORKERS_AI_REVIEW_MODEL, "[]"),
    ).rejects.toMatchObject({ code: "model-retired" });
    expect(reviewFailureLabel("model-retired")).toContain("retired");
    ai.mockRejectedValue(new Error("network down"));
    await expect(
      draftMemoryReview(env, WORKERS_AI_REVIEW_MODEL, "[]"),
    ).rejects.toMatchObject({ code: "provider-unavailable" });
  });

  it("names a reply cut off at the output cap instead of calling it invalid JSON", async () => {
    // A cap hit returns half a JSON string.
    const cut = '{"why":"Both memories time the full verify';
    vi.spyOn(env.AI, "run").mockResolvedValue({
      choices: [{ message: { content: cut }, finish_reason: "length" }],
    } as never);
    const workersAi = draftMemoryReview(env, WORKERS_AI_REVIEW_MODEL, "[]");
    await expect(workersAi).rejects.toBeInstanceOf(ReviewFailure);
    await expect(workersAi).rejects.toMatchObject({
      code: "response-truncated",
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content: cut }, finish_reason: "length" }],
      }),
    );
    await expect(
      draftMemoryReview(
        { OPENROUTER_API_KEY: "synthetic-key" },
        DEFAULT_REVIEW_MODEL,
        "[]",
      ),
    ).rejects.toMatchObject({ code: "response-truncated" });
    expect(reviewFailureLabel("response-truncated")).toBe(
      "The model ran out of output tokens before it finished its answer.",
    );
  });

  it("keeps no-change history separate and list payloads compact without losing named sources", async () => {
    await save("claimmarker apples PRIVATE full body");
    await save("claimmarker pears PRIVATE full body");
    await enable();
    await runMemoryReview(env, "local", async () => noop);
    expect(await listReviewGroups(db, "local", 30, true, false)).toEqual([]);
    const rows = await listReviewGroups(db, "local", 30, true, true);
    expect(rows).toHaveLength(1);
    expect(rows[0].sources_json).toContain("Orchard storage review");
    expect(rows[0].sources_json).not.toContain("PRIVATE full body");
    expect(rows[0].proposal_json).not.toContain('"body"');
    expect(rows[0].draft_body).toBeNull();
  });
});

describe("human-reviewed model synthesis", () => {
  it("defaults off, has no implicit provider fallback, and enqueues real changes only", async () => {
    const a = await save("claimmarker Apples stay cool.");
    expect(await readReviewSettings(db, "local")).toEqual(
      DEFAULT_REVIEW_SETTINGS,
    );
    const draft = vi.fn(async () => noop);
    expect((await runMemoryReview(env, "local", draft)).stopped).toBe("off");
    expect(draft).not.toHaveBeenCalled();
    await db.prepare("DELETE FROM memory_review_pending").run();
    await db
      .prepare(
        "UPDATE memories SET updated_at = updated_at + 1 WHERE memory_id = ?",
      )
      .bind(raw(a.id))
      .run();
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_review_pending")
        .first(),
    ).toEqual({ n: 0 });
    await editMemory(
      env,
      raw(a.id),
      { body: "claimmarker New actual evidence." },
      model,
    );
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_review_pending")
        .first(),
    ).toEqual({ n: 1 });
    await enable("local", { model: REVIEW_MODELS[2] });
    expect((await runMemoryReview({ DB: db }, "local")).stopped).toBe(
      reviewProviderUnavailable(REVIEW_MODELS[2]),
    );
    expect((await reviewBudget(db, "local")).calls).toBe(0);
  });

  it("drafts a genuinely new compatible summary, edits one field and accepts it with provenance atomically", async () => {
    const a = await save("claimmarker Apples stay cool. Only ripe fruit.");
    const b = await save("claimmarker Pears stay dry, per the grower.");
    await enable();
    const infer = vi.fn(async (_model: string, input: string) =>
      proposal(input),
    );
    const pass = await runMemoryReview(env, "local", infer);
    expect(pass).toMatchObject({ calls: 1, proposed: 1, failed: 0 });
    expect(infer.mock.calls[0][0]).toBe(REVIEW_MODELS[0]);
    const g = await firstGroup();
    expect(g.prompt_version).toBe(REVIEW_PROMPT_VERSION);
    const selection = JSON.parse(g.sources_json).map(
      (s: { selection: { via: string; anchorId: string } }) => s.selection,
    );
    expect(selection).toHaveLength(2);
    expect(selection[0].via).toBe("starting-memory");
    expect(selection[1].via).toBe("keyword-match");
    expect(selection[1].anchorId).toBe(selection[0].anchorId);
    expect(g.sources_json).toContain('"revision":1');
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 2 });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memory_links").first(),
    ).toEqual({ n: 0 });
    const originalProposal = g.proposal_json;
    const edited =
      "claimmarker Human-corrected summary: ripe apples stay cool; pears stay dry, according to the grower.";
    await editReviewDraft(
      db,
      "local",
      g.group_id,
      "body",
      edited,
      g.draft_body ?? "",
    );
    const changed = await firstGroup();
    expect(changed.proposal_json).toBe(originalProposal);
    expect(changed.draft_title).toBe(g.draft_title);
    const id = await acceptMemoryReview(
      env,
      g.group_id,
      acceptance(changed),
      person,
    );
    expect(id).toMatch(/^mem_/);
    const saved = await getMemory(db, "local", id ?? "");
    expect(saved?.body).toContain(edited);
    expect(saved?.body).toContain(a.id);
    expect(saved?.body).toContain(b.id);
    expect(saved?.body).toContain("test-author, mcp, synthetic-session");
    expect(saved?.sourceAgent).toBe("console");
    const links = await listMemoryLinks(db, "local", id ?? "");
    expect(links).toHaveLength(2);
    expect(
      links.every(
        (l) =>
          l.kind === "related" && l.confirmed && l.asserted_by === "person",
      ),
    ).toBe(true);
    expect(
      (
        await search(env, { userId: "local", query: "claimmarker", limit: 100 })
      ).map((h) => h.docKey),
    ).toEqual(expect.arrayContaining([a.id, b.id, `memory:${id}`]));
    expect(await listMemoryRevisions(db, "local", raw(a.id))).toEqual([]);
    expect(await getMemory(db, "local", raw(a.id))).toMatchObject({
      body: "claimmarker Apples stay cool. Only ripe fruit.",
    });
    expect(
      await acceptMemoryReview(env, g.group_id, acceptance(changed), person),
    ).toBe(id);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 3 });
    expect((await runMemoryReview(env, "local", infer)).calls).toBe(0);
  });

  it("requires a separate retained-truth judgment for duplicate consolidation supersession", async () => {
    const a = await save("claimmarker Store ripe apples cool, not frozen.");
    const b = await save(
      "claimmarker Ripe apples need cool storage; never freeze them.",
    );
    await enable();
    await runMemoryReview(env, "local", async (_m, input) =>
      proposal(input, "consolidation"),
    );
    const g = await firstGroup();
    await expect(
      acceptMemoryReview(
        env,
        g.group_id,
        acceptance(g, { supersede: true }),
        person,
      ),
    ).rejects.toThrow("retained truth");
    const id = await acceptMemoryReview(
      env,
      g.group_id,
      acceptance(g, { supersede: true, retainedTruth: true }),
      person,
    );
    const hits = (
      await search(env, { userId: "local", query: "claimmarker" })
    ).map((h) => h.docKey);
    expect(hits).toContain(`memory:${id}`);
    expect(hits).not.toContain(a.id);
    expect(hits).not.toContain(b.id);
    expect(await getMemory(db, "local", raw(a.id))).not.toBeNull();
    await archiveMemory(env, "local", id ?? "");
    expect(
      (await search(env, { userId: "local", query: "claimmarker" })).map(
        (h) => h.docKey,
      ),
    ).toEqual(expect.arrayContaining([a.id, b.id]));
  });

  it("drafts an updated stale summary as a new attributed memory without silently replacing the old rollup", async () => {
    const old = await saveMemory(
      env,
      {
        type: "reference",
        title: "Orchard storage rollup",
        body: "claimmarker Apples stay cool.",
        tags: ["rollup"],
        project: "review-fixture",
      },
      model,
    );
    const fresh = await save(
      "claimmarker New qualification from the grower: only ripe fruit; pears stay dry.",
    );
    await enable();
    await runMemoryReview(env, "local", async (_m, input) => ({
      ...proposal(input, "stale-summary"),
      why: "The old rollup omits the grower's qualification and the separate pear-storage evidence.",
    }));
    const g = await firstGroup();
    expect(JSON.parse(g.proposal_json ?? "{}").kind).toBe("stale-summary");
    const id = await acceptMemoryReview(env, g.group_id, acceptance(g), person);
    expect((await getMemory(db, "local", id ?? ""))?.body).toContain(fresh.id);
    expect((await getMemory(db, "local", raw(old.id)))?.body).toBe(
      "claimmarker Apples stay cool.",
    );
    expect(
      (await listMemoryLinks(db, "local", raw(old.id))).every(
        (l) => l.kind !== "superseded-by",
      ),
    ).toBe(true);
    expect(
      (
        await search(env, { userId: "local", query: "claimmarker", limit: 100 })
      ).map((h) => h.docKey),
    ).toContain(old.id);
  });

  it("does not spend model calls resurrecting a memory already superseded by a human judgment", async () => {
    const old = await save("claimmarker Old storage claim.");
    const successor = await save(
      "claimmarker Human-confirmed complete replacement.",
    );
    await assertPersonMemoryLink(
      env,
      raw(successor.id),
      { id: old.id, kind: "supersedes" },
      person,
    );
    await enable();
    const infer = vi.fn(async () => noop);
    expect((await runMemoryReview(env, "local", infer)).calls).toBe(0);
    expect(infer).not.toHaveBeenCalled();
    expect((await listMemoryLinks(db, "local", raw(old.id)))[0]).toMatchObject({
      kind: "superseded-by",
      confirmed: true,
      asserted_by: "person",
    });
  });

  it("does not permit summaries to masquerade as supersession", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    await runMemoryReview(env, "local", async (_m, input) => proposal(input));
    const g = await firstGroup();
    await expect(
      acceptMemoryReview(
        env,
        g.group_id,
        acceptance(g, { supersede: true, retainedTruth: true }),
        person,
      ),
    ).rejects.toThrow("Supersession");
  });

  it("keeps contradictory claims and confirms a conflict, never selecting a winner", async () => {
    const a = await save("claimmarker User says do not freeze apples.");
    const b = await save("claimmarker Third-party source says freeze apples.");
    await enable();
    await runMemoryReview(env, "local", async (_m, input) => ({
      ...proposal(input, "contradiction"),
      body: "",
      why: "The user's judgment conflicts with an attributed third-party claim; neither is chosen automatically.",
    }));
    const g = await firstGroup();
    expect(
      await acceptMemoryReview(env, g.group_id, acceptance(g), person),
    ).toBeNull();
    expect((await listMemoryLinks(db, "local", raw(a.id)))[0]).toMatchObject({
      kind: "contradicts",
      id: b.id,
      confirmed: true,
    });
    expect(
      (await search(env, { userId: "local", query: "claimmarker" })).length,
    ).toBe(2);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 2 });
  });

  it("persists no-op and dismissed group coverage, reopens for new evidence and preserves dismiss history", async () => {
    const a = await save("claimmarker Apples cool.");
    const b = await save("claimmarker Pears dry.");
    // Two checks a day, so the last pass below shows coverage within the count.
    await enable("local", { manualMemories: 2 });
    const infer = vi.fn(async (_m: string, input: string) => proposal(input));
    await runMemoryReview(env, "local", infer);
    const g = await firstGroup();
    await dismissReview(db, "local", g.group_id);
    for (const id of [a.id, b.id])
      await db
        .prepare(
          "INSERT OR REPLACE INTO memory_review_pending VALUES (?, 'local', 1)",
        )
        .bind(raw(id))
        .run();
    expect((await runMemoryReview(env, "local", infer)).calls).toBe(0);
    expect(infer).toHaveBeenCalledTimes(1);
    await dismissReview(db, "local", g.group_id, true);
    expect((await getReviewGroup(db, "local", g.group_id))?.state).toBe(
      "proposal",
    );
    await dismissReview(db, "local", g.group_id);
    await save("claimmarker New evidence: keep apples away from pears.");
    const noChange = vi.fn(async () => noop);
    expect((await runMemoryReview(env, "local", noChange)).calls).toBe(1);
    expect((await listReviewGroups(db, "local")).map((r) => r.state)).toEqual(
      expect.arrayContaining(["dismissed", "noop"]),
    );
    expect((await runMemoryReview(env, "local", noChange)).calls).toBe(0);
    await db
      .prepare(
        `INSERT OR REPLACE INTO memory_review_pending(memory_id, user_id, enqueued_at)
      SELECT memory_id, user_id, 1 FROM memories WHERE user_id = 'local'`,
      )
      .run();
    expect((await runMemoryReview(env, "local", noChange)).calls).toBe(0);
    expect(noChange).toHaveBeenCalledTimes(1);
    expect((await reviewBudget(db, "local")).calls).toBe(2);
  });

  it("refuses stale and same-second edit-and-revert sources; changed revisions become eligible again", async () => {
    const a = await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable("local", { manualMemories: 8 });
    await runMemoryReview(env, "local", async (_m, input) => proposal(input));
    const g = await firstGroup();
    const before = await reviewSnapshot(db, "local", raw(a.id));
    await editMemory(
      env,
      raw(a.id),
      { body: "claimmarker Apples warmer." },
      model,
    );
    await editMemory(
      env,
      raw(a.id),
      { body: "claimmarker Apples cool." },
      model,
    );
    const after = await reviewSnapshot(db, "local", raw(a.id));
    expect(after?.source.body).toBe(before?.source.body);
    expect(after?.source.revision).toBe(3);
    expect(after?.fingerprint).not.toBe(before?.fingerprint);
    await expect(
      acceptMemoryReview(env, g.group_id, acceptance(g), person),
    ).rejects.toThrow("revision changed");
    expect((await runMemoryReview(env, "local", async () => noop)).calls).toBe(
      1,
    );
    expect((await listMemoryRevisions(db, "local", raw(a.id))).length).toBe(2);
  });

  it("aborts memory, link, event and projection writes when a source changes between preflight and batch", async () => {
    const a = await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    await runMemoryReview(env, "local", async (_m, input) => proposal(input));
    const g = await firstGroup();
    let raced = false;
    const guardedDb = new Proxy(db, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await editMemory(
                env,
                raw(a.id),
                { body: "claimmarker Changed during approval." },
                model,
              );
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      acceptMemoryReview({ DB: guardedDb }, g.group_id, acceptance(g), person),
    ).rejects.toThrow("sources changed");
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 2 });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memory_links").first(),
    ).toEqual({ n: 0 });
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_review_events")
        .first(),
    ).toEqual({ n: 0 });
    expect((await firstGroup()).state).toBe("proposal");
  });

  it("refuses stale draft approval and logs field edits without overwriting the model output", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    await runMemoryReview(env, "local", async (_m, input) => proposal(input));
    const g = await firstGroup();
    await editReviewDraft(
      db,
      "local",
      g.group_id,
      "title",
      "Human title",
      g.draft_title ?? "",
    );
    await expect(
      editReviewDraft(
        db,
        "local",
        g.group_id,
        "title",
        "Stale editor",
        g.draft_title ?? "",
      ),
    ).rejects.toThrow("proposal or its sources changed");
    await expect(
      acceptMemoryReview(env, g.group_id, acceptance(g), person),
    ).rejects.toThrow("proposal or its sources changed");
    expect((await firstGroup()).proposal_json).toBe(g.proposal_json);
    expect(
      await db.prepare("SELECT kind, value FROM memory_review_events").first(),
    ).toEqual({ kind: "edit-title", value: "Human title" });
  });

  it("isolates candidate selection, draft reads, mutations, evidence and budgets by credential-selected user", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    const secret = await save(
      "claimmarker Another user's private evidence.",
      "other-user",
    );
    await enable();
    await enable("other-user");
    const infer = vi.fn(async (_m: string, input: string) => proposal(input));
    await runMemoryReview(env, "local", infer);
    expect(infer.mock.calls[0][1]).not.toContain("private evidence");
    const g = await firstGroup();
    expect(await getReviewGroup(db, "other-user", g.group_id)).toBeNull();
    expect(await reviewSnapshot(db, "local", raw(secret.id))).toBeNull();
    await expect(
      acceptMemoryReview(env, g.group_id, acceptance(g), {
        ...person,
        userId: "other-user",
      }),
    ).rejects.toThrow("No proposal");
    await expect(dismissReview(db, "other-user", g.group_id)).rejects.toThrow(
      "No proposal",
    );
    await expect(
      editReviewDraft(
        db,
        "other-user",
        g.group_id,
        "body",
        "steal",
        g.draft_body ?? "",
      ),
    ).rejects.toThrow("No editable");
    expect((await reviewBudget(db, "other-user")).calls).toBe(0);
    expect((await reviewBudget(db, "local")).calls).toBe(1);
  });
});

describe("authenticated inbox actions", () => {
  async function browser() {
    const consoleEnv = {
      ...env,
      SESSION_SECRET: "memory-review-synthetic-session-secret",
    };
    const context = new RouterContextProvider();
    context.set(consoleContext, {
      env: consoleEnv,
      ctx: createExecutionContext(),
    });
    const url = new URL("https://valise.test/memories?tab=review");
    const cookie = (
      await createSessionCookie(consoleEnv, new Request(url), "local")
    ).split(";")[0];
    return {
      args: { context, params: {}, pattern: "/memories", url },
      cookie,
      request: (
        form: Record<string, string>,
        origin: string | null = url.origin,
      ) =>
        new Request(url, {
          method: "POST",
          headers: { cookie, ...(origin ? { origin } : {}) },
          body: new URLSearchParams(form),
        }),
      read: () =>
        loader({
          context,
          params: {},
          pattern: "/memories",
          url,
          request: new Request(url, { headers: { cookie } }),
        }),
    };
  }

  it("requires same-origin human actions and keeps no-script/fetcher acceptance on the same authority boundary", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    await runMemoryReview(env, "local", async (_m, input) => proposal(input));
    const g = await firstGroup();
    const b = await browser();
    const form = {
      intent: "accept",
      id: g.group_id,
      draftTitle: g.draft_title ?? "",
      draftBody: g.draft_body ?? "",
    };
    await expect(
      action({ ...b.args, request: b.request(form, "https://attacker.test") }),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      action({ ...b.args, request: b.request(form, null) }),
    ).rejects.toMatchObject({ status: 403 });
    expect((await firstGroup()).state).toBe("proposal");
    const response = await action({ ...b.args, request: b.request(form) });
    expect(response).toBeInstanceOf(Response);
    expect((response as Response).headers.get("location")).toContain(
      `open=${g.group_id}`,
    );
    const id = (await firstGroup()).result_memory_id;
    expect(await getMemory(db, "local", id ?? "")).toMatchObject({
      sourceAgent: "console",
      sourceClient: "web",
    });
    expect(
      await action({
        ...b.args,
        request: b.request({ ...form, via: "fetcher" }),
      }),
    ).toEqual({ saved: true });
    expect((await b.read()).groups[0].state).toBe("accepted");
  });

  it("normalizes native-form line endings and refuses a nightly opt-in that names another model", async () => {
    const b = await browser();
    const refused = await action({
      ...b.args,
      request: b.request({
        intent: "upkeep",
        value: "on",
        expectedModel: NEW_REVIEW_MODELS.find(
          (m) => m !== DEFAULT_REVIEW_MODEL,
        )!,
        via: "fetcher",
      }),
    });
    expect(refused).toMatchObject({
      data: {
        error:
          "The selected model changed. Reload review settings before turning on nightly upkeep.",
      },
    });
    expect((await readReviewSettings(db, "local")).overnight).toBe(false);
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    await runMemoryReview(env, "local", async (_m, input) => ({
      ...proposal(input),
      body: "claimmarker Apples cool.\n\nPears dry.",
    }));
    const g = await firstGroup();
    expect(
      await action({
        ...b.args,
        request: b.request({
          intent: "accept",
          id: g.group_id,
          draftTitle: g.draft_title ?? "",
          draftBody: (g.draft_body ?? "").replaceAll("\n", "\r\n"),
          via: "fetcher",
        }),
      }),
    ).toEqual({ saved: true });
  });
});

describe("bounded cost and failure controls", () => {
  it("handles both text and decoded JSON-mode Workers AI responses without live inference", async () => {
    const run = vi
      .spyOn(env.AI, "run")
      .mockResolvedValue({ response: JSON.stringify(noop) });
    expect(await draftMemoryReview(env, WORKERS_AI_REVIEW_MODEL, "[]")).toEqual(
      noop,
    );
    // A provider can return a JSON-mode object despite older generated response types saying string.
    run.mockResolvedValue(JSON.parse(JSON.stringify({ response: noop })));
    expect(await draftMemoryReview(env, WORKERS_AI_REVIEW_MODEL, "[]")).toEqual(
      noop,
    );
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0][1]).toMatchObject({
      max_tokens: 1536,
      stream: false,
      response_format: { type: "json_object" },
    });
  });

  it("reserves failed calls, backs off an hour, retries once and never recreates terminal failures", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable("local", { manualMemories: 8 });
    const fail = vi.fn(async () => {
      throw new Error("PRIVATE INPUT AND SECRET must not be logged");
    });
    expect((await runMemoryReview(env, "local", fail)).failed).toBe(1);
    expect((await firstGroup()).error).not.toContain("PRIVATE");
    expect((await reviewBudget(db, "local")).calls).toBe(1);
    expect((await runMemoryReview(env, "local", fail)).calls).toBe(0);
    await db.prepare("UPDATE memory_review_groups SET retry_at = 0").run();
    expect((await runMemoryReview(env, "local", fail)).failed).toBe(1);
    await db.prepare("UPDATE memory_review_groups SET retry_at = 0").run();
    expect((await runMemoryReview(env, "local", fail)).calls).toBe(0);
    expect(fail).toHaveBeenCalledTimes(2);
    expect((await firstGroup()).attempts).toBe(2);
    expect((await reviewBudget(db, "local")).calls).toBe(2);
  });

  it("enforces daily calls and conservative money reservations before sending evidence", async () => {
    const a = await save(
      `claimmarker Apples cool. ${"Retain this qualification. ".repeat(50)}`,
    );
    await save("claimmarker Pears dry.");
    // The money cap is an admin's; the count is the person's (ADR-0012, 2026-11-04 limits).
    await writeReviewCaps(
      db,
      "local",
      { reviewMicrousd: 1000, rankingMicrousd: DEFAULT_RANKING_MICROUSD },
      "admin-test",
    );
    await enable("local", { manualMemories: 1 });
    const infer = vi.fn(async () => noop);
    expect((await runMemoryReview(env, "local", infer)).stopped).toBe(
      "cost limit",
    );
    expect(infer).not.toHaveBeenCalled();
    await writeReviewCaps(
      db,
      "local",
      {
        reviewMicrousd: DEFAULT_REVIEW_MICROUSD,
        rankingMicrousd: DEFAULT_RANKING_MICROUSD,
      },
      "admin-test",
    );
    expect((await runMemoryReview(env, "local", infer)).calls).toBe(1);
    await editMemory(
      env,
      raw(a.id),
      { body: "claimmarker A new qualification." },
      model,
    );
    expect((await runMemoryReview(env, "local", infer)).stopped).toBe(
      "daily budget",
    );
    expect(infer).toHaveBeenCalledTimes(1);
    expect((await reviewBudget(db, "local")).reserved_microusd).toBeGreaterThan(
      0,
    );
  });

  it("caps an invocation at two model calls/eight anchors and avoids repeated all-corpus scans", async () => {
    for (let i = 0; i < 18; i++)
      await saveMemory(
        env,
        {
          type: "fact",
          title: `unique${i}needle`,
          body: `claimmarker Evidence ${i}.`,
          tags: [],
          project: `isolated-${i}`,
        },
        model,
      );
    await enable("local", { manualMemories: 8 });
    const pass = await runMemoryReview(env, "local", async () => noop);
    expect(pass.scanned).toBeLessThanOrEqual(8);
    expect(pass.calls).toBeLessThanOrEqual(2);
    // Singleton no-ops are persisted locally without paying for inference.
    expect(pass.calls).toBe(0);
    expect(
      (await listReviewGroups(db, "local")).every((g) => g.state === "noop"),
    ).toBe(true);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_review_pending")
        .first(),
    ).toEqual({ n: 10 });
  });

  it("stops at two actual inference calls even when more eligible groups remain", async () => {
    for (let i = 0; i < 5; i++)
      for (let j = 0; j < 2; j++)
        await saveMemory(
          env,
          {
            type: "fact",
            title: `Orchard group ${i}`,
            body: `claimmarker Compatible detail ${j}.`,
            tags: [],
            project: `group-${i}`,
          },
          model,
        );
    await enable("local", { manualMemories: 8 });
    const infer = vi.fn(async () => noop);
    const pass = await runMemoryReview(env, "local", infer);
    expect(pass).toMatchObject({ calls: 2, stopped: "pass limit" });
    expect(infer).toHaveBeenCalledTimes(2);
    expect(pass.scanned).toBeLessThanOrEqual(8);
    expect(
      await db
        .prepare("SELECT COUNT(*) AS n FROM memory_review_pending")
        .first(),
      // Keep compared neighbors queued for their own unseen relationships.
    ).toEqual({ n: 8 });
  });

  it("serializes passes and obeys the off switch before subsequent calls", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    const infer = vi.fn(async () => {
      expect(
        (await runMemoryReview(env, "local", async () => noop)).stopped,
      ).toBe("already running");
      await writeReviewSettings(db, "local", {
        ...DEFAULT_REVIEW_SETTINGS,
        enabled: false,
      });
      return noop;
    });
    expect((await runMemoryReview(env, "local", infer)).calls).toBe(1);
    expect((await runMemoryReview(env, "local", infer)).stopped).toBe("off");
    expect(infer).toHaveBeenCalledTimes(1);
  });

  it("treats unsupported model evidence as failure, not authoritative memory", async () => {
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    const result = await runMemoryReview(env, "local", async (_m, input) => ({
      ...proposal(input),
      evidence: [
        {
          id: (JSON.parse(input) as ReviewSource[])[0].id,
          quote: "invented quote",
        },
        { id: "mem_other_tenant", quote: "stolen evidence" },
      ],
    }));
    expect(result.failed).toBe(1);
    expect((await firstGroup()).state).toBe("failed");
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 2 });
    expect(() =>
      validateReviewProposal(
        {
          ...noop,
          kind: "summary",
          title: "Link only",
          body: "",
          evidence: [],
        },
        [],
      ),
    ).toThrow();
  });

  it("keeps overnight inference opt-in and runs at most five accounts a minute", async () => {
    const run = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      Response.json({
        choices: [{ message: { content: JSON.stringify(noop) } }],
      }),
    );
    const bindings = { DB: db, OPENROUTER_API_KEY: "synthetic-not-a-real-key" };
    await save("claimmarker Apples cool.");
    await save("claimmarker Pears dry.");
    await enable();
    expect(await overnightMemoryReview(bindings)).toEqual({
      users: 0,
      calls: 0,
      applied: 0,
      failed: 0,
    });
    expect(run).not.toHaveBeenCalled();
    for (let i = 0; i < 11; i++) {
      const user = `night-${i}`;
      await seedAccount(user);
      await save("claimmarker Apples cool.", user);
      await save("claimmarker Pears dry.", user);
      await enable(user, { overnight: true });
    }
    expect(await overnightMemoryReview(bindings)).toEqual({
      users: 5,
      calls: 5,
      applied: 0,
      failed: 0,
    });
    expect(run).toHaveBeenCalledTimes(5);
    expect((await overnightMemoryReview(bindings)).users).toBe(5);
    expect((await overnightMemoryReview(bindings)).users).toBe(1);
  });
});
