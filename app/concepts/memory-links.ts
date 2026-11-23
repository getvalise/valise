import type { Provenance } from "~/concepts/memories";
import { memoryProjectionStatements } from "~/search/memory";

export const MEMORY_LINK_KINDS = [
  "part-of",
  "supersedes",
  "contradicts",
  "related",
] as const;
export type MemoryLinkKind = (typeof MEMORY_LINK_KINDS)[number];
export type MemoryRelation = { id: string; kind: MemoryLinkKind };
type Assertion = { kind: "model" } | { kind: "person"; userId: string };
export class MemoryLinkError extends Error {}

/** Both ends live, and in the same user's case: a link never crosses users. ADR-0016. */
const liveEndpointsSql = `EXISTS (SELECT 1 FROM memories a JOIN memories b ON a.user_id = b.user_id
  WHERE a.memory_id = candidate.from_memory_id AND a.deleted_at IS NULL
    AND b.memory_id = candidate.to_memory_id AND b.deleted_at IS NULL)`;
const noReverseSql = `(candidate.kind NOT IN ('supersedes', 'part-of') OR NOT EXISTS (
  SELECT 1 FROM memory_links reverse WHERE reverse.from_memory_id = candidate.to_memory_id
  AND reverse.to_memory_id = candidate.from_memory_id AND reverse.kind = candidate.kind AND reverse.removed_at IS NULL))`;

/** The NOT NULL link id makes a failed in-statement guard abort the whole batch. */
export async function memoryLinkBatch(
  db: D1Database,
  statements: D1PreparedStatement[],
): Promise<D1Result[]> {
  try {
    return await db.batch(statements);
  } catch (error) {
    if (
      error instanceof Error &&
      error.message.includes("NOT NULL constraint failed: memory_links.link_id")
    )
      throw new MemoryLinkError(
        "Memory link endpoints must be live and no reverse memory link may exist. Reload and try again.",
        { cause: error },
      );
    throw error;
  }
}

/** Asserted links are claims, never inferred similarity. */
export async function memoryLinkStatements(
  db: D1Database,
  from: string,
  relates: readonly MemoryRelation[],
  provenance: Provenance,
  assertion: Assertion = { kind: "model" },
  /** Memories inserted earlier in the same batch; the statement's own guard still checks them. */
  inserted: ReadonlySet<string> = new Set(),
): Promise<D1PreparedStatement[]> {
  const statements: D1PreparedStatement[] = [];
  for (const relation of relates) {
    const to = relation.id.slice("memory:".length);
    if (to === from)
      throw new MemoryLinkError("A memory cannot link to itself.");
    const live =
      inserted.has(to) ||
      (await db
        .prepare(
          "SELECT 1 FROM memories WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL",
        )
        .bind(to, provenance.userId)
        .first());
    if (!live)
      throw new MemoryLinkError(`${relation.id}: no active memory exists.`);
    const symmetric =
      relation.kind === "related" || relation.kind === "contradicts";
    const [a, b] = symmetric && from > to ? [to, from] : [from, to];
    const existing = await db
      .prepare(
        `SELECT 1 FROM memory_links WHERE from_memory_id = ? AND to_memory_id = ? AND kind = ?`,
      )
      .bind(a, b, relation.kind)
      .first();
    if (!symmetric && !existing) {
      const reverse = await db
        .prepare(`SELECT 1 FROM memory_links WHERE from_memory_id = ?
        AND to_memory_id = ? AND kind = ? AND removed_at IS NULL`)
        .bind(b, a, relation.kind)
        .first();
      if (reverse)
        throw new MemoryLinkError(
          `${relation.id}: reverse ${relation.kind} link exists.`,
        );
    }
    const now = Math.floor(Date.now() / 1000);
    statements.push(
      db
        .prepare(`WITH candidate AS (SELECT ? AS from_memory_id, ? AS to_memory_id, ? AS kind)
      INSERT INTO memory_links (
      link_id, from_memory_id, to_memory_id, kind, asserted_by,
      source_agent, source_client, source_session, created_at, confirmed_at, confirmed_by
    ) SELECT CASE WHEN ${liveEndpointsSql} AND (${noReverseSql} OR EXISTS (
      SELECT 1 FROM memory_links existing WHERE existing.from_memory_id = candidate.from_memory_id
      AND existing.to_memory_id = candidate.to_memory_id AND existing.kind = candidate.kind))
      THEN ? END, from_memory_id, to_memory_id, kind, ?, ?, ?, ?, ?, ?, ?
      FROM candidate WHERE true
     ON CONFLICT(from_memory_id, to_memory_id, kind) DO UPDATE SET
       confirmed_at = COALESCE(memory_links.confirmed_at, excluded.confirmed_at),
       confirmed_by = COALESCE(memory_links.confirmed_by, excluded.confirmed_by)
       WHERE memory_links.removed_at IS NULL AND excluded.asserted_by = 'person'`)
        .bind(
          a,
          b,
          relation.kind,
          `mln_${crypto.randomUUID()}`,
          assertion.kind,
          provenance.agent,
          provenance.client,
          provenance.session,
          now,
          assertion.kind === "person" ? now : null,
          assertion.kind === "person" ? assertion.userId : null,
        ),
    );
  }
  return statements;
}

