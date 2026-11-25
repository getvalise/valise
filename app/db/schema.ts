import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { MCP_SCOPES } from "~/auth/scopes";

/**
 * Authoritative per-concept tables plus one derived projection, per ADR-0001.
 * Concepts never reference each other. They meet only at `search_index`.
 */

export type Concept = "skill" | "memory" | "todo";

/**
 * Everything that publishes into `search_docs`. `Concept` stays the three
 * with console lists and facets; assets and sources join the projection
 * without joining those. ADR-0015.
 */
export type SearchConcept = Concept | "asset" | "source" | "transcript";

// --- Skills -----------------------------------------------------------------

export const skills = sqliteTable(
  "skills",
  {
    skillId: text("skill_id").primaryKey(),
    /**
     * Whose skill this is. `local` is the owner, the one user v1 had, so
     * every row written before multi-user belongs to them by default.
     * ADR-0016.
     */
    userId: text("user_id").notNull().default("local"),
    /** Slug, taken from SKILL.md frontmatter `name`. Unique per user. */
    name: text("name").notNull(),
    project: text("project"),
    tagsJson: text("tags_json").notNull().default("[]"),
    visibility: text("visibility", { enum: ["private", "public"] })
      .notNull()
      .default("private"),
    /** Null only between the skills insert and its first version, inside one batch. */
    headVersionId: text("head_version_id"),
    /**
     * Where an imported skill came from, as `owner/repo/skill` on skills.sh,
     * and the upstream's own content digest beside it. Null for a skill
     * published here. The digest is what makes a later "has this changed" a
     * comparison rather than a re-download. V1-16.
     */
    source: text("source"),
    sourceHash: text("source_hash"),
    /**
     * The version the last import wrote. A head past it was edited here, so
     * an upstream update would replace a local edit and has to say so.
     */
    sourceVersionId: text("source_version_id"),
    /**
     * The last upstream check: what upstream's digest was, the source an
     * update would import (a `github:` source pinned to the newer commit),
     * and when. An update is available when `upstream_hash` differs from
     * `source_hash`. Null until the first check.
     */
    upstreamHash: text("upstream_hash"),
    upstreamSource: text("upstream_source"),
    upstreamCheckedAt: integer("upstream_checked_at"),
    /**
     * Follow upstream without review: an upstream check that finds a newer
     * bundle publishes it, unless the head was edited here. Off by default,
     * because it puts a third party's text in front of every agent.
     */
    autoUpdate: integer("auto_update", { mode: "boolean" })
      .notNull()
      .default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
    /**
     * The per-user off switch. A disabled skill closes all three doors at
     * once — no `skill_{name}` tool, absent from list/get and the SEP-2640
     * resources, unpublished from search — while the row and its immutable
     * versions stay put. Distinct from `deleted_at`, which hides the skill
     * from the console too. V1-19.
     */
    disabledAt: integer("disabled_at"),
  },
  (table) => [
    /**
     * Each tenant owns its name namespace. Migration 0035 replaces the
     * single-user global index by hand (ADR-0008, ADR-0016).
     */
    uniqueIndex("skills_user_name_unique").on(table.userId, table.name),
    index("skills_project").on(table.project),
    check(
      "skills_visibility_check",
      sql`${table.visibility} IN ('private','public')`,
    ),
  ],
);

/** Append-only. Rows are never updated and never deleted. */
export const skillVersions = sqliteTable(
  "skill_versions",
  {
    versionId: text("version_id").primaryKey(),
    skillId: text("skill_id")
      .notNull()
      .references(() => skills.skillId),
    /** Monotonic per skill, starting at 1. */
    version: integer("version").notNull(),
    /** Full SKILL.md including frontmatter. */
    bodyMd: text("body_md").notNull(),
    bodySha256: text("body_sha256").notNull(),
    /** Manifest of R2 bundle files: [{path, r2Key, sha256, size}]. */
    filesJson: text("files_json").notNull().default("[]"),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    uniqueIndex("skill_versions_skill_version").on(
      table.skillId,
      table.version,
    ),
  ],
);

// --- Memories ---------------------------------------------------------------

export const memories = sqliteTable(
  "memories",
  {
    memoryId: text("memory_id").primaryKey(),
    /** Whose memory this is; `local` is the owner. ADR-0016. */
    userId: text("user_id").notNull().default("local"),
    /** Open vocabulary: user, feedback, project, reference, and whatever follows. */
    memoryType: text("memory_type").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"),
    project: text("project"),
    /** Provenance is three columns, not a blob, because it is filtered on. */
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull(),
    sourceSession: text("source_session"),
    /**
     * What the session calls itself, such as a worktree name, from the
     * plugin's `X-Valise-Session-Name`. Shown in place of the client id when
     * present; the client id stays in `source_agent`. ADR-0004.
     */
    sourceSessionName: text("source_session_name"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("memories_type").on(table.memoryType),
    index("memories_project").on(table.project),
    index("memories_user").on(table.userId, table.updatedAt),
    index("memories_review_project").on(
      table.userId,
      table.project,
      table.updatedAt,
      table.memoryId,
    ),
  ],
);

/** Append-only snapshot of a memory as it stood before an edit. */
export const memoryRevisions = sqliteTable(
  "memory_revisions",
  {
    revisionId: text("revision_id").primaryKey(),
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.memoryId),
    /** Monotonic per memory, starting at 1. */
    revision: integer("revision").notNull(),
    memoryType: text("memory_type").notNull(),
    title: text("title"),
    body: text("body").notNull(),
    tagsJson: text("tags_json").notNull().default("[]"),
    project: text("project"),
    sourceClient: text("source_client"),
    sourceSession: text("source_session"),
    createdAt: integer("created_at").notNull(),
    createdBy: text("created_by").notNull(),
  },
  (table) => [
    uniqueIndex("memory_revisions_memory_revision").on(
      table.memoryId,
      table.revision,
    ),
  ],
);

export const memoryLinks = sqliteTable(
  "memory_links",
  {
    linkId: text("link_id").primaryKey(),
    fromMemoryId: text("from_memory_id")
      .notNull()
      .references(() => memories.memoryId),
    toMemoryId: text("to_memory_id")
      .notNull()
      .references(() => memories.memoryId),
    kind: text("kind", {
      enum: ["part-of", "supersedes", "contradicts", "related"],
    }).notNull(),
    assertedBy: text("asserted_by", { enum: ["model", "person"] }).notNull(),
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull(),
    sourceSession: text("source_session"),
    createdAt: integer("created_at").notNull(),
    confirmedAt: integer("confirmed_at"),
    confirmedBy: text("confirmed_by"),
    removedAt: integer("removed_at"),
    removedBy: text("removed_by"),
  },
  (table) => [
    uniqueIndex("memory_links_pair_kind").on(
      table.fromMemoryId,
      table.toMemoryId,
      table.kind,
    ),
    index("memory_links_to").on(table.toMemoryId),
    check(
      "memory_links_kind",
      sql`${table.kind} IN ('part-of', 'supersedes', 'contradicts', 'related')`,
    ),
    check(
      "memory_links_asserted_by",
      sql`${table.assertedBy} IN ('model', 'person')`,
    ),
    check(
      "memory_links_distinct",
      sql`${table.fromMemoryId} <> ${table.toMemoryId}`,
    ),
    check(
      "memory_links_symmetric",
      sql`${table.kind} NOT IN ('related', 'contradicts') OR ${table.fromMemoryId} < ${table.toMemoryId}`,
    ),
    check(
      "memory_links_confirmation",
      sql`(${table.confirmedAt} IS NULL) = (${table.confirmedBy} IS NULL)`,
    ),
    check(
      "memory_links_removal",
      sql`(${table.removedAt} IS NULL) = (${table.removedBy} IS NULL)`,
    ),
  ],
);

/** Stable user-owned grouping, independent of any summary memory or tag. */
export const memorySubjects = sqliteTable(
  "memory_subjects",
  {
    subjectId: text("subject_id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    kind: text("kind", {
      enum: ["profile", "topic", "area", "person"],
    }).notNull(),
    description: text("description").notNull().default(""),
    summaryMemoryId: text("summary_memory_id").references(
      () => memories.memoryId,
    ),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Soft delete; the subject page's Restore clears it (P12). */
    deletedAt: integer("deleted_at"),
  },
  (t) => [
    index("memory_subjects_user_name").on(t.userId, t.name, t.subjectId),
    check(
      "memory_subjects_kind",
      sql`${t.kind} IN ('profile', 'topic', 'area', 'person')`,
    ),
  ],
);

export const memorySubjectMembers = sqliteTable(
  "memory_subject_members",
  {
    subjectId: text("subject_id")
      .notNull()
      .references(() => memorySubjects.subjectId),
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.memoryId),
    assertedBy: text("asserted_by", { enum: ["person", "model"] }).notNull(),
    confirmedAt: integer("confirmed_at"),
    confirmedBy: text("confirmed_by"),
    createdAt: integer("created_at").notNull(),
    removedAt: integer("removed_at"),
    removedBy: text("removed_by"),
  },
  (t) => [
    primaryKey({ columns: [t.subjectId, t.memoryId] }),
    index("memory_subject_members_memory").on(t.memoryId),
    check(
      "memory_subject_members_assertion",
      sql`${t.assertedBy} IN ('person', 'model')`,
    ),
    check(
      "memory_subject_members_confirmation",
      sql`(${t.confirmedAt} IS NULL) = (${t.confirmedBy} IS NULL)`,
    ),
    check(
      "memory_subject_members_removal",
      sql`(${t.removedAt} IS NULL) = (${t.removedBy} IS NULL)`,
    ),
  ],
);

