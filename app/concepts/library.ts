import {
  type Asset,
  type AssetEnv,
  AssetRefused,
  assetIdOf,
  assetRef,
  assetReferences,
  assetUnpublishStatements,
  type BeginAssetUpload,
  beginAssetUpload,
  finalizeAssetUpload,
  listAssets,
  readAsset,
  readAssetRow,
} from "~/concepts/assets";
import { unreferencedHookFiles } from "~/concepts/hook-runnables";
import { forgetUseStatements } from "~/concepts/library-use";
import type { Provenance } from "~/concepts/memories";
import { sourceSearchStatements } from "~/concepts/source-search";
import {
  listSourceRevisions,
  listSources,
  sourceIdOf,
  sourceRef,
} from "~/concepts/sources";
import {
  nowSeconds,
  objectKey,
  sha256Hex,
  uploadKey,
  uploadPrefix,
} from "~/r2/objects";
import { assetVectorInvalidateStatement } from "~/search/asset-vectors";
import { projectAsset, projectSource } from "~/search/project";
import { projectionStatement } from "~/search/write";

/**
 * The library as a whole: the console's upload and delete, the nightly
 * cleanup, and the export and import that make a library portable.
 * ADR-0015.
 */

/**
 * A console upload: the same begin, staged bytes and finalize an agent
 * uses, run server-side because the browser already sent the bytes here.
 */
export async function uploadAssetFile(
  env: AssetEnv,
  file: File,
  details: {
    title?: string;
    description?: string;
    expiresInSeconds?: number;
  },
  provenance: Provenance,
): Promise<Asset> {
  if (file.size === 0) throw new AssetRefused("That file is empty.");
  return storeAssetBytes(
    env,
    {
      fileName: file.name,
      contentType: file.type,
      title: details.title,
      description: details.description,
      expiresInSeconds: details.expiresInSeconds,
    },
    await file.arrayBuffer(),
    provenance,
  );
}

/**
 * Bytes already in this Worker, stored as a ready asset: begin, stage and
 * finalize in one request, the path `PUT /uploads/{id}` runs for a remote
 * client. A declared checksum is checked before any row is written. A
 * finalize that fails leaves a pending row that the nightly cleanup removes
 * once its upload expires, as an abandoned PUT does.
 */
export async function storeAssetBytes(
  env: AssetEnv,
  input: Omit<BeginAssetUpload, "size">,
  bytes: ArrayBuffer,
  provenance: Provenance,
): Promise<Asset> {
  const sha256 = await sha256Hex(bytes);
  if (input.sha256 && input.sha256.toLowerCase() !== sha256)
    throw new AssetRefused(
      `The file hashes to ${sha256}, not the declared ${input.sha256}.`,
    );
  const { asset } = await beginAssetUpload(
    env,
    { ...input, size: bytes.byteLength },
    provenance,
  );
  await env.BUNDLES.put(uploadKey(provenance.userId, asset.assetId), bytes, {
    customMetadata: { sha256 },
  });
  const finalized = await finalizeAssetUpload(
    env,
    provenance.userId,
    asset.assetId,
  );
  if (!finalized.ok) throw new AssetRefused(finalized.reason);
  return finalized.asset;
}

/**
 * Deletes an asset and its bytes, which nothing else does: ADR-0003 keeps
 * deletion in the console. Refused, naming them, while a source revision or
 * a to-do or memory attachment refers to the file.
 */
export async function deleteAsset(
  env: AssetEnv,
  userId: string,
  assetId: string,
): Promise<{ deleted: true } | { refusedBy: string[] } | null> {
  const asset = await readAssetRow(env.DB, userId, assetId);
  if (asset === null) return null;
  const references = await assetReferences(env.DB, asset);
  if (references.length > 0) return { refusedBy: references };
  await purgeAsset(env, asset);
  return { deleted: true };
}

/**
 * Bytes first, rows second. A failure between them leaves a row whose bytes
 * are gone, which every delivery path already answers as missing, and the
 * next run deletes the row; the reverse order would leave bytes no row
 * names. R2 deletes are idempotent, so a retry repeats them harmlessly.
 */
