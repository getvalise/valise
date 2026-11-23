import { memoryProjectionStatements } from "~/search/memory";
import { type ConsoleMemory, getMemory, type Provenance } from "./memories";

export const SUBJECT_KINDS = ["profile", "topic", "area", "person"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
export type Subject = {
  id: string;
  name: string;
  kind: SubjectKind;
  description: string;
  summaryId: string | null;
  summary: ConsoleMemory | null;
  count: number;
  newestEvidence: number | null;
  conflicts: number;
  freshness: "missing" | "needs review" | "current against linked evidence";
  /** Set when deleted; a deleted subject is shown only on its own page. */
  deletedAt: number | null;
};

type SubjectRow = {
  subject_id: string;
  name: string;
  kind: SubjectKind;
  description: string;
  summary_memory_id: string | null;
  member_count: number;
  newest_evidence: number | null;
  conflicts: number;
  deleted_at: number | null;
};

/** A subject that has not been deleted. */
const LIVE = "deleted_at IS NULL";

const SUBJECT_SELECT = `SELECT s.subject_id, s.name, s.kind, s.description, s.summary_memory_id, s.deleted_at,
  (SELECT COUNT(*) FROM memory_subject_members sm JOIN memories m ON m.memory_id = sm.memory_id
     WHERE sm.subject_id = s.subject_id AND sm.removed_at IS NULL AND sm.confirmed_at IS NOT NULL
       AND m.user_id = s.user_id AND m.deleted_at IS NULL) AS member_count,
  (SELECT MAX(event_at) FROM (
    SELECT MAX(m.updated_at, sm.created_at, sm.confirmed_at) AS event_at FROM memory_subject_members sm
      JOIN memories m ON m.memory_id = sm.memory_id
       WHERE sm.subject_id = s.subject_id AND sm.removed_at IS NULL AND sm.confirmed_at IS NOT NULL
         AND m.user_id = s.user_id AND m.deleted_at IS NULL
    UNION ALL
    SELECT MAX(removed_at) FROM memory_subject_members WHERE subject_id = s.subject_id
    UNION ALL
    SELECT MAX(m.deleted_at) FROM memory_subject_members sm
      JOIN memories m ON m.memory_id = sm.memory_id
      WHERE sm.subject_id = s.subject_id AND sm.removed_at IS NULL
  )) AS newest_evidence,
  (SELECT COUNT(*) FROM memory_links l
    JOIN memory_subject_members a ON a.memory_id = l.from_memory_id AND a.subject_id = s.subject_id
    JOIN memory_subject_members b ON b.memory_id = l.to_memory_id AND b.subject_id = s.subject_id
     JOIN memories left_source ON left_source.memory_id = a.memory_id AND left_source.user_id = s.user_id AND left_source.deleted_at IS NULL
     JOIN memories right_source ON right_source.memory_id = b.memory_id AND right_source.user_id = s.user_id AND right_source.deleted_at IS NULL
    WHERE l.kind = 'contradicts' AND l.confirmed_at IS NOT NULL AND l.removed_at IS NULL
      AND a.confirmed_at IS NOT NULL AND b.confirmed_at IS NOT NULL
      AND a.removed_at IS NULL AND b.removed_at IS NULL) AS conflicts
 FROM memory_subjects s`;

async function subjectFromRow(
  db: D1Database,
  userId: string,
  row: SubjectRow,
): Promise<Subject> {
  const summary = row.summary_memory_id
    ? await getMemory(db, userId, row.summary_memory_id)
    : null;
  return {
    id: row.subject_id,
    name: row.name,
    kind: row.kind,
    description: row.description,
    summaryId: row.summary_memory_id,
    summary,
    count: row.member_count,
    newestEvidence: row.newest_evidence,
    conflicts: row.conflicts,
    freshness: !summary
      ? "missing"
      : row.newest_evidence !== null && row.newest_evidence >= summary.updatedAt
        ? "needs review"
        : "current against linked evidence",
    deletedAt: row.deleted_at,
  };
}

/** Live subjects by name, 30 a page; `name` keeps those whose name contains it, ignoring case. */
export async function listSubjects(
  db: D1Database,
  userId: string,
  page = 1,
  name?: string,
): Promise<{ rows: Subject[]; hasMore: boolean }> {
  const filter = name?.trim() ?? "";
  const { results } = await db
    .prepare(
      `${SUBJECT_SELECT} WHERE s.user_id = ? AND s.${LIVE} AND (? = '' OR instr(lower(s.name), lower(?)) > 0)
      ORDER BY s.name COLLATE NOCASE, s.subject_id LIMIT 31 OFFSET ?`,
    )
    .bind(userId, filter, filter, (page - 1) * 30)
    .all<SubjectRow>();
  return {
    rows: await Promise.all(
      results.slice(0, 30).map((row) => subjectFromRow(db, userId, row)),
    ),
    hasMore: results.length > 30,
  };
}

/** The first 30 subjects by name, for a review's subject picker. */
export async function listSubjectChoices(db: D1Database, userId: string) {
  const { results } = await db
    .prepare(
      `SELECT subject_id,name,summary_memory_id FROM memory_subjects WHERE user_id=? AND ${LIVE} ORDER BY name,subject_id LIMIT 30`,
    )
    .bind(userId)
    .all<{
      subject_id: string;
      name: string;
      summary_memory_id: string | null;
    }>();
  return results;
}

export async function getSubject(
  db: D1Database,
  userId: string,
  id: string,
  options: { includeDeleted?: boolean } = {},
): Promise<Subject | null> {
  const row = await db
    .prepare(
      `${SUBJECT_SELECT} WHERE s.subject_id = ? AND s.user_id = ?${options.includeDeleted ? "" : ` AND s.${LIVE}`}`,
    )
    .bind(id, userId)
    .first<SubjectRow>();
  return row ? subjectFromRow(db, userId, row) : null;
}

export async function listSubjectMembers(
  db: D1Database,
  userId: string,
  id: string,
  page = 1,
) {
  const { results } = await db
    .prepare(`SELECT m.memory_id, m.title, m.body, m.memory_type,
     m.source_agent, m.source_client, m.source_session, m.source_session_name,
     m.created_at, m.updated_at, sm.asserted_by, sm.confirmed_at
     FROM memory_subject_members sm JOIN memory_subjects s ON s.subject_id = sm.subject_id
     JOIN memories m ON m.memory_id = sm.memory_id AND m.user_id = s.user_id
     WHERE sm.subject_id = ? AND s.user_id = ? AND sm.removed_at IS NULL AND sm.confirmed_at IS NOT NULL
       AND m.deleted_at IS NULL
    ORDER BY m.created_at DESC, m.memory_id LIMIT 31 OFFSET ?`)
    .bind(id, userId, (page - 1) * 30)
    .all<{
      memory_id: string;
      title: string | null;
      body: string;
      memory_type: string;
      source_agent: string;
      source_client: string;
      source_session: string | null;
      source_session_name: string | null;
      created_at: number;
      updated_at: number;
      asserted_by: "person" | "model";
      confirmed_at: number | null;
    }>();
  return {
    rows: results.slice(0, 30).map((m) => ({
      id: `memory:${m.memory_id}`,
      title: m.title ?? "Untitled memory",
      body: m.body,
      type: m.memory_type,
      sourceAgent: m.source_agent,
      sourceClient: m.source_client,
      sourceSession: m.source_session,
      sourceSessionName: m.source_session_name,
      createdAt: m.created_at,
      updatedAt: m.updated_at,
      assertedBy: m.asserted_by,
      confirmed: m.confirmed_at !== null,
    })),
    hasMore: results.length > 30,
  };
}

export async function listMemorySubjects(
  db: D1Database,
  userId: string,
  memoryId: string,
) {
  const { results } = await db
    .prepare(`SELECT s.subject_id, s.name FROM memory_subject_members sm
    JOIN memory_subjects s ON s.subject_id = sm.subject_id
     WHERE sm.memory_id = ? AND s.user_id = ? AND s.${LIVE} AND sm.removed_at IS NULL
       AND sm.confirmed_at IS NOT NULL ORDER BY s.name LIMIT 100`)
    .bind(memoryId, userId)
    .all<{ subject_id: string; name: string }>();
  return results.map((row) => ({ id: row.subject_id, name: row.name }));
}

/** SQL true when no other live subject of `user_id = ?` is named `?`, ignoring case. */
export const NAME_FREE = `NOT EXISTS (SELECT 1 FROM memory_subjects other
  WHERE other.user_id = ? AND other.name = ? COLLATE NOCASE AND other.${LIVE} AND other.subject_id <> ?)`;

/** The live subject with this name, ignoring case and outer spaces. */
export async function findSubjectByName(
  db: D1Database,
  userId: string,
  name: string,
) {
  const row = await db
    .prepare(
      `SELECT subject_id FROM memory_subjects WHERE user_id = ? AND name = ? COLLATE NOCASE AND ${LIVE} LIMIT 1`,
    )
    .bind(userId, name.trim())
    .first<{ subject_id: string }>();
  return row?.subject_id ?? null;
}

/**
 * Creates a subject unless a live one already has the name. A retried create
 * then gets the existing id back with `created: false`, not a duplicate.
 */
export async function createSubject(
  db: D1Database,
  userId: string,
  input: { name: string; kind: SubjectKind; description: string },
): Promise<{ id: string; created: boolean }> {
  const id = `sub_${crypto.randomUUID()}`;
  const name = input.name.trim();
  const now = Math.floor(Date.now() / 1000);
  const result = await db
    .prepare(`INSERT INTO memory_subjects (subject_id, user_id, name, kind, description, created_at, updated_at)
    SELECT ?, ?, ?, ?, ?, ?, ? WHERE ${NAME_FREE}`)
    .bind(
      id,
      userId,
      name,
      input.kind,
      input.description,
      now,
      now,
      userId,
      name,
      id,
    )
    .run();
  if (result.meta.changes > 0) return { id, created: true };
  const existing = await findSubjectByName(db, userId, name);
  if (!existing) throw new Error("Subject create matched no row and no name.");
  return { id: existing, created: false };
}

/** Deletes or restores a subject. A restore is refused while a live subject has its name. */
export async function setSubjectDeleted(
  db: D1Database,
  userId: string,
  id: string,
  deleted: boolean,
) {
  const now = Math.floor(Date.now() / 1000);
  const result = await (deleted
    ? db
        .prepare(
          `UPDATE memory_subjects SET deleted_at = ?, updated_at = ? WHERE subject_id = ? AND user_id = ? AND ${LIVE}`,
        )
        .bind(now, now, id, userId)
    : db
        .prepare(`UPDATE memory_subjects SET deleted_at = NULL, updated_at = ?
          WHERE subject_id = ? AND user_id = ? AND deleted_at IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM memory_subjects other
              WHERE other.user_id = memory_subjects.user_id AND other.name = memory_subjects.name COLLATE NOCASE
                AND other.${LIVE} AND other.subject_id <> memory_subjects.subject_id)`)
        .bind(now, id, userId)
  ).run();
  return result.meta.changes > 0;
}

export async function editSubject(
  db: D1Database,
  userId: string,
  id: string,
  field: "name" | "kind" | "description",
  value: string,
) {
  const column = { name: "name", kind: "kind", description: "description" }[
    field
  ];
  // A rename may not take another live subject's name.
  const result = await db
    .prepare(
      `UPDATE memory_subjects SET ${column} = ?, updated_at = ? WHERE subject_id = ? AND user_id = ? AND ${LIVE}${field === "name" ? ` AND ${NAME_FREE}` : ""}`,
    )
    .bind(
      value,
      Math.floor(Date.now() / 1000),
      id,
      userId,
      ...(field === "name" ? [userId, value, id] : []),
    )
    .run();
  return result.meta.changes > 0;
}

export async function setSubjectSummary(
  db: D1Database,
  userId: string,
  id: string,
  memoryId: string | null,
) {
  const result = await db
    .prepare(`UPDATE memory_subjects SET summary_memory_id = ?, updated_at = ?
    WHERE subject_id = ? AND user_id = ? AND ${LIVE} AND (? IS NULL OR EXISTS
      (SELECT 1 FROM memories WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL))
      AND (? IS NULL OR NOT EXISTS (SELECT 1 FROM memory_subject_members
        WHERE subject_id = ? AND memory_id = ? AND removed_at IS NULL))`)
    .bind(
      memoryId,
      Math.floor(Date.now() / 1000),
      id,
      userId,
      memoryId,
      memoryId,
      userId,
      memoryId,
      id,
      memoryId,
    )
    .run();
  return result.meta.changes > 0;
}

/** New summary and its search projection land with the subject pointer or not at all. */
export async function createSubjectSummary(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  subject: Subject,
  body: string,
  provenance: Provenance,
) {
  if (!(await getSubject(env.DB, provenance.userId, subject.id)))
    throw new Error("Subject not found for this user.");
  const id = `mem_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO memories (memory_id, user_id, memory_type, title, body, tags_json, project,
      source_agent, source_client, source_session, source_session_name, created_at, updated_at)
      SELECT ?, ?, 'insight', ?, ?, '[]', NULL, ?, ?, ?, ?, ?, ? FROM memory_subjects
      WHERE subject_id = ? AND user_id = ? AND ${LIVE}`).bind(
      id,
      provenance.userId,
      `${subject.name} — current understanding`,
      body,
      provenance.agent,
      provenance.client,
      provenance.session,
      provenance.sessionName ?? null,
      now,
      now,
      subject.id,
      provenance.userId,
    ),
    env.DB.prepare(
      `UPDATE memory_subjects SET summary_memory_id = ?, updated_at = ? WHERE subject_id = ? AND user_id = ?`,
    ).bind(id, now, subject.id, provenance.userId),
    ...memoryProjectionStatements(env.DB, id, env),
  ]);
  return `memory:${id}`;
}

