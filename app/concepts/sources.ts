import { type Asset, assetRef, readAsset } from "~/concepts/assets";
import {
  type AllowanceSettings,
  allowanceOf,
  attachmentRefusal,
} from "~/concepts/attachment-limits";
import {
  LIBRARY_PAGE_SIZE,
  type LibraryPageOptions,
  libraryPage,
  libraryPageWhere,
} from "~/concepts/library-page";
import { forgetUseStatements } from "~/concepts/library-use";
import type { Provenance } from "~/concepts/memories";
import {
  ARTICLE_SUMMARY_SQL,
  type ArticleInput,
  articleInsert,
  parseArticleSummary,
  readSourceArticle,
  type SourceArticle,
  type SourceArticleSummary,
} from "~/concepts/source-articles";
import { sourceSearchStatements } from "~/concepts/source-search";
import { nowSeconds } from "~/r2/objects";
import { docKey, projectSource } from "~/search/project";
import { sourceVectorInvalidateStatement } from "~/search/source-vectors";
import { projectionStatement } from "~/search/write";

/**
 * Sources: durable knowledge entries, ADR-0015. A bookmark, a document, an
 * image, or a reference, carrying an optional URL, notes someone wrote, and
 * links to ready assets. Every save is a revision: the head row plus an
 * append-only `source_revisions` row and its asset links, in one batch with
 * the projection. What is searchable is what a person or agent wrote, the
 * article a client extracted at capture or Valise fetched once, and a
 * generated summary and concepts (`source-enrichment.ts`).
 */

export const SOURCE_KINDS = [
  ["bookmark", "a web page worth returning to"],
  ["document", "a file such as a PDF, kept as an asset"],
  ["image", "a picture or screenshot, kept as an asset"],
  ["reference", "anything else to cite: a book, a paper, a talk"],
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number][0];

/** Long notes stay whole in the source; only the projection is capped. */
export const MAX_NOTES_LENGTH = 64 * 1024;
export const MAX_SOURCE_ASSETS = 20;
export const MAX_AUTHORS = 20;

export const SOURCE_COVERAGE =
  "Search matches a source's title, URL, authors, notes, tags, its generated summary and key concepts, and its article text, which a client extracted at capture or Valise fetched once (robots.txt respected, paywalled pages not kept). Long articles match by passage. Linked files' contents are not indexed.";

export type SourceAsset = Pick<
  Asset,
  "assetId" | "title" | "fileName" | "contentType" | "size" | "objectId"
> & { available: boolean };

export type Source = {
  sourceId: string;
  userId: string;
  kind: string;
  title: string;
  url: string | null;
  notes: string;
  project: string | null;
  tags: string[];
  authors: string[];
  revision: number;
  assets: SourceAsset[];
  /** Newest extracted article: full text from readSource, metadata in lists. */
  article: SourceArticle | SourceArticleSummary | null;
  sourceAgent: string;
  sourceClient: string;
  sourceSession: string | null;
  /** Unix seconds the page or post was published: as saved, else the newest
   * article's date. Null when unknown. */
  published: number | null;
  createdAt: number;
  updatedAt: number;
  archivedAt: number | null;
};

/** The published time a source row `alias` reads as: saved, else its article's. */
export const PUBLISHED_SQL = (alias: string) =>
  `COALESCE(${alias}.published_at, (SELECT unixepoch(sa.published) FROM source_articles sa
     WHERE sa.source_id = ${alias}.source_id AND sa.user_id = ${alias}.user_id
       AND sa.published IS NOT NULL ORDER BY sa.revision DESC LIMIT 1))`;

/** Unix seconds from an ISO 8601 date or datetime; null for anything else. */
export function publishedSeconds(value: string | null | undefined) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) || time < 0 ? null : Math.floor(time / 1000);
}

/** The orders Library offers for sources; the key is a constant, never URL input. */
export const SOURCE_SORTS = [
  ["saved", "Newest saved"],
  ["published", "Newest published"],
] as const;
export type SourceSort = (typeof SOURCE_SORTS)[number][0];

export function sourceSort(value: string | undefined): SourceSort {
  return value === "published" ? "published" : "saved";
}