async function purgeAsset(
  env: AssetEnv,
  asset: Pick<Asset, "assetId" | "userId" | "objectId">,
): Promise<void> {
  const object =
    asset.objectId === null
      ? null
      : await env.DB.prepare(
          "SELECT r2_key FROM objects WHERE object_id = ? AND user_id = ?",
        )
          .bind(asset.objectId, asset.userId)
          .first<{ r2_key: string }>();
  await env.BUNDLES.delete(
    [uploadKey(asset.userId, asset.assetId), object?.r2_key].filter(
      (key): key is string => typeof key === "string",
    ),
  );
  await env.DB.batch([
    ...assetUnpublishStatements(env.DB, asset.assetId, asset.userId),
    assetVectorInvalidateStatement(env.DB, asset.userId, asset.assetId),
    ...forgetUseStatements(env.DB, asset.userId, "asset", asset.assetId),
    env.DB.prepare(
      "DELETE FROM assets WHERE asset_id = ? AND user_id = ?",
    ).bind(asset.assetId, asset.userId),
    ...(asset.objectId === null
      ? []
      : [
          env.DB.prepare(
            "DELETE FROM objects WHERE object_id = ? AND user_id = ?",
          ).bind(asset.objectId, asset.userId),
        ]),
  ]);
}

export type CleanupReport = {
  abandoned: number;
  expired: number;
  protected: number;
  strayUploads: number;
  orphanObjects: number;
  /** Hook files no live version names any more. */
  hookFiles: number;
  errors: string[];
};

/** Rows handled per run; the rest wait a night. */
const CLEANUP_BATCH = 200;
/** An object key younger than this may belong to a finalize in flight. */
const ORPHAN_GRACE_SECONDS = 24 * 60 * 60;

/**
 * The nightly sweep, ADR-0015. Each step is idempotent and catches its own
 * failures, so one bad row does not stop the rest and the next run retries.
 *
 * 1. Uploads abandoned past their credential's life, and failed ones, lose
 *    their staged bytes and their row. They were never discoverable.
 * 2. Expired assets nothing refers to lose their bytes, row and object row.
 *    They were already denied on every path; this reclaims the storage.
 * 3. Staged uploads with no pending asset, left by a finalize whose delete
 *    failed, are deleted.
 * 4. Object keys no `objects` row names, from a batch that failed after its
 *    R2 write, are deleted once a day old (ADR-0011's accepted orphans).
 *
 * Between 2 and 3, hook files no approved or pending version names lose
 * their bytes and rows (ADR-0023).
 */
export async function cleanupLibrary(
  env: AssetEnv,
  now = nowSeconds(),
): Promise<CleanupReport> {
  const report: CleanupReport = {
    abandoned: 0,
    expired: 0,
    protected: 0,
    strayUploads: 0,
    orphanObjects: 0,
    hookFiles: 0,
    errors: [],
  };
  const attempt = async (what: string, step: () => Promise<void>) => {
    try {
      await step();
    } catch (error) {
      report.errors.push(`${what}: ${String(error)}`);
    }
  };

  const { results: abandoned } = await env.DB.prepare(
    `SELECT asset_id AS assetId, user_id AS userId FROM assets
      WHERE (state = 'pending' AND upload_expires_at <= ?) OR state = 'failed'
      LIMIT ?`,
  )
    .bind(now, CLEANUP_BATCH)
    .all<{ assetId: string; userId: string }>();
  for (const row of abandoned) {
    await attempt(assetRef(row.assetId), async () => {
      await env.BUNDLES.delete(uploadKey(row.userId, row.assetId));
      // Still pending and still past its life: a finalize that won in the
      // meantime made it ready, and this deletes nothing.
      const { results } = await env.DB.prepare(
        `DELETE FROM assets WHERE asset_id = ?
            AND ((state = 'pending' AND upload_expires_at <= ?) OR state = 'failed')
          RETURNING asset_id`,
      )
        .bind(row.assetId, now)
        .all<{ asset_id: string }>();
      // D1 meta.changes includes the folder/membership trigger writes too.
      report.abandoned += results.length;
    });
  }

  const { results: expired } = await env.DB.prepare(
    `SELECT asset_id AS assetId, user_id AS userId FROM assets
      WHERE state = 'ready' AND expires_at <= ?
      LIMIT ?`,
  )
    .bind(now, CLEANUP_BATCH)
    .all<{ assetId: string; userId: string }>();
  for (const row of expired) {
    await attempt(assetRef(row.assetId), async () => {
      const asset = await readAssetRow(env.DB, row.userId, row.assetId);
      if (asset === null) return;
      if ((await assetReferences(env.DB, asset)).length > 0) {
        report.protected++;
        return;
      }
      await purgeAsset(env, asset);
      report.expired++;
    });
  }

  // Hook files are never given an expiry; they go once no live version
  // names them. ADR-0023.
  for (const file of await unreferencedHookFiles(env.DB, now)) {
    await attempt(assetRef(file.assetId), async () => {
      await purgeAsset(env, file);
      report.hookFiles++;
    });
  }

  const { results: owners } = await env.DB.prepare(
    "SELECT DISTINCT user_id AS userId FROM objects UNION SELECT DISTINCT user_id FROM assets",
  ).all<{ userId: string }>();
  for (const { userId } of owners) {
    await attempt(`uploads of ${userId}`, async () => {
      const listed = await env.BUNDLES.list({ prefix: uploadPrefix(userId) });
      const stray: string[] = [];
      for (const object of listed.objects) {
        const assetId = object.key.slice(uploadPrefix(userId).length);
        const pending = await env.DB.prepare(
          "SELECT 1 FROM assets WHERE asset_id = ? AND user_id = ? AND state = 'pending'",
        )
          .bind(assetId, userId)
          .first();
        if (pending === null) stray.push(object.key);
      }
      if (stray.length) await env.BUNDLES.delete(stray);
      report.strayUploads += stray.length;
    });
    await attempt(`objects of ${userId}`, async () => {
      const prefix = objectKey(userId, "");
      const listed = await env.BUNDLES.list({ prefix });
      const keys = listed.objects
        .filter(
          (object) =>
            object.uploaded.getTime() / 1000 < now - ORPHAN_GRACE_SECONDS,
        )
        .map((object) => object.key);
      if (keys.length === 0) return;
      const { results } = await env.DB.prepare(
        "SELECT r2_key FROM objects WHERE r2_key IN (SELECT value FROM json_each(?))",
      )
        .bind(JSON.stringify(keys))
        .all<{ r2_key: string }>();
      const named = new Set(results.map((row) => row.r2_key));
      const orphans = keys.filter((key) => !named.has(key));
      if (orphans.length) await env.BUNDLES.delete(orphans);
      report.orphanObjects += orphans.length;
    });
  }
  return report;
}

