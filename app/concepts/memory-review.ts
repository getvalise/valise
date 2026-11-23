import { z } from "zod";
import type { Provenance } from "~/concepts/memories";
import { memoryLinkBatch, memoryLinkStatements } from "~/concepts/memory-links";
import {
  CLUSTER_SYSTEM,
  candidateMeta,
  clusterInput,
  DRAFT_SYSTEM,
  draftCandidates,
  draftInput,
  dueReflection,
  EVIDENCE_RULE,
  knownRules,
  parseReflectionState,
  principleStatement,
  REFLECTION_CALLS_PER_NIGHT,
  reflectionLines,
  requestReflection,
  validateCluster,
  validateDraft,
} from "~/concepts/memory-reflection";
import { findSubjectByName, NAME_FREE } from "~/concepts/memory-subjects";
import { spendStatement } from "~/concepts/spend";
import { accountAdmissionSql, accountAdmitted } from "~/concepts/users";
import { memoryProjectionStatements } from "~/search/memory";
import { search } from "~/search/query";
import { vectorSnapshotStatement } from "~/search/vector-outbox";
import type { VectorBindings } from "~/search/vectors";
import {
  fitLessonBatch,
  LESSON_CALLS_PER_NIGHT,
  LESSON_SYSTEM,
  lessonCandidates,
  lessonInput,
  lessonStatements,
  validateLessons,
} from "./memory-lessons";
import {
  reviewedPairs,
  reviewPairKey,
  sourceWasReviewed,
} from "./memory-review-history";
import {
  MAX_MANUAL_MEMORIES,
  MAX_UPKEEP_MEMORIES,
  RANKING_REQUESTS_PER_MEMORY,
  readReviewCaps,
  reviewCapSql,
} from "./memory-review-limits";
import {
  DEFAULT_REVIEW_MODEL,
  draftMemoryReview,
  NEW_REVIEW_MODELS,
  REVIEW_INPUT_BYTES,
  REVIEW_MODELS,
  REVIEW_PROMPT_VERSION,
  REVIEW_SYSTEM,
  ReviewFailure,
  type ReviewModel,
  type ReviewProposal,
  type ReviewProviderEnv,
  reviewFailureCode,
  reviewMaxCallMicrousd,
  reviewProposalSchema,
  reviewProviderAvailable,
  reviewProviderUnavailable,
  reviewReservation,
} from "./memory-review-model";
import {
  REVIEW_RANK_DESTINATION,
  ReviewRankingError,
  rankingAuthorization,
  rankingBudget,
  rankingFailureCode,
  rankReviewSources,
  readRankingSettings,
  reviewVectors,
} from "./memory-review-ranking";

type ReviewEnv = ReviewProviderEnv &
  VectorBindings & {
    DB: D1Database;
    TYPESAFE_API_KEY?: string;
    VALISE_VECTOR_NAMESPACE?: string;
  };
export class MemoryReviewError extends Error {}
const nowSeconds = () => Math.floor(Date.now() / 1000);
const bytes = (text: string) => new TextEncoder().encode(text).byteLength;
const MAX_ANCHORS = 8;
const MAX_CALLS_PER_PASS = 2;

export const reviewSettingsSchema = z
  .object({
    enabled: z.boolean(),
    overnight: z.boolean(),
    /** Apply additive results without asking (ADR-0012, 2026-11-04). Only with nightly upkeep. */
    autoApply: z.boolean(),
    model: z.enum(REVIEW_MODELS),
    /**
     * Memories checked a day by hand, and by the nightly run, each against its
     * own counter. One check is one model call about one starting memory, and
     * with candidate ranking on, two ranking requests. Money is an admin cap
     * (`memory-review-limits.ts`), not a person's setting (ADR-0012, 2026-11-04 limits).
     */
    manualMemories: z.number().int().min(1).max(MAX_MANUAL_MEMORIES),
    upkeepMemories: z.number().int().min(1).max(MAX_UPKEEP_MEMORIES),
  })
  .strict();
export type ReviewSettings = z.infer<typeof reviewSettingsSchema>;
export const DEFAULT_REVIEW_SETTINGS: ReviewSettings = {
  enabled: false,
  overnight: false,
  autoApply: false,
  model: DEFAULT_REVIEW_MODEL,
  manualMemories: 25,
  upkeepMemories: 50,
};
/** Kinds a nightly run applies itself: each only adds a memory, and Undo archives it. */
export const AUTO_APPLY_KINDS: readonly ReviewProposal["kind"][] = [
  "summary",
  "stale-summary",
];
/** The hour (UTC) a finished run is next due. Budgets reset at 00:00 UTC. */
export const UPKEEP_HOUR_UTC = 2;
/** At most this many passes in one run, so a queue that never empties cannot loop all day. */
const UPKEEP_MAX_PASSES = 40;

export async function readReviewSettings(
  db: D1Database,
  userId: string,
): Promise<ReviewSettings> {
  const row = await db
    .prepare(`SELECT enabled, overnight, auto_apply, model, manual_memories, upkeep_memories
    FROM memory_review_settings WHERE user_id = ?`)
    .bind(userId)
    .first<{
      enabled: number;
      overnight: number;
      auto_apply: number;
      model: ReviewModel;
      manual_memories: number;
      upkeep_memories: number;
    }>();
  return row
    ? reviewSettingsSchema.parse({
        enabled: row.enabled === 1,
        overnight: row.overnight === 1,
        autoApply: row.auto_apply === 1,
        model: row.model,
        manualMemories: row.manual_memories,
        upkeepMemories: row.upkeep_memories,
      })
    : { ...DEFAULT_REVIEW_SETTINGS };
}

/** Full configuration replacement for trusted application callers; console fields use patchReviewSetting. */
export async function writeReviewSettings(
  db: D1Database,
  userId: string,
  input: ReviewSettings,
): Promise<void> {
  const s = reviewSettingsSchema.parse(input);
  await db
    .prepare(`INSERT INTO memory_review_settings(user_id, enabled, overnight, auto_apply, model, manual_memories, upkeep_memories)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET enabled = excluded.enabled,
    overnight = excluded.overnight, auto_apply = excluded.auto_apply, model = excluded.model,
    manual_memories = excluded.manual_memories, upkeep_memories = excluded.upkeep_memories`)
    .bind(
      userId,
      +s.enabled,
      +s.overnight,
      +s.autoApply,
      s.model,
      s.manualMemories,
      s.upkeepMemories,
    )
    .run();
}

/** One field per commit (P2); a destination change also revokes its coupled execution consent. */
export async function patchReviewSetting(
  db: D1Database,
  userId: string,
  field: keyof ReviewSettings,
  raw: string,
  expectedModel?: ReviewModel,
): Promise<void> {
  const columns = {
    enabled: "enabled",
    overnight: "overnight",
    autoApply: "auto_apply",
    model: "model",
    manualMemories: "manual_memories",
    upkeepMemories: "upkeep_memories",
  };
  let value: string | number;
  if (field === "enabled" || field === "overnight" || field === "autoApply") {
    if (raw !== "on" && raw !== "off")
      throw new MemoryReviewError("Choose on or off.");
    value = +(raw === "on");
  } else if (field === "model")
    value = reviewSettingsSchema.shape.model.parse(raw);
  else value = reviewSettingsSchema.shape[field].parse(Number(raw));
  const consentOn =
    (field === "enabled" || field === "overnight" || field === "autoApply") &&
    value === 1;
  if (consentOn && !expectedModel)
    throw new MemoryReviewError(
      "Reload review settings before enabling transmission; permission must name the selected provider and model.",
    );
  if (consentOn) reviewSettingsSchema.shape.model.parse(expectedModel);
  await db
    .prepare(
      "INSERT INTO memory_review_settings(user_id, model) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING",
    )
    .bind(userId, DEFAULT_REVIEW_MODEL)
    .run();
  if (field === "model") {
    // Saving a different destination/model revokes the old transmission and
    // overnight consent. Choosing a model is never permission to start calls.
    const updated = await db
      .prepare(`UPDATE memory_review_settings SET
      enabled = CASE WHEN model = ? THEN enabled ELSE 0 END,
      overnight = CASE WHEN model = ? THEN overnight ELSE 0 END,
      auto_apply = CASE WHEN model = ? THEN auto_apply ELSE 0 END, model = ? WHERE user_id = ?
      AND (model = ? OR ? = 1) RETURNING user_id`)
      .bind(
        value,
        value,
        value,
        value,
        userId,
        value,
        +NEW_REVIEW_MODELS.some((model) => model === value),
      )
      .first();
    if (!updated)
      throw new MemoryReviewError(
        "Choose an offered review model for a new provider selection. Legacy choices can only be retained unchanged.",
      );
    return;
  }
  const updated = await db
    .prepare(`UPDATE memory_review_settings SET ${columns[field]} = ? WHERE user_id = ?
    AND (? = 0 OR model = ?)
    AND (? = 0 OR NOT EXISTS(SELECT 1 FROM memory_review_ranking r WHERE r.user_id=memory_review_settings.user_id AND r.enabled=1 AND (r.manual_model IS NULL OR r.manual_model<>memory_review_settings.model)))
    RETURNING user_id`)
    .bind(
      value,
      userId,
      +consentOn,
      expectedModel ?? "",
      +(field === "overnight" && value === 1),
    )
    .first();
  if (!updated) {
    if (
      consentOn &&
      (await readReviewSettings(db, userId)).model !== expectedModel
    )
      throw new MemoryReviewError(
        "The selected provider or model changed. Reload review settings before enabling transmission.",
      );
    throw new MemoryReviewError(RANKING_FIRST);
  }
}

const RANKING_FIRST =
  "Candidate ranking needs a manual check with this model before it can run at night. Turn ranking off or run a check first.";

/**
 * The one switch of nightly upkeep (ADR-0012, 2026-11-04). On: model reviews,
 * nightly runs and applying additive results, all bound to the model the form
 * displayed, due at once. Off:
 * nightly runs and automatic application stop; manual checks stay as they were.
 */