/** Review drafts, explicit provider authorization and durable coverage. ADR-0012, 2026-10-24. */
export const memoryReviewSettings = sqliteTable(
  "memory_review_settings",
  {
    userId: text("user_id").primaryKey().notNull(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(false),
    overnight: integer("overnight", { mode: "boolean" })
      .notNull()
      .default(false),
    model: text("model")
      .notNull()
      // Frozen 0038 SQL default is legacy compatibility, not the application
      // default. All application inserts explicitly bind DEFAULT_REVIEW_MODEL;
      // historical/restored Llama choices must never become OpenRouter consent.
      .default("@cf/meta/llama-3.1-8b-instruct-fp8"),
    dailyCalls: integer("daily_calls").notNull().default(2),
    dailyMicrousd: integer("daily_microusd").notNull().default(10000),
    nextRunAt: integer("next_run_at").notNull().default(0),
    lockToken: text("lock_token"),
    lockUntil: integer("lock_until").notNull().default(0),
    // 0060, nightly upkeep (ADR-0012, 2026-11-04). Additive columns with no SQL
    // CHECK, so no table rebuild: the application bounds them.
    /** Apply additive results (new summaries) without asking; consented with the nightly switch. */
    autoApply: integer("auto_apply", { mode: "boolean" })
      .notNull()
      .default(false),
    /** The nightly call cap, 1–30. Manual checks keep daily_calls (1–8). */
    nightlyCalls: integer("nightly_calls").notNull().default(20),
    /** The latest automatic run's totals, for the Review status line. */
    lastRunJson: text("last_run_json"),
    // 0061, review limits (ADR-0012, 2026-11-04 limits). Memory checks a
    // person sets, by hand and in the nightly run, each with its own counter.
    // No SQL CHECK, so no rebuild; the application bounds them. They replace
    // daily_calls, nightly_calls and daily_microusd, which stay unused.
    manualMemories: integer("manual_memories").notNull().default(25),
    upkeepMemories: integer("upkeep_memories").notNull().default(50),
  },
  (t) => [
    index("memory_review_due").on(t.enabled, t.overnight, t.nextRunAt),
    check("memory_review_enabled", sql`${t.enabled} IN (0, 1)`),
    check("memory_review_overnight", sql`${t.overnight} IN (0, 1)`),
    check("memory_review_calls", sql`${t.dailyCalls} BETWEEN 1 AND 8`),
    check(
      "memory_review_cost",
      sql`${t.dailyMicrousd} BETWEEN 1000 AND 100000`,
    ),
  ],
);

/** Derived eligibility, initially backfilled then maintained by the 0038 triggers. */
export const memoryReviewPending = sqliteTable(
  "memory_review_pending",
  {
    memoryId: text("memory_id")
      .primaryKey()
      .notNull()
      .references(() => memories.memoryId, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    enqueuedAt: integer("enqueued_at").notNull(),
  },
  (t) => [
    index("memory_review_pending_user").on(t.userId, t.enqueuedAt, t.memoryId),
  ],
);

export const memoryReviewGroups = sqliteTable(
  "memory_review_groups",
  {
    groupId: text("group_id").primaryKey().notNull(),
    userId: text("user_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    sourcesJson: text("sources_json").notNull(),
    proposalJson: text("proposal_json"),
    draftTitle: text("draft_title"),
    draftBody: text("draft_body"),
    state: text("state", {
      enum: ["running", "proposal", "noop", "failed", "dismissed", "accepted"],
    }).notNull(),
    attempts: integer("attempts").notNull().default(1),
    retryAt: integer("retry_at").notNull().default(0),
    resultMemoryId: text("result_memory_id"),
    error: text("error"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    /** Who applied an accepted result: `person`, or `auto` for nightly upkeep. Null on older rows. */
    appliedBy: text("applied_by"),
  },
  (t) => [
    uniqueIndex("memory_review_groups_fingerprint").on(t.userId, t.fingerprint),
    index("memory_review_groups_user").on(t.userId, t.createdAt, t.groupId),
    index("memory_review_retry").on(t.userId, t.state, t.retryAt),
    check(
      "memory_review_state",
      sql`${t.state} IN ('running', 'proposal', 'noop', 'failed', 'dismissed', 'accepted')`,
    ),
  ],
);

/** Derived source-history/coverage index, rebuilt by group INSERT triggers. */
export const memoryReviewSources = sqliteTable(
  "memory_review_sources",
  {
    groupId: text("group_id")
      .notNull()
      .references(() => memoryReviewGroups.groupId, { onDelete: "cascade" }),
    userId: text("user_id").notNull(),
    memoryId: text("memory_id").notNull(),
    fingerprint: text("fingerprint").notNull(),
    revision: integer("revision").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.memoryId] }),
    index("memory_review_source_history").on(t.userId, t.memoryId, t.createdAt),
    index("memory_review_source_coverage").on(
      t.userId,
      t.memoryId,
      t.fingerprint,
    ),
  ],
);

/** Separate destination consent; no existing synthesis flag authorizes ranking. */
export const memoryReviewRanking = sqliteTable(
  "memory_review_ranking",
  {
    userId: text("user_id").primaryKey().notNull(),
    enabled: integer("enabled").notNull().default(0),
    revision: integer("revision").notNull().default(0),
    destination: text("destination").notNull(),
    dailyRequests: integer("daily_requests").notNull().default(4),
    dailyMicrousd: integer("daily_microusd").notNull().default(10000),
    manualModel: text("manual_model"),
  },
  (t) => [
    check("review_ranking_enabled", sql`${t.enabled} IN (0,1)`),
    check("review_ranking_requests", sql`${t.dailyRequests} BETWEEN 1 AND 16`),
    check(
      "review_ranking_cost",
      sql`${t.dailyMicrousd} BETWEEN 1000 AND 100000`,
    ),
  ],
);
export const memoryReviewRankingBudgets = sqliteTable(
  "memory_review_ranking_budgets",
  {
    userId: text("user_id").notNull(),
    day: integer("day").notNull(),
    requests: integer("requests").notNull(),
    reservedMicrousd: integer("reserved_microusd").notNull(),
    lastError: text("last_error"),
    /** 0061: today's requests by hand and by the nightly run; `requests` stays their total. */
    manualRequests: integer("manual_requests").notNull().default(0),
    upkeepRequests: integer("upkeep_requests").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/**
 * An admin's per-account daily money caps for review and ranking (ADR-0012,
 * 2026-11-04 limits). No row means the operator defaults in
 * `app/concepts/memory-review-limits.ts`. Only the admin workbench writes it.
 */
export const memoryReviewCostCaps = sqliteTable("memory_review_cost_caps", {
  userId: text("user_id").primaryKey().notNull(),
  reviewMicrousd: integer("review_microusd").notNull(),
  rankingMicrousd: integer("ranking_microusd").notNull(),
  setBy: text("set_by").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

/** Append-only human decisions and one-field edits; model proposal JSON is never overwritten. */
export const memoryReviewEvents = sqliteTable(
  "memory_review_events",
  {
    eventId: text("event_id").primaryKey().notNull(),
    groupId: text("group_id")
      .notNull()
      .references(() => memoryReviewGroups.groupId),
    userId: text("user_id").notNull(),
    kind: text("kind", {
      enum: ["edit-title", "edit-body", "dismiss", "reopen", "accept"],
    }).notNull(),
    value: text("value"),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    index("memory_review_events_group").on(t.userId, t.groupId, t.createdAt),
    check(
      "memory_review_event_kind",
      sql`${t.kind} IN ('edit-title', 'edit-body', 'dismiss', 'reopen', 'accept')`,
    ),
  ],
);

export const memoryReviewBudgets = sqliteTable(
  "memory_review_budgets",
  {
    userId: text("user_id").notNull(),
    day: integer("day").notNull(),
    calls: integer("calls").notNull(),
    reservedMicrousd: integer("reserved_microusd").notNull(),
    /** 0061: today's calls by hand and by the nightly run; `calls` stays their total. */
    manualCalls: integer("manual_calls").notNull().default(0),
    upkeepCalls: integer("upkeep_calls").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.userId, t.day] })],
);

/**
 * One lesson line per memory revision: the memory's transferable lesson with
 * project nouns, paths, products and people removed (J-E in
 * docs/design/memory-consolidation.md, ADR-0012 amendment of 2026-11-08).
 * Model output written by the nightly lesson pass, never the person's text,
 * so it sits beside `memories` rather than in it. An empty `lesson` records
 * that the memory has none (reference or taste data), so it is not sent again.
 */
export const memoryLessons = sqliteTable(
  "memory_lessons",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.memoryId),
    revision: integer("revision").notNull(),
    userId: text("user_id").notNull(),
    lesson: text("lesson").notNull(),
    /** JSON array of two to five lowercase mechanism keywords. */
    mechanismJson: text("mechanism_json").notNull(),
    forward: text("forward").notNull(),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.memoryId, t.revision] }),
    index("memory_lessons_user").on(t.userId, t.createdAt),
  ],
);

/**
 * One weekly reflection (J-E): a model call that names recurring mechanisms in
 * the lesson lines, then one call per mechanism that may draft a principle.
 * Stepped one call a minute by nightly upkeep; `state_json` holds the
 * mechanisms still to draft. ADR-0012 amendment of 2026-11-08.
 */