// --- Export and import ------------------------------------------------------

export const LIBRARY_FORMAT = "valise-library";
export const LIBRARY_VERSION = 1;

type Provenanced = {
  provenance: { agent: string; client: string; session: string | null };
};

export type ManifestAsset = Provenanced & {
  id: string;
  title: string;
  description: string;
  file_name: string;
  content_type: string;
  size: number;
  sha256: string;
  project: string | null;
  tags: string[];
  expires_at: number | null;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  finalized_at: number | null;
  /** Where the original sits inside the export directory. */
  file: string;
  /** Absent in older v1 exports: those import as singleton folders. */
  folder?: {
    id: string;
    title: string | null;
    created_at: number;
    /** Absent in exports from before folder tags and notes (2026-11-02). */
    tags?: string[];
    notes?: string;
  };
};

export type ManifestRevision = Provenanced & {
  revision: number;
  kind: string;
  title: string;
  url: string | null;
  notes: string;
  project: string | null;
  tags: string[];
  assets: string[];
  /** Absent in exports made before publication dates were kept. */
  published_at?: number | null;
  created_at: number;
};

export type ManifestSource = Provenanced & {
  id: string;
  revision: number;
  archived_at: number | null;
  created_at: number;
  updated_at: number;
  revisions: ManifestRevision[];
};

export type LibraryManifest = {
  format: typeof LIBRARY_FORMAT;
  version: typeof LIBRARY_VERSION;
  exported_at: number;
  assets: ManifestAsset[];
  sources: ManifestSource[];
};

/** `files/ast_…/name.pdf`: one folder per asset, so names never collide. */
export function exportPath(asset: Pick<Asset, "assetId" | "fileName">) {
  return `files/${asset.assetId}/${asset.fileName}`;
}

/**
 * Every ready, unexpired asset and every source with all its revisions and
 * links, archived ones included, with stable ids and provenance. The bytes
 * are fetched per asset alongside. docs/operations/library-export.md.
 */
