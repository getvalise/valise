import { assetSearchStatements } from "~/concepts/assets";
import { ARTICLE_TEXT_SQL } from "~/concepts/source-articles";
import { sourceSearchStatements } from "~/concepts/source-search";
import { readTranscriptTurns } from "~/concepts/transcripts";
import type { Concept, SearchConcept } from "~/db/schema";
import { supersededMemorySql } from "~/search/memory";
import {
  type AssetSource,
  type ProjectionRow,
  projectAsset,
  projectMemory,
  projectSkill,
  projectSource,
  projectTodo,
  projectTranscript,
  type SourceProjection,
} from "~/search/project";
import { unpublishProjection, upsertProjection } from "~/search/write";

/**
 * The restore path and the weekly drift reconciliation, one function.
 *
 * The projection and the FTS index are derived and disposable, so nothing here
 * reads them. It clears the projection rows for the named concepts, re-runs
 * every `project()` over the authoritative tables, and rebuilds the FTS index
 * from the content table. ADR-0001.
 */

/** The concepts with console lists, facets, and an unfiltered search. */
export const ALL_CONCEPTS: Concept[] = ["skill", "memory", "todo"];

/**
 * Everything the projection holds. Assets and sources require an explicit
 * type or include_library: `search`'s result schema is a client's cached
 * contract, and one discovered before they existed rejects their type.
 * ADR-0015, amendment of 2026-10-21.
 */
export const SEARCH_CONCEPTS: SearchConcept[] = [
  ...ALL_CONCEPTS,
  "asset",
  "source",
];

/**
 * Everything the projection holds, transcripts included. A transcript is
 * found only with `type: transcript`: a session's text is long and rarely
 * what a broad question wants, and `include_library` keeps its meaning.
 * ADR-0022.
 */
export const PROJECTED_CONCEPTS: SearchConcept[] = [
  ...SEARCH_CONCEPTS,
  "transcript",
];

export type ReindexEnv = { DB: D1Database };

export type ReindexReport = {
  concepts: SearchConcept[];
  published: Record<SearchConcept, number>;
  unpublished: Record<SearchConcept, number>;
  total: number;
};

const zeroCounts = (): Record<SearchConcept, number> => ({
  skill: 0,
  memory: 0,
  todo: 0,
  asset: 0,
  source: 0,
  transcript: 0,
});

/** Rows read per round trip. Personal scale, so one page is usually enough. */
const PAGE = 500;

