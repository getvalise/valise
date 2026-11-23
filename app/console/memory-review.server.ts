import { data } from "react-router";
import { z } from "zod";
import { MemoryLinkError } from "~/concepts/memory-links";
import { PrincipleError } from "~/concepts/memory-reflection";
import type { ReviewSnapshot, ReviewView } from "~/concepts/memory-review";
import { MemoryReviewError } from "~/concepts/memory-review";
import {
  MAX_MANUAL_MEMORIES,
  MAX_UPKEEP_MEMORIES,
} from "~/concepts/memory-review-limits";
import {
  REVIEW_MODELS,
  ReviewFailure,
  reviewFailureLabel,
  reviewProviderAvailable,
  reviewProviderUnavailable,
} from "~/concepts/memory-review-model";
import { memoryReviewHref } from "~/concepts/memory-review-path";
import { ReviewRankingError } from "~/concepts/memory-review-ranking";
import {
  decodeOutcome,
  encodeOutcome,
  outcomeText,
  reviewOutcome,
} from "~/concepts/memory-review-report";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { afterSave } from "~/console/forms.server";
import { waitingQuestions } from "~/console/memory-sections.server";
import type { Route } from "../routes/+types/memories";

const formSchema = z.discriminatedUnion("intent", [
  z.object({ intent: z.literal("run"), memory: z.string().optional() }),
  z.object({
    intent: z.literal("ranking-setting"),
    field: z.literal("enabled"),
    value: z.string(),
    revision: z.coerce.number().int().min(0),
    destination: z.string(),
    expectedModel: z.enum(REVIEW_MODELS),
  }),
  z.object({
    intent: z.literal("limits"),
    manualMemories: z.string(),
    upkeepMemories: z.string(),
    wasManualMemories: z.string(),
    wasUpkeepMemories: z.string(),
    expectedModel: z.enum(REVIEW_MODELS),
  }),
  z.object({
    intent: z.literal("setting"),
    field: z.enum([
      "enabled",
      "overnight",
      "model",
      "manualMemories",
      "upkeepMemories",
    ]),
    value: z.string(),
    expectedModel: z.enum(REVIEW_MODELS).optional(),
  }),
  z.object({
    intent: z.literal("edit"),
    id: z.string(),
    field: z.enum(["title", "body"]),
    value: z.string(),
    was: z.string(),
  }),
  z.object({ intent: z.enum(["dismiss", "reopen", "undo"]), id: z.string() }),
  z.object({ intent: z.literal("reflect") }),
  z.object({
    intent: z.literal("adopt"),
    principle: z.string(),
    rule: z.string(),
    fileTodo: z.string().optional(),
  }),
  z.object({
    intent: z.literal("reject"),
    principle: z.string(),
    reason: z.string().default(""),
  }),
  z.object({
    intent: z.literal("upkeep"),
    value: z.enum(["on", "off"]),
    expectedModel: z.enum(REVIEW_MODELS).optional(),
  }),
  z.object({
    intent: z.literal("accept"),
    id: z.string(),
    draftTitle: z.string(),
    draftBody: z.string(),
    supersede: z.string().optional(),
    retainedTruth: z.string().optional(),
    subjectMode: z.enum(["new", "existing"]).optional(),
    subjectName: z.string().optional(),
    subjectId: z.string().optional(),
    subjectTarget: z.string().optional(),
    expectedSummary: z.string().optional(),
    setSummary: z.string().optional(),
  }),
]);