export async function setNightlyUpkeep(
  db: D1Database,
  userId: string,
  on: boolean,
  expectedModel?: ReviewModel,
): Promise<void> {
  if (!on) {
    await db
      .prepare(
        "UPDATE memory_review_settings SET overnight = 0, auto_apply = 0 WHERE user_id = ?",
      )
      .bind(userId)
      .run();
    return;
  }
  if (!expectedModel)
    throw new MemoryReviewError(
      "Reload review settings before turning on nightly upkeep; it must name the selected model.",
    );
  reviewSettingsSchema.shape.model.parse(expectedModel);
  await db
    .prepare(
      "INSERT INTO memory_review_settings(user_id, model) VALUES (?, ?) ON CONFLICT(user_id) DO NOTHING",
    )
    .bind(userId, DEFAULT_REVIEW_MODEL)
    .run();
  const updated = await db
    .prepare(`UPDATE memory_review_settings SET enabled = 1, overnight = 1, auto_apply = 1,
    next_run_at = 0, last_run_json = NULL WHERE user_id = ? AND model = ?
    AND NOT EXISTS(SELECT 1 FROM memory_review_ranking r WHERE r.user_id=memory_review_settings.user_id AND r.enabled=1 AND (r.manual_model IS NULL OR r.manual_model<>memory_review_settings.model))
    RETURNING user_id`)
    .bind(userId, expectedModel)
    .first();
  if (updated) return;
  if ((await readReviewSettings(db, userId)).model !== expectedModel)
    throw new MemoryReviewError(
      "The selected model changed. Reload review settings before turning on nightly upkeep.",
    );
  throw new MemoryReviewError(RANKING_FIRST);
}

export type ReviewSource = {
  id: string;
  revision: number;
  type: string;
  title: string | null;
  body: string;
  tags: string;
  project: string | null;
  agent: string;
  client: string;
  session: string | null;
  sessionName: string | null;
  links: [
    string,
    string,
    string,
    string,
    string,
    number | null,
    number | null,
    number | null,
  ][];
};
export type ReviewSnapshot = {
  source: ReviewSource;
  stamp: string;
  fingerprint: string;
  /** Selection evidence for this run, not model input or source authority. Absent on older runs. */
  selection?: {
    via:
      | "starting-memory"
      | "existing-link"
      | "keyword-match"
      | "same-project"
      | "vector-match"
      | "hybrid-ranking";
    anchorId: string;
    score?: number;
    ranking?: {
      model: string;
      threshold: number;
      revision?: number;
      candidates: { id: string; score: number; via?: string }[];
      omitted: string[];
    };
  };
};

/** A byte-exact SQL snapshot doubles as the acceptance guard. Revisions catch edit-and-revert,
 * full content catches same-second edits, link stamps catch new confirmed evidence. */
const snapshotSelect = `SELECT json_object(
  'id', m.memory_id, 'revision', 1 + COALESCE((SELECT MAX(revision) FROM memory_revisions r WHERE r.memory_id = m.memory_id), 0),
  'type', m.memory_type, 'title', m.title, 'body', m.body, 'tags', m.tags_json, 'project', m.project,
  'agent', m.source_agent, 'client', m.source_client, 'session', m.source_session, 'sessionName', m.source_session_name,
  'links', json((SELECT json_group_array(json_array(link_id, from_memory_id, to_memory_id, kind, asserted_by, confirmed_at, removed_at, other_deleted))
    FROM (SELECT l.*, other.deleted_at AS other_deleted FROM memory_links l JOIN memories other ON other.memory_id =
      CASE WHEN l.from_memory_id = m.memory_id THEN l.to_memory_id ELSE l.from_memory_id END
      WHERE (l.from_memory_id = m.memory_id OR l.to_memory_id = m.memory_id) AND other.user_id = m.user_id
       ORDER BY l.link_id)))) AS stamp FROM memories m
  WHERE m.memory_id = ? AND m.user_id = ? AND m.deleted_at IS NULL`;