export const memoryReflections = sqliteTable(
  "memory_reflections",
  {
    reflectionId: text("reflection_id").primaryKey(),
    userId: text("user_id").notNull(),
    /** `schedule` (weekly) or `person` (Reflect now). */
    requestedBy: text("requested_by").notNull(),
    /** Lesson lines written after this second are the week's lines. */
    since: integer("since").notNull(),
    stateJson: text("state_json"),
    calls: integer("calls").notNull().default(0),
    proposed: integer("proposed").notNull().default(0),
    ended: text("ended"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
  },
  (t) => [index("memory_reflections_user").on(t.userId, t.createdAt)],
);

/**
 * A principle card a reflection drafted. It is not a memory until a person
 * adopts it; adoption writes a `decision` memory with its evidence linked
 * `part-of`, and optionally a to-do. Rejected cards keep their reason so the
 * next reflection does not propose the same rule again.
 */
export const memoryPrinciples = sqliteTable(
  "memory_principles",
  {
    principleId: text("principle_id").primaryKey(),
    userId: text("user_id").notNull(),
    reflectionId: text("reflection_id").notNull(),
    /** proposal, adopted or rejected. */
    state: text("state").notNull(),
    rule: text("rule").notNull(),
    appliesWhen: text("applies_when").notNull(),
    mechanism: text("mechanism").notNull(),
    exceptions: text("exceptions").notNull(),
    changeKind: text("change_kind").notNull(),
    changeText: text("change_text").notNull(),
    /** JSON [{id, revision, lesson, title, project}] for evidence and counterexamples. */
    evidenceJson: text("evidence_json").notNull(),
    counterJson: text("counter_json").notNull(),
    reason: text("reason"),
    resultMemoryId: text("result_memory_id"),
    resultTodoId: text("result_todo_id"),
    model: text("model").notNull(),
    promptVersion: text("prompt_version").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [index("memory_principles_user").on(t.userId, t.state, t.createdAt)],
);

/** The memory owns its link; object storage owns the bytes. ADR-0011. */
export const memoryAttachments = sqliteTable(
  "memory_attachments",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.memoryId),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.objectId),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.objectId] }),
    index("memory_attachments_memory").on(table.memoryId, table.createdAt),
  ],
);

/** Delivery snapshots preserve exact generation stamps, including original update time. */
export const vectorSnapshots = sqliteTable(
  "vector_snapshots",
  {
    memoryId: text("memory_id")
      .notNull()
      .references(() => memories.memoryId, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    projectionJson: text("projection_json").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.memoryId, table.generation] }),
    check("vector_snapshots_generation_check", sql`${table.generation} > 0`),
    check(
      "vector_snapshots_json_check",
      sql`json_valid(${table.projectionJson})`,
    ),
  ],
);

/** Durable, replayable delivery ledger; completed rows retain deletion targets. */
export const vectorPending = sqliteTable(
  "vector_pending",
  {
    namespace: text("namespace").notNull(),
    /** Indexed scheduling hint only; delivery still reads the authoritative owner. */
    userId: text("user_id"),
    memoryId: text("memory_id").notNull(),
    generation: integer("generation").notNull(),
    target: text("target", { enum: ["head", "history", "delete"] }).notNull(),
    epoch: integer("epoch").notNull().default(1),
    completedEpoch: integer("completed_epoch").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until").notNull().default(0),
    mutationId: text("mutation_id"),
    errorCode: text("error_code"),
    queuedAt: integer("queued_at").notNull().default(0),
    completedAt: integer("completed_at").notNull().default(0),
  },
  (table) => [
    primaryKey({
      columns: [table.namespace, table.memoryId, table.generation],
    }),
    foreignKey({
      columns: [table.memoryId, table.generation],
      foreignColumns: [vectorSnapshots.memoryId, vectorSnapshots.generation],
    }).onDelete("cascade"),
    check(
      "vector_pending_target_check",
      sql`${table.target} IN ('head','history','delete')`,
    ),
    index("vector_pending_due").on(table.nextAttemptAt, table.leaseUntil),
    index("vector_pending_tenant_due").on(
      table.namespace,
      table.userId,
      table.nextAttemptAt,
      table.memoryId,
      table.generation,
    ),
    // Admission counts only unfinished embeddings, never the retained history.
    index("vector_pending_outstanding")
      .on(table.namespace, table.userId, table.memoryId)
      .where(
        sql`${table.completedEpoch} < ${table.epoch} AND ${table.target} != 'delete'`,
      ),
  ],
);

/**
 * A memory whose write committed while its owner was at the embedding backlog
 * cap. One row per memory however often it is edited; the cron moves it into
 * `vector_pending` once the owner is under the cap. ADR-0017, 2026-11-01.
 */
export const vectorDeferred = sqliteTable(
  "vector_deferred",
  {
    namespace: text("namespace").notNull(),
    userId: text("user_id").notNull(),
    memoryId: text("memory_id").notNull(),
    deferredAt: integer("deferred_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.memoryId] }),
    index("vector_deferred_tenant").on(
      table.namespace,
      table.userId,
      table.deferredAt,
      table.memoryId,
    ),
  ],
);

/**
 * Provider embedding calls per owner per UTC day, by kind. Every call counts
 * its input bytes, failed attempts and retries included; deletes cost
 * nothing. Enforced only when `VALISE_EMBEDDING_DAILY_BYTES` is set.
 * ADR-0017, 2026-11-01.
 */
export const embeddingUsageDaily = sqliteTable(
  "embedding_usage_daily",
  {
    userId: text("user_id").notNull(),
    /** `date('now')`: YYYY-MM-DD in UTC. */
    day: text("day").notNull(),
    kind: text("kind", {
      enum: ["memory", "asset", "source", "query"],
    }).notNull(),
    calls: integer("calls").notNull().default(0),
    failures: integer("failures").notNull().default(0),
    inputBytes: integer("input_bytes").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day, table.kind] }),
    check(
      "embedding_usage_daily_kind_check",
      sql`${table.kind} IN ('memory','asset','source','query')`,
    ),
    index("embedding_usage_daily_day").on(table.day),
  ],
);

/**
 * Estimated spend per account, UTC day and category, at list price.
 * `app/concepts/spend.ts` writes it next to each metered call;
 * `docs/design/spend.md` is the contract. A cron job's D1 load is charged to
 * the `(system)` account, never NULL: NULLs are distinct in a primary key, so
 * the upsert could not find yesterday's row.
 */
export const spendDaily = sqliteTable(
  "spend_daily",
  {
    userId: text("user_id").notNull(),
    /** `date('now')`: YYYY-MM-DD in UTC. */
    day: text("day").notNull(),
    category: text("category").notNull(),
    calls: integer("calls").notNull().default(0),
    /** Calls with no list price; their units count, their money does not. */
    unpricedCalls: integer("unpriced_calls").notNull().default(0),
    units: integer("units").notNull().default(0),
    microusd: integer("microusd").notNull().default(0),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.day, table.category] }),
    index("spend_daily_day").on(table.day),
  ],
);

/** Deployment-owned resumable initial backfill, never an external-index acknowledgement. */
export const vectorBackfills = sqliteTable("vector_backfills", {
  namespace: text("namespace").primaryKey(),
  cursor: text("cursor").notNull().default(""),
  done: integer("done").notNull().default(0),
});

/** Bounded round-robin drain reservation, independent of backfill checkpoints. */
export const vectorDrainState = sqliteTable("vector_drain_state", {
  namespace: text("namespace").primaryKey(),
  afterUserId: text("after_user_id").notNull().default(""),
  leaseToken: text("lease_token"),
  leaseUntil: integer("lease_until").notNull().default(0),
});

// --- To-dos -----------------------------------------------------------------