export async function reindex(
  env: ReindexEnv,
  concepts: SearchConcept[] = PROJECTED_CONCEPTS,
): Promise<ReindexReport> {
  const db = env.DB;
  const report: ReindexReport = {
    concepts,
    published: zeroCounts(),
    unpublished: zeroCounts(),
    total: 0,
  };

  for (const concept of concepts) {
    const rows = await readConcept(db, concept);
    const live: ProjectionRow[] = [];
    for (const row of rows) {
      if (row === null) report.unpublished[concept]++;
      else live.push(row);
    }
    report.published[concept] = live.length;

    const statements = live.map((row) => upsertProjection(db, row));
    for (let i = 0; i < statements.length; i += PAGE) {
      await db.batch(statements.slice(i, i + PAGE));
    }

    // Prune what no longer projects. Upsert-then-prune rather than
    // delete-then-insert, so surviving rows keep their rowid and the FTS
    // rebuild below reproduces the index exactly.
    const keep = new Set(live.map((row) => row.docKey));
    const { results } = await db
      .prepare("SELECT doc_key FROM search_docs WHERE concept = ?")
      .bind(concept)
      .all<{ doc_key: string }>();
    // A live asset's passages are rebuilt below, from its current output.
    const stale = results
      .map((r) => r.doc_key)
      .filter((key) => !keep.has(key) && !keep.has(key.replace(/#\d+$/, "")))
      .map((key) => unpublishProjection(db, key));
    for (let i = 0; i < stale.length; i += PAGE) {
      await db.batch(stale.slice(i, i + PAGE));
    }
    if (concept === "source") {
      // Summaries, concepts and article passages, from the newest enrichment.
      const extra = live.flatMap((row) =>
        sourceSearchStatements(db, row.conceptId, row.userId),
      );
      for (let i = 0; i < extra.length; i += PAGE)
        await db.batch(extra.slice(i, i + PAGE));
    }
    if (concept === "asset") {
      // One asset per batch: a book's passages are hundreds of rows each.
      for (const row of live)
        await db.batch(assetSearchStatements(db, row.conceptId, row.userId));
    }
  }

  // Rebuild reads the whole content table, so a partial reindex still leaves a
  // consistent index for every concept.
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();

  report.total = PROJECTED_CONCEPTS.reduce(
    (sum, concept) => sum + report.published[concept],
    0,
  );
  return report;
}

async function readConcept(
  db: D1Database,
  concept: SearchConcept,
): Promise<(ProjectionRow | null)[]> {
  switch (concept) {
    case "skill":
      return readSkills(db);
    case "memory":
      return readMemories(db);
    case "todo":
      return readTodos(db);
    case "asset":
      return readAssets(db);
    case "source":
      return readSources(db);
    case "transcript":
      return readTranscripts(db);
  }
}

async function readTranscripts(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT transcript_id AS transcriptId, user_id AS userId, project, title,
              client, updated_at AS updatedAt
         FROM transcripts ORDER BY transcript_id`,
    )
    .all<{
      transcriptId: string;
      userId: string;
      project: string | null;
      title: string;
      client: string;
      updatedAt: number;
    }>();
  const rows: ProjectionRow[] = [];
  for (const transcript of results) {
    rows.push(
      projectTranscript(
        transcript,
        await readTranscriptTurns(db, transcript.transcriptId),
      ),
    );
  }
  return rows;
}

async function readSources(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT source_id AS sourceId, user_id AS userId, title, url, notes, tags_json AS tagsJson,
              authors_json AS authorsJson, project, archived_at AS archivedAt,
              updated_at AS updatedAt, ${ARTICLE_TEXT_SQL("sources")} AS articleText
         FROM sources
        ORDER BY source_id`,
    )
    .all<SourceProjection>();
  return results.map(projectSource);
}

async function readAssets(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT asset_id AS assetId, user_id AS userId, state, title, file_name AS fileName,
              description, tags_json AS tagsJson, project,
              archived_at AS archivedAt, updated_at AS updatedAt,
              (SELECT substr(o.text, 1, 65536) FROM asset_processing_heads h
                JOIN asset_processing_outputs o USING (processing_id)
                WHERE h.asset_id = assets.asset_id AND h.user_id = assets.user_id
                  AND o.user_id = assets.user_id) AS extractedText
         FROM assets
        ORDER BY asset_id`,
    )
    .all<AssetSource>();
  return results.map(projectAsset);
}

async function readSkills(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT s.skill_id, s.user_id, s.name, s.tags_json, s.project, s.deleted_at,
              s.disabled_at, s.updated_at,
              v.body_md AS head_body_md
         FROM skills s
         LEFT JOIN skill_versions v ON v.version_id = s.head_version_id
        ORDER BY s.skill_id`,
    )
    .all<{
      skill_id: string;
      user_id: string;
      name: string;
      tags_json: string;
      project: string | null;
      deleted_at: number | null;
      disabled_at: number | null;
      updated_at: number;
      head_body_md: string | null;
    }>();
  return results.map((r) =>
    projectSkill({
      skillId: r.skill_id,
      userId: r.user_id,
      name: r.name,
      tagsJson: r.tags_json,
      project: r.project,
      deletedAt: r.deleted_at,
      disabledAt: r.disabled_at,
      updatedAt: r.updated_at,
      headBodyMd: r.head_body_md,
    }),
  );
}

async function readMemories(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT memory_id, user_id, memory_type, title, body, tags_json, project, deleted_at, updated_at,
              ${supersededMemorySql("memories")} AS superseded
         FROM memories
        ORDER BY memory_id`,
    )
    .all<{
      memory_id: string;
      user_id: string;
      memory_type: string;
      superseded: number;
      title: string | null;
      body: string;
      tags_json: string;
      project: string | null;
      deleted_at: number | null;
      updated_at: number;
    }>();
  return results.map((r) =>
    projectMemory({
      memoryId: r.memory_id,
      userId: r.user_id,
      memoryType: r.memory_type,
      superseded: r.superseded !== 0,
      title: r.title,
      body: r.body,
      tagsJson: r.tags_json,
      project: r.project,
      deletedAt: r.deleted_at,
      updatedAt: r.updated_at,
    }),
  );
}

async function readTodos(db: D1Database) {
  const { results } = await db
    .prepare(
      `SELECT todo_id, user_id, title, body, tags_json, refs_json, project, updated_at,
              (SELECT group_concat(body, char(10))
                 FROM (SELECT body FROM todo_comments c
                        WHERE c.todo_id = todos.todo_id
                        ORDER BY created_at, comment_id)) AS comments
         FROM todos
        ORDER BY todo_id`,
    )
    .all<{
      todo_id: string;
      user_id: string;
      title: string;
      body: string;
      tags_json: string;
      refs_json: string;
      project: string | null;
      updated_at: number;
      comments: string | null;
    }>();
  return results.map((r) =>
    projectTodo({
      todoId: r.todo_id,
      userId: r.user_id,
      title: r.title,
      body: r.body,
      tagsJson: r.tags_json,
      refsJson: r.refs_json,
      project: r.project,
      updatedAt: r.updated_at,
      comments: r.comments ?? undefined,
    }),
  );
}