export async function exportManifest(
  db: D1Database,
  userId: string,
): Promise<LibraryManifest> {
  const assets = [
    ...(await listAssets(db, userId, false)),
    ...(await listAssets(db, userId, true)),
  ];
  const sources = [
    ...(await listSources(db, userId, false)),
    ...(await listSources(db, userId, true)),
  ];
  const { results: folders } = await db
    .prepare(`SELECT m.asset_id AS assetId, f.folder_id AS id, f.title, f.created_at,
    f.tags_json AS tagsJson, f.notes
    FROM asset_folders f JOIN asset_folder_files m USING(folder_id) WHERE f.user_id = ? AND m.user_id = f.user_id`)
    .bind(userId)
    .all<{
      assetId: string;
      id: string;
      title: string | null;
      created_at: number;
      tagsJson: string;
      notes: string;
    }>();
  const foldersByAsset = new Map(
    folders.map(({ assetId, tagsJson, ...folder }) => [
      assetId,
      { ...folder, tags: JSON.parse(tagsJson) as string[] },
    ]),
  );
  return {
    format: LIBRARY_FORMAT,
    version: LIBRARY_VERSION,
    exported_at: nowSeconds(),
    assets: assets.map((asset) => ({
      id: assetRef(asset.assetId),
      title: asset.title,
      description: asset.description,
      file_name: asset.fileName,
      content_type: asset.contentType,
      size: asset.size ?? 0,
      sha256: asset.sha256 ?? "",
      project: asset.project,
      tags: asset.tags,
      expires_at: asset.expiresAt,
      archived_at: asset.archivedAt,
      created_at: asset.createdAt,
      updated_at: asset.updatedAt,
      finalized_at: asset.finalizedAt,
      provenance: {
        agent: asset.sourceAgent,
        client: asset.sourceClient,
        session: asset.sourceSession,
      },
      file: exportPath(asset),
      folder: foldersByAsset.get(asset.assetId),
    })),
    sources: await Promise.all(
      sources.map(async (source) => ({
        id: sourceRef(source.sourceId),
        revision: source.revision,
        archived_at: source.archivedAt,
        created_at: source.createdAt,
        updated_at: source.updatedAt,
        provenance: {
          agent: source.sourceAgent,
          client: source.sourceClient,
          session: source.sourceSession,
        },
        revisions: (await listSourceRevisions(db, userId, source.sourceId)).map(
          (revision) => ({
            revision: revision.revision,
            kind: revision.kind,
            title: revision.title,
            url: revision.url,
            notes: revision.notes,
            project: revision.project,
            tags: revision.tags,
            assets: revision.assetIds.map(assetRef),
            published_at: revision.publishedAt,
            created_at: revision.createdAt,
            provenance: {
              agent: revision.sourceAgent,
              client: revision.sourceClient,
              session: revision.sourceSession,
            },
          }),
        ),
      })),
    ),
  };
}

export class ImportRefused extends Error {}

/**
 * Restores one asset under its original id and timestamps, from its manifest
 * entry and its bytes. The bytes must match the recorded size and checksum.
 * An id this user already has is skipped, so an import can be rerun.
 */