export const todos = sqliteTable(
  "todos",
  {
    todoId: text("todo_id").primaryKey(),
    /**
     * Whose to-do this is; `local` is the owner. The coordinator is already
     * one Durable Object per user, so this column makes D1 agree with it.
     * ADR-0016.
     */
    userId: text("user_id").notNull().default("local"),
    title: text("title").notNull(),
    body: text("body").notNull().default(""),
    project: text("project"),
    tagsJson: text("tags_json").notNull().default("[]"),
    state: text("state", {
      enum: ["pending", "claimed", "done", "blocked"],
    })
      .notNull()
      .default("pending"),
    /** Mirror of coordinator truth, may lag by seconds. Display only. */
    leaseHolder: text("lease_holder"),
    /**
     * The holder's `x-valise-session`, null when its client sent none. Written
     * with the fence on claim, so fetch can show the token to the holder only.
     * ADR-0002, amendment of 2026-11-24.
     */
    holderSession: text("holder_session"),
    /** Mirror of coordinator truth, may lag by seconds. Display only. */
    leaseExpiresAt: integer("lease_expires_at"),
    /**
     * The fence floor, not a mirror. Written synchronously before any claim or
     * transition returns, guarded by `WHERE fencing_token < :token`. ADR-0002.
     */
    fencingToken: integer("fencing_token").notNull().default(0),
    /** Monotonic coordinator snapshot version used to reject delayed mirrors. */
    mirrorGeneration: integer("mirror_generation").notNull().default(0),
    blockedOn: text("blocked_on"),
    /**
     * Typed pointers at where the work is: `[{kind, value}]`, kind an open
     * string steered by `TODO_REF_KINDS` in `app/concepts/todo-contracts.ts`. A title
     * and a project say what to do and whose it is; these say where to look.
     * V1-20.
     */
    refsJson: text("refs_json").notNull().default("[]"),
    /**
     * The same provenance triple memories carry, under the same names. Was
     * `created_by`, which held the agent and nothing else. The backfilled
     * client is `unknown`: rows written before V1-20 never recorded one.
     */
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull().default("unknown"),
    sourceSession: text("source_session"),
    sourceSessionName: text("source_session_name"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    completedAt: integer("completed_at"),
  },
  (table) => [
    index("todos_state").on(table.state, table.updatedAt),
    index("todos_project").on(table.project),
    index("todos_user_state").on(table.userId, table.state, table.updatedAt),
    check(
      "todos_state_check",
      sql`${table.state} IN ('pending','claimed','done','blocked')`,
    ),
  ],
);

/** Authoritative graph; writes and cycle/readiness checks share the coordinator gate. */
export const todoRelations = sqliteTable(
  "todo_relations",
  {
    userId: text("user_id").notNull(),
    fromTodoId: text("from_todo_id")
      .notNull()
      .references(() => todos.todoId),
    toTodoId: text("to_todo_id")
      .notNull()
      .references(() => todos.todoId),
    kind: text("kind", { enum: ["parent", "depends-on"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.fromTodoId, table.toTodoId, table.kind] }),
    uniqueIndex("todo_relations_one_parent")
      .on(table.fromTodoId)
      .where(sql`${table.kind} = 'parent'`),
    index("todo_relations_inverse").on(
      table.userId,
      table.toTodoId,
      table.kind,
    ),
    check(
      "todo_relations_kind",
      sql`${table.kind} IN ('parent', 'depends-on')`,
    ),
    check(
      "todo_relations_distinct",
      sql`${table.fromTodoId} <> ${table.toTodoId}`,
    ),
  ],
);

/** One opaque admission fence per owner; a recovered attempt can never regain its token. */
export const todoRelationFences = sqliteTable("todo_relation_fences", {
  userId: text("user_id").primaryKey(),
  token: text("token").notNull(),
});

/** Append-only agent progress log. Survives lease expiry. */
export const todoUpdates = sqliteTable(
  "todo_updates",
  {
    updateId: text("update_id").primaryKey(),
    todoId: text("todo_id")
      .notNull()
      .references(() => todos.todoId),
    kind: text("kind", {
      enum: ["progress", "claim", "release", "complete", "blocked"],
    }).notNull(),
    author: text("author").notNull(),
    /** The author's session name, beside `author`, which stays the lease holder. */
    sessionName: text("session_name"),
    /** The fencing token the author held, kept for audit. */
    token: integer("token"),
    body: text("body").notNull().default(""),
    /**
     * One line, written with the row: the author's own or the body's first
     * sentence (`app/concepts/update-summary.ts`). Null on rows written
     * before 0026, which get the same cut at read time.
     */
    summary: text("summary"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("todo_updates_todo").on(table.todoId, table.createdAt),
    check(
      "todo_updates_kind_check",
      sql`${table.kind} IN ('progress','claim','release','complete','blocked')`,
    ),
  ],
);

/**
 * Anyone's note on a to-do: a question, an answer, context. Not a state
 * change, so no token and no coordinator; its own table rather than a kind on
 * `todo_updates`, whose CHECK a new kind would break (ADR-0003 amendment,
 * ADR-0008). Read back merged into the update log, in time order.
 */
export const todoComments = sqliteTable(
  "todo_comments",
  {
    commentId: text("comment_id").primaryKey(),
    todoId: text("todo_id")
      .notNull()
      .references(() => todos.todoId),
    author: text("author").notNull(),
    sourceClient: text("source_client").notNull(),
    sourceSession: text("source_session"),
    sourceSessionName: text("source_session_name"),
    body: text("body").notNull(),
    /** As on `todo_updates`: one line, null on rows from before 0026. */
    summary: text("summary"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [index("todo_comments_todo").on(table.todoId, table.createdAt)],
);

/**
 * A file attached to a to-do. The to-do's side of the link to an `objects`
 * row, so the storage table never learns which concepts point at it. A memory
 * gets its own table of the same shape. ADR-0011.
 */
export const todoAttachments = sqliteTable(
  "todo_attachments",
  {
    todoId: text("todo_id")
      .notNull()
      .references(() => todos.todoId),
    objectId: text("object_id")
      .notNull()
      .references(() => objects.objectId),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.todoId, table.objectId] }),
    index("todo_attachments_todo").on(table.todoId, table.createdAt),
  ],
);

// --- Objects ----------------------------------------------------------------

/**
 * One row per stored file, owned by `app/r2/objects.ts`. The bytes live in R2
 * under `u/{user_id}/objects/{object_id}`; this row is what says whose they
 * are, what they are called, and what to serve them as. Immutable: a changed
 * file is a new object. Not a concept, and not searchable. ADR-0011.
 */
export const objects = sqliteTable(
  "objects",
  {
    objectId: text("object_id").primaryKey(),
    userId: text("user_id").notNull(),
    r2Key: text("r2_key").notNull(),
    /** The uploader's file name, cleaned of any path, for display only. */
    name: text("name").notNull(),
    contentType: text("content_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("objects_user").on(table.userId, table.createdAt),
    uniqueIndex("objects_r2_key").on(table.r2Key),
  ],
);

// --- Assets -----------------------------------------------------------------

/**
 * A file someone chose to keep, with descriptive metadata around one
 * immutable `objects` row. ADR-0015. Pending until its `PUT /uploads/{id}`
 * verifies the bytes and commits the object row, the asset's `ready` state
 * and its projection in one batch; only ready assets are discoverable.
 *
 * The bytes, size and checksum are the object's, so the asset never repeats
 * them. `declared_*` are what the uploader promised at begin, checked at
 * upload and again at finalize. An upload credential is stored as its HMAC
 * digest and dies with the pending state.
 */
export const assets = sqliteTable(
  "assets",
  {
    assetId: text("asset_id").primaryKey(),
    userId: text("user_id").notNull(),
    state: text("state", { enum: ["pending", "ready", "failed"] })
      .notNull()
      .default("pending"),
    /** Null until ready; the object this asset publishes. */
    objectId: text("object_id").references(() => objects.objectId),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    /** The uploader's file name, cleaned of any path. */
    fileName: text("file_name").notNull(),
    contentType: text("content_type").notNull(),
    declaredSize: integer("declared_size").notNull(),
    declaredSha256: text("declared_sha256"),
    project: text("project"),
    tagsJson: text("tags_json").notNull().default("[]"),
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull(),
    sourceSession: text("source_session"),
    uploadTokenDigest: text("upload_token_digest"),
    uploadExpiresAt: integer("upload_expires_at"),
    /** Null keeps the asset. Past it, every delivery path answers missing. */
    expiresAt: integer("expires_at"),
    /** Out of search and lists; bytes and id still resolve. */
    archivedAt: integer("archived_at"),
    /**
     * Null for a file someone chose to keep. `hook` is a runnable hook's
     * file (ADR-0023): no projection, not in Library, not reachable by an
     * agent's `fetch` or `get_asset_download`, and swept once no live
     * version names it. No CHECK: adding one would rebuild the table.
     */
    purpose: text("purpose", { enum: ["hook"] }),
    failure: text("failure"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    finalizedAt: integer("finalized_at"),
  },
  (table) => [
    index("assets_user").on(table.userId, table.createdAt),
    uniqueIndex("assets_object").on(table.objectId),
    index("assets_pending").on(table.state, table.uploadExpiresAt),
    index("assets_expiry").on(table.expiresAt),
    check(
      "assets_state_check",
      sql`${table.state} IN ('pending','ready','failed')`,
    ),
    check(
      "assets_ready_object",
      sql`(${table.state} = 'ready') = (${table.objectId} IS NOT NULL)`,
    ),
  ],
);

// --- Sources ----------------------------------------------------------------

/** Attempts are mutable until settled; successful outputs are immutable. ADR-0015. */
export const assetProcessing = sqliteTable(
  "asset_processing",
  {
    processingId: text("processing_id").primaryKey(),
    userId: text("user_id").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.assetId, { onDelete: "cascade" }),
    generation: integer("generation").notNull(),
    processorVersion: text("processor_version").notNull(),
    state: text("state", {
      enum: ["queued", "running", "ready", "failed"],
    }).notNull(),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
    finishedAt: integer("finished_at"),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
  },
  (table) => [
    uniqueIndex("asset_processing_asset_generation").on(
      table.assetId,
      table.generation,
    ),
    index("asset_processing_asset").on(table.assetId, table.generation),
    index("asset_processing_user_due").on(
      table.userId,
      table.state,
      table.leaseUntil,
    ),
    index("asset_processing_user_created").on(table.userId, table.createdAt),
    check(
      "asset_processing_state",
      sql`${table.state} IN ('queued', 'running', 'ready', 'failed')`,
    ),
  ],
);

export const assetProcessingOutputs = sqliteTable(
  "asset_processing_outputs",
  {
    userId: text("user_id").notNull(),
    processingId: text("processing_id")
      .primaryKey()
      .references(() => assetProcessing.processingId, { onDelete: "cascade" }),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.assetId, { onDelete: "cascade" }),
    objectId: text("object_id").notNull(),
    originalSha256: text("original_sha256").notNull(),
    processorVersion: text("processor_version").notNull(),
    extractor: text("extractor").notNull(),
    text: text("text").notNull(),
    truncated: integer("truncated").notNull(),
    suggestionsJson: text("suggestions_json").notNull(),
    suggestionModel: text("suggestion_model"),
    suggestionError: text("suggestion_error"),
    /**
     * `PassageIndex` from `app/concepts/asset-passages.ts`: code point offsets
     * into `text`, with page, slide or chapter labels. Null on outputs written
     * before passages existed; immutable like the rest of the row.
     */
    passagesJson: text("passages_json"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    check(
      "asset_processing_suggestions_json",
      sql`json_valid(${table.suggestionsJson})`,
    ),
  ],
);

export const assetProcessingAdmissions = sqliteTable(
  "asset_processing_admissions",
  {
    processingId: text("processing_id").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
    attempts: integer("attempts").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until").notNull().default(0),
  },
  (table) => [
    index("asset_processing_admissions_user").on(table.userId, table.createdAt),
  ],
);

export const assetDrainState = sqliteTable("asset_drain_state", {
  namespace: text("namespace").primaryKey(),
  afterUserId: text("after_user_id").notNull().default(""),
  leaseToken: text("lease_token"),
  leaseUntil: integer("lease_until").notNull().default(0),
});

/** Flat owned containers. Every asset has one membership, including singletons. */
export const assetFolders = sqliteTable(
  "asset_folders",
  {
    folderId: text("folder_id").primaryKey(),
    userId: text("user_id").notNull(),
    title: text("title"),
    /** The folder's own tags and notes, beside each file's. ADR-0015. */
    tagsJson: text("tags_json").notNull().default("[]"),
    notes: text("notes").notNull().default(""),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("asset_folders_user_created").on(
      table.userId,
      table.createdAt,
      table.folderId,
    ),
  ],
);

export const assetFolderFiles = sqliteTable(
  "asset_folder_files",
  {
    assetId: text("asset_id")
      .primaryKey()
      .references(() => assets.assetId, { onDelete: "cascade" }),
    folderId: text("folder_id")
      .notNull()
      .references(() => assetFolders.folderId),
    userId: text("user_id").notNull(),
  },
  (table) => [
    index("asset_folder_files_folder").on(table.userId, table.folderId),
  ],
);

export const assetProcessingHeads = sqliteTable("asset_processing_heads", {
  userId: text("user_id").notNull(),
  assetId: text("asset_id")
    .primaryKey()
    .references(() => assets.assetId, { onDelete: "cascade" }),
  processingId: text("processing_id")
    .notNull()
    .references(() => assetProcessingOutputs.processingId, {
      onDelete: "cascade",
    }),
});

export const assetSuggestionDecisions = sqliteTable(
  "asset_suggestion_decisions",
  {
    userId: text("user_id").notNull(),
    processingId: text("processing_id")
      .notNull()
      .references(() => assetProcessingOutputs.processingId, {
        onDelete: "cascade",
      }),
    field: text("field").notNull(),
    value: text("value").notNull().default(""),
    decision: text("decision", { enum: ["accepted", "dismissed"] }).notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.processingId, table.field, table.value] }),
    check(
      "asset_suggestion_decision",
      sql`${table.decision} IN ('accepted', 'dismissed')`,
    ),
  ],
);