export type MemoryLink = {
  link_id: string;
  kind: MemoryLinkKind | "superseded-by" | "has-part";
  id: string;
  title: string;
  confirmed: boolean;
  asserted_by: "model" | "person";
  removed_at: number | null;
};

/** The picker needs no content, tags, or provenance from the rest of the store. */
/** One page of the memories a link can point at, newest first. */
export const LINK_TARGET_PAGE = 30;

export async function listMemoryLinkTargets(
  db: D1Database,
  userId: string,
  excluding: string,
  { query = "", offset = 0 }: { query?: string; offset?: number } = {},
): Promise<{ targets: { id: string; title: string }[]; next: number | null }> {
  const like = `%${query.trim().replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
  const { results } = await db
    .prepare(`SELECT memory_id, title FROM memories
    WHERE user_id = ? AND deleted_at IS NULL AND memory_id <> ?
      AND EXISTS (SELECT 1 FROM memories root WHERE root.memory_id = ?
        AND root.user_id = memories.user_id AND root.deleted_at IS NULL)
      AND (? = '' OR title LIKE ? ESCAPE '\\')
    ORDER BY updated_at DESC, memory_id LIMIT ? OFFSET ?`)
    .bind(
      userId,
      excluding,
      excluding,
      query.trim(),
      like,
      LINK_TARGET_PAGE + 1,
      offset,
    )
    .all<{ memory_id: string; title: string | null }>();
  return {
    targets: results.slice(0, LINK_TARGET_PAGE).map((row) => ({
      id: `memory:${row.memory_id}`,
      title: row.title ?? "",
    })),
    next: results.length > LINK_TARGET_PAGE ? offset + LINK_TARGET_PAGE : null,
  };
}

export async function listMemoryLinks(
  db: D1Database,
  userId: string,
  id: string,
  includeRemoved = false,
): Promise<MemoryLink[]> {
  const { results } = await db
    .prepare(`SELECT l.link_id, l.kind, l.from_memory_id,
    other.memory_id, other.title, l.confirmed_at, l.asserted_by, l.removed_at
    FROM memory_links l JOIN memories other ON other.memory_id =
      CASE WHEN l.from_memory_id = ? THEN l.to_memory_id ELSE l.from_memory_id END
    WHERE (l.from_memory_id = ? OR l.to_memory_id = ?) AND other.deleted_at IS NULL
      AND other.user_id = ?
      AND EXISTS (SELECT 1 FROM memories root WHERE root.memory_id = ?
        AND root.user_id = other.user_id AND root.deleted_at IS NULL)
      AND (? OR l.removed_at IS NULL) ORDER BY l.created_at, l.link_id`)
    .bind(id, id, id, userId, id, includeRemoved ? 1 : 0)
    .all<{
      link_id: string;
      kind: MemoryLinkKind;
      from_memory_id: string;
      memory_id: string;
      title: string | null;
      confirmed_at: number | null;
      asserted_by: "model" | "person";
      removed_at: number | null;
    }>();
  return results.map((row) => ({
    link_id: row.link_id,
    kind:
      row.from_memory_id === id
        ? row.kind
        : row.kind === "supersedes"
          ? "superseded-by"
          : row.kind === "part-of"
            ? "has-part"
            : row.kind,
    id: `memory:${row.memory_id}`,
    title: row.title ?? "",
    confirmed: row.confirmed_at !== null,
    asserted_by: row.asserted_by,
    removed_at: row.removed_at,
  }));
}

/** Only the authenticated console calls this; no assertion authority in MCP input. */
export async function changeMemoryLink(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  memoryId: string,
  linkId: string,
  action: "confirm" | "remove" | "restore",
  userId: string,
): Promise<boolean> {
  const row =
    await env.DB.prepare(`SELECT from_memory_id, to_memory_id, kind, removed_at FROM memory_links
    WHERE link_id = ? AND (from_memory_id = ? OR to_memory_id = ?)
      AND EXISTS (SELECT 1 FROM memories WHERE memory_id = ? AND user_id = ?)
      AND EXISTS (SELECT 1 FROM memories a JOIN memories b ON a.user_id = b.user_id
        WHERE a.memory_id = from_memory_id AND b.memory_id = to_memory_id)`)
      .bind(linkId, memoryId, memoryId, memoryId, userId)
      .first<{
        from_memory_id: string;
        to_memory_id: string;
        kind: MemoryLinkKind;
        removed_at: number | null;
      }>();
  if (!row) return false;
  if (action === "restore" && row.removed_at !== null) {
    const endpoints = await env.DB.prepare(`SELECT COUNT(*) AS n FROM memories
      WHERE memory_id IN (?, ?) AND deleted_at IS NULL`)
      .bind(row.from_memory_id, row.to_memory_id)
      .first<{ n: number }>();
    if (endpoints?.n !== 2)
      throw new MemoryLinkError(
        "Cannot restore: both memory link endpoints must be live.",
      );
    if (row.kind === "part-of" || row.kind === "supersedes") {
      const reverse = await env.DB.prepare(`SELECT 1 FROM memory_links
        WHERE from_memory_id = ? AND to_memory_id = ? AND kind = ? AND removed_at IS NULL`)
        .bind(row.to_memory_id, row.from_memory_id, row.kind)
        .first();
      if (reverse)
        throw new MemoryLinkError(
          "Cannot restore: reverse memory link exists.",
        );
    }
  }
  const now = Math.floor(Date.now() / 1000);
  const update =
    action === "confirm"
      ? env.DB.prepare(
          `UPDATE memory_links SET confirmed_at = ?, confirmed_by = ? WHERE link_id = ? AND confirmed_at IS NULL AND removed_at IS NULL`,
        ).bind(now, userId, linkId)
      : action === "remove"
        ? env.DB.prepare(
            `UPDATE memory_links SET removed_at = ?, removed_by = ? WHERE link_id = ? AND removed_at IS NULL`,
          ).bind(now, userId, linkId)
        : env.DB.prepare(
            `UPDATE memory_links AS candidate SET
              link_id = CASE WHEN ${liveEndpointsSql} AND ${noReverseSql} THEN candidate.link_id END,
              removed_at = NULL, removed_by = NULL WHERE link_id = ? AND removed_at IS NOT NULL`,
          ).bind(linkId);
  await memoryLinkBatch(env.DB, [
    update,
    ...memoryProjectionStatements(env.DB, row.from_memory_id, env),
    ...memoryProjectionStatements(env.DB, row.to_memory_id, env),
  ]);
  return true;
}

export async function assertPersonMemoryLink(
  env: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  from: string,
  relation: MemoryRelation,
  provenance: Provenance,
): Promise<void> {
  const owned = await env.DB.prepare(
    "SELECT 1 FROM memories WHERE memory_id = ? AND user_id = ? AND deleted_at IS NULL",
  )
    .bind(from, provenance.userId)
    .first();
  if (!owned)
    throw new MemoryLinkError(`memory:${from}: no active memory exists.`);
  const statements = await memoryLinkStatements(
    env.DB,
    from,
    [relation],
    provenance,
    { kind: "person", userId: provenance.userId },
  );
  await memoryLinkBatch(env.DB, [
    ...statements,
    ...memoryProjectionStatements(env.DB, from, env),
    ...memoryProjectionStatements(
      env.DB,
      relation.id.slice("memory:".length),
      env,
    ),
  ]);
}