export async function loader({ context, request }: Route.LoaderArgs) {
  const { env, store } = await requireConsoleActor(context, request);
  const review = store.review;
  const settings = await review.settings();
  const params = new URL(request.url).searchParams;
  const limit = Math.min(100, Math.max(30, Number(params.get("limit")) || 30));
  // Questions by default; `activity=all` is the older address of All activity.
  const view: ReviewView =
    params.get("view") === "applied"
      ? "applied"
      : params.get("view") === "all" || params.get("activity") === "all"
        ? "all"
        : "questions";
  const history = view === "all";
  const hideDecided = params.get("decided") === "hide";
  // J-B: one memory's suggestions. A foreign or archived id narrows to nothing.
  const memoryId = params.get("memory") || undefined;
  const anchored = memoryId ? await store.memories.get(memoryId) : null;
  // An untitled memory reads as null, as the page has always received it.
  const anchor = anchored
    ? { id: memoryId, title: anchored.title || null }
    : null;
  const groups = await review.groups(limit, true, history, {
    memoryId,
    hideDecided: view === "questions" && hideDecided,
    view,
  });
  // A deep link remains readable outside the bounded list window.
  const open = params.get("open");
  const selected = open ? await review.group(open) : null;
  const events = selected ? await review.events(selected.group_id) : [];
  const sourceHistory: Record<
    string,
    Awaited<ReturnType<typeof review.sourceHistory>>
  > = Object.fromEntries(
    await Promise.all(
      (selected ? (JSON.parse(selected.sources_json) as ReviewSnapshot[]) : [])
        .slice(0, 4)
        .map(async (s) => [
          s.source.id,
          await review.sourceHistory(s.source.id, selected!.group_id),
        ]),
    ),
  );
  const subjects =
    selected?.state === "proposal" ? await store.subjects.choices() : [];
  const ran = decodeOutcome(params.get("ran"));
  return {
    settings,
    memoryId,
    anchor,
    hideDecided,
    counts: await review.count(memoryId),
    waiting: await waitingQuestions(store),
    ranking: await review.ranking(),
    rankingBudget: await review.rankingBudget(),
    rankingConfigured: !!(
      env.AI &&
      env.VECTOR_INDEX &&
      env.TYPESAFE_API_KEY &&
      env.VALISE_VECTOR_NAMESPACE
    ),
    sourceHistory,
    subjects,
    history,
    view,
    principles: await review.principles(),
    upkeep: {
      ...(await review.upkeepStatus()),
      lessons: await review.lessons(),
      now: Math.floor(Date.now() / 1000),
    },
    events,
    groups: selected
      ? groups.some((g) => g.group_id === open)
        ? groups.map((g) => (g.group_id === open ? selected : g))
        : [...groups, selected]
      : groups,
    budget: await review.budget(),
    caps: await review.caps(),
    editing: params.get("edit") ?? undefined,
    open,
    limit,
    ran: ran ? outcomeText(ran) : null,
    providerAvailable: REVIEW_MODELS.map((model) =>
      reviewProviderAvailable(env, model),
    ),
    providerUnavailableReason: reviewProviderAvailable(env, settings.model)
      ? null
      : reviewProviderUnavailable(settings.model),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const form = await request.formData();
  const params = new URL(request.url).searchParams;
  const parsed = formSchema.safeParse(Object.fromEntries(form));
  if (!parsed.success)
    return data({ error: "Invalid review action." }, { status: 400 });
  const input = parsed.data;
  try {
    if (input.intent === "ranking-setting") {
      await actor.store.review.setRanking(
        input.value,
        input.revision,
        input.destination,
        input.expectedModel,
      );
    } else if (input.intent === "limits") {
      // One Save for the two counts a person sees together. Only a value that
      // changed is written, and only if it still equals what the form showed,
      // so an untouched field cannot overwrite a newer one (P2).
      const review = actor.store.review;
      const settings = await review.settings();
      const shown = {
        manualMemories: String(settings.manualMemories),
        upkeepMemories: String(settings.upkeepMemories),
      };
      const changes = (
        [
          ["manualMemories", input.manualMemories, input.wasManualMemories],
          ["upkeepMemories", input.upkeepMemories, input.wasUpkeepMemories],
        ] as const
      ).flatMap(([field, raw, was]) => {
        const value = raw.trim();
        if (value === was) return [];
        if (shown[field] !== was)
          throw new MemoryReviewError(
            "These limits changed elsewhere. Reload the page and try again.",
          );
        return [[field, value] as const];
      });
      for (const [field, value] of changes)
        await review.patchSetting(field, value, input.expectedModel);
    } else if (input.intent === "setting") {
      await actor.store.review.patchSetting(
        input.field,
        input.value,
        input.expectedModel,
      );
    } else if (input.intent === "run") {
      if (input.memory && !(await actor.store.memories.get(input.memory)))
        throw new MemoryReviewError(
          "That memory cannot be found. It may have been archived.",
        );
      const report = await actor.store.review.run(input.memory || undefined);
      const outcome = reviewOutcome(report);
      if (form.get("via") === "fetcher")
        return { report, outcome: outcomeText(outcome) };
      return afterSave(
        form,
        memoryReviewHref(params, { ran: encodeOutcome(outcome), edit: null }),
      );
    } else if (input.intent === "edit") {
      await actor.store.review.editDraft(
        input.id,
        input.field,
        input.value.replaceAll("\r\n", "\n"),
        input.was.replaceAll("\r\n", "\n"),
      );
    } else if (input.intent === "upkeep") {
      await actor.store.review.upkeep(
        input.value === "on",
        input.expectedModel,
      );
    } else if (input.intent === "reflect") {
      await actor.store.review.reflect();
    } else if (input.intent === "adopt") {
      await actor.store.review.adopt(input.principle, {
        rule: input.rule.replaceAll("\r\n", "\n"),
        fileTodo: input.fileTodo === "on",
      });
    } else if (input.intent === "reject") {
      await actor.store.review.reject(input.principle, input.reason);
    } else if (input.intent === "undo") {
      await actor.store.review.undo(input.id);
    } else if (input.intent === "dismiss" || input.intent === "reopen") {
      await actor.store.review.dismiss(input.id, input.intent === "reopen");
    } else if (input.intent === "accept") {
      let subjectTarget: { id: string; summary: string | null } | null = null;
      if (
        input.subjectMode === "existing" &&
        !input.subjectId &&
        input.subjectTarget
      ) {
        try {
          subjectTarget = z
            .object({ id: z.string(), summary: z.string().nullable() })
            .parse(JSON.parse(input.subjectTarget));
        } catch {
          throw new MemoryReviewError(
            "Choose a valid subject or paste its id.",
          );
        }
      }
      await actor.store.review.accept(input.id, {
        ...input,
        draftBody: input.draftBody.replaceAll("\r\n", "\n"),
        supersede: input.supersede === "on",
        retainedTruth: input.retainedTruth === "on",
        ...(input.subjectMode
          ? {
              subject: {
                id:
                  input.subjectMode === "existing"
                    ? input.subjectId || subjectTarget?.id
                    : undefined,
                name:
                  input.subjectMode === "new" ? input.subjectName : undefined,
                members: form.getAll("member").map(String),
                setSummary: input.setSummary === "on",
                expectedSummary:
                  subjectTarget?.summary ?? input.expectedSummary ?? null,
              },
            }
          : {}),
      });
    }
    // A save made under Advanced lands with Advanced still open (P11).
    const advanced =
      input.intent === "limits" ||
      input.intent === "ranking-setting" ||
      (input.intent === "setting" && input.field === "model");
    return afterSave(
      form,
      memoryReviewHref(params, {
        ...("id" in input ? { open: input.id } : {}),
        ...(advanced ? { settings: "open" } : {}),
        edit: null,
      }),
    );
  } catch (error) {
    if (
      error instanceof MemoryReviewError ||
      error instanceof PrincipleError ||
      error instanceof ReviewRankingError ||
      error instanceof ReviewFailure ||
      error instanceof MemoryLinkError ||
      error instanceof z.ZodError
    )
      return data(
        {
          error:
            error instanceof ReviewFailure
              ? reviewFailureLabel(error.code)
              : error instanceof z.ZodError
                ? input.intent === "limits" || input.intent === "setting"
                  ? `Enter whole numbers: 1 to ${MAX_MANUAL_MEMORIES} memories by hand and 1 to ${MAX_UPKEEP_MEMORIES} each night.`
                  : "The value is outside the review limits."
                : error.message,
        },
        { status: 409 },
      );
    throw error;
  }
}