/** Retains external deletion targets even after originals and outputs are deleted. */
export const assetVectorPending = sqliteTable(
  "asset_vector_pending",
  {
    namespace: text("namespace").notNull(),
    userId: text("user_id").notNull(),
    processingId: text("processing_id").notNull(),
    assetId: text("asset_id").notNull(),
    chunk: integer("chunk").notNull(),
    stamp: text("stamp").notNull(),
    epoch: integer("epoch").notNull().default(1),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until").notNull().default(0),
    mutationId: text("mutation_id"),
    errorCode: text("error_code"),
  },
  (table) => [
    primaryKey({ columns: [table.namespace, table.processingId, table.chunk] }),
    index("asset_vector_due").on(
      table.namespace,
      table.userId,
      table.nextAttemptAt,
      table.leaseUntil,
    ),
    index("asset_vector_asset").on(table.userId, table.assetId),
  ],
);

/**
 * The bookmark twin of `asset_vector_pending`: one row per passage of an
 * enrichment, kept after the source is deleted so its vectors can be.
 */
export const sourceVectorPending = sqliteTable(
  "source_vector_pending",
  {
    namespace: text("namespace").notNull(),
    userId: text("user_id").notNull(),
    enrichmentId: text("enrichment_id").notNull(),
    sourceId: text("source_id").notNull(),
    chunk: integer("chunk").notNull(),
    stamp: text("stamp").notNull(),
    epoch: integer("epoch").notNull().default(1),
    attempts: integer("attempts").notNull().default(0),
    nextAttemptAt: integer("next_attempt_at").notNull().default(0),
    leaseToken: text("lease_token"),
    leaseUntil: integer("lease_until").notNull().default(0),
    mutationId: text("mutation_id"),
    errorCode: text("error_code"),
  },
  (table) => [
    primaryKey({
      columns: [table.namespace, table.enrichmentId, table.chunk],
    }),
    index("source_vector_due").on(
      table.namespace,
      table.userId,
      table.nextAttemptAt,
      table.leaseUntil,
    ),
    index("source_vector_source").on(table.userId, table.sourceId),
  ],
);

/**
 * A durable knowledge entry: a bookmark, a document, an image, or a
 * reference, with notes someone wrote and links to ready assets. ADR-0015.
 * The row is the head; `revision` names the `source_revisions` row it
 * matches, and a save with a stale expected revision is refused. `kind` has
 * no CHECK, for the reason `search_docs.concept` has none; the tool schema
 * holds the vocabulary.
 */
export const sources = sqliteTable(
  "sources",
  {
    sourceId: text("source_id").primaryKey(),
    userId: text("user_id").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    notes: text("notes").notNull().default(""),
    project: text("project"),
    tagsJson: text("tags_json").notNull().default("[]"),
    /** Who wrote it, as given: a JSON array of names, in byline order. */
    authorsJson: text("authors_json").notNull().default("[]"),
    revision: integer("revision").notNull(),
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull(),
    sourceSession: text("source_session"),
    /** When the page or post was published, as its saver gave it; null when
     * unknown. Reads fall back to the newest article's `published`. */
    publishedAt: integer("published_at"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    archivedAt: integer("archived_at"),
  },
  (table) => [
    index("sources_user").on(table.userId, table.createdAt),
    index("sources_project").on(table.project),
    // A bookmark saved again by URL revises the one already held.
    index("sources_user_url").on(table.userId, table.url),
  ],
);

/**
 * Append-only: every revision of a source, the first included, as it was
 * saved. The UNIQUE pair is the conflict guard: two saves from the same
 * expected revision race to insert the same number, and one fails.
 */
export const sourceRevisions = sqliteTable(
  "source_revisions",
  {
    revisionId: text("revision_id").primaryKey(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.sourceId),
    revision: integer("revision").notNull(),
    kind: text("kind").notNull(),
    title: text("title").notNull(),
    url: text("url"),
    notes: text("notes").notNull().default(""),
    project: text("project"),
    tagsJson: text("tags_json").notNull().default("[]"),
    authorsJson: text("authors_json").notNull().default("[]"),
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull(),
    sourceSession: text("source_session"),
    publishedAt: integer("published_at"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    uniqueIndex("source_revisions_source_revision").on(
      table.sourceId,
      table.revision,
    ),
  ],
);

/**
 * Which assets each revision linked, in order. Append-only with its
 * revision. Any row here, head or history, protects its asset from expiry
 * and deletion until the source itself is deleted. ADR-0015.
 */
export const sourceRevisionAssets = sqliteTable(
  "source_revision_assets",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.sourceId),
    revision: integer("revision").notNull(),
    assetId: text("asset_id")
      .notNull()
      .references(() => assets.assetId),
    position: integer("position").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.revision, table.assetId] }),
    index("source_revision_assets_asset").on(table.assetId),
  ],
);

/**
 * The readable article a client extracted from the page behind a source,
 * with the page's own metadata. Append-only: a save that carries an article
 * adds a row at that revision, and the source reads its newest row. Search
 * indexes `text`; `markdown` is what a person reads. The linked HTML asset
 * stays the archive original.
 */
export const sourceArticles = sqliteTable(
  "source_articles",
  {
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.sourceId),
    revision: integer("revision").notNull(),
    userId: text("user_id").notNull(),
    /** False when no article was found and only the full page was kept. */
    detected: integer("detected", { mode: "boolean" }).notNull(),
    markdown: text("markdown").notNull().default(""),
    text: text("text").notNull().default(""),
    truncated: integer("truncated", { mode: "boolean" })
      .notNull()
      .default(false),
    wordCount: integer("word_count").notNull().default(0),
    pageWordCount: integer("page_word_count").notNull().default(0),
    extractor: text("extractor").notNull(),
    published: text("published"),
    siteName: text("site_name"),
    canonicalUrl: text("canonical_url"),
    leadImage: text("lead_image"),
    description: text("description"),
    language: text("language"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.sourceId, table.revision] }),
    index("source_articles_user").on(table.userId),
  ],
);

/**
 * One processing attempt for a source revision: the page fetch, if Valise
 * fetched one, a generated summary and key concepts, the article's passage
 * index, and what the model call cost. Append-only; the newest ready row is
 * the source's current enrichment. Also the cost ledger the daily budget
 * reads. ADR-0015, amendment of 2026-10-29 (bookmarks).
 */