const SORT_KEYS: Record<SourceSort, (alias: string) => string> = {
  saved: (alias) => `${alias}.created_at`,
  // Undated sources, and any article date before 1970, sort after the rest.
  published: (alias) => `MAX(COALESCE(${PUBLISHED_SQL(alias)}, 0), 0)`,
};

export type SourceRevision = {
  revision: number;
  kind: string;
  title: string;
  url: string | null;
  notes: string;
  project: string | null;
  tags: string[];
  assetIds: string[];
  /** As saved at this revision; no article fallback. */
  publishedAt: number | null;
  sourceAgent: string;
  sourceClient: string;
  sourceSession: string | null;
  createdAt: number;
};

export class SourceRefused extends Error {}

/** `source:src_…` → `src_…`, or null for anything else. */
export function sourceIdOf(id: string): string | null {
  const match = /^(?:source:)?(src_[0-9a-f-]{36})$/.exec(id.trim());
  return match ? match[1] : null;
}

export function sourceRef(sourceId: string): string {
  return docKey("source", sourceId);
}

export type SaveSource = {
  /** Absent creates a source; present appends a revision to it. */
  sourceId?: string;
  /** The revision the writer last read. Required with `sourceId`. */
  expectedRevision?: number;
  kind?: SourceKind;
  title?: string;
  /** Null clears it. */
  url?: string | null;
  notes?: string;
  project?: string | null;
  tags?: readonly string[];
  /** Replaces the author list, in byline order. Absent keeps it. */
  authors?: readonly string[];
  /** Appends an extracted article at this revision. Absent keeps the last. */
  article?: ArticleInput;
  /** Replaces the linked assets, in order. Absent keeps them. */
  assetIds?: readonly string[];
  /** Appended after the linked assets, skipping any already linked. */
  addAssetIds?: readonly string[];
  /** Unix seconds the page was published; null clears it. Absent keeps the
   * saved value, or takes the article's `published` when it parses. */
  published?: number | null;
};

/**
 * Creates a source or appends a revision. Omitted fields keep the head's
 * values. A stale `expectedRevision` is refused with the current one rather
 * than overwritten. Linked assets must be owned, ready and durable: an asset
 * with an expiry would leave the source pointing at nothing.
 *
 * A bookmark saved without an id whose URL matches a live bookmark the user
 * already holds revises that one, and changes nothing if nothing differs, so
 * a rerun capture versions its bookmarks instead of duplicating them. Other
 * kinds always create: a page legitimately has many highlights (references)
 * and many captured documents.
 */