async function digest(text: string): Promise<string> {
  const hash = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(hash), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

export async function reviewSnapshot(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ReviewSnapshot | null> {
  const row = await db
    .prepare(snapshotSelect)
    .bind(id, userId)
    .first<{ stamp: string }>();
  return row
    ? {
        source: JSON.parse(row.stamp) as ReviewSource,
        stamp: row.stamp,
        fingerprint: await digest(row.stamp),
      }
    : null;
}

export type ReviewGroup = {
  group_id: string;
  state: "running" | "proposal" | "noop" | "failed" | "dismissed" | "accepted";
  model: ReviewModel;
  prompt_version: string;
  sources_json: string;
  proposal_json: string | null;
  draft_title: string | null;
  draft_body: string | null;
  result_memory_id: string | null;
  attempts: number;
  retry_at: number;
  error: string | null;
  created_at: number;
  /** `auto` when nightly upkeep applied it (or applied it and was undone), `person` for an acceptance. */
  applied_by: "auto" | "person" | null;
};
/**
 * The Review tab's three views (ADR-0012, 2026-11-04). `questions` holds what
 * waits on the person and the rows they decided, which stay in place (P5);
 * `applied` holds what nightly upkeep applied; `all` adds no-change and failed.
 */
export type ReviewView = "questions" | "applied" | "all";
export async function listReviewGroups(
  db: D1Database,
  userId: string,
  limit = 30,
  summariesOnly = false,
  includeNoops = true,
  /** A memory's own suggestions (J-B), whether decided rows are hidden (P5), and the view. */
  narrow: { memoryId?: string; hideDecided?: boolean; view?: ReviewView } = {},
): Promise<ReviewGroup[]> {
  const view = narrow.view ?? (includeNoops ? "all" : null);
  const { results } = await db
    .prepare(`SELECT ${summariesOnly ? "group_id, state, model, prompt_version, (SELECT json_group_array(json_object('source', json_object('id', json_extract(value, '$.source.id'), 'title', json_extract(value, '$.source.title')))) FROM json_each(sources_json)) AS sources_json, json_remove(proposal_json, '$.body', '$.evidence') AS proposal_json, draft_title, NULL AS draft_body, result_memory_id, attempts, retry_at, error, created_at, applied_by" : "*"} FROM memory_review_groups g WHERE user_id = ? AND (? = 1 OR state != 'noop')
    AND (? = 0 OR state NOT IN ('accepted', 'dismissed'))
    AND (? = 0 OR state = 'proposal' OR (state IN ('accepted', 'dismissed') AND applied_by IS NOT 'auto'))
    AND (? = 0 OR applied_by = 'auto')
    AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_review_sources s WHERE s.user_id = g.user_id AND s.memory_id = ? AND s.group_id = g.group_id))
    ORDER BY created_at DESC, group_id LIMIT ?`)
    .bind(
      userId,
      +includeNoops,
      +!!narrow.hideDecided,
      +(view === "questions"),
      +(view === "applied"),
      narrow.memoryId ?? null,
      narrow.memoryId ?? null,
      Math.max(1, Math.min(100, limit)),
    )
    .all<ReviewGroup>();
  return results;
}
/** Per-state totals for the status line and Hide decided (n), over the same narrowing as the list. */
export async function countReviewGroups(
  db: D1Database,
  userId: string,
  memoryId?: string,
): Promise<
  Record<ReviewGroup["state"], number> & {
    /** Applied by nightly upkeep and still standing. */
    applied: number;
    /** Applied by nightly upkeep, then undone. */
    undone: number;
  }
> {
  const counts = {
    running: 0,
    proposal: 0,
    noop: 0,
    failed: 0,
    dismissed: 0,
    accepted: 0,
    applied: 0,
    undone: 0,
  };
  const { results } = await db
    .prepare(`SELECT state, applied_by = 'auto' AS auto, COUNT(*) AS n FROM memory_review_groups g WHERE user_id = ?
    AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_review_sources s WHERE s.user_id = g.user_id AND s.memory_id = ? AND s.group_id = g.group_id))
    GROUP BY state, auto`)
    .bind(userId, memoryId ?? null, memoryId ?? null)
    .all<{ state: ReviewGroup["state"]; auto: number | null; n: number }>();
  for (const { state, auto, n } of results) {
    if (auto && state === "accepted") counts.applied += n;
    else if (auto && state === "dismissed") counts.undone += n;
    else counts[state] += n;
  }
  return counts;
}
/**
 * Questions waiting on the person, for the count beside Review in the
 * Memories sections. One COUNT on memory_review_retry (user_id, state, ...),
 * unnarrowed by the J-B memory filter, so it reads the same on every page.
 */
export async function countWaitingQuestions(
  db: D1Database,
  userId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COUNT(*) AS n FROM memory_review_groups WHERE user_id = ? AND state = 'proposal'",
    )
    .bind(userId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
export async function getReviewGroup(
  db: D1Database,
  userId: string,
  id: string,
): Promise<ReviewGroup | null> {
  return db
    .prepare(
      "SELECT * FROM memory_review_groups WHERE user_id = ? AND group_id = ?",
    )
    .bind(userId, id)
    .first<ReviewGroup>();
}
/** The newest 50 decisions on one review group, for its detail. */
export async function listReviewEvents(
  db: D1Database,
  userId: string,
  groupId: string,
) {
  const { results } = await db
    .prepare(
      `SELECT kind, value, created_at FROM memory_review_events WHERE user_id = ? AND group_id = ? ORDER BY created_at DESC, event_id DESC LIMIT 50`,
    )
    .bind(userId, groupId)
    .all<{ kind: string; value: string | null; created_at: number }>();
  return results;
}

/** Overnight drafts need a finished manual check with the selected model first. */
export async function overnightReady(
  db: D1Database,
  userId: string,
  model: string,
): Promise<boolean> {
  return !!(await db
    .prepare(
      "SELECT 1 FROM memory_review_groups WHERE user_id = ? AND model = ? AND state IN ('proposal', 'noop', 'dismissed', 'accepted') LIMIT 1",
    )
    .bind(userId, model)
    .first());
}

export async function reviewBudget(db: D1Database, userId: string) {
  return (
    (await db
      .prepare(
        `SELECT calls, manual_calls, upkeep_calls, reserved_microusd FROM memory_review_budgets WHERE user_id = ? AND day = ?`,
      )
      .bind(userId, Math.floor(nowSeconds() / 86400))
      .first<{
        calls: number;
        manual_calls: number;
        upkeep_calls: number;
        reserved_microusd: number;
      }>()) ?? {
      calls: 0,
      manual_calls: 0,
      upkeep_calls: 0,
      reserved_microusd: 0,
    }
  );
}

/** Validation is separate from inference so fixtures exercise the production acceptance boundary. */
export function validateReviewProposal(
  value: unknown,
  sources: ReviewSnapshot[],
): ReviewProposal {
  const parsed = reviewProposalSchema.safeParse(value);
  if (!parsed.success) throw new ReviewFailure("invalid-schema");
  const proposal = parsed.data;
  if (proposal.kind === "noop") return proposal;
  if (
    proposal.evidence.length < 2 ||
    (proposal.kind === "contradiction" && proposal.evidence.length !== 2)
  )
    throw new ReviewFailure("invalid-evidence");
  if (proposal.kind !== "contradiction" && (!proposal.title || !proposal.body))
    throw new ReviewFailure("invalid-draft");
  if (
    new Set(proposal.evidence.map((e) => e.id)).size !==
    proposal.evidence.length
  )
    throw new ReviewFailure("invalid-evidence");
  for (const evidence of proposal.evidence) {
    const source = sources.find((s) => s.source.id === evidence.id)?.source;
    if (
      !source ||
      !(
        (source.title ?? "").includes(evidence.quote) ||
        source.body.includes(evidence.quote)
      )
    )
      throw new ReviewFailure("invalid-evidence");
  }
  return proposal;
}

function modelInput(sources: ReviewSnapshot[]): string {
  return JSON.stringify(
    sources.map(({ source }) => ({
      ...source,
      links: source.links.map(
        ([
          id,
          from,
          to,
          kind,
          assertedBy,
          confirmedAt,
          removedAt,
          otherDeleted,
        ]) => ({
          id,
          from,
          to,
          kind,
          assertedBy,
          confirmed: confirmedAt !== null,
          removed: removedAt !== null,
          otherArchived: otherDeleted !== null,
        }),
      ),
    })),
  );
}

/** A rollup and a memory it already links to: comparing them again would only draft a summary of a summary. */
function summarizes(a: ReviewSnapshot, b: ReviewSnapshot): boolean {
  const rollup = (s: ReviewSnapshot) => s.source.tags.includes('"rollup"');
  return (
    (rollup(a) || rollup(b)) &&
    a.source.links.some(
      ([, from, to, , , , removed]) =>
        removed === null && (from === b.source.id || to === b.source.id),
    )
  );
}

function humanSuperseded({ source }: ReviewSnapshot): boolean {
  return source.links.some(
    ([, , to, kind, , confirmed, removed, otherDeleted]) =>
      to === source.id &&
      kind === "supersedes" &&
      confirmed !== null &&
      removed === null &&
      otherDeleted === null,
  );
}
function fingerprint(sources: ReviewSnapshot[], model: ReviewModel) {
  return digest(
    JSON.stringify([
      REVIEW_PROMPT_VERSION,
      model,
      sources
        .map((s) => [s.source.id, s.source.revision, s.fingerprint])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    ]),
  );
}

type ReviewLease = { userId: string; token: string; overnight: boolean };
const reviewAccountAdmittedSql = `EXISTS (SELECT 1 FROM users review_account
  WHERE review_account.user_id = memory_review_settings.user_id AND ${accountAdmissionSql("review_account")})`;
// Evaluate expiry in D1 at execution time, not against a timestamp bound by a delayed caller.
const currentReviewOwnerSql = `EXISTS (SELECT 1 FROM memory_review_settings
  WHERE user_id = ? AND lock_token = ? AND lock_until > unixepoch() AND ${reviewAccountAdmittedSql})`;
const ownerValues = (lease: ReviewLease) => [lease.userId, lease.token];
const currentReviewLeaseSql = `EXISTS (SELECT 1 FROM memory_review_settings
  WHERE user_id = ? AND lock_token = ? AND lock_until > unixepoch() AND enabled = 1
  AND (? = 0 OR overnight = 1) AND ${reviewAccountAdmittedSql})`;
const leaseValues = (lease: ReviewLease) => [
  lease.userId,
  lease.token,
  +lease.overnight,
];

/** A new fingerprint must still be absent. A retry must still be the exact due
 * failed/running attempt observed by this pass. No UPSERT may revive coverage.
 */
async function admitReviewGroup(
  db: D1Database,
  lease: ReviewLease,
  model: ReviewModel,
  key: string,
  sources: ReviewSnapshot[],
  retry?: ReviewGroup,
): Promise<{ group_id: string; attempts: number } | null> {
  const permission = `${currentReviewLeaseSql} AND (SELECT model FROM memory_review_settings WHERE user_id = ?) = ?`;
  if (retry)
    return db
      .prepare(`UPDATE memory_review_groups SET state = 'running', attempts = attempts + 1,
    retry_at = unixepoch() + 900, updated_at = unixepoch()
    WHERE group_id = ? AND user_id = ? AND fingerprint = ? AND model = ? AND prompt_version = ?
    AND state = ? AND state IN ('failed', 'running') AND attempts = ? AND attempts < 2
    AND retry_at = ? AND retry_at <= unixepoch() AND ${permission}
    RETURNING group_id, attempts`)
      .bind(
        retry.group_id,
        lease.userId,
        key,
        model,
        REVIEW_PROMPT_VERSION,
        retry.state,
        retry.attempts,
        retry.retry_at,
        ...leaseValues(lease),
        lease.userId,
        model,
      )
      .first();
  return db
    .prepare(`INSERT INTO memory_review_groups(group_id, user_id, fingerprint, model, prompt_version,
    sources_json, state, retry_at, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, 'running', unixepoch() + 900, unixepoch(), unixepoch() WHERE ${permission}
    ON CONFLICT(user_id, fingerprint) DO NOTHING RETURNING group_id, attempts`)
    .bind(
      `mrg_${crypto.randomUUID()}`,
      lease.userId,
      key,
      model,
      REVIEW_PROMPT_VERSION,
      JSON.stringify(sources),
      ...leaseValues(lease),
      lease.userId,
      model,
    )
    .first();
}

/** A delayed admission response is not permission to dispatch an obsolete attempt. */
async function beginReviewInference(
  db: D1Database,
  lease: ReviewLease,
  model: ReviewModel,
  admitted: { group_id: string; attempts: number },
): Promise<number | null> {
  const permitted = await db
    .prepare(`UPDATE memory_review_groups SET updated_at = unixepoch()
    WHERE group_id = ? AND user_id = ? AND attempts = ? AND state = 'running' AND model = ?
    AND ${currentReviewLeaseSql} AND (SELECT model FROM memory_review_settings WHERE user_id = ?) = ?
    AND (SELECT lock_until FROM memory_review_settings WHERE user_id = ?) > unixepoch() + 30
    RETURNING (SELECT lock_until FROM memory_review_settings WHERE user_id = ?) AS lock_until`)
    .bind(
      admitted.group_id,
      lease.userId,
      admitted.attempts,
      model,
      ...leaseValues(lease),
      lease.userId,
      model,
      lease.userId,
      lease.userId,
    )
    .first<{ lock_until: number }>();
  return permitted?.lock_until ?? null;
}

/** Which of today's limits refused a call: the person's count, or the admin's money cap. */
async function budgetStop(
  db: D1Database,
  userId: string,
  overnight: boolean,
  reserved: number,
): Promise<"daily budget" | "cost limit"> {
  const settings = await readReviewSettings(db, userId);
  const budget = await reviewBudget(db, userId);
  const caps = await readReviewCaps(db, userId);
  if (
    (overnight ? budget.upkeep_calls : budget.manual_calls) >=
    (overnight ? settings.upkeepMemories : settings.manualMemories)
  )
    return "daily budget";
  return budget.reserved_microusd + reserved > caps.reviewMicrousd
    ? "cost limit"
    : "daily budget";
}

/** Record why ranking stopped, where the console and the logs both find it. */
async function rankingStopped(
  db: D1Database,
  userId: string,
  error: unknown,
  stage: "embedding" | "ranking",
): Promise<string> {
  const code = rankingFailureCode(error, stage);
  // The code and error class only: never provider text or memory content.
  console.error("memory review ranking stopped", {
    code,
    stage,
    error: error instanceof Error ? error.name : typeof error,
  });
  await db
    .prepare(
      "INSERT INTO memory_review_ranking_budgets(user_id,day,requests,reserved_microusd,last_error) VALUES(?,CAST(unixepoch()/86400 AS INTEGER),0,0,?) ON CONFLICT(user_id,day) DO UPDATE SET last_error=excluded.last_error",
    )
    .bind(userId, code)
    .run();
  return code;
}

async function cancelReviewRetry(
  db: D1Database,
  lease: ReviewLease,
  retry: ReviewGroup,
  reason: string,
): Promise<boolean> {
  return !!(await db
    .prepare(`UPDATE memory_review_groups SET attempts = 2, state = 'failed', error = ?, updated_at = unixepoch()
    WHERE group_id = ? AND user_id = ? AND state = ? AND state IN ('failed', 'running') AND attempts = ?
    AND retry_at = ? AND retry_at <= unixepoch() AND ${currentReviewLeaseSql} RETURNING group_id`)
    .bind(
      reason,
      retry.group_id,
      lease.userId,
      retry.state,
      retry.attempts,
      retry.retry_at,
      ...leaseValues(lease),
    )
    .first());
}

async function clearPending(
  db: D1Database,
  userId: string,
  sources: ReviewSnapshot[],
  lease: ReviewLease,
) {
  if (!sources.length) return;
  await db.batch(
    sources.slice(0, 1).map((s) =>
      db
        .prepare(`DELETE FROM memory_review_pending
    WHERE memory_id = ? AND user_id = ? AND (${snapshotSelect}) = ? AND ${currentReviewLeaseSql}`)
        .bind(
          s.source.id,
          userId,
          s.source.id,
          userId,
          s.stamp,
          ...leaseValues(lease),
        ),
    ),
  );
}

/** Take the account's review lock for five minutes, or null when a pass holds it. */
async function acquireReviewLock(
  db: D1Database,
  userId: string,
  overnight: boolean,
): Promise<string | null> {
  const lock = crypto.randomUUID();
  const acquired = await db
    .prepare(`UPDATE memory_review_settings SET lock_token = ?, lock_until = unixepoch() + 300
    WHERE user_id = ? AND lock_until <= unixepoch() AND enabled = 1 AND (? = 0 OR overnight = 1)
    AND ${reviewAccountAdmittedSql} RETURNING user_id`)
    .bind(lock, userId, +overnight)
    .first();
  return acquired ? lock : null;
}

async function releaseReviewLock(db: D1Database, userId: string, lock: string) {
  await db
    .prepare(
      "UPDATE memory_review_settings SET lock_token = NULL, lock_until = 0 WHERE user_id = ? AND lock_token = ?",
    )
    .bind(userId, lock)
    .run();
}

/**
 * Reserve one call's attempt and money BEFORE inference, including failures,
 * against the person's count and the admin's cap. False when either refuses.
 */
async function reserveReviewCall(
  db: D1Database,
  userId: string,
  lock: string,
  model: ReviewModel,
  overnight: boolean,
  reserved: number,
): Promise<boolean> {
  const reservation = db
    .prepare(`INSERT INTO memory_review_budgets(user_id, day, calls, reserved_microusd, manual_calls, upkeep_calls)
    SELECT user_id, ?, 1, ?, 1 - ?, ? FROM memory_review_settings WHERE user_id = ? AND enabled = 1
    AND lock_token = ? AND lock_until > unixepoch() AND model = ? AND (? = 0 OR overnight = 1)
    AND ${reviewAccountAdmittedSql} AND ? <= ${reviewCapSql("memory_review_settings.user_id")}
    ON CONFLICT(user_id, day) DO UPDATE SET calls = calls + 1,
    reserved_microusd = reserved_microusd + excluded.reserved_microusd,
    manual_calls = manual_calls + excluded.manual_calls, upkeep_calls = upkeep_calls + excluded.upkeep_calls
    WHERE (CASE WHEN ? = 1 THEN upkeep_calls ELSE manual_calls END)
      < (SELECT CASE WHEN ? = 1 THEN upkeep_memories ELSE manual_memories END FROM memory_review_settings WHERE user_id = excluded.user_id)
    AND reserved_microusd + excluded.reserved_microusd <= ${reviewCapSql("excluded.user_id")} RETURNING calls`)
    .bind(
      Math.floor(nowSeconds() / 86400),
      reserved,
      +overnight,
      +overnight,
      userId,
      lock,
      model,
      +overnight,
      reserved,
      +overnight,
      +overnight,
    );
  // The spend row applies only when the reservation did: a refusal costs nothing.
  const [granted] = await db.batch<{ calls: number }>([
    reservation,
    spendStatement(
      db,
      userId,
      "memory_review",
      { units: 1, microusd: reserved },
      { afterWrite: true },
    ),
  ]);
  return granted.results.length > 0;
}

type Draft = (model: ReviewModel, input: string) => Promise<unknown>;
export type ReviewPassReport = {
  scanned: number;
  calls: number;
  /** Results left for the person to decide: questions. */
  proposed: number;
  /** Additive results applied without asking (nightly upkeep). */
  applied: number;
  skipped: number;
  failed: number;
  stopped: string | null;
};

/** One incremental page, up to two calls. A persisted lock serializes manual and scheduled passes.
 * The injected drafter is used by tests only; production uses the explicitly saved provider/model.
 * `anchor` is a person's "check this memory now": it replaces the queue windows and the due retry
 * with that one starting memory, under the same consent, lock, budget and pair coverage. */
export async function runMemoryReview(
  env: ReviewEnv,
  userId: string,
  draft?: Draft,
  overnight = false,
  anchor?: string,
): Promise<ReviewPassReport> {
  const report: ReviewPassReport = {
    scanned: 0,
    calls: 0,
    proposed: 0,
    applied: 0,
    skipped: 0,
    failed: 0,
    stopped: null,
  };
  if (!(await accountAdmitted(env.DB, userId)))
    return { ...report, stopped: "account not admitted" };
  let settings = await readReviewSettings(env.DB, userId);
  if (!settings.enabled || (overnight && !settings.overnight))
    return { ...report, stopped: "off" };
  if (!draft && !reviewProviderAvailable(env, settings.model))
    return { ...report, stopped: reviewProviderUnavailable(settings.model) };
  const lock = await acquireReviewLock(env.DB, userId, overnight);
  if (!lock) return { ...report, stopped: "already running" };
  const lease: ReviewLease = { userId, token: lock, overnight };
  const infer =
    draft ?? ((model, input) => draftMemoryReview(env, model, input));
  try {
    // A crashed call counts against the budget. At most one retry, delayed an hour;
    // running attempts become retryable after the five-minute lock and a longer safety margin.
    const retry = anchor
      ? null
      : await env.DB.prepare(`SELECT * FROM memory_review_groups WHERE user_id = ?
      AND state IN ('failed', 'running') AND attempts < 2 AND retry_at <= unixepoch() ORDER BY retry_at, group_id LIMIT 1`)
          .bind(userId)
          .first<ReviewGroup>();
    // Recent and oldest bounded windows prevent a daily corpus walk. Frequency only prioritizes
    // this small eligible window; it never establishes authority or creates new eligibility.
    const pending = anchor
      ? { results: [{ memory_id: anchor }] }
      : await env.DB.prepare(`WITH oldest AS (
      SELECT memory_id, enqueued_at FROM memory_review_pending WHERE user_id = ? ORDER BY enqueued_at, memory_id LIMIT 8
    ), recent AS (
      SELECT memory_id, enqueued_at FROM memory_review_pending WHERE user_id = ? ORDER BY enqueued_at DESC, memory_id DESC LIMIT 8
    ), eligible AS (SELECT * FROM oldest UNION SELECT * FROM recent), calls AS (
      SELECT target_id, tool, outcome FROM mcp_calls WHERE user_id = ? ORDER BY at DESC LIMIT 100
    ), uses AS (SELECT target_id, COUNT(*) AS n FROM calls WHERE tool = 'fetch' AND outcome = 'ok' GROUP BY target_id)
      SELECT e.memory_id FROM eligible e LEFT JOIN uses u ON u.target_id = 'memory:' || e.memory_id
      ORDER BY COALESCE(u.n, 0) DESC, e.enqueued_at, e.memory_id LIMIT ?`)
          .bind(userId, userId, userId, MAX_ANCHORS)
          .all<{ memory_id: string }>();
    const handled = new Set<string>();
    let rankedAnchors = 0;
    let completedRankingRevision: number | null = null;
    async function* candidates(): AsyncGenerator<{
      sources: ReviewSnapshot[];
      retry?: ReviewGroup;
    }> {
      if (retry) {
        const sources = JSON.parse(retry.sources_json) as ReviewSnapshot[];
        if (await snapshotsCurrent(env.DB, userId, sources))
          yield { sources, retry };
        else if (
          !(await cancelReviewRetry(env.DB, lease, retry, "sources-changed"))
        ) {
          report.stopped = "admission lost";
          return;
        }
      }
      for (const row of pending.results) {
        if (report.calls >= MAX_CALLS_PER_PASS) {
          report.stopped = "pass limit";
          return;
        }
        if (handled.has(row.memory_id)) continue;
        report.scanned++;
        const anchor = await reviewSnapshot(env.DB, userId, row.memory_id);
        if (!anchor) {
          await env.DB.prepare(
            `DELETE FROM memory_review_pending WHERE memory_id = ? AND user_id = ?
            AND NOT EXISTS (SELECT 1 FROM memories WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL)
            AND ${currentReviewLeaseSql}`,
          )
            .bind(
              row.memory_id,
              userId,
              row.memory_id,
              userId,
              ...leaseValues(lease),
            )
            .run();
          continue;
        }
        if (humanSuperseded(anchor)) {
          await clearPending(env.DB, userId, [anchor], lease);
          report.skipped++;
          continue;
        }
        settings = await readReviewSettings(env.DB, userId);
        const ranking = await readRankingSettings(env.DB, userId);
        const budget = await reviewBudget(env.DB, userId);
        const caps = await readReviewCaps(env.DB, userId);
        const memories = overnight
          ? settings.upkeepMemories
          : settings.manualMemories;
        if (!settings.enabled || (overnight && !settings.overnight)) {
          report.stopped = "off";
          return;
        }
        if (
          (overnight ? budget.upkeep_calls : budget.manual_calls) >= memories
        ) {
          report.stopped = "daily budget";
          return;
        }
        // Ranking spends before the model call; stop first if that call could not be afforded.
        if (
          ranking.enabled &&
          budget.reserved_microusd + reviewMaxCallMicrousd(settings.model) >
            caps.reviewMicrousd
        ) {
          report.stopped = "cost limit";
          return;
        }
        if (ranking.enabled && rankedAnchors >= 2) {
          report.stopped = "ranking pass limit";
          return;
        }
        const authorize = rankingAuthorization(
          env.DB,
          lease,
          ranking,
          settings.model,
        );
        let vectorIds: string[] = [];
        if (ranking.enabled) {
          if (ranking.destination !== REVIEW_RANK_DESTINATION) {
            report.stopped =
              "Ranking permission needs renewal for the current destination.";
            return;
          }
          // One anchor needs an embedding and a Jev request. Starting with one
          // left would spend it on the embedding and leave Jev unfunded.
          const spent = await rankingBudget(env.DB, userId);
          if (
            (overnight ? spent.upkeep_requests : spent.manual_requests) +
              RANKING_REQUESTS_PER_MEMORY >
            RANKING_REQUESTS_PER_MEMORY * memories
          ) {
            report.stopped = await rankingStopped(
              env.DB,
              userId,
              new ReviewRankingError("ranking-daily-limit"),
              "embedding",
            );
            return;
          }
          rankedAnchors++;
          try {
            vectorIds = (
              await reviewVectors(env, userId, anchor, authorize)
            ).map((p) => p.conceptId);
          } catch (error) {
            report.stopped = await rankingStopped(
              env.DB,
              userId,
              error,
              "embedding",
            );
            return;
          }
        }
        const query = anchor.source.title || anchor.source.body.slice(0, 200);
        const scope = {
          userId,
          query,
          concepts: ["memory" as const],
          project: anchor.source.project ?? undefined,
          limit: 50,
        };
        // The anchor always matches its own title, so the every-term pass is
        // never empty; ask for any term when it found nothing else.
        let hits = (await search(env, scope)).filter(
          (h) => h.conceptId !== anchor.source.id,
        );
        if (!hits.length)
          hits = (await search(env, { ...scope, match: "any" })).filter(
            (h) => h.conceptId !== anchor.source.id,
          );
        const linked =
          await env.DB.prepare(`SELECT other.memory_id FROM memory_links l JOIN memories other ON other.memory_id =
        CASE WHEN l.from_memory_id = ? THEN l.to_memory_id ELSE l.from_memory_id END
        WHERE (l.from_memory_id = ? OR l.to_memory_id = ?) AND l.removed_at IS NULL AND other.user_id = ?
        AND other.deleted_at IS NULL ORDER BY l.created_at DESC, l.link_id LIMIT 3`)
            .bind(anchor.source.id, anchor.source.id, anchor.source.id, userId)
            .all<{ memory_id: string }>();
        const sources: ReviewSnapshot[] = [
          {
            ...anchor,
            selection: { via: "starting-memory", anchorId: anchor.source.id },
          },
        ];
        const pool: ReviewSnapshot[] = [];
        for (const { id, via } of [
          ...linked.results.map((r) => ({
            id: r.memory_id,
            via: "existing-link" as const,
          })),
          ...hits.map((h) => ({
            id: h.conceptId,
            via: "keyword-match" as const,
          })),
          ...vectorIds.map((id) => ({ id, via: "vector-match" as const })),
          // No same-project filler (2026-11-08): recent memories that only
          // share a project made most no-change results. A memory with no
          // linked, matching or ranked neighbour is recorded without a call.
        ]) {
          if (pool.length === 100) break;
          if (
            sources.some((s) => s.source.id === id) ||
            pool.some((s) => s.source.id === id)
          )
            continue;
          const neighbor = await reviewSnapshot(env.DB, userId, id);
          if (
            neighbor &&
            !humanSuperseded(neighbor) &&
            bytes(REVIEW_SYSTEM + modelInput([...sources, neighbor])) <=
              REVIEW_INPUT_BYTES
          )
            pool.push({
              ...neighbor,
              selection: { via, anchorId: anchor.source.id },
            });
        }
        const covered = await reviewedPairs(
          env.DB,
          userId,
          [anchor, ...pool],
          settings.model,
        );
        const available = pool.filter(
          (s) =>
            !covered.has(reviewPairKey(anchor.source.id, s.source.id)) &&
            !summarizes(anchor, s),
        );
        const addSources = (neighbors: ReviewSnapshot[]) => {
          for (const neighbor of neighbors) {
            if (sources.length === 4) break;
            if (
              !sources.some(
                (s) =>
                  covered.has(reviewPairKey(s.source.id, neighbor.source.id)) ||
                  summarizes(s, neighbor),
              ) &&
              bytes(REVIEW_SYSTEM + modelInput([...sources, neighbor])) <=
                REVIEW_INPUT_BYTES
            )
              sources.push(neighbor);
          }
        };
        if (ranking.enabled) {
          try {
            const ranked = await rankReviewSources(
              env,
              anchor,
              available,
              authorize,
            );
            sources[0].selection!.ranking = {
              ...ranked.trace,
              revision: ranking.revision,
            };
            addSources(ranked.sources);
          } catch (error) {
            report.stopped = await rankingStopped(
              env.DB,
              userId,
              error,
              "ranking",
            );
            return;
          }
        } else addSources(available);
        if (
          sources.length === 1 &&
          (await sourceWasReviewed(env.DB, userId, anchor, settings.model))
        ) {
          await clearPending(env.DB, userId, [anchor], lease);
          report.skipped++;
          continue;
        }
        for (const s of sources) handled.add(s.source.id);
        yield { sources };
      }
    }
    for await (const candidate of candidates()) {
      settings = await readReviewSettings(env.DB, userId);
      if (!settings.enabled || (overnight && !settings.overnight)) {
        report.stopped = "off";
        break;
      }
      if (!draft && !reviewProviderAvailable(env, settings.model)) {
        report.stopped = reviewProviderUnavailable(settings.model);
        break;
      }
      if (report.calls >= MAX_CALLS_PER_PASS) {
        report.stopped = "pass limit";
        break;
      }
      if (!(await accountAdmitted(env.DB, userId))) {
        report.stopped = "account not admitted";
        break;
      }
      const { sources } = candidate;
      const input = modelInput(sources);
      const key = await fingerprint(sources, settings.model);
      const existing = await env.DB.prepare(
        "SELECT * FROM memory_review_groups WHERE user_id = ? AND fingerprint = ?",
      )
        .bind(userId, key)
        .first<ReviewGroup>();
      // Every terminal decision (even noop or dismissed) is coverage, never a new prompt.
      if (
        existing &&
        (!candidate.retry ||
          existing.group_id !== candidate.retry.group_id ||
          existing.attempts >= 2 ||
          existing.state !== candidate.retry.state ||
          existing.attempts !== candidate.retry.attempts ||
          existing.retry_at !== candidate.retry.retry_at)
      ) {
        await clearPending(env.DB, userId, sources, lease);
        report.skipped++;
        continue;
      }
      if (
        candidate.retry &&
        (candidate.retry.model !== settings.model ||
          candidate.retry.prompt_version !== REVIEW_PROMPT_VERSION)
      ) {
        if (
          !(await cancelReviewRetry(
            env.DB,
            lease,
            candidate.retry,
            "selection-changed",
          ))
        ) {
          report.stopped = "admission lost";
          break;
        }
        continue;
      }
      const localNoop =
        sources.length < 2 || bytes(REVIEW_SYSTEM + input) > REVIEW_INPUT_BYTES;
      if (!localNoop) {
        const reserved = reviewReservation(settings.model, input);
        if (
          !(await reserveReviewCall(
            env.DB,
            userId,
            lock,
            settings.model,
            overnight,
            reserved,
          ))
        ) {
          report.stopped = !(await accountAdmitted(env.DB, userId))
            ? "account not admitted"
            : await budgetStop(env.DB, userId, overnight, reserved);
          break;
        }
      }
      const admitted = await admitReviewGroup(
        env.DB,
        lease,
        settings.model,
        key,
        sources,
        candidate.retry,
      );
      if (!admitted) {
        report.stopped = "admission lost";
        break;
      }
      if (!localNoop) {
        const deadline = await beginReviewInference(
          env.DB,
          lease,
          settings.model,
          admitted,
        );
        // Check response delay on this frame, with no await between validation
        // and launching the already-authorized bounded provider request below.
        if (deadline === null || deadline <= nowSeconds() + 30) {
          report.stopped = "admission lost";
          break;
        }
      }
      const { group_id: id, attempts: attempt } = admitted;
      if (!localNoop) report.calls++;
      try {
        const proposal = localNoop
          ? {
              kind: "noop" as const,
              title: "",
              body: "",
              why:
                sources.length < 2
                  ? "No related source in the bounded candidate window."
                  : "Source exceeds the review byte budget; review it manually.",
              evidence: [],
            }
          : validateReviewProposal(await infer(settings.model, input), sources);
        const completed =
          await env.DB.prepare(`UPDATE memory_review_groups SET state = ?, proposal_json = ?, draft_title = ?, draft_body = ?, error = NULL, updated_at = unixepoch()
          WHERE group_id = ? AND user_id = ? AND attempts = ? AND state = 'running' AND ${currentReviewOwnerSql} RETURNING group_id`)
            .bind(
              proposal.kind === "noop" ? "noop" : "proposal",
              JSON.stringify(proposal),
              proposal.title,
              proposal.body,
              id,
              userId,
              attempt,
              ...ownerValues(lease),
            )
            .first();
        if (!completed) {
          report.stopped = "admission lost";
          break;
        }
        if (!localNoop && sources[0].selection?.ranking)
          completedRankingRevision =
            sources[0].selection.ranking.revision ?? null;
        await clearPending(env.DB, userId, sources, lease);
        if (proposal.kind === "noop") report.skipped++;
        else if (
          settings.autoApply &&
          AUTO_APPLY_KINDS.includes(proposal.kind) &&
          (await applyAutomatically(env, userId, id, proposal))
        )
          report.applied++;
        else report.proposed++;
      } catch (error) {
        // No provider text, private input or credentials in logs/errors. A failed call is not refunded.
        const failed =
          await env.DB.prepare(`UPDATE memory_review_groups SET state = 'failed', error = ?, retry_at = unixepoch() + 3600, updated_at = unixepoch()
          WHERE group_id = ? AND user_id = ? AND attempts = ? AND state = 'running' AND ${currentReviewOwnerSql} RETURNING group_id`)
            .bind(
              reviewFailureCode(error),
              id,
              userId,
              attempt,
              ...ownerValues(lease),
            )
            .first();
        if (!failed) {
          report.stopped = "admission lost";
          break;
        }
        await clearPending(env.DB, userId, sources, lease);
        report.failed++;
      }
    }
    if (!overnight && completedRankingRevision !== null)
      await env.DB.prepare(
        `UPDATE memory_review_ranking SET manual_model=? WHERE user_id=? AND enabled=1 AND revision=? AND destination=? AND EXISTS(SELECT 1 FROM memory_review_settings s WHERE s.user_id=? AND s.lock_token=? AND s.lock_until>unixepoch() AND s.model=?)`,
      )
        .bind(
          settings.model,
          userId,
          completedRankingRevision,
          REVIEW_RANK_DESTINATION,
          userId,
          lock,
          settings.model,
        )
        .run();
    return report;
  } finally {
    await releaseReviewLock(env.DB, userId, lock);
  }
}

async function snapshotsCurrent(
  db: D1Database,
  userId: string,
  sources: ReviewSnapshot[],
): Promise<boolean> {
  for (const s of sources)
    if ((await reviewSnapshot(db, userId, s.source.id))?.stamp !== s.stamp)
      return false;
  return true;
}

function eventStatement(
  db: D1Database,
  userId: string,
  id: string,
  kind: string,
  value: string | null,
) {
  return db
    .prepare(
      `INSERT INTO memory_review_events(event_id, user_id, group_id, kind, value, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(`mre_${crypto.randomUUID()}`, userId, id, kind, value, nowSeconds());
}

/** Draft edits change one proposal field only; immutable model output and append-only decisions remain. */
export async function editReviewDraft(
  db: D1Database,
  userId: string,
  id: string,
  field: "title" | "body",
  value: string,
  was: string,
): Promise<void> {
  const parsed = z
    .string()
    .trim()
    .min(1)
    .max(field === "title" ? 500 : 8000)
    .parse(value);
  const group = await getReviewGroup(db, userId, id);
  if (!group || group.state !== "proposal")
    throw new MemoryReviewError("No editable proposal exists.");
  const column = field === "title" ? "draft_title" : "draft_body";
  // NOT NULL fingerprint is an intentional transaction-aborting optimistic guard.
  await guardedBatch(db, [
    db
      .prepare(`UPDATE memory_review_groups SET
    fingerprint = CASE WHEN state = 'proposal' AND ${column} IS ? THEN fingerprint ELSE NULL END,
    ${column} = ?, updated_at = ? WHERE group_id = ? AND user_id = ?`)
      .bind(was, parsed, nowSeconds(), id, userId),
    eventStatement(db, userId, id, `edit-${field}`, parsed),
  ]);
}

export async function dismissReview(
  db: D1Database,
  userId: string,
  id: string,
  reopen = false,
): Promise<void> {
  const group = await getReviewGroup(db, userId, id);
  if (!group || !["proposal", "dismissed"].includes(group.state))
    throw new MemoryReviewError("No proposal exists.");
  const state = reopen ? "proposal" : "dismissed";
  if (group.state === state) return;
  await guardedBatch(db, [
    db
      .prepare(`UPDATE memory_review_groups SET fingerprint = CASE WHEN state = ? THEN fingerprint ELSE NULL END,
    state = ?, updated_at = ? WHERE group_id = ? AND user_id = ?`)
      .bind(reopen ? "dismissed" : "proposal", state, nowSeconds(), id, userId),
    eventStatement(db, userId, id, reopen ? "reopen" : "dismiss", null),
  ]);
}

async function guardedBatch(db: D1Database, statements: D1PreparedStatement[]) {
  try {
    await memoryLinkBatch(db, statements);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes(
        "NOT NULL constraint failed: memory_review_groups.fingerprint",
      )
    )
      throw new MemoryReviewError(
        "The proposal or its sources changed. Reload and review the current evidence.",
      );
    throw error;
  }
}

export type ReviewAcceptance = {
  /** Nightly upkeep, not a person: model-asserted links, applied_by 'auto', guarded by auto_apply. */
  automatic?: boolean;
  supersede?: boolean;
  retainedTruth?: boolean;
  draftTitle: string;
  draftBody: string;
  subject?: {
    id?: string;
    name?: string;
    members: string[];
    setSummary: boolean;
    expectedSummary: string | null;
  };
};
/** Only called by authenticated same-origin console actions. No MCP assertion can impersonate this judgment. */
export async function acceptMemoryReview(
  env: ReviewEnv,
  id: string,
  input: ReviewAcceptance,
  provenance: Provenance,
): Promise<string | null> {
  const userId = provenance.userId;
  const group = await getReviewGroup(env.DB, userId, id);
  if (!group) throw new MemoryReviewError("No proposal exists.");
  if (group.state === "accepted") return group.result_memory_id;
  if (group.state !== "proposal" || !group.proposal_json)
    throw new MemoryReviewError("No pending proposal exists.");
  const sources = JSON.parse(group.sources_json) as ReviewSnapshot[];
  const proposal = validateReviewProposal(
    JSON.parse(group.proposal_json),
    sources,
  );
  const contributing = sources.filter((s) =>
    proposal.evidence.some((e) => e.id === s.source.id),
  );
  if (proposal.kind === "noop")
    throw new MemoryReviewError("A no-op cannot be accepted.");
  if (
    input.automatic &&
    (input.supersede ||
      input.subject ||
      !AUTO_APPLY_KINDS.includes(proposal.kind))
  )
    throw new MemoryReviewError(
      "Only an additive summary can be applied without a person.",
    );
  if (
    input.supersede &&
    (proposal.kind !== "consolidation" || !input.retainedTruth)
  )
    throw new MemoryReviewError(
      "Supersession needs a consolidation and your explicit judgment that all retained truth is present.",
    );
  if (!(await snapshotsCurrent(env.DB, userId, sources)))
    throw new MemoryReviewError(
      "A source revision changed. Run another review before accepting.",
    );
  if (proposal.kind === "contradiction") {
    const [a, b] = contributing.map((s) => s.source.id).sort();
    const removed =
      await env.DB.prepare(`SELECT 1 FROM memory_links WHERE from_memory_id = ? AND to_memory_id = ?
      AND kind = 'contradicts' AND removed_at IS NOT NULL`)
        .bind(a, b)
        .first();
    if (removed)
      throw new MemoryReviewError(
        "This contradiction link was removed. Restore it explicitly in Memories before confirming it here.",
      );
  }
  const newId =
    proposal.kind === "contradiction" ? null : `mem_${crypto.randomUUID()}`;
  const now = nowSeconds();
  const subject = input.subject;
  let subjectId: string | null = null;
  if (subject) {
    if (!newId)
      throw new MemoryReviewError(
        "A conflict cannot nominate a summary or create a subject here.",
      );
    if (
      !subject.members.length ||
      new Set(subject.members).size !== subject.members.length ||
      subject.members.some((id) => !sources.some((s) => s.source.id === id))
    )
      throw new MemoryReviewError(
        "Choose one or more compared sources as subject members.",
      );
    if (subject.id) {
      const target = await env.DB.prepare(
        "SELECT summary_memory_id FROM memory_subjects WHERE subject_id=? AND user_id=? AND deleted_at IS NULL",
      )
        .bind(subject.id, userId)
        .first<{ summary_memory_id: string | null }>();
      if (
        !target ||
        (subject.setSummary &&
          target.summary_memory_id !== subject.expectedSummary)
      )
        throw new MemoryReviewError(
          "The subject or its current summary changed. Reload before organizing.",
        );
      if (!subject.setSummary)
        subject.expectedSummary = target.summary_memory_id;
      if (
        !subject.setSummary &&
        subject.members.includes(target.summary_memory_id ?? "")
      )
        throw new MemoryReviewError(
          "A subject summary cannot also be its source member.",
        );
      subjectId = subject.id;
    } else {
      const name = z.string().trim().min(1).max(200).parse(subject.name);
      if (await findSubjectByName(env.DB, userId, name))
        throw new MemoryReviewError(
          `A subject named "${name}" already exists. Choose it as the existing subject instead.`,
        );
      subjectId = `sub_${crypto.randomUUID()}`;
    }
  }
  const subjectGuard = subject?.id
    ? "AND EXISTS(SELECT 1 FROM memory_subjects WHERE subject_id=? AND user_id=? AND deleted_at IS NULL AND summary_memory_id IS ?)"
    : "";
  // An automatic application must still hold the person's consent when it writes.
  const autoGuard = input.automatic
    ? "AND EXISTS(SELECT 1 FROM memory_review_settings WHERE user_id=? AND enabled=1 AND auto_apply=1)"
    : "";
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(`UPDATE memory_review_groups SET
     fingerprint = CASE WHEN state = 'proposal' AND draft_title IS ? AND draft_body IS ? AND ${sources.map(() => `(${snapshotSelect}) = ?`).join(" AND ")} ${subjectGuard} ${autoGuard}
      THEN fingerprint ELSE NULL END, state = 'accepted', result_memory_id = ?, applied_by = ?, updated_at = ? WHERE group_id = ? AND user_id = ?`).bind(
      input.draftTitle,
      input.draftBody,
      ...sources.flatMap((s) => [s.source.id, userId, s.stamp]),
      ...(subject?.id ? [subject.id, userId, subject.expectedSummary] : []),
      ...(input.automatic ? [userId] : []),
      newId,
      input.automatic ? "auto" : "person",
      now,
      id,
      userId,
    ),
  ];
  if (subject && !subject.id)
    statements.push(
      env.DB.prepare(
        // A same-name subject created since the check inserts nothing here,
        // and the membership rows then fail their foreign key, refusing the batch.
        `INSERT INTO memory_subjects(subject_id,user_id,name,kind,description,created_at,updated_at) SELECT ?,?,?,'topic','',?,? WHERE ${NAME_FREE}`,
      ).bind(
        subjectId,
        userId,
        subject.name!.trim(),
        now,
        now,
        userId,
        subject.name!.trim(),
        subjectId,
      ),
    );
  if (newId) {
    const attribution = contributing
      .map(
        ({ source: s, fingerprint: f }) =>
          `- memory:${s.id} (revision ${s.revision}, SHA-256 ${f}; ${s.agent}, ${s.client}${s.session ? `, ${s.session}` : ""}${s.sessionName ? `; session label ${s.sessionName}` : ""})`,
      )
      .join("\n");
    const body = `${group.draft_body}\n\n## Source evidence\n\n${attribution}\n\n${input.automatic ? `Applied automatically by nightly memory upkeep; no person checked it. ${proposal.kind}` : `Human-approved ${proposal.kind}`}; model ${group.model}; prompt ${group.prompt_version}; review ${id}. Originals and their histories are retained.`;
    if (body.length > 16 * 1024)
      throw new MemoryReviewError(
        "Draft and attribution exceed the memory size limit. Shorten the draft before accepting.",
      );
    const project = sources.every(
      (s) => s.source.project === sources[0].source.project,
    )
      ? sources[0].source.project
      : null;
    statements.push(
      env.DB.prepare(`INSERT INTO memories(memory_id, user_id, memory_type, title, body, tags_json, project,
      source_agent, source_client, source_session, source_session_name, created_at, updated_at) VALUES (?, ?, 'reference', ?, ?, '["rollup"]', ?, ?, ?, ?, ?, ?, ?)`).bind(
        newId,
        userId,
        group.draft_title,
        body,
        project,
        provenance.agent,
        provenance.client,
        provenance.session,
        provenance.sessionName ?? null,
        now,
        now,
      ),
    );
    statements.push(
      ...(await memoryLinkStatements(
        env.DB,
        newId,
        contributing.map((s) => ({
          id: `memory:${s.source.id}`,
          kind: input.supersede
            ? ("supersedes" as const)
            : ("related" as const),
        })),
        provenance,
        input.automatic ? { kind: "model" } : { kind: "person", userId },
      )),
    );
    statements.push(...memoryProjectionStatements(env.DB, newId, env));
  } else {
    statements.push(
      ...(await memoryLinkStatements(
        env.DB,
        contributing[0].source.id,
        [{ id: `memory:${contributing[1].source.id}`, kind: "contradicts" }],
        provenance,
        { kind: "person", userId },
      )),
    );
  }
  for (const s of sources)
    statements.push(...memoryProjectionStatements(env.DB, s.source.id, env));
  if (subject && subjectId) {
    if (subject.setSummary)
      statements.push(
        env.DB.prepare(
          "UPDATE memory_subjects SET summary_memory_id=?,updated_at=? WHERE subject_id=? AND user_id=?",
        ).bind(newId, now, subjectId, userId),
      );
    for (const memoryId of subject.members)
      statements.push(
        env.DB.prepare(`INSERT INTO memory_subject_members(subject_id,memory_id,asserted_by,confirmed_at,confirmed_by,created_at)
      VALUES(?,?,'person',?,?,?) ON CONFLICT(subject_id,memory_id) DO UPDATE SET removed_at=NULL,removed_by=NULL,confirmed_at=excluded.confirmed_at,confirmed_by=excluded.confirmed_by`).bind(
          subjectId,
          memoryId,
          now,
          userId,
          now,
        ),
      );
  }
  statements.push(
    eventStatement(
      env.DB,
      userId,
      id,
      "accept",
      JSON.stringify({
        result: newId,
        ...(input.automatic ? { automatic: true } : {}),
        supersede: !!input.supersede,
        retainedTruth: !!input.retainedTruth,
        ...(subjectId
          ? {
              subject: subjectId,
              members: subject?.members,
              currentSummary: subject?.setSummary,
            }
          : {}),
      }),
    ),
  );
  // Approval's own links are not new evidence for another overnight call. Later real edits enqueue again.
  statements.push(
    env.DB.prepare(
      `DELETE FROM memory_review_pending WHERE user_id = ? AND memory_id IN (${[...sources.map(() => "?"), ...(newId ? ["?"] : [])].join(",")})`,
    ).bind(
      userId,
      ...sources.map((s) => s.source.id),
      ...(newId ? [newId] : []),
    ),
  );
  await guardedBatch(env.DB, statements);
  return newId;
}

/** Nightly upkeep's own identity on the memories it writes: not a person and not an MCP client. */
export type LessonPassReport = {
  calls: number;
  written: number;
  failed: number;
  stopped: string | null;
};
type LessonDraft = (
  model: ReviewModel,
  input: string,
  system: string,
) => Promise<unknown>;

type NightlyReport = { calls: number; failed: number; stopped: string | null };
type NightlyCall = {
  settings: ReviewSettings;
  lease: ReviewLease;
  /**
   * Reserve one nightly call, check the lock outlives it, then send. Undefined
   * when it was refused or failed; `report.stopped` then says why. A failed
   * call is not refunded.
   */
  send(input: string, system: string): Promise<unknown>;
};

/**
 * The consent, lock, count and cost cap every nightly call besides review
 * itself shares (lesson lines and reflection, J-E). Nightly only.
 */
async function withNightlyCall<R extends NightlyReport>(
  env: ReviewEnv,
  userId: string,
  draft: LessonDraft | undefined,
  report: R,
  body: (call: NightlyCall) => Promise<void>,
): Promise<R> {
  if (!(await accountAdmitted(env.DB, userId)))
    return { ...report, stopped: "account not admitted" };
  const settings = await readReviewSettings(env.DB, userId);
  if (!settings.enabled || !settings.overnight)
    return { ...report, stopped: "off" };
  if (!draft && !reviewProviderAvailable(env, settings.model))
    return { ...report, stopped: reviewProviderUnavailable(settings.model) };
  const lock = await acquireReviewLock(env.DB, userId, true);
  if (!lock) return { ...report, stopped: "already running" };
  const lease: ReviewLease = { userId, token: lock, overnight: true };
  const infer: LessonDraft =
    draft ??
    ((model, input, system) => draftMemoryReview(env, model, input, system));
  const send = async (input: string, system: string) => {
    const reserved = reviewReservation(settings.model, input, system);
    if (
      !(await reserveReviewCall(
        env.DB,
        userId,
        lock,
        settings.model,
        true,
        reserved,
      ))
    ) {
      report.stopped = !(await accountAdmitted(env.DB, userId))
        ? "account not admitted"
        : await budgetStop(env.DB, userId, true, reserved);
      return undefined;
    }
    // A delayed reservation is not permission to send: the lock must outlive the call.
    const live = await env.DB.prepare(
      `SELECT 1 FROM memory_review_settings WHERE user_id = ? AND lock_token = ? AND model = ?
      AND lock_until > unixepoch() + 30 AND enabled = 1 AND overnight = 1`,
    )
      .bind(userId, lock, settings.model)
      .first();
    if (!live) {
      report.stopped = "admission lost";
      return undefined;
    }
    report.calls++;
    try {
      return await infer(settings.model, input, system);
    } catch (error) {
      failed(report, error);
      return undefined;
    }
  };
  try {
    await body({ settings, lease, send });
    return report;
  } finally {
    await releaseReviewLock(env.DB, userId, lock);
  }
}

/** The code only: never provider text or memory content. */
function failed(report: NightlyReport, error: unknown) {
  report.failed++;
  report.stopped = reviewFailureCode(error);
  console.error("memory nightly call failed", { code: report.stopped });
}

/**
 * One lesson-line call (J-E; ADR-0012 amendment of 2026-11-08): up to sixteen
 * memories whose current revision has no line, sent to the person's chosen
 * review model under the same nightly consent, lock, count and cost cap as a
 * review call. Nightly only. `stopped` is null when the call ran or nothing
 * was left; `calls` is 0 in the second case. A failed call is not refunded and
 * ends tonight's lesson lines, so one bad batch cannot spend the night.
 */
export async function runLessonPass(
  env: ReviewEnv,
  userId: string,
  draft?: LessonDraft,
): Promise<LessonPassReport> {
  const report: LessonPassReport = {
    calls: 0,
    written: 0,
    failed: 0,
    stopped: null,
  };
  return withNightlyCall(env, userId, draft, report, async (call) => {
    const batch = fitLessonBatch(await lessonCandidates(env.DB, userId));
    if (!batch.length) return;
    const value = await call.send(lessonInput(batch), LESSON_SYSTEM);
    if (value === undefined) return;
    let lines: ReturnType<typeof validateLessons>;
    try {
      lines = validateLessons(value, batch);
    } catch (error) {
      failed(report, error);
      return;
    }
    const results = await env.DB.batch(
      lessonStatements(
        env.DB,
        userId,
        batch,
        lines,
        call.settings.model,
        currentReviewLeaseSql,
        leaseValues(call.lease),
      ),
    );
    report.written = results.reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  });
}

export type ReflectionStepReport = NightlyReport & {
  proposed: number;
  /** True while the due reflection has a step left for the next minute. */
  more: boolean;
};

/**
 * One step of the weekly reflection (J-E): the cluster call when the due
 * reflection has none yet, otherwise one mechanism's draft call. One call a
 * step, under the same nightly consent, lock, count and cost cap as lesson
 * lines. A failed call ends the reflection, so one bad answer cannot spend
 * the week's calls; a spent count or cap leaves it for the next night.
 */
export async function runReflectionStep(
  env: ReviewEnv,
  userId: string,
  draft?: LessonDraft,
): Promise<ReflectionStepReport> {
  const report: ReflectionStepReport = {
    calls: 0,
    failed: 0,
    stopped: null,
    proposed: 0,
    more: false,
  };
  return withNightlyCall(env, userId, draft, report, async (call) => {
    const now = nowSeconds();
    const reflection = await dueReflection(env.DB, userId, now);
    if (!reflection) return;
    let state = parseReflectionState(reflection.state_json);
    let ended: string | null = null;
    const statements: D1PreparedStatement[] = [];
    if (!state) {
      const { input, sent } = clusterInput(
        await knownRules(env.DB, userId),
        await reflectionLines(env.DB, userId, reflection.since),
      );
      if (sent.length < EVIDENCE_RULE.memories) ended = "nothing";
      else {
        const value = await call.send(input, CLUSTER_SYSTEM);
        if (value !== undefined)
          try {
            state = { mechanisms: validateCluster(value, sent), next: 0 };
          } catch (error) {
            failed(report, error);
          }
      }
    } else if (state.next < state.mechanisms.length) {
      const mechanism = state.mechanisms[state.next];
      const lines = draftCandidates(
        mechanism,
        await reflectionLines(env.DB, userId),
      );
      const meta = await candidateMeta(
        env.DB,
        userId,
        lines.map((l) => l.id),
      );
      const { input, sent } = draftInput(mechanism, lines, meta);
      const value = await call.send(input, DRAFT_SYSTEM);
      if (value !== undefined) {
        state = { ...state, next: state.next + 1 };
        try {
          const accepted = validateDraft(value, sent, meta);
          if (accepted) {
            statements.push(
              principleStatement(
                env.DB,
                userId,
                reflection.reflection_id,
                accepted,
                call.settings.model,
                now,
                currentReviewLeaseSql,
                leaseValues(call.lease),
              ),
            );
            report.proposed = 1;
          }
        } catch (error) {
          failed(report, error);
        }
      }
    }
    if (report.failed) ended = report.stopped;
    else if (!ended && state && state.next >= state.mechanisms.length)
      ended = state.mechanisms.length ? "done" : "nothing";
    // A refused reservation (count, cap, admission) leaves the step for later.
    if (!report.calls && !ended) return;
    statements.push(
      env.DB.prepare(`UPDATE memory_reflections SET state_json = ?, calls = calls + ?, proposed = proposed + ?,
        ended = ?, finished_at = CASE WHEN ? IS NULL THEN NULL ELSE ? END
        WHERE reflection_id = ? AND user_id = ? AND finished_at IS NULL`).bind(
        state ? JSON.stringify(state) : null,
        report.calls,
        report.proposed,
        ended,
        ended,
        nowSeconds(),
        reflection.reflection_id,
        userId,
      ),
    );
    await env.DB.batch(statements);
    report.more = !ended;
  });
}

/**
 * Reflect now: a reflection over the lines since the last one. It runs under
 * nightly upkeep's consent and count, so it needs upkeep on; a finished run is
 * made due at once, and a run in progress reaches it when its queue drains.
 */
export async function reflectNow(db: D1Database, userId: string) {
  const settings = await readReviewSettings(db, userId);
  if (!settings.enabled || !settings.overnight)
    throw new MemoryReviewError(
      "Turn on nightly upkeep first; a reflection runs under its consent and nightly count.",
    );
  const now = nowSeconds();
  await requestReflection(db, userId, now);
  await db
    .prepare(`UPDATE memory_review_settings SET next_run_at = ? WHERE user_id = ? AND overnight = 1
      AND (last_run_json IS NULL OR json_extract(last_run_json, '$.finishedAt') IS NOT NULL)`)
    .bind(now, userId)
    .run();
}

export const UPKEEP_AGENT = "valise:memory-upkeep";

/** Apply one additive result for the person. A refusal (stale source, consent withdrawn) leaves it a question. */
async function applyAutomatically(
  env: ReviewEnv,
  userId: string,
  id: string,
  proposal: ReviewProposal,
): Promise<boolean> {
  try {
    await acceptMemoryReview(
      env,
      id,
      { automatic: true, draftTitle: proposal.title, draftBody: proposal.body },
      { userId, agent: UPKEEP_AGENT, client: "nightly", session: null },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Undo an automatic application: archive the memory it added and record the
 * group as dismissed, so the same unchanged sources are not proposed again.
 * The originals were never touched. Reversal of a person's own acceptance stays
 * with the Memories archive control.
 */
export async function undoAutoApplied(
  env: ReviewEnv,
  userId: string,
  id: string,
): Promise<void> {
  const group = await getReviewGroup(env.DB, userId, id);
  if (
    !group ||
    group.state !== "accepted" ||
    group.applied_by !== "auto" ||
    !group.result_memory_id
  )
    throw new MemoryReviewError("Only an automatic change can be undone here.");
  const memoryId = group.result_memory_id;
  const sources = (JSON.parse(group.sources_json) as ReviewSnapshot[]).map(
    (s) => s.source.id,
  );
  const now = nowSeconds();
  await guardedBatch(env.DB, [
    env.DB.prepare(`UPDATE memory_review_groups SET
    fingerprint = CASE WHEN state = 'accepted' AND applied_by = 'auto' THEN fingerprint ELSE NULL END,
    state = 'dismissed', updated_at = ? WHERE group_id = ? AND user_id = ?`).bind(
      now,
      id,
      userId,
    ),
    vectorSnapshotStatement(env.DB, memoryId),
    env.DB.prepare(`UPDATE memories SET deleted_at = COALESCE(deleted_at, ?),
    updated_at = CASE WHEN deleted_at IS NULL THEN ? ELSE updated_at END
    WHERE memory_id = ? AND user_id = ?`).bind(now, now, memoryId, userId),
    ...memoryProjectionStatements(env.DB, memoryId, env),
    eventStatement(
      env.DB,
      userId,
      id,
      "dismiss",
      JSON.stringify({ undo: true, archived: memoryId }),
    ),
    // Archiving the added memory changes its originals' link evidence, which
    // the triggers enqueue. That is the undo itself, not new evidence: without
    // this the next run would draft the same summary again and apply it.
    env.DB.prepare(
      `DELETE FROM memory_review_pending WHERE user_id = ? AND memory_id IN (${[...sources, memoryId].map(() => "?").join(",")})`,
    ).bind(userId, ...sources, memoryId),
  ]);
}

/** A run's totals across its passes, shown on the Review status line. */
export type UpkeepRun = {
  startedAt: number;
  finishedAt: number | null;
  passes: number;
  scanned: number;
  calls: number;
  applied: number;
  questions: number;
  failed: number;
  /** Lesson lines written and lesson calls spent; absent on runs before 2026-11-08. */
  lessons?: number;
  lessonCalls?: number;
  /** Reflection calls spent and principle cards drafted; absent before slice 2 of J-E. */
  reflectionCalls?: number;
  principles?: number;
  /** Why the run ended: `done` (nothing left), `limit` (today's limit), or a stop reason. */
  ended: string | null;
};

export function parseUpkeepRun(raw: string | null): UpkeepRun | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as UpkeepRun;
  } catch {
    return null;
  }
}

/** The latest run and when the next one is due, for the Review status line. */
export async function readUpkeepStatus(
  db: D1Database,
  userId: string,
): Promise<{ run: UpkeepRun | null; nextRunAt: number | null }> {
  const row = await db
    .prepare(
      "SELECT last_run_json, next_run_at, overnight FROM memory_review_settings WHERE user_id = ?",
    )
    .bind(userId)
    .first<{
      last_run_json: string | null;
      next_run_at: number;
      overnight: number;
    }>();
  return {
    run: parseUpkeepRun(row?.last_run_json ?? null),
    nextRunAt: row?.overnight ? row.next_run_at : null,
  };
}

/** The next UPKEEP_HOUR_UTC after `now`, at least an hour away. */
export function nextUpkeepAt(now: number): number {
  const day = Math.floor(now / 86400) * 86400;
  let next = day + UPKEEP_HOUR_UTC * 3600;
  while (next <= now + 3600) next += 86400;
  return next;
}

/**
 * Nightly upkeep, called every minute (ADR-0012, 2026-11-04). A due account
 * gets one bounded pass; while work and today's limit remain it is due again
 * the next minute, so a night's run drains the queue a pass at a time. When the
 * queue is empty, the limit is used or the run stops, the next run is due at
 * UPKEEP_HOUR_UTC. Inspects twenty due settings and runs at most five accounts
 * per minute. Deferring inadmissible entries prevents orphaned settings from
 * starving the bounded window.
 */
export async function overnightMemoryReview(env: ReviewEnv): Promise<{
  users: number;
  calls: number;
  applied: number;
  failed: number;
}> {
  const report = { users: 0, calls: 0, applied: 0, failed: 0 };
  const now = nowSeconds();
  const users =
    await env.DB.prepare(`SELECT user_id FROM memory_review_settings WHERE enabled = 1 AND overnight = 1
    AND next_run_at <= ? ORDER BY next_run_at LIMIT 20`)
      .bind(now)
      .all<{ user_id: string }>();
  const claimed: { userId: string; run: UpkeepRun | null }[] = [];
  for (const { user_id: userId } of users.results) {
    if (claimed.length >= 5) break;
    if (!(await accountAdmitted(env.DB, userId))) {
      // This only advances operational scheduling. Preserve all consent,
      // history and queued work; never reserve budget or dispatch for this row.
      await env.DB.prepare(`UPDATE memory_review_settings SET next_run_at = unixepoch() + 86400
        WHERE user_id = ? AND enabled = 1 AND overnight = 1 AND next_run_at <= unixepoch()
        AND NOT ${reviewAccountAdmittedSql}`)
        .bind(userId)
        .run();
      continue;
    }
    // Claiming moves the row five minutes out, the pass lock's own length, so
    // an overlapping minute does not start a second pass for the same account.
    const row =
      await env.DB.prepare(`UPDATE memory_review_settings SET next_run_at = ? WHERE user_id = ?
      AND enabled = 1 AND overnight = 1 AND next_run_at <= ? AND ${reviewAccountAdmittedSql}
      RETURNING last_run_json`)
        .bind(now + 300, userId, now)
        .first<{ last_run_json: string | null }>();
    if (!row) continue;
    claimed.push({ userId, run: parseUpkeepRun(row.last_run_json) });
  }
  report.users = claimed.length;
  await Promise.all(
    claimed.map(async ({ userId, run: previous }) => {
      const run: UpkeepRun =
        previous && previous.finishedAt === null
          ? previous
          : {
              startedAt: now,
              finishedAt: null,
              passes: 0,
              scanned: 0,
              calls: 0,
              applied: 0,
              questions: 0,
              failed: 0,
              ended: null,
            };
      let stopped: string | null;
      try {
        const pass = await runMemoryReview(env, userId, undefined, true);
        report.calls += pass.calls;
        report.applied += pass.applied;
        report.failed += pass.failed;
        run.passes++;
        run.scanned += pass.scanned;
        run.calls += pass.calls;
        run.applied += pass.applied;
        run.questions += pass.proposed;
        run.failed += pass.failed;
        stopped = pass.stopped;
      } catch {
        report.failed++;
        run.passes++;
        stopped = "review-failed";
      }
      let more =
        stopped === "pass limit" ||
        stopped === "ranking pass limit" ||
        stopped === "already running" ||
        stopped === "admission lost";
      if (stopped === null)
        more = !!(await env.DB.prepare(
          "SELECT 1 FROM memory_review_pending WHERE user_id = ? LIMIT 1",
        )
          .bind(userId)
          .first());
      // Lesson lines once the review queue is drained, one call a minute.
      if (
        !more &&
        stopped === null &&
        (run.lessonCalls ?? 0) < LESSON_CALLS_PER_NIGHT
      ) {
        try {
          const lessons = await runLessonPass(env, userId);
          report.calls += lessons.calls;
          report.failed += lessons.failed;
          run.calls += lessons.calls;
          run.failed += lessons.failed;
          run.lessonCalls = (run.lessonCalls ?? 0) + lessons.calls;
          run.lessons = (run.lessons ?? 0) + lessons.written;
          if (lessons.stopped === "already running") more = true;
          else if (lessons.stopped === null) more = lessons.calls > 0;
          // A spent count or cap ends the run as review's would. A failed
          // call is already counted in `failed`; the queue itself is done.
          else if (
            lessons.stopped === "daily budget" ||
            lessons.stopped === "cost limit"
          )
            stopped = lessons.stopped;
        } catch {
          report.failed++;
          run.failed++;
        }
      }
      // The weekly reflection once lesson lines are done, one call a minute.
      if (
        !more &&
        stopped === null &&
        (run.reflectionCalls ?? 0) < REFLECTION_CALLS_PER_NIGHT
      ) {
        try {
          const step = await runReflectionStep(env, userId);
          report.calls += step.calls;
          report.failed += step.failed;
          run.calls += step.calls;
          run.failed += step.failed;
          run.reflectionCalls = (run.reflectionCalls ?? 0) + step.calls;
          run.principles = (run.principles ?? 0) + step.proposed;
          if (step.stopped === "already running") more = true;
          else if (step.stopped === null) more = step.more;
          else if (
            step.stopped === "daily budget" ||
            step.stopped === "cost limit"
          )
            stopped = step.stopped;
        } catch {
          report.failed++;
          run.failed++;
        }
      }
      if (run.passes >= UPKEEP_MAX_PASSES) more = false;
      const finished = nowSeconds();
      if (!more) {
        run.finishedAt = finished;
        run.ended =
          stopped === null
            ? "done"
            : stopped === "daily budget"
              ? "limit"
              : stopped === "cost limit"
                ? "cost"
                : stopped === "pass limit" || stopped === "ranking pass limit"
                  ? "passes"
                  : stopped;
      }
      // Only this claim's own row; a person who turned upkeep off meanwhile keeps it off.
      await env.DB.prepare(`UPDATE memory_review_settings SET next_run_at = ?, last_run_json = ?
        WHERE user_id = ? AND next_run_at = ?`)
        .bind(
          more ? finished + 60 : nextUpkeepAt(finished),
          JSON.stringify(run),
          userId,
          now + 300,
        )
        .run();
    }),
  );
  return report;
}