export const sourceEnrichments = sqliteTable(
  "source_enrichments",
  {
    enrichmentId: text("enrichment_id").primaryKey(),
    userId: text("user_id").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.sourceId),
    /** The source revision this attempt read. */
    revision: integer("revision").notNull(),
    /** The `source_articles` revision summarised and split, if any. */
    articleRevision: integer("article_revision"),
    /** ready, failed, or skipped (nothing to summarise). */
    state: text("state").notNull(),
    /** fetched, not_article, paywalled, robots_disallowed, fetch_failed; null when no fetch was tried. */
    fetchStatus: text("fetch_status"),
    summary: text("summary"),
    conceptsJson: text("concepts_json").notNull().default("[]"),
    /** Tags the model suggested, not yet the source's; the person adds them. */
    suggestedTagsJson: text("suggested_tags_json").notNull().default("[]"),
    /** Suggested tags the person dismissed, so they are not offered again. */
    dismissedTagsJson: text("dismissed_tags_json").notNull().default("[]"),
    /** Linked images this attempt was owed, at most the summary's cap. A
     * newer revision linking more images makes the source owed again. */
    imagesLinked: integer("images_linked").notNull().default(0),
    /** How many of those the model was shown; the rest were too large or unreadable. */
    imagesRead: integer("images_read").notNull().default(0),
    /** `PassageIndex` over the article text; null without an article. */
    passagesJson: text("passages_json"),
    model: text("model"),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Millionths of a US dollar at Workers AI list price. */
    costMicrousd: integer("cost_microusd").notNull().default(0),
    errorCode: text("error_code"),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    index("source_enrichments_source").on(table.sourceId, table.revision),
    index("source_enrichments_user_time").on(table.userId, table.createdAt),
    check(
      "source_enrichments_state",
      sql`${table.state} IN ('ready', 'failed', 'skipped')`,
    ),
  ],
);

// --- Auth ------------------------------------------------------------------

// All auth timestamps are Unix seconds.

/**
 * One row per person who can sign in. `local` is the owner: the user every
 * row written before multi-user belongs to, the one the administrator
 * password still signs in as, and the one the address it records signs in
 * to. Another address `VALISE_ADMIN_EMAILS` lists is its own member row with
 * admin pages; everyone else arrives through an invite. ADR-0016.
 */
export const users = sqliteTable(
  "users",
  {
    userId: text("user_id").primaryKey(),
    /** Lowercased; password registrations remain pending until emailVerified. */
    email: text("email"),
    displayName: text("display_name").notNull().default(""),
    role: text("role", { enum: ["owner", "member"] })
      .notNull()
      .default("member"),
    /** `free` until billing exists; the plan document names the tiers. */
    plan: text("plan").notNull().default("free"),
    /** The invite that admitted this user, null for the owner. */
    inviteId: text("invite_id"),
    createdAt: integer("created_at").notNull(),
    lastSeenAt: integer("last_seen_at"),
    passwordHash: text("password_hash"),
    emailVerified: integer("email_verified", { mode: "boolean" })
      .notNull()
      .default(false),
    verificationToken: text("verification_token"),
    verificationExpiresAt: integer("verification_expires_at"),
    /** When the first-run checklist was dismissed; null while it shows. */
    onboardingDismissedAt: integer("onboarding_dismissed_at"),
  },
  (table) => [
    uniqueIndex("users_email_unique").on(table.email),
    index("users_invite").on(table.inviteId),
    check("users_role_check", sql`${table.role} IN ('owner','member')`),
  ],
);

/** Built-in release completion and expiring fencing leases, per account. */
export const builtinSkillSync = sqliteTable("builtin_skill_sync", {
  userId: text("user_id")
    .primaryKey()
    .references(() => users.userId, { onDelete: "cascade" }),
  completedVersion: text("completed_version"),
  targetVersion: text("target_version").notNull(),
  leaseToken: text("lease_token"),
  leaseExpiresAt: integer("lease_expires_at").notNull().default(0),
  retryAfter: integer("retry_after").notNull().default(0),
  lastError: text("last_error"),
});

/** Resumable keyset scan; a failed tenant never pins the next minute's page. */
export const builtinSkillSweep = sqliteTable("builtin_skill_sweep", {
  id: integer("id").primaryKey(),
  afterUserId: text("after_user_id").notNull().default(""),
});

/**
 * The gate on sign-up. One-person invites can bind an email; group invites
 * admit multiple accounts until expiry or withdrawal. Redemption records the
 * latest signup; users.invite_id retains every account's origin.
 * Revoked and expired invites stay as rows, so the people page can say what
 * happened to each. ADR-0016.
 */
export const invites = sqliteTable(
  "invites",
  {
    inviteId: text("invite_id").primaryKey(),
    /** What the link carries. Random, unguessable, unique. */
    code: text("code").notNull(),
    /** Who it is for, in the owner's words. */
    label: text("label").notNull().default(""),
    /** When set, this email must be verified before sign-in. */
    email: text("email"),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at"),
    reusable: integer("reusable", { mode: "boolean" }).notNull().default(false),
    redeemedAt: integer("redeemed_at"),
    redeemedBy: text("redeemed_by"),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("invites_code_unique").on(table.code),
    index("invites_created").on(table.createdBy, table.createdAt),
  ],
);

/** Opaque browser session ids. Timestamps are Unix seconds. */
export const sessions = sqliteTable(
  "sessions",
  {
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("sessions_user_id").on(table.userId)],
);

/**
 * One-time password-reset links the owner issues for a member on /people.
 * The link carries a 256-bit token; only its SHA-256 is stored. A row is
 * also the record of who issued it and when it was used. ADR-0016,
 * amendment of 2026-10-29 (reset).
 */
export const passwordResets = sqliteTable(
  "password_resets",
  {
    resetId: text("reset_id").primaryKey(),
    userId: text("user_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    usedAt: integer("used_at"),
    /** Set when a newer link for the same member replaced this one. */
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("password_resets_token_hash_unique").on(table.tokenHash),
    index("password_resets_user_created").on(table.userId, table.createdAt),
  ],
);

/** Long-lived CLI credentials. The raw bearer token is never persisted. */
export const bearerTokens = sqliteTable(
  "bearer_tokens",
  {
    tokenId: text("token_id").primaryKey(),
    userId: text("user_id").notNull(),
    label: text("label").notNull(),
    tokenDigest: text("token_digest").notNull(),
    createdAt: integer("created_at").notNull(),
    revokedAt: integer("revoked_at"),
  },
  (table) => [
    uniqueIndex("bearer_tokens_token_digest_unique").on(table.tokenDigest),
    index("bearer_tokens_user_id").on(table.userId),
  ],
);

/**
 * One row per granted scope, for the seven scopes 0001 knew. Timestamps live
 * on `bearer_tokens`. The CHECK lists those seven literally, and SQLite widens
 * a CHECK only by rebuilding the table, which ADR-0008 makes a by-hand
 * migration. Later scopes live in `bearer_token_grants`; a token's scope set
 * is the union of both tables.
 */
export const bearerTokenScopes = sqliteTable(
  "bearer_token_scopes",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => bearerTokens.tokenId),
    scope: text("scope", { enum: MCP_SCOPES }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.tokenId, table.scope] }),
    check(
      "bearer_token_scopes_scope_check",
      sql`${table.scope} IN ('search:read','todos:read','todos:write','memories:read','memories:write','skills:read','skills:write')`,
    ),
  ],
);

/**
 * Scopes added to the vocabulary after `bearer_token_scopes`, starting with
 * `config:read`. No CHECK: `resolveBearerToken` refuses a token holding any
 * scope outside `MCP_SCOPES`, so an unknown row fails closed.
 */
export const bearerTokenGrants = sqliteTable(
  "bearer_token_grants",
  {
    tokenId: text("token_id")
      .notNull()
      .references(() => bearerTokens.tokenId),
    scope: text("scope").notNull(),
  },
  (table) => [primaryKey({ columns: [table.tokenId, table.scope] })],
);

// --- Hook config ------------------------------------------------------------

/**
 * The document a hook client caches as `~/.valise/config.json`, one per user.
 * Stored as the JSON text the client parses, so the console and the client
 * validate the same bytes. Read by `GET /config/hooks` under `config:read`.
 */
export const hookConfigs = sqliteTable("hook_configs", {
  userId: text("user_id").primaryKey(),
  document: text("document").notNull(),
  updatedAt: integer("updated_at").notNull(),
});

// --- Runnable hooks ---------------------------------------------------------

/**
 * A named hook that runs a command on the owner's machines, ADR-0023. Its
 * content lives in versions; what runs is decided by approval events. Kept
 * out of `hook_configs`, which agents edit field by field under
 * `config:write`.
 */
export const hookRunnables = sqliteTable(
  "hook_runnables",
  {
    runnableId: text("runnable_id").primaryKey(),
    userId: text("user_id").notNull(),
    name: text("name").notNull(),
    createdAt: integer("created_at").notNull(),
    /** Set in the console; a disabled entry is never in the manifest. */
    disabledAt: integer("disabled_at"),
  },
  (table) => [uniqueIndex("hook_runnables_name").on(table.userId, table.name)],
);