export async function changeSubjectMember(
  db: D1Database,
  subjectId: string,
  memoryId: string,
  action: "add" | "remove",
  userId: string,
  /** Who asked: a person in the console, or an agent over MCP. Both are confirmed members. */
  assertedBy: "person" | "model" = "person",
) {
  const now = Math.floor(Date.now() / 1000);
  if (action === "add") {
    const result = await db
      .prepare(`INSERT INTO memory_subject_members
      (subject_id, memory_id, asserted_by, confirmed_at, confirmed_by, created_at)
      SELECT ?, memory_id, ?, ?, ?, ? FROM memories
       WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL AND EXISTS
         (SELECT 1 FROM memory_subjects WHERE subject_id = ? AND user_id = ? AND ${LIVE} AND
          (summary_memory_id IS NULL OR summary_memory_id <> ?))
      ON CONFLICT(subject_id, memory_id) DO UPDATE SET
        removed_at = NULL, removed_by = NULL, confirmed_at = excluded.confirmed_at,
        confirmed_by = excluded.confirmed_by WHERE memory_subject_members.removed_at IS NOT NULL
        OR memory_subject_members.confirmed_at IS NULL`)
      .bind(
        subjectId,
        assertedBy,
        now,
        userId,
        now,
        memoryId,
        userId,
        subjectId,
        userId,
        memoryId,
      )
      .run();
    return result.meta.changes > 0;
  }
  const result = await db
    .prepare(`UPDATE memory_subject_members SET removed_at = ?, removed_by = ?
    WHERE subject_id = ? AND memory_id = ? AND removed_at IS NULL
      AND EXISTS (SELECT 1 FROM memory_subjects WHERE subject_id = ? AND user_id = ? AND ${LIVE})`)
    .bind(now, userId, subjectId, memoryId, subjectId, userId)
    .run();
  if (result.meta.changes > 0) return true;
  // Removing a memory that was only suggested dismisses the suggestion: a
  // removed, never-confirmed row, so it is not suggested again. Adding it
  // later revives the same row. ADR-0012, 2026-11-05.
  const dismissed = await db
    .prepare(`INSERT INTO memory_subject_members
      (subject_id, memory_id, asserted_by, confirmed_at, confirmed_by, created_at, removed_at, removed_by)
      SELECT ?, memory_id, 'model', NULL, NULL, ?, ?, ? FROM memories
       WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL AND EXISTS
         (SELECT 1 FROM memory_subjects WHERE subject_id = ? AND user_id = ? AND ${LIVE})
      ON CONFLICT(subject_id, memory_id) DO NOTHING`)
    .bind(subjectId, now, now, userId, memoryId, userId, subjectId, userId)
    .run();
  return dismissed.meta.changes > 0;
}