export async function importAsset(
  env: AssetEnv,
  userId: string,
  entry: ManifestAsset,
  bytes: ArrayBuffer,
): Promise<"imported" | "exists"> {
  const assetId = assetIdOf(entry.id);
  if (assetId === null)
    throw new ImportRefused(`${entry.id} is not an asset id.`);
  const existing = await env.DB.prepare(
    "SELECT user_id FROM assets WHERE asset_id = ?",
  )
    .bind(assetId)
    .first<{ user_id: string }>();
  if (existing !== null) {
    if (existing.user_id === userId) return "exists";
    throw new ImportRefused(`${entry.id} belongs to another library.`);
  }
  const sha256 = await sha256Hex(bytes);
  if (
    !entry.folder &&
    (await env.DB.prepare("SELECT 1 FROM asset_folders WHERE folder_id = ?")
      .bind(assetId)
      .first())
  )
    throw new ImportRefused(
      "This legacy asset id still names a retained folder. Export the current folder metadata before importing it; no files were merged.",
    );
  if (entry.folder) {
    if (
      typeof entry.folder.id !== "string" ||
      assetIdOf(entry.folder.id) !== entry.folder.id ||
      (entry.folder.title !== null &&
        (typeof entry.folder.title !== "string" ||
          !entry.folder.title.trim() ||
          entry.folder.title.length > 200)) ||
      !Number.isSafeInteger(entry.folder.created_at) ||
      entry.folder.created_at < 0 ||
      (entry.folder.tags !== undefined &&
        (!Array.isArray(entry.folder.tags) ||
          entry.folder.tags.length > 20 ||
          entry.folder.tags.some(
            (tag) => typeof tag !== "string" || !tag || tag.length > 100,
          ))) ||
      (entry.folder.notes !== undefined &&
        (typeof entry.folder.notes !== "string" ||
          entry.folder.notes.length > 4000))
    )
      throw new ImportRefused("Invalid folder metadata.");
    const owner = await env.DB.prepare(
      "SELECT user_id FROM asset_folders WHERE folder_id = ?",
    )
      .bind(entry.folder.id)
      .first<{ user_id: string }>();
    if (owner && owner.user_id !== userId)
      throw new ImportRefused("Folder belongs to another library.");
    const count = await env.DB.prepare(
      "SELECT COUNT(*) AS count FROM asset_folder_files WHERE folder_id = ?",
    )
      .bind(entry.folder.id)
      .first<{ count: number }>();
    if ((count?.count ?? 0) >= 100)
      throw new ImportRefused("Folder is full (100 files).");
  }
  if (bytes.byteLength !== entry.size || sha256 !== entry.sha256) {
    throw new ImportRefused(
      `${entry.id}: the file is ${bytes.byteLength} bytes hashing to ${sha256}; the manifest says ${entry.size} and ${entry.sha256}.`,
    );
  }
  const objectId = `obj_${crypto.randomUUID()}`;
  const r2Key = objectKey(userId, objectId);
  await env.BUNDLES.put(r2Key, bytes, {
    httpMetadata: { contentType: entry.content_type },
    customMetadata: { sha256 },
  });
  const tagsJson = JSON.stringify(entry.tags);
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO objects (
           object_id, user_id, r2_key, name, content_type, size, sha256, created_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        objectId,
        userId,
        r2Key,
        entry.file_name,
        entry.content_type,
        bytes.byteLength,
        sha256,
        entry.finalized_at ?? entry.created_at,
      ),
      env.DB.prepare(
        `INSERT INTO assets (
           asset_id, user_id, state, object_id, title, description, file_name,
           content_type, declared_size, declared_sha256, project, tags_json,
           source_agent, source_client, source_session, expires_at, archived_at,
           created_at, updated_at, finalized_at
         ) VALUES (?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        assetId,
        userId,
        objectId,
        entry.title,
        entry.description,
        entry.file_name,
        entry.content_type,
        entry.size,
        entry.sha256,
        entry.project,
        tagsJson,
        entry.provenance.agent,
        entry.provenance.client,
        entry.provenance.session,
        entry.expires_at,
        entry.archived_at,
        entry.created_at,
        entry.updated_at,
        entry.finalized_at,
      ),
      projectionStatement(
        env.DB,
        projectAsset({
          assetId,
          userId,
          state: "ready",
          title: entry.title,
          fileName: entry.file_name,
          description: entry.description,
          tagsJson,
          project: entry.project,
          archivedAt: entry.archived_at,
          updatedAt: entry.updated_at,
        }),
        assetRef(assetId),
      ),
      ...(entry.folder
        ? [
            // Every file of a folder carries the same details; the first
            // keeps them and later ones never overwrite what is there.
            env.DB.prepare(`INSERT INTO asset_folders(folder_id, user_id, title, created_at, tags_json, notes)
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(folder_id) DO UPDATE SET title = COALESCE(asset_folders.title, excluded.title),
            created_at = MIN(asset_folders.created_at, excluded.created_at),
            tags_json = CASE WHEN asset_folders.tags_json = '[]' THEN excluded.tags_json ELSE asset_folders.tags_json END,
            notes = CASE WHEN asset_folders.notes = '' THEN excluded.notes ELSE asset_folders.notes END
          WHERE asset_folders.user_id = excluded.user_id`).bind(
              entry.folder.id,
              userId,
              entry.folder.title,
              entry.folder.created_at,
              JSON.stringify(entry.folder.tags ?? []),
              entry.folder.notes ?? "",
            ),
            env.DB.prepare(
              "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = ? AND user_id = ?",
            ).bind(entry.folder.id, assetId, userId),
          ]
        : []),
    ]);
  } catch (error) {
    await env.BUNDLES.delete(r2Key);
    throw error;
  }
  return "imported";
}

/** A manifest is hand-editable JSON: keep a time only when it is one. */
function manifestSeconds(value: unknown): number | null {
  return Number.isSafeInteger(value) && (value as number) >= 0
    ? (value as number)
    : null;
}

/**
 * Restores sources under their original ids, with every revision, every
 * link and their provenance. Import the assets first: a revision that links
 * an asset this library does not have is refused, never silently dropped.
 */
export async function importSources(
  db: D1Database,
  userId: string,
  sources: ManifestSource[],
): Promise<{ imported: number; existing: number }> {
  let imported = 0;
  let existing = 0;
  for (const source of sources) {
    const sourceId = sourceIdOf(source.id);
    if (sourceId === null)
      throw new ImportRefused(`${source.id} is not a source id.`);
    const owner = await db
      .prepare("SELECT user_id FROM sources WHERE source_id = ?")
      .bind(sourceId)
      .first<{ user_id: string }>();
    if (owner !== null) {
      if (owner.user_id !== userId)
        throw new ImportRefused(`${source.id} belongs to another library.`);
      existing++;
      continue;
    }
    const revisions = [...source.revisions].sort(
      (a, b) => a.revision - b.revision,
    );
    const head = revisions.at(-1);
    if (
      head === undefined ||
      head.revision !== source.revision ||
      revisions.some((revision, at) => revision.revision !== at + 1)
    ) {
      throw new ImportRefused(
        `${source.id}: revisions must run 1..${source.revision} without gaps.`,
      );
    }
    for (const id of new Set(
      revisions.flatMap((revision) => revision.assets),
    )) {
      const assetId = assetIdOf(id);
      if (assetId === null || (await readAsset(db, userId, assetId)) === null) {
        throw new ImportRefused(
          `${source.id} links ${id}, which is not in this library. Import the assets first.`,
        );
      }
    }
    const headTags = JSON.stringify(head.tags);
    await db.batch([
      db
        .prepare(
          `INSERT INTO sources (
             source_id, user_id, kind, title, url, notes, project, tags_json,
             revision, source_agent, source_client, source_session,
             published_at, created_at, updated_at, archived_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          sourceId,
          userId,
          head.kind,
          head.title,
          head.url,
          head.notes,
          head.project,
          headTags,
          head.revision,
          source.provenance.agent,
          source.provenance.client,
          source.provenance.session,
          manifestSeconds(head.published_at),
          source.created_at,
          source.updated_at,
          source.archived_at,
        ),
      ...revisions.flatMap((revision) => [
        db
          .prepare(
            `INSERT INTO source_revisions (
               revision_id, source_id, revision, kind, title, url, notes,
               project, tags_json, source_agent, source_client,
               source_session, published_at, created_at
             ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(
            `srv_${crypto.randomUUID()}`,
            sourceId,
            revision.revision,
            revision.kind,
            revision.title,
            revision.url,
            revision.notes,
            revision.project,
            JSON.stringify(revision.tags),
            revision.provenance.agent,
            revision.provenance.client,
            revision.provenance.session,
            manifestSeconds(revision.published_at),
            revision.created_at,
          ),
        ...revision.assets.map((id, position) =>
          db
            .prepare(
              `INSERT INTO source_revision_assets (source_id, revision, asset_id, position)
               VALUES (?, ?, ?, ?)`,
            )
            .bind(sourceId, revision.revision, assetIdOf(id), position),
        ),
      ]),
      projectionStatement(
        db,
        projectSource({
          sourceId,
          userId,
          title: head.title,
          url: head.url,
          notes: head.notes,
          tagsJson: headTags,
          project: head.project,
          archivedAt: source.archived_at,
          updatedAt: source.updated_at,
        }),
        sourceRef(sourceId),
      ),
      ...sourceSearchStatements(db, sourceId, userId),
    ]);
    imported++;
  }
  return { imported, existing };
}

/** Identify import receipts among this page's owned links, not by MIME alone. */
export async function linkedImportBackups(
  db: D1Database,
  userId: string,
  assetIds: string[],
): Promise<string[]> {
  if (!assetIds.length) return [];
  const { results } = await db
    .prepare(`SELECT a.asset_id AS assetId FROM assets a
    WHERE a.user_id = ? AND a.source_agent = 'raindrop-import'
      AND a.asset_id IN (SELECT value FROM json_each(?))
      AND EXISTS (SELECT 1 FROM json_each(a.tags_json) WHERE value = 'import-snapshot')`)
    .bind(userId, JSON.stringify([...new Set(assetIds)]))
    .all<{ assetId: string }>();
  return results.map((row) => row.assetId);
}