/**
 * One proposed content of a runnable entry, keyed by the SHA-256 of its
 * canonical JSON (`runnableVersionHash`). The content columns are never
 * updated. `proposed_at` and `expires_at` are the latest proposal of that
 * content: proposing identical content again after a rejection or expiry
 * renews them, so the same hash is pending again.
 */
export const hookRunnableVersions = sqliteTable(
  "hook_runnable_versions",
  {
    userId: text("user_id").notNull(),
    versionHash: text("version_hash").notNull(),
    runnableId: text("runnable_id")
      .notNull()
      .references(() => hookRunnables.runnableId),
    event: text("event", {
      enum: ["SessionStart", "Stop", "SessionEnd"],
    }).notNull(),
    argvJson: text("argv_json").notNull(),
    gatesJson: text("gates_json").notNull(),
    outputsJson: text("outputs_json").notNull(),
    timeoutSeconds: integer("timeout_seconds").notNull(),
    dailyCapMicrousd: integer("daily_cap_microusd").notNull(),
    maxRunsPerDay: integer("max_runs_per_day").notNull(),
    /** `[{ path, sha256, size, asset_id }]`, sorted by path. */
    filesJson: text("files_json").notNull(),
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull(),
    sourceSession: text("source_session"),
    proposedAt: integer("proposed_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.versionHash] }),
    index("hook_runnable_versions_runnable").on(
      table.runnableId,
      table.proposedAt,
    ),
    check(
      "hook_runnable_versions_event",
      sql`${table.event} IN ('SessionStart', 'Stop', 'SessionEnd')`,
    ),
  ],
);

/**
 * Append-only decisions on a version. Its state is the latest decision made
 * at or after its `proposed_at`; with none it is pending until it expires.
 * `credential_id` is the passkey that made an approval.
 */
export const hookRunnableDecisions = sqliteTable(
  "hook_runnable_decisions",
  {
    decisionId: integer("decision_id").primaryKey({ autoIncrement: true }),
    userId: text("user_id").notNull(),
    versionHash: text("version_hash").notNull(),
    decision: text("decision", {
      enum: ["approved", "rejected", "revoked", "suspended"],
    }).notNull(),
    credentialId: text("credential_id"),
    at: integer("at").notNull(),
    reason: text("reason"),
  },
  (table) => [
    index("hook_runnable_decisions_version").on(
      table.userId,
      table.versionHash,
    ),
    check(
      "hook_runnable_decisions_decision",
      sql`${table.decision} IN ('approved', 'rejected', 'revoked', 'suspended')`,
    ),
  ],
);

/**
 * One run of a runnable entry on one machine, as its runner reported it,
 * ADR-0023. `run_id` is the runner's own id, so a report sent twice is one
 * row. Feeds the manifest's cross-machine daily cost and run count and the
 * brief's results line; kept 90 days, and never part of `spend_daily`, since
 * a hook's model call is paid by the owner's own account.
 */
export const hookRuns = sqliteTable(
  "hook_runs",
  {
    userId: text("user_id").notNull(),
    runId: text("run_id").notNull(),
    runnableId: text("runnable_id")
      .notNull()
      .references(() => hookRunnables.runnableId),
    versionHash: text("version_hash").notNull(),
    machine: text("machine").notNull(),
    session: text("session"),
    repo: text("repo"),
    /** Unix seconds when the run started, as the runner saw it. */
    startedAt: integer("started_at").notNull(),
    durationMs: integer("duration_ms").notNull(),
    outcome: text("outcome", {
      enum: ["ok", "failed", "timeout", "violation"],
    }).notNull(),
    /** What the entry reported to `$VALISE_HOOK_REPORT`; null is unpriced. */
    costMicrousd: integer("cost_microusd"),
    /** The entry's own result line, at most 2 KiB. */
    result: text("result"),
    receivedAt: integer("received_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.runId] }),
    index("hook_runs_runnable").on(
      table.userId,
      table.runnableId,
      table.startedAt,
    ),
    check(
      "hook_runs_outcome",
      sql`${table.outcome} IN ('ok', 'failed', 'timeout', 'violation')`,
    ),
  ],
);

// --- Observability ----------------------------------------------------------

// Both tables below keep time in milliseconds, unlike every other timestamp in
// this schema. Ordering inside one second matters in a log and durations are
// milliseconds anyway. Neither joins to a table that uses seconds. ADR-0006.

/**
 * One row per MCP request, written from the wrapper in `workers/mcp.ts` that
 * every transport passes through, including the rate-limit and preflight
 * rejections that return before dispatch. Written through `ctx.waitUntil`, so
 * a row never costs the caller latency.
 */
export const mcpCalls = sqliteTable(
  "mcp_calls",
  {
    callId: text("call_id").primaryKey(),
    /** Unix milliseconds. */
    at: integer("at").notNull(),
    transport: text("transport", {
      enum: ["oauth", "bearer", "loopback"],
    }).notNull(),
    userId: text("user_id"),
    /** OAuth client id, bearer token label, or the dev agent header. */
    principal: text("principal"),
    /** The provenance triple the concepts carry, so a call joins to its writes. */
    agent: text("agent"),
    client: text("client"),
    session: text("session"),
    /** HTTP verb, separate from the JSON-RPC method. Null on older rows. */
    httpMethod: text("http_method"),
    /** Effective rate-limit header dimensions, including their fallbacks. */
    limiterMethod: text("limiter_method"),
    limiterName: text("limiter_name"),
    /** The JSON-RPC method: `tools/call`, `tools/list`, `resources/read`. */
    method: text("method").notNull(),
    /** The tool name on a `tools/call`, null on everything else. */
    tool: text("tool"),
    requiredScope: text("required_scope"),
    /** The arguments as sent, capped at 8KB. The point of the table. */
    argsJson: text("args_json"),
    /** Length before the cap, so a truncation reads as one. */
    argsBytes: integer("args_bytes"),
    /**
     * Why the agent says it made the call, from a `why` argument or from a
     * SEP-2817 `_meta` reason. Model-asserted, so it is a thing the model
     * said rather than the reason it called, and nothing reads it but a
     * person on the logs tab. ADR-0007.
     */
    intent: text("intent"),
    outcome: text("outcome", {
      enum: [
        "ok",
        "tool_error",
        "invalid_input",
        "insufficient_scope",
        "rate_limited",
        "unauthorized",
        "protocol_error",
      ],
    }).notNull(),
    errorCode: text("error_code"),
    /**
     * Why a failed call failed, in the words the response gave: the tool's
     * `isError` text or a JSON-RPC `error.message`. Capped at 2KB. Null on
     * `ok` and on rows written before the column existed.
     */
    errorMessage: text("error_message"),
    status: integer("status").notNull(),
    durationMs: integer("duration_ms").notNull(),
    resultBytes: integer("result_bytes"),
    /**
     * Who the client says it is, all self-reported, so they label a row and
     * authorize nothing. `client_info` is the protocol's `clientInfo` as
     * `name version`, which the stateless protocol sends on every request.
     * The rest come from the `X-Valise-*` headers the plugin's
     * `headersHelper` adds: the Claude Code session, its name, the machine,
     * and the plugin version, which is null for a client without the plugin.
     */
    clientInfo: text("client_info"),
    userAgent: text("user_agent"),
    sessionName: text("session_name"),
    host: text("host"),
    plugin: text("plugin"),
    /**
     * The item the call acted on, as `todo:`, `memory:` or `skill:` plus its
     * id: the `id` argument of a tool that takes one, or the `id` in the
     * result of a tool that creates or resolves one. Null on every other call
     * and on rows written before the column existed.
     */
    targetId: text("target_id"),
    /**
     * What `search`'s rerank stage did, as JSON: `{ backend, reranked, ms }`
     * and a `fallback` reason when the result came back in FTS order. Read
     * from the result's `_meta`. Null on every other tool, on a search that
     * ran no reranker, and on rows written before the column existed.
     */
    rerankJson: text("rerank_json"),
    /** First ten delivered search ids, not retrieval or reranking candidates. */
    searchResultIdsJson: text("search_result_ids_json"),
  },
  (table) => [
    index("mcp_calls_at").on(table.at),
    index("mcp_calls_user_at").on(table.userId, table.at),
    index("mcp_calls_target_at").on(table.targetId, table.at),
    index("mcp_calls_tool_at").on(table.tool, table.at),
    index("mcp_calls_outcome_at").on(table.outcome, table.at),
    check(
      "mcp_calls_transport_check",
      sql`${table.transport} IN ('oauth','bearer','loopback')`,
    ),
    check(
      "mcp_calls_outcome_check",
      sql`${table.outcome} IN ('ok','tool_error','invalid_input','insufficient_scope','rate_limited','unauthorized','protocol_error')`,
    ),
  ],
);

/**
 * Who got in and who was refused. `sessions` already implies the successful
 * logins; a refusal is the row worth having when something is wrong.
 */
export const authEvents = sqliteTable(
  "auth_events",
  {
    eventId: text("event_id").primaryKey(),
    /** Unix milliseconds. */
    at: integer("at").notNull(),
    kind: text("kind", {
      enum: [
        "console_login",
        "console_login_failed",
        "console_logout",
        "oauth_grant",
        "oauth_denied",
      ],
    }).notNull(),
    userId: text("user_id"),
    /** The OAuth client name on a consent decision, null on a console event. */
    subject: text("subject"),
    /** Granted scopes, the redirect host, or whatever the kind makes useful. */
    detail: text("detail"),
    ip: text("ip"),
    userAgent: text("user_agent"),
  },
  (table) => [
    index("auth_events_at").on(table.at),
    index("auth_events_user_at").on(table.userId, table.at),
    index("auth_events_kind_at").on(table.kind, table.at),
    check(
      "auth_events_kind_check",
      sql`${table.kind} IN ('console_login','console_login_failed','console_logout','oauth_grant','oauth_denied')`,
    ),
  ],
);

// --- The search projection --------------------------------------------------

/**
 * Derived and disposable. Five frozen content columns plus a rowid and a
 * timestamp. Excluded from backups, rebuilt by `reindex`. The FTS5 virtual
 * table `search_docs_fts`, its three sync triggers, and `search_docs_vocab`
 * are hand-written at the tail of `drizzle/0023_search_docs.sql`, because
 * drizzle-kit generates ordinary tables only.
 *
 * `concept` has no CHECK. The first projection table listed its concepts in
 * one, which SQLite widens only by rebuilding the table, so a new concept
 * would have been a by-hand migration (ADR-0008). `SearchConcept` is the
 * vocabulary, enforced by the type of `ProjectionRow`, which every write in
 * `app/search/write.ts` takes.
 * ADR-0015, amendment of 2026-10-21.
 */
export const searchDocs = sqliteTable(
  "search_docs",
  {
    /** The FTS content_rowid. */
    id: integer("id").primaryKey({ autoIncrement: false }),
    /** `<concept>:<id>`, one of `SearchConcept`. */
    docKey: text("doc_key").notNull(),
    /**
     * The owner of the source row, copied at projection time so a search is
     * one more column predicate rather than a join back per concept.
     * ADR-0016.
     */
    userId: text("user_id").notNull().default("local"),
    concept: text("concept").notNull(),
    conceptId: text("concept_id").notNull(),
    project: text("project"),
    title: text("title").notNull().default(""),
    /** Capped at 16KB at projection time. */
    body: text("body").notNull().default(""),
    /** Space-joined tags. */
    tags: text("tags").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("search_docs_doc_key").on(table.docKey),
    index("search_docs_user").on(table.userId, table.concept),
    index("search_docs_concept").on(table.concept),
    index("search_docs_project").on(table.project),
  ],
);

/**
 * The first projection, retired by `search_docs` and no longer read or
 * written by app code. Its CHECK admits only skill, memory and to-do rows.
 * Kept declared so drizzle-kit does not generate a DROP: dropping it is a
 * by-hand migration (ADR-0008) for a later merge. Until then, triggers from
 * `0023_search_docs.sql` forward any write that still reaches it, from a
 * Worker deployed before the cutover, into `search_docs`.
 */
export const searchIndex = sqliteTable(
  "search_index",
  {
    /** The FTS content_rowid. */
    id: integer("id").primaryKey({ autoIncrement: false }),
    /** `skill:<id>` | `memory:<id>` | `todo:<id>`. */
    docKey: text("doc_key").notNull(),
    concept: text("concept", { enum: ["skill", "memory", "todo"] }).notNull(),
    conceptId: text("concept_id").notNull(),
    /**
     * The one filter dimension every concept shares. Amends ADR-0001's five
     * columns to six, so a project filter stays a column predicate instead of
     * a per-concept join back to the authoritative table.
     */
    project: text("project"),
    title: text("title").notNull().default(""),
    /** Capped at 16KB at projection time. */
    body: text("body").notNull().default(""),
    /** Space-joined tags. */
    tags: text("tags").notNull().default(""),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("search_index_doc_key").on(table.docKey),
    index("search_index_concept").on(table.concept),
    index("search_index_project").on(table.project),
    check(
      "search_index_concept_check",
      sql`${table.concept} IN ('skill','memory','todo')`,
    ),
  ],
);

// --- Scheduled backups --------------------------------------------------------

/**
 * One row per scheduled backup run, written by the backup Workflow. The R2
 * manifest is what makes a snapshot complete; this row is what the workbench
 * and the staleness check read. Operational, not restored. ADR-0019.
 */
export const backupRuns = sqliteTable(
  "backup_runs",
  {
    snapshot: text("snapshot").primaryKey(),
    state: text("state").notNull(),
    startedAt: integer("started_at").notNull(),
    finishedAt: integer("finished_at"),
    attempts: integer("attempts").notNull().default(0),
    originals: integer("originals"),
    databaseBytes: integer("database_bytes"),
    error: text("error"),
  },
  (table) => [
    index("backup_runs_started").on(table.startedAt),
    check(
      "backup_runs_state_check",
      sql`${table.state} IN ('running','complete','failed')`,
    ),
  ],
);

/**
 * The single row that keeps backup alerts to one email per incident. An
 * incident is everything since the last complete snapshot. ADR-0019.
 */
export const backupAlerts = sqliteTable(
  "backup_alerts",
  {
    id: integer("id").primaryKey(),
    /** When the monitor first ran: the staleness baseline before any snapshot. */
    firstCheckedAt: integer("first_checked_at").notNull(),
    incident: text("incident"),
    alertedAt: integer("alerted_at"),
  },
  (table) => [check("backup_alerts_single_row", sql`${table.id} = 1`)],
);

/**
 * What the owner and their agents did with a library item: opened it in the
 * console reader, or an agent fetched it. Append-only and kept forever; it
 * only orders search results, never hides an item. Repeats within half an
 * hour are one event. ADR-0015, amendment of 2026-11-01 (use).
 */
export const libraryUseEvents = sqliteTable(
  "library_use_events",
  {
    eventId: text("event_id").primaryKey(),
    userId: text("user_id").notNull(),
    /** `source` or `asset`; no CHECK, as `search_docs.concept` has none. */
    concept: text("concept").notNull(),
    conceptId: text("concept_id").notNull(),
    kind: text("kind").notNull(),
    at: integer("at").notNull(),
  },
  (table) => [
    index("library_use_item").on(
      table.userId,
      table.concept,
      table.conceptId,
      table.at,
    ),
    check("library_use_kind", sql`${table.kind} IN ('opened', 'fetched')`),
  ],
);

/** One to three stars on a library item; the row is removed when cleared. */
export const libraryRatings = sqliteTable(
  "library_ratings",
  {
    userId: text("user_id").notNull(),
    concept: text("concept").notNull(),
    conceptId: text("concept_id").notNull(),
    stars: integer("stars").notNull(),
    ratedAt: integer("rated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.userId, table.concept, table.conceptId] }),
    check("library_rating_stars", sql`${table.stars} BETWEEN 1 AND 3`),
  ],
);

/**
 * The searched failed-command hook's injections per session: one row per
 * error fingerprint injected, so the same error injects once a session and a
 * session gets at most three. Pruned past 24 hours on write. Not searchable
 * content. ADR-0004, 2026-11-04.
 */
export const hookRecallInjections = sqliteTable(
  "hook_recall_injections",
  {
    userId: text("user_id").notNull(),
    sessionId: text("session_id").notNull(),
    /** SHA-256 hex of `normaliseError(error)`. */
    fingerprint: text("fingerprint").notNull(),
    createdAt: integer("created_at").notNull(),
  },
  (table) => [
    primaryKey({
      columns: [table.userId, table.sessionId, table.fingerprint],
    }),
    index("hook_recall_injections_age").on(table.userId, table.createdAt),
  ],
);

// --- Transcripts ------------------------------------------------------------

/**
 * One agent session's distilled conversation, as the Valise CLI sent it or an
 * import read it. A session is identified by its client, the device and the
 * client's own session id; the turns hang off it in `transcript_turns`.
 * `chain_hash` folds every turn hash in order, so a writer can tell whether
 * its history and the server's agree before appending. ADR-0022.
 */
export const transcripts = sqliteTable(
  "transcripts",
  {
    transcriptId: text("transcript_id").primaryKey(),
    userId: text("user_id").notNull(),
    /** `claude-code`, `codex`, `opencode`: the program that held the session. */
    client: text("client").notNull(),
    /** The machine, as the writer names it. */
    device: text("device").notNull(),
    sessionId: text("session_id").notNull(),
    cwd: text("cwd"),
    gitBranch: text("git_branch"),
    project: text("project"),
    model: text("model"),
    /** The first human turn's first line, for lists. */
    title: text("title").notNull().default(""),
    turnCount: integer("turn_count").notNull().default(0),
    chainHash: text("chain_hash").notNull().default(""),
    firstAt: integer("first_at"),
    lastAt: integer("last_at"),
    sourceAgent: text("source_agent").notNull(),
    sourceClient: text("source_client").notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    uniqueIndex("transcripts_session").on(
      table.userId,
      table.client,
      table.device,
      table.sessionId,
    ),
    index("transcripts_user").on(table.userId, table.updatedAt),
    index("transcripts_project").on(table.project),
  ],
);

/**
 * Append-only: one row per turn, at its position in the session. `kind` is
 * one of `TURN_KINDS` in `app/concepts/transcripts.ts`; no CHECK, so a new
 * kind is not a by-hand migration (ADR-0008). `hash` is the turn's own
 * digest, what a resend is compared against.
 */
export const transcriptTurns = sqliteTable(
  "transcript_turns",
  {
    transcriptId: text("transcript_id").notNull(),
    position: integer("position").notNull(),
    kind: text("kind").notNull(),
    text: text("text").notNull(),
    toolName: text("tool_name"),
    at: integer("at"),
    hash: text("hash").notNull(),
  },
  (table) => [primaryKey({ columns: [table.transcriptId, table.position] })],
);