export async function saveSource(
  env: { DB: D1Database } & AllowanceSettings,
  input: SaveSource,
  provenance: Provenance,
): Promise<Source> {
  const db = env.DB;
  const now = nowSeconds();
  const matched =
    input.sourceId === undefined && input.kind === "bookmark" && input.url
      ? await liveBookmarkAt(db, provenance.userId, input.url)
      : null;
  const head =
    input.sourceId === undefined
      ? matched
      : await readSource(db, provenance.userId, input.sourceId);
  if (input.sourceId !== undefined) {
    if (head === null) {
      throw new SourceRefused(
        `No source exists for ${sourceRef(input.sourceId)}.`,
      );
    }
    if (input.expectedRevision === undefined) {
      throw new SourceRefused(
        `Pass expected_revision ${head.revision} to change ${sourceRef(head.sourceId)}.`,
      );
    }
    if (input.expectedRevision !== head.revision) {
      throw new SourceRefused(conflict(head));
    }
  }

  const kind = input.kind ?? head?.kind;
  const title = input.title?.trim() || head?.title;
  if (!kind || !title) {
    throw new SourceRefused("A new source needs a kind and a title.");
  }
  const url = input.url !== undefined ? input.url : (head?.url ?? null);
  const notes =
    input.notes !== undefined ? input.notes.trim() : (head?.notes ?? "");
  const project =
    input.project !== undefined ? input.project : (head?.project ?? null);
  const tags = input.tags ?? head?.tags ?? [];
  const authors = normalizeAuthorList(input.authors ?? head?.authors ?? []);
  if (authors.length > MAX_AUTHORS) {
    throw new SourceRefused(`A source names at most ${MAX_AUTHORS} authors.`);
  }
  const assetIds = [
    ...new Set([
      ...(input.assetIds ?? head?.assets.map((asset) => asset.assetId) ?? []),
      ...(input.addAssetIds ?? []),
    ]),
  ];
  const linksChanged =
    assetIds.join() !==
    (head?.assets.map((asset) => asset.assetId) ?? []).join();
  if (assetIds.length > MAX_SOURCE_ASSETS) {
    throw new SourceRefused(
      `A source links at most ${MAX_SOURCE_ASSETS} files.`,
    );
  }
  if (!url && assetIds.length === 0 && notes === "") {
    throw new SourceRefused(
      "A source needs at least one of a URL, a linked asset, or notes.",
    );
  }
  const published =
    input.published !== undefined
      ? input.published
      : (publishedSeconds(input.article?.published) ?? undefined);
  if (
    matched !== null &&
    unchanged(matched, {
      published,
      kind,
      title,
      url,
      notes,
      project,
      tags,
      authors,
      assetIds,
      article: input.article,
    })
  ) {
    return matched;
  }
  if (linksChanged) {
    const linked = await checkLinkable(db, provenance.userId, assetIds);
    // Only a bookmark's files count against its allowance; documents are files.
    const refusal =
      kind === "bookmark"
        ? attachmentRefusal(
            await allowanceOf(db, provenance.userId, env),
            linked.map((asset) => ({
              title: asset.title,
              contentType: asset.contentType,
              size: asset.size ?? 0,
            })),
          )
        : null;
    if (refusal) throw new SourceRefused(refusal);
  }

  const sourceId = head?.sourceId ?? `src_${crypto.randomUUID()}`;
  const revision = (head?.revision ?? 0) + 1;
  const tagsJson = JSON.stringify(tags);
  const authorsJson = JSON.stringify(authors);
  const articleText =
    input.article !== undefined
      ? input.article.detected
        ? input.article.text
        : null
      : head?.article && "text" in head.article && head.article.detected
        ? head.article.text
        : null;
  const statements: D1PreparedStatement[] = [];
  if (head === null) {
    statements.push(
      db
        .prepare(
          `INSERT INTO sources (
             source_id, user_id, kind, title, url, notes, project, tags_json,
             authors_json, revision, source_agent, source_client,
             source_session, published_at, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          sourceId,
          provenance.userId,
          kind,
          title,
          url,
          notes,
          project,
          tagsJson,
          authorsJson,
          revision,
          provenance.agent,
          provenance.client,
          provenance.session,
          published ?? null,
          now,
          now,
        ),
    );
  } else {
    statements.push(
      db
        .prepare(
          `UPDATE sources
              SET kind = ?, title = ?, url = ?, notes = ?, project = ?,
                  tags_json = ?, authors_json = ?, revision = ?, updated_at = ?,
                  published_at = CASE WHEN ? THEN ? ELSE published_at END
            WHERE source_id = ? AND user_id = ? AND revision = ?`,
        )
        .bind(
          kind,
          title,
          url,
          notes,
          project,
          tagsJson,
          authorsJson,
          revision,
          now,
          published === undefined ? 0 : 1,
          published ?? null,
          sourceId,
          provenance.userId,
          head.revision,
        ),
    );
  }
  // The UNIQUE (source_id, revision) index is what refuses the loser of two
  // saves from the same expected revision: both insert the same number.
  statements.push(
    db
      .prepare(
        `INSERT INTO source_revisions (
           revision_id, source_id, revision, kind, title, url, notes, project,
           tags_json, authors_json, source_agent, source_client,
           source_session, created_at, published_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
           (SELECT published_at FROM sources WHERE source_id = ? AND user_id = ?))`,
      )
      .bind(
        `srv_${crypto.randomUUID()}`,
        sourceId,
        revision,
        kind,
        title,
        url,
        notes,
        project,
        tagsJson,
        authorsJson,
        provenance.agent,
        provenance.client,
        provenance.session,
        now,
        sourceId,
        provenance.userId,
      ),
    ...(input.article === undefined
      ? []
      : [
          articleInsert(
            db,
            sourceId,
            revision,
            provenance.userId,
            input.article,
            now,
          ),
        ]),
    ...assetIds.map((assetId, position) =>
      db
        .prepare(
          `INSERT INTO source_revision_assets (source_id, revision, asset_id, position)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(sourceId, revision, assetId, position),
    ),
    projectionStatement(
      db,
      projectSource({
        sourceId,
        userId: provenance.userId,
        title,
        url,
        notes,
        tagsJson,
        authorsJson,
        articleText,
        project,
        archivedAt: head?.archivedAt ?? null,
        updatedAt: now,
      }),
      sourceRef(sourceId),
    ),
    ...sourceSearchStatements(db, sourceId, provenance.userId),
  );
  try {
    await db.batch(statements);
  } catch (error) {
    const current = await readSource(db, provenance.userId, sourceId);
    if (current !== null && current.revision !== revision - 1) {
      throw new SourceRefused(conflict(current));
    }
    throw error;
  }
  const saved = await readSource(db, provenance.userId, sourceId);
  if (saved === null) throw new Error("the saved source did not persist");
  return saved;
}

export type SavedAtUrl = {
  sourceId: string;
  kind: string;
  title: string;
  revision: number;
  updatedAt: number;
  /** The head revision's notes, whole. */
  notes: string;
  /** The newest available HTML file linked to the head revision. */
  archiveAssetId: string | null;
};

/** Unarchived sources at exactly this URL, any kind, newest first. Reads only. */
export async function sourcesSavedAt(
  db: D1Database,
  userId: string,
  url: string,
): Promise<SavedAtUrl[]> {
  const { results } = await db
    .prepare(
      `SELECT s.source_id AS sourceId, s.kind, s.title, s.revision,
              s.updated_at AS updatedAt, s.notes,
              (SELECT a.asset_id FROM source_revision_assets ra
                 JOIN assets a ON a.asset_id = ra.asset_id
                WHERE ra.source_id = s.source_id AND ra.revision = s.revision
                  AND a.user_id = s.user_id AND a.state = 'ready'
                  AND (a.expires_at IS NULL OR a.expires_at > ?3)
                  AND a.content_type = 'text/html'
                ORDER BY a.created_at DESC, a.asset_id DESC LIMIT 1) AS archiveAssetId
         FROM sources s
        WHERE s.user_id = ?1 AND s.url = ?2 AND s.archived_at IS NULL
        ORDER BY s.updated_at DESC, s.source_id DESC LIMIT 10`,
    )
    .bind(userId, url, nowSeconds())
    .all<SavedAtUrl>();
  return results;
}

/** The most recently updated unarchived bookmark at exactly this URL. */
export async function liveBookmarkAt(
  db: D1Database,
  userId: string,
  url: string,
): Promise<Source | null> {
  const row = await db
    .prepare(
      `SELECT source_id AS sourceId FROM sources
        WHERE user_id = ? AND url = ? AND kind = 'bookmark'
          AND archived_at IS NULL
        ORDER BY updated_at DESC LIMIT 1`,
    )
    .bind(userId, url)
    .first<{ sourceId: string }>();
  return row === null ? null : readSource(db, userId, row.sourceId);
}

function unchanged(
  head: Source,
  next: {
    published: number | null | undefined;
    kind: string;
    title: string;
    url: string | null;
    notes: string;
    project: string | null;
    tags: readonly string[];
    authors: readonly string[];
    assetIds: readonly string[];
    article: ArticleInput | undefined;
  },
): boolean {
  const same = (a: readonly string[], b: readonly string[]) =>
    a.length === b.length && a.every((value, index) => value === b[index]);
  const article =
    next.article === undefined ||
    (head.article !== null &&
      "text" in head.article &&
      head.article.detected === next.article.detected &&
      head.article.text === next.article.text &&
      head.article.markdown === next.article.markdown);
  return (
    article &&
    (next.published === undefined || head.published === next.published) &&
    head.kind === next.kind &&
    head.title === next.title &&
    head.url === next.url &&
    head.notes === next.notes &&
    head.project === next.project &&
    same(head.tags, next.tags) &&
    same(head.authors, next.authors) &&
    same(
      head.assets.map((asset) => asset.assetId),
      next.assetIds,
    )
  );
}

/** Archive or restore: out of search and lists, revisions and links kept. */
export async function setSourceArchived(
  db: D1Database,
  userId: string,
  sourceId: string,
  archived: boolean,
): Promise<boolean> {
  const source = await readSource(db, userId, sourceId);
  if (source === null) return false;
  const now = nowSeconds();
  const archivedAt = archived ? now : null;
  await db.batch([
    db
      .prepare(
        `UPDATE sources SET archived_at = ?, updated_at = ?
          WHERE source_id = ? AND user_id = ?`,
      )
      .bind(archivedAt, now, sourceId, userId),
    projectionStatement(
      db,
      projectSource({
        ...source,
        tagsJson: JSON.stringify(source.tags),
        authorsJson: JSON.stringify(source.authors),
        articleText:
          source.article && "text" in source.article && source.article.detected
            ? source.article.text
            : null,
        archivedAt,
        updatedAt: now,
      }),
      sourceRef(sourceId),
    ),
    ...sourceSearchStatements(db, sourceId, userId),
    sourceVectorInvalidateStatement(db, userId, sourceId),
  ]);
  return true;
}

/** The head of an owned source, archived or not, or null. */
export async function readSource(
  db: D1Database,
  userId: string,
  sourceId: string,
): Promise<Source | null> {
  const row = await db
    .prepare(
      `SELECT source_id AS sourceId, user_id AS userId, kind, title, url, notes,
              project, tags_json AS tagsJson, authors_json AS authorsJson,
              revision, source_agent AS sourceAgent,
              source_client AS sourceClient, source_session AS sourceSession,
              ${PUBLISHED_SQL("sources")} AS published,
              created_at AS createdAt, updated_at AS updatedAt,
              archived_at AS archivedAt
         FROM sources WHERE source_id = ? AND user_id = ?`,
    )
    .bind(sourceId, userId)
    .first<SourceRow>();
  if (row === null) return null;
  const { tagsJson, authorsJson, ...rest } = row;
  return {
    ...rest,
    tags: parseTags(tagsJson),
    authors: parseTags(authorsJson),
    assets: await linkedAssets(db, userId, sourceId, row.revision),
    article: await readSourceArticle(db, userId, sourceId),
  };
}

/** The owner's sources, newest first, archived or not as asked. */
export async function listSources(
  db: D1Database,
  userId: string,
  archived: boolean,
): Promise<Source[]> {
  return sourceList(db, userId, archived);
}

/** One bounded head query plus one owned link join, never reads per card. */
export type SourcePageOptions = LibraryPageOptions & {
  fullNotesFor?: string;
  sort?: SourceSort;
};
export async function listSourcesPage(
  db: D1Database,
  userId: string,
  archived: boolean,
  options: SourcePageOptions = {},
) {
  const rows = await sourceList(db, userId, archived, options);
  return libraryPage(rows, (row) => ({
    createdAt:
      options.sort === "published"
        ? Math.max(row.published ?? 0, 0)
        : row.createdAt,
    id: row.sourceId,
  }));
}

async function sourceList(
  db: D1Database,
  userId: string,
  archived: boolean,
  options?: SourcePageOptions,
): Promise<Source[]> {
  const key = SORT_KEYS[options?.sort ?? "saved"]("s");
  const where = options
    ? libraryPageWhere("s", "source_id", options, key)
    : { sql: "", values: [] };
  const { results } = await db
    .prepare(`SELECT
      s.source_id AS sourceId, s.user_id AS userId, s.kind, s.title, s.url,
      ${options ? "CASE WHEN s.source_id = ? THEN s.notes ELSE substr(s.notes, 1, 400) END" : "s.notes"} AS notes,
      s.project, s.tags_json AS tagsJson, s.authors_json AS authorsJson, s.revision,
      s.source_agent AS sourceAgent, s.source_client AS sourceClient,
      s.source_session AS sourceSession, ${PUBLISHED_SQL("s")} AS published,
      s.created_at AS createdAt,
      s.updated_at AS updatedAt, s.archived_at AS archivedAt,
      ${ARTICLE_SUMMARY_SQL("s")} AS articleJson
    FROM sources s WHERE s.user_id = ? AND (s.archived_at IS NOT NULL) = ? ${where.sql}
    ORDER BY ${key} DESC, s.source_id DESC ${options ? "LIMIT ?" : ""}`)
    .bind(
      ...(options ? [options.fullNotesFor ?? ""] : []),
      userId,
      archived ? 1 : 0,
      ...where.values,
      ...(options ? [LIBRARY_PAGE_SIZE + 1] : []),
    )
    .all<SourceRow & { articleJson: string | null }>();
  if (!results.length) return [];
  const { results: links } = await db
    .prepare(`SELECT s.source_id AS sourceId,
      ra.asset_id AS assetId, a.title, a.file_name AS fileName,
      a.content_type AS contentType, o.size, o.object_id AS objectId,
      a.asset_id IS NOT NULL AS available
    FROM json_each(?1) AS head
    JOIN sources s ON s.source_id = json_extract(head.value, '$[0]') AND s.user_id = ?2
    JOIN source_revision_assets ra
      ON ra.source_id = s.source_id AND ra.revision = json_extract(head.value, '$[1]')
    LEFT JOIN assets a ON a.asset_id = ra.asset_id AND a.user_id = s.user_id
      AND a.state = 'ready' AND (a.expires_at IS NULL OR a.expires_at > ?3)
    LEFT JOIN objects o ON o.object_id = a.object_id AND o.user_id = s.user_id
    ORDER BY s.source_id, ra.position`)
    .bind(
      JSON.stringify(results.map((row) => [row.sourceId, row.revision])),
      userId,
      nowSeconds(),
    )
    .all<
      Omit<SourceAsset, "available" | "title" | "fileName" | "contentType"> & {
        sourceId: string;
        title: string | null;
        fileName: string | null;
        contentType: string | null;
        available: number;
      }
    >();
  const assets = new Map<string, SourceAsset[]>();
  for (const {
    sourceId,
    available,
    title,
    fileName,
    contentType,
    ...link
  } of links) {
    const group = assets.get(sourceId) ?? [];
    group.push({
      ...link,
      available: !!available,
      title: title ?? "",
      fileName: fileName ?? "",
      contentType: contentType ?? "",
    });
    assets.set(sourceId, group);
  }
  return results.map(({ tagsJson, authorsJson, articleJson, ...row }) => ({
    ...row,
    tags: parseTags(tagsJson),
    authors: parseTags(authorsJson),
    assets: assets.get(row.sourceId) ?? [],
    article: parseArticleSummary(articleJson),
  }));
}

/**
 * Deletes a source with every revision and link: the explicit removal that
 * releases the assets it protected. Console only (ADR-0003: no MCP delete).
 */
export async function deleteSource(
  db: D1Database,
  userId: string,
  sourceId: string,
): Promise<boolean> {
  const owned = await db
    .prepare("SELECT 1 FROM sources WHERE source_id = ? AND user_id = ?")
    .bind(sourceId, userId)
    .first();
  if (owned === null) return false;
  await db.batch([
    db
      .prepare("DELETE FROM source_revision_assets WHERE source_id = ?")
      .bind(sourceId),
    db
      .prepare("DELETE FROM source_enrichments WHERE source_id = ?")
      .bind(sourceId),
    db
      .prepare("DELETE FROM source_articles WHERE source_id = ?")
      .bind(sourceId),
    db
      .prepare(
        "DELETE FROM search_docs WHERE user_id = ? AND concept = 'source' AND concept_id = ?",
      )
      .bind(userId, sourceId),
    db
      .prepare("DELETE FROM source_revisions WHERE source_id = ?")
      .bind(sourceId),
    db
      .prepare("DELETE FROM sources WHERE source_id = ? AND user_id = ?")
      .bind(sourceId, userId),
    projectionStatement(db, null, sourceRef(sourceId)),
    // The ledger rows outlive the source so the drain can delete its vectors.
    sourceVectorInvalidateStatement(db, userId, sourceId),
    ...forgetUseStatements(db, userId, "source", sourceId),
  ]);
  return true;
}

/** Every revision, oldest first, each with the asset ids it linked. */
export async function listSourceRevisions(
  db: D1Database,
  userId: string,
  sourceId: string,
  recentLimit?: number,
): Promise<SourceRevision[]> {
  const { results } = await db
    .prepare(
      `SELECT r.revision, r.kind, r.title, r.url, r.notes, r.project,
              r.tags_json AS tagsJson, r.source_agent AS sourceAgent,
              r.source_client AS sourceClient, r.source_session AS sourceSession,
              r.published_at AS publishedAt, r.created_at AS createdAt,
              (SELECT json_group_array(asset_id)
                 FROM (SELECT asset_id FROM source_revision_assets ra
                        WHERE ra.source_id = r.source_id AND ra.revision = r.revision
                        ORDER BY position)) AS assetIdsJson
         FROM source_revisions r
         JOIN sources s ON s.source_id = r.source_id
        WHERE r.source_id = ? AND s.user_id = ?
        ORDER BY r.revision ${recentLimit ? "DESC LIMIT ?" : ""}`,
    )
    .bind(
      sourceId,
      userId,
      ...(recentLimit ? [Math.max(1, Math.min(recentLimit, 10))] : []),
    )
    .all<
      Omit<SourceRevision, "tags" | "assetIds"> & {
        tagsJson: string;
        assetIdsJson: string;
      }
    >();
  return results.map(({ tagsJson, assetIdsJson, ...rest }) => ({
    ...rest,
    tags: parseTags(tagsJson),
    assetIds: parseTags(assetIdsJson),
  }));
}

/** Search may show this user these sources: owned and not archived. */
export async function visibleSourceIds(
  db: D1Database,
  userId: string,
  sourceIds: string[],
): Promise<Set<string>> {
  if (sourceIds.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT source_id FROM sources
        WHERE user_id = ? AND archived_at IS NULL
          AND source_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, JSON.stringify(sourceIds))
    .all<{ source_id: string }>();
  return new Set(results.map((row) => row.source_id));
}

async function linkedAssets(
  db: D1Database,
  userId: string,
  sourceId: string,
  revision: number,
): Promise<SourceAsset[]> {
  const { results } = await db
    .prepare(
      `SELECT ra.asset_id AS assetId FROM source_revision_assets ra
        WHERE ra.source_id = ? AND ra.revision = ?
        ORDER BY ra.position`,
    )
    .bind(sourceId, revision)
    .all<{ assetId: string }>();
  const linked: SourceAsset[] = [];
  for (const { assetId } of results) {
    const asset = await readAsset(db, userId, assetId);
    linked.push(
      asset
        ? {
            assetId,
            title: asset.title,
            fileName: asset.fileName,
            contentType: asset.contentType,
            size: asset.size,
            objectId: asset.objectId,
            available: true,
          }
        : {
            assetId,
            title: "",
            fileName: "",
            contentType: "",
            size: null,
            objectId: null,
            available: false,
          },
    );
  }
  return linked;
}

async function checkLinkable(
  db: D1Database,
  userId: string,
  assetIds: string[],
): Promise<Asset[]> {
  const refused: string[] = [];
  const linked: Asset[] = [];
  for (const assetId of assetIds) {
    const asset = await readAsset(db, userId, assetId);
    if (asset === null)
      refused.push(`${assetRef(assetId)} is not a ready asset`);
    else if (asset.expiresAt !== null)
      refused.push(
        `${assetRef(assetId)} expires; clear its expiry with update_asset first`,
      );
    else linked.push(asset);
  }
  if (refused.length) throw new SourceRefused(`${refused.join("; ")}.`);
  return linked;
}

type SourceRow = Omit<Source, "tags" | "authors" | "assets" | "article"> & {
  tagsJson: string;
  authorsJson: string;
};

/**
 * Trims, collapses whitespace and drops case-insensitive duplicates, keeping
 * the first spelling. Matching "Luke W" to "Luke Wroblewski" is the author
 * view's job, not the stored list's: the byline is kept as written.
 */
export function normalizeAuthorList(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const kept: string[] = [];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim();
    const key = name.toLowerCase();
    if (!name || seen.has(key)) continue;
    seen.add(key);
    kept.push(name);
  }
  return kept;
}

function conflict(head: Source): string {
  return `${sourceRef(head.sourceId)} is at revision ${head.revision}, not the expected one. Fetch it, merge your change into the current notes, and save with expected_revision ${head.revision}.`;
}

function parseTags(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}