/** A subject as `search` and `get_brief` list it: enough to pass its id on. */
export type SubjectRef = {
  id: string;
  name: string;
  kind: SubjectKind;
  members: number;
};

/** Live subjects scanned for a query match; past this the newest are kept. */
const MATCH_SCAN = 500;

function words(text: string) {
  return text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

/**
 * Live subjects a search query names, so an agent about to save a memory
 * sees which subject it supports. Subjects are not in `search_docs`; a name
 * matches when every one of its words is a word of the query, or the whole
 * query is a word run inside the name. Plain words, no ranking: names are
 * short, and a subject either is what the query says or is not.
 */
export async function matchSubjects(
  db: D1Database,
  userId: string,
  query: string,
  limit = 5,
): Promise<SubjectRef[]> {
  const asked = new Set(words(query));
  const phrase = words(query).join(" ");
  if (asked.size === 0) return [];
  const { results } = await db
    .prepare(`SELECT s.subject_id, s.name, s.kind,
      (SELECT COUNT(*) FROM memory_subject_members sm JOIN memories m ON m.memory_id = sm.memory_id
        WHERE sm.subject_id = s.subject_id AND sm.removed_at IS NULL AND sm.confirmed_at IS NOT NULL
          AND m.user_id = s.user_id AND m.deleted_at IS NULL) AS members
      FROM memory_subjects s WHERE s.user_id = ? AND s.${LIVE}
      ORDER BY s.updated_at DESC, s.subject_id LIMIT ${MATCH_SCAN}`)
    .bind(userId)
    .all<{
      subject_id: string;
      name: string;
      kind: SubjectKind;
      members: number;
    }>();
  return results
    .filter((row) => {
      const name = words(row.name);
      return (
        name.length > 0 &&
        (name.every((word) => asked.has(word)) ||
          ` ${name.join(" ")} `.includes(` ${phrase} `))
      );
    })
    .slice(0, limit)
    .map((row) => ({
      id: `subject:${row.subject_id}`,
      name: row.name,
      kind: row.kind,
      members: row.members,
    }));
}

/**
 * The brief's subjects: live subjects with a confirmed member in the
 * project, or any live subject without one, most recently changed first.
 */
export async function briefSubjects(
  db: D1Database,
  userId: string,
  project: string | null,
  limit = 10,
): Promise<{ limit: number; has_more: boolean; items: SubjectRef[] }> {
  const { results } = await db
    .prepare(`SELECT s.subject_id, s.name, s.kind,
      (SELECT COUNT(*) FROM memory_subject_members sm JOIN memories m ON m.memory_id = sm.memory_id
        WHERE sm.subject_id = s.subject_id AND sm.removed_at IS NULL AND sm.confirmed_at IS NOT NULL
          AND m.user_id = s.user_id AND m.deleted_at IS NULL) AS members
      FROM memory_subjects s WHERE s.user_id = ? AND s.${LIVE}
        AND (? IS NULL OR EXISTS (SELECT 1 FROM memory_subject_members sm
          JOIN memories m ON m.memory_id = sm.memory_id
          WHERE sm.subject_id = s.subject_id AND sm.removed_at IS NULL AND sm.confirmed_at IS NOT NULL
            AND m.user_id = s.user_id AND m.deleted_at IS NULL AND m.project = ?))
      ORDER BY s.updated_at DESC, s.subject_id LIMIT ?`)
    .bind(userId, project, project, limit + 1)
    .all<{
      subject_id: string;
      name: string;
      kind: SubjectKind;
      members: number;
    }>();
  return {
    limit,
    has_more: results.length > limit,
    items: results.slice(0, limit).map((row) => ({
      id: `subject:${row.subject_id}`,
      name: row.name,
      kind: row.kind,
      members: row.members,
    })),
  };
}

/** A tag or name lowercased, spaces and underscores as hyphens: `Ada Lovelace` is `ada-lovelace`. */
const slugSql = (expr: string) =>
  `trim(lower(replace(replace(${expr}, ' ', '-'), '_', '-')), '-')`;

export type SubjectSuggestion = {
  id: string;
  title: string;
  body: string;
  type: string;
  createdAt: number;
  /** Why it is suggested: the matching tag, or an agent's unconfirmed assertion. */
  reason: string;
};

/**
 * Memories that may support a subject but are not members: live memories
 * tagged with the subject's name, and unconfirmed memberships. A memory with
 * any row for the subject, confirmed, removed or dismissed, is never
 * suggested, nor is the summary. Computed on read, so nothing goes stale;
 * bounded at `limit`, newest first. ADR-0012, 2026-11-05.
 */
export async function listSubjectSuggestions(
  db: D1Database,
  userId: string,
  id: string,
  limit = 10,
): Promise<{ rows: SubjectSuggestion[]; hasMore: boolean }> {
  const subject = await db
    .prepare(
      `SELECT name, summary_memory_id FROM memory_subjects WHERE subject_id = ? AND user_id = ? AND ${LIVE}`,
    )
    .bind(id, userId)
    .first<{ name: string; summary_memory_id: string | null }>();
  if (!subject) return { rows: [], hasMore: false };
  const { results } = await db
    .prepare(`SELECT memory_id, title, body, memory_type, created_at, updated_at, reason FROM (
      SELECT m.memory_id, m.title, m.body, m.memory_type, m.created_at, m.updated_at,
        'suggested by an agent' AS reason
        FROM memory_subject_members sm JOIN memories m ON m.memory_id = sm.memory_id
       WHERE sm.subject_id = ? AND sm.removed_at IS NULL AND sm.confirmed_at IS NULL
         AND m.user_id = ? AND m.deleted_at IS NULL
      UNION ALL
      SELECT m.memory_id, m.title, m.body, m.memory_type, m.created_at, m.updated_at,
        'tagged ' || MIN(tag.value) AS reason
        FROM memories m, json_each(m.tags_json) AS tag
       WHERE m.user_id = ? AND m.deleted_at IS NULL AND ${slugSql("?")} <> ''
         AND ${slugSql("tag.value")} = ${slugSql("?")}
         AND m.memory_id <> COALESCE(?, '')
         AND NOT EXISTS (SELECT 1 FROM memory_subject_members sm
           WHERE sm.subject_id = ? AND sm.memory_id = m.memory_id)
       GROUP BY m.memory_id
    ) ORDER BY updated_at DESC, memory_id LIMIT ?`)
    .bind(
      id,
      userId,
      userId,
      subject.name,
      subject.name,
      subject.summary_memory_id,
      id,
      limit + 1,
    )
    .all<{
      memory_id: string;
      title: string | null;
      body: string;
      memory_type: string;
      created_at: number;
      reason: string;
    }>();
  return {
    rows: results.slice(0, limit).map((row) => ({
      id: `memory:${row.memory_id}`,
      title: row.title ?? "Untitled memory",
      body: row.body,
      type: row.memory_type,
      createdAt: row.created_at,
      reason: row.reason,
    })),
    hasMore: results.length > limit,
  };
}
