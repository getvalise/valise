import { AUTO_PROCESSING_BYTES } from "~/concepts/asset-formats";
import { type Passage, passageCitation } from "~/concepts/asset-passages";
import { queueAssetProcessing } from "~/concepts/asset-processing";
import {
  LIBRARY_PAGE_SIZE,
  type LibraryPageOptions,
  libraryPage,
  libraryPageWhere,
} from "~/concepts/library-page";
import type { Provenance } from "~/concepts/memories";
import {
  cleanName,
  cleanType,
  type DeliveredObject,
  fileResponse,
  nowSeconds,
  objectKey,
  sha256Hex,
  uploadKey,
} from "~/r2/objects";
import { assetVectorInvalidateStatement } from "~/search/asset-vectors";
import { docKey } from "~/search/project";
import { type ProjectionSelect, projectionStatement } from "~/search/write";

/**
 * Assets: files someone chose to keep, around ADR-0011's immutable objects.
 * ADR-0015.
 *
 * An upload is two steps for the client. `beginAssetUpload` writes a pending
 * row and hands back a one-object upload credential. The bytes arrive over
 * HTTP at `PUT /uploads/{id}`, outside any model's context, and land at a
 * staging key, and the same request runs `finalizeAssetUpload`: it verifies
 * them, copies them to a fresh object key nothing writes again, and commits
 * the object row, the ready state and the projection in one batch. R2 and D1
 * cannot commit together: a finalize that loses a race or a batch deletes the
 * object it wrote, and the pending row stays retryable by sending the PUT
 * again.
 */

export type AssetEnv = {
  DB: D1Database;
  BUNDLES: R2Bucket;
  TOKEN_PEPPER?: string;
};

/**
 * 25 MiB. An upload buffers the file twice in a 128 MB isolate, once as
 * received and once as finalize reads it back from staging;
 * a scanned PDF outgrows ADR-0011's 10 MiB attachment cap long before that.
 */
export const MAX_ASSET_BYTES = 25 * 1024 * 1024;
/** How long an upload credential, and so a pending asset, lives. */
export const UPLOAD_TTL_SECONDS = 60 * 60;
/** A download capability's life, and so the delay before a revocation bites. */
export const DOWNLOAD_TTL_SECONDS = 15 * 60;
/** The longest temporary handoff; anything longer should be durable. */
export const MAX_EXPIRY_SECONDS = 366 * 24 * 60 * 60;

export const ASSET_COVERAGE =
  "Search matches asset metadata and, after processing, up to 1 MiB of extracted text or a generated image description. Long files match by passage: such a hit's metadata.passage gives its page, slide or chapter and a citation to quote. Unprocessed file contents are not indexed; unsupported content is metadata-only and linked pages are never fetched.";

export type AssetState = "pending" | "ready" | "failed";

export type Asset = {
  assetId: string;
  userId: string;
  state: AssetState;
  objectId: string | null;
  title: string;
  description: string;
  fileName: string;
  contentType: string;
  declaredSize: number;
  declaredSha256: string | null;
  /** The object's verified values once ready; null while pending. */
  size: number | null;
  sha256: string | null;
  project: string | null;
  tags: string[];
  sourceAgent: string;
  sourceClient: string;
  sourceSession: string | null;
  uploadExpiresAt: number | null;
  expiresAt: number | null;
  archivedAt: number | null;
  failure: string | null;
  createdAt: number;
  updatedAt: number;
  finalizedAt: number | null;
};

export class AssetRefused extends Error {}

export const FOLDER_FULL =
  "That folder already holds 100 files. Nothing was uploaded.";

type AssetRow = Omit<Asset, "tags"> & { tagsJson: string };

const SELECT_ASSET = `
SELECT a.asset_id AS assetId, a.user_id AS userId, a.state, a.object_id AS objectId,
       a.title, a.description, a.file_name AS fileName, a.content_type AS contentType,
       a.declared_size AS declaredSize, a.declared_sha256 AS declaredSha256,
       o.size, o.sha256, a.project, a.tags_json AS tagsJson,
       a.source_agent AS sourceAgent, a.source_client AS sourceClient,
       a.source_session AS sourceSession, a.upload_expires_at AS uploadExpiresAt,
       a.expires_at AS expiresAt, a.archived_at AS archivedAt, a.failure,
       a.created_at AS createdAt, a.updated_at AS updatedAt,
       a.finalized_at AS finalizedAt
  FROM assets a
  LEFT JOIN objects o ON o.object_id = a.object_id`;

/** `asset:ast_…` → `ast_…`, or null for anything else. */
export function assetIdOf(id: string): string | null {
  const match = /^(?:asset:)?(ast_[0-9a-f-]{36})$/.exec(id.trim());
  return match ? match[1] : null;
}

export function assetRef(assetId: string): string {
  return docKey("asset", assetId);
}

/** The owner's asset in any state, or null. Another user's id is missing. */
export async function readAssetRow(
  db: D1Database,
  userId: string,
  assetId: string,
): Promise<Asset | null> {
  const row = await db
    .prepare(`${SELECT_ASSET} WHERE a.asset_id = ? AND a.user_id = ?`)
    .bind(assetId, userId)
    .first<AssetRow>();
  return row === null ? null : fromRow(row);
}

/**
 * The owner's deliverable assets, newest first, archived or not as asked.
 * Pending, failed and expired ones are not files anyone can use, so the
 * console never lists them.
 */
export async function readAssets(
  db: D1Database,
  userId: string,
  ids: string[],
): Promise<Asset[]> {
  if (!ids.length) return [];
  const { results } = await db
    .prepare(`${SELECT_ASSET} WHERE a.user_id = ? AND a.asset_id IN (SELECT value FROM json_each(?))
    AND a.state = 'ready' AND (a.expires_at IS NULL OR a.expires_at > unixepoch()) ORDER BY a.created_at, a.asset_id`)
    .bind(userId, JSON.stringify(ids))
    .all<AssetRow>();
  return results.map(fromRow);
}

export async function listAssets(
  db: D1Database,
  userId: string,
  archived: boolean,
): Promise<Asset[]> {
  const { results } = await db
    .prepare(
      `${SELECT_ASSET}
        WHERE a.user_id = ? AND a.state = 'ready'
          AND (a.expires_at IS NULL OR a.expires_at > ?)
          AND (a.archived_at IS NOT NULL) = ?
        ORDER BY a.created_at DESC, a.asset_id DESC`,
    )
    .bind(userId, nowSeconds(), archived ? 1 : 0)
    .all<AssetRow>();
  return results.map(fromRow);
}

/** Console window, filtered before LIMIT; exports keep listAssets's full contract. */
export async function listAssetsPage(
  db: D1Database,
  userId: string,
  archived: boolean,
  options: LibraryPageOptions = {},
) {
  const where = libraryPageWhere("a", "asset_id", options);
  const { results } = await db
    .prepare(`${SELECT_ASSET}
    WHERE a.user_id = ? AND a.state = 'ready'
      AND (a.expires_at IS NULL OR a.expires_at > ?)
      AND (a.archived_at IS NOT NULL) = ? ${where.sql}
      ${options.durableOnly ? "AND NOT (a.source_agent = 'raindrop-import' AND EXISTS (SELECT 1 FROM json_each(a.tags_json) WHERE value = 'import-snapshot'))" : ""}
    ORDER BY a.created_at DESC, a.asset_id DESC LIMIT ?`)
    .bind(
      userId,
      nowSeconds(),
      archived ? 1 : 0,
      ...where.values,
      LIBRARY_PAGE_SIZE + 1,
    )
    .all<AssetRow>();
  return libraryPage(results.map(fromRow), (row) => ({
    createdAt: row.createdAt,
    id: row.assetId,
  }));
}

/**
 * Archive or restore: out of search and lists, or back. The bytes, the id
 * and every reference stay as they were.
 */
export async function setAssetArchived(
  db: D1Database,
  userId: string,
  assetId: string,
  archived: boolean,
): Promise<boolean> {
  const asset = await readAsset(db, userId, assetId);
  if (asset === null) return false;
  const now = nowSeconds();
  await db.batch([
    db
      .prepare(
        `UPDATE assets SET archived_at = ?, updated_at = ?
          WHERE asset_id = ? AND user_id = ?`,
      )
      .bind(archived ? now : null, now, assetId, userId),
    ...(archived
      ? assetUnpublishStatements(db, assetId, userId)
      : assetSearchStatements(db, assetId, userId)),
    assetVectorInvalidateStatement(db, userId, assetId),
  ]);
  return true;
}

/**
 * Whether a ready asset may be delivered now. An expired one is gone from
 * every path at once, before cleanup removes its bytes. Archived assets keep
 * resolving by id; archive only takes them out of search and lists.
 */
export function deliverable(asset: Asset, now = nowSeconds()): boolean {
  return (
    asset.state === "ready" &&
    (asset.expiresAt === null || asset.expiresAt > now)
  );
}

/** A ready, unexpired asset the user owns, or null. */
/** The current processing output behind `fetch` of an asset, if any. */
export async function readAssetExtraction(
  db: D1Database,
  userId: string,
  assetId: string,
) {
  return db
    .prepare(`SELECT o.processing_id, o.processor_version, o.extractor,
    o.original_sha256, o.text, o.truncated FROM asset_processing_heads h
    JOIN asset_processing_outputs o USING (processing_id)
    WHERE h.asset_id = ? AND h.user_id = ? AND o.user_id = ?`)
    .bind(assetId, userId, userId)
    .first<{
      processing_id: string;
      processor_version: string;
      extractor: string;
      original_sha256: string;
      text: string;
      truncated: number;
    }>();
}

export async function readAsset(
  db: D1Database,
  userId: string,
  assetId: string,
): Promise<Asset | null> {
  const asset = await readAssetRow(db, userId, assetId);
  return asset && deliverable(asset) ? asset : null;
}

/**
 * The subset of `assetIds` search may show this user: owned, ready, not
 * archived, not expired. The projection carries no owner or expiry, so a hit
 * is checked against its row before it is returned.
 */
export async function visibleAssetIds(
  db: D1Database,
  userId: string,
  assetIds: string[],
): Promise<Set<string>> {
  if (assetIds.length === 0) return new Set();
  const { results } = await db
    .prepare(
      `SELECT asset_id FROM assets
        WHERE user_id = ? AND state = 'ready' AND archived_at IS NULL
          AND (expires_at IS NULL OR expires_at > ?)
          AND asset_id IN (SELECT value FROM json_each(?))`,
    )
    .bind(userId, nowSeconds(), JSON.stringify(assetIds))
    .all<{ asset_id: string }>();
  return new Set(results.map((row) => row.asset_id));
}

export type BeginAssetUpload = {
  fileName: string;
  contentType?: string;
  size: number;
  sha256?: string;
  title?: string;
  description?: string;
  project?: string | null;
  tags?: readonly string[];
  expiresInSeconds?: number;
  /** A folder `joinableFolder` returned; the new file becomes its member. */
  folderId?: string;
};

export type BegunUpload = {
  asset: Asset;
  /** The raw credential, returned once and stored only as its digest. */
  token: string;
};

export async function beginAssetUpload(
  env: AssetEnv,
  input: BeginAssetUpload,
  provenance: Provenance,
): Promise<BegunUpload> {
  const pepper = requirePepper(env);
  if (!Number.isInteger(input.size) || input.size <= 0) {
    throw new AssetRefused("size must be the file's byte count, above zero.");
  }
  if (input.size > MAX_ASSET_BYTES) {
    throw new AssetRefused(
      `That file is ${input.size} bytes; the limit is ${MAX_ASSET_BYTES}.`,
    );
  }
  const expiresAt = expiryFrom(input.expiresInSeconds);
  const assetId = `ast_${crypto.randomUUID()}`;
  const token = `vlu_${randomBase64Url(32)}`;
  const now = nowSeconds();
  const fileName = cleanName(input.fileName);
  const insert = env.DB.prepare(
    `INSERT INTO assets (
       asset_id, user_id, state, title, description, file_name, content_type,
       declared_size, declared_sha256, project, tags_json,
       source_agent, source_client, source_session,
       upload_token_digest, upload_expires_at, expires_at,
       created_at, updated_at
     ) VALUES (?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(
    assetId,
    provenance.userId,
    input.title?.trim() || fileName,
    input.description?.trim() ?? "",
    fileName,
    cleanType(input.contentType ?? ""),
    input.size,
    input.sha256?.toLowerCase() ?? null,
    input.project ?? null,
    JSON.stringify(input.tags ?? []),
    provenance.agent,
    provenance.client,
    provenance.session,
    await digest(pepper, `asset-upload:${assetId}:${token}`),
    now + UPLOAD_TTL_SECONDS,
    expiresAt,
    now,
    now,
  );
  try {
    // The insert trigger files the asset in its own folder; the move in the
    // same batch re-files it, and the folder triggers abort both at 100 files.
    await env.DB.batch(
      input.folderId === undefined
        ? [insert]
        : [
            insert,
            env.DB.prepare(
              "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = ? AND user_id = ?",
            ).bind(input.folderId, assetId, provenance.userId),
          ],
    );
  } catch (error) {
    if (String(error).includes("folder file limit"))
      throw new AssetRefused(FOLDER_FULL);
    throw error;
  }
  const asset = await readAssetRow(env.DB, provenance.userId, assetId);
  if (asset === null) throw new Error("the pending asset did not persist");
  return { asset, token };
}

/**
 * `PUT /uploads/{id}`. The credential names one pending asset, so it
 * can write that asset's staging key and nothing else, and only until the
 * asset is finalized or its upload expires. The declared size is checked
 * against `Content-Length` before the body is read, and the declared
 * checksum, when one was given, before anything is stored. A stored body is
 * finalized in the same request, so a 200 means the asset is ready.
 */
export async function receiveAssetUpload(
  env: AssetEnv,
  assetId: string,
  request: Request,
): Promise<Response> {
  if (request.method !== "PUT") {
    return new Response(null, { status: 405, headers: { allow: "PUT" } });
  }
  const pepper = env.TOKEN_PEPPER;
  const token = credential(request);
  if (!pepper || token === null) return httpError(401, "invalid_token");
  const row = await env.DB.prepare(
    `SELECT user_id AS userId, state, declared_size AS declaredSize,
            declared_sha256 AS declaredSha256, upload_token_digest AS tokenDigest,
            upload_expires_at AS uploadExpiresAt
       FROM assets WHERE asset_id = ?`,
  )
    .bind(assetId)
    .first<{
      userId: string;
      state: AssetState;
      declaredSize: number;
      declaredSha256: string | null;
      tokenDigest: string | null;
      uploadExpiresAt: number | null;
    }>();
  const presented = await digest(pepper, `asset-upload:${assetId}:${token}`);
  if (row === null || !sameDigest(row.tokenDigest, presented)) {
    return httpError(
      401,
      "invalid_token",
      "A successful PUT spends the credential, so a repeat of one is refused here; fetch the asset id to see whether it is ready.",
    );
  }
  if (row.state !== "pending") {
    return httpError(
      409,
      "already_finalized",
      "This asset is finalized; its bytes cannot change. Begin a new upload for a new file.",
    );
  }
  if (row.uploadExpiresAt === null || row.uploadExpiresAt <= nowSeconds()) {
    return httpError(410, "upload_expired", "Begin a new upload.");
  }
  // A declared length is checked before any byte is read. A chunked body has
  // none, so the reader below stops at the declared size either way.
  const length = request.headers.get("content-length");
  if (length !== null && Number(length) > MAX_ASSET_BYTES) {
    return httpError(413, "too_large", `The limit is ${MAX_ASSET_BYTES}.`);
  }
  if (length !== null && Number(length) !== row.declaredSize) {
    return httpError(
      400,
      "size_mismatch",
      `upload_asset declared ${row.declaredSize} bytes; this request carries ${length}.`,
    );
  }
  const bytes = await readBounded(request, row.declaredSize);
  if (bytes === null) {
    return httpError(
      413,
      "too_large",
      `The body runs past the declared ${row.declaredSize} bytes.`,
    );
  }
  if (bytes.byteLength !== row.declaredSize) {
    // An interrupted transfer arrives short. Nothing is stored; send again.
    return httpError(
      400,
      "size_mismatch",
      `Received ${bytes.byteLength} of ${row.declaredSize} bytes. Send the file again.`,
    );
  }
  const sha256 = await sha256Hex(bytes);
  if (row.declaredSha256 !== null && row.declaredSha256 !== sha256) {
    return httpError(
      400,
      "checksum_mismatch",
      `Received bytes hash to ${sha256}, not the declared ${row.declaredSha256}.`,
    );
  }
  await env.BUNDLES.put(uploadKey(row.userId, assetId), bytes, {
    customMetadata: { sha256 },
  });
  let outcome: FinalizeOutcome;
  try {
    outcome = await finalizeAssetUpload(env, row.userId, assetId);
  } catch {
    outcome = { ok: false, reason: "the file could not be committed" };
  }
  if (!outcome.ok) {
    return httpError(
      503,
      "not_finalized",
      `${outcome.reason}. The asset is still pending; send the same PUT again.`,
    );
  }
  return Response.json(
    {
      id: assetRef(assetId),
      state: outcome.asset.state,
      size: bytes.byteLength,
      sha256,
    },
    { headers: { "cache-control": "no-store" } },
  );
}

export type FinalizeOutcome =
  | { ok: true; asset: Asset }
  | { ok: false; reason: string };

/**
 * Safe to call again at any point. A ready asset returns as it is. A
 * pending one is verified from its staged bytes, which are copied to a new
 * object key; the batch inserts that object and flips the asset only while
 * it is still pending, so a second finalize racing the first commits
 * nothing and deletes the copy it made.
 */
export async function finalizeAssetUpload(
  env: AssetEnv,
  userId: string,
  assetId: string,
): Promise<FinalizeOutcome> {
  const asset = await readAssetRow(env.DB, userId, assetId);
  if (asset === null) return { ok: false, reason: "not found" };
  if (asset.state === "ready") {
    return deliverable(asset)
      ? { ok: true, asset }
      : { ok: false, reason: "expired" };
  }
  if (asset.state === "failed") {
    return {
      ok: false,
      reason: `upload failed (${asset.failure ?? "abandoned"}); begin a new upload`,
    };
  }
  const staged = await env.BUNDLES.get(uploadKey(userId, assetId));
  if (staged === null) {
    return {
      ok: false,
      reason:
        "no bytes have been uploaded yet; PUT the file to the upload URL from upload_asset",
    };
  }
  const bytes = await staged.arrayBuffer();
  if (bytes.byteLength !== asset.declaredSize) {
    return {
      ok: false,
      reason: `the staged file is ${bytes.byteLength} bytes, not the declared ${asset.declaredSize}; upload it again`,
    };
  }
  const sha256 = await sha256Hex(bytes);
  if (asset.declaredSha256 !== null && asset.declaredSha256 !== sha256) {
    return {
      ok: false,
      reason: `the staged file hashes to ${sha256}, not the declared ${asset.declaredSha256}; upload it again`,
    };
  }

  const objectId = `obj_${crypto.randomUUID()}`;
  const r2Key = objectKey(userId, objectId);
  await env.BUNDLES.put(r2Key, bytes, {
    httpMetadata: { contentType: asset.contentType },
    customMetadata: { sha256 },
  });
  const now = nowSeconds();
  let committed: boolean;
  try {
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO objects (
           object_id, user_id, r2_key, name, content_type, size, sha256, created_at
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM assets
                         WHERE asset_id = ? AND user_id = ? AND state = 'pending')`,
      ).bind(
        objectId,
        userId,
        r2Key,
        asset.fileName,
        asset.contentType,
        bytes.byteLength,
        sha256,
        now,
        assetId,
        userId,
      ),
      env.DB.prepare(
        `UPDATE assets
            SET state = 'ready', object_id = ?, finalized_at = ?, updated_at = ?,
                upload_token_digest = NULL
          WHERE asset_id = ? AND user_id = ? AND state = 'pending'`,
      ).bind(objectId, now, now, assetId, userId),
      projectionStatement(
        env.DB,
        assetProjection(assetId, userId),
        assetRef(assetId),
      ),
    ]);
    committed = (results[1]?.meta.changes ?? 0) > 0;
  } catch (error) {
    await env.BUNDLES.delete(r2Key);
    throw error;
  }
  if (committed) {
    await env.BUNDLES.delete(uploadKey(userId, assetId));
  } else {
    await env.BUNDLES.delete(r2Key);
  }
  const current = await readAssetRow(env.DB, userId, assetId);
  if (current?.state === "ready") {
    // Admission is independent of publication: AI failure cannot turn a saved
    // original into a failed upload. The minute scheduler recovers queued work.
    // A file over the automatic size waits for an explicit Process after its
    // cost estimate has been shown.
    try {
      if ((current.size ?? current.declaredSize) <= AUTO_PROCESSING_BYTES)
        await queueAssetProcessing(env, userId, assetId);
    } catch {
      /* The library offers a bounded retry. */
    }
    return { ok: true, asset: current };
  }
  return { ok: false, reason: "the upload changed state while finalizing" };
}

export type AssetPatch = {
  title?: string;
  description?: string;
  project?: string | null;
  tags?: readonly string[];
  /** Seconds from now; null makes the asset durable again. */
  expiresInSeconds?: number | null;
};

/**
 * Descriptive metadata and retention, never bytes. An expiry is refused while
 * anything refers to the file: a to-do or memory attachment, or a source.
 */
export async function updateAsset(
  env: AssetEnv,
  userId: string,
  assetId: string,
  patch: AssetPatch,
): Promise<Asset | null> {
  const asset = await readAsset(env.DB, userId, assetId);
  if (asset === null) return null;
  let expiresAt = asset.expiresAt;
  if (patch.expiresInSeconds === null) expiresAt = null;
  else if (patch.expiresInSeconds !== undefined) {
    const references = await assetReferences(env.DB, asset);
    if (references.length > 0) {
      throw new AssetRefused(
        `${assetRef(assetId)} cannot expire while ${references.join(", ")} refer to it. Remove those references first.`,
      );
    }
    expiresAt = expiryFrom(patch.expiresInSeconds);
  }
  const now = nowSeconds();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE assets
          SET title = ?, description = ?, project = ?, tags_json = ?,
              expires_at = ?, updated_at = ?
        WHERE asset_id = ? AND user_id = ? AND state = 'ready'`,
    ).bind(
      patch.title?.trim() || asset.title,
      patch.description !== undefined
        ? patch.description.trim()
        : asset.description,
      patch.project !== undefined ? patch.project : asset.project,
      JSON.stringify(patch.tags ?? asset.tags),
      expiresAt,
      now,
      assetId,
      userId,
    ),
    ...assetSearchStatements(env.DB, assetId, userId),
    ...(patch.expiresInSeconds !== undefined
      ? [assetVectorInvalidateStatement(env.DB, userId, assetId)]
      : []),
  ]);
  return readAssetRow(env.DB, userId, assetId);
}

/**
 * What would break if this asset's file went away, as ids a person can
 * follow. ADR-0015: these protect it from expiry and deletion until they are
 * removed explicitly.
 */
export async function assetReferences(
  db: D1Database,
  asset: Pick<Asset, "assetId" | "objectId">,
): Promise<string[]> {
  // Any revision counts, not only the head: a source's history must stay
  // able to show the file it once linked.
  const { results } = await db
    .prepare(
      `SELECT DISTINCT 'source:' || source_id AS ref
         FROM source_revision_assets WHERE asset_id = ?
       UNION ALL
       SELECT 'todo:' || todo_id FROM todo_attachments WHERE object_id = ?
       UNION ALL
       SELECT 'memory:' || memory_id FROM memory_attachments WHERE object_id = ?`,
    )
    .bind(asset.assetId, asset.objectId ?? "", asset.objectId ?? "")
    .all<{ ref: string }>();
  return results.map((row) => row.ref);
}

export type AssetDownload = { url: string; expiresAt: number };

/**
 * A short-lived capability URL for a ready, unexpired asset. Every issuance
 * reads the asset's current state; the URL carries an expiry and an HMAC over
 * the asset id and that expiry, so the bytes can be fetched by any HTTP
 * client without the MCP credential. Saved references use the asset id,
 * never this URL.
 */
export async function issueAssetDownload(
  env: AssetEnv,
  asset: Asset,
  origin: string,
): Promise<AssetDownload> {
  const pepper = requirePepper(env);
  const expiresAt = nowSeconds() + DOWNLOAD_TTL_SECONDS;
  const signature = await digest(
    pepper,
    `asset-download:${asset.assetId}:${expiresAt}`,
  );
  const url = new URL(`/downloads/${asset.assetId}`, origin);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set("signature", signature);
  return { url: url.href, expiresAt };
}

/**
 * `GET /downloads/{id}`. Checks the signature, then the asset's state
 * as it is now, so an expiry set after the URL was issued still applies.
 */
export async function serveAssetDownload(
  env: AssetEnv,
  assetId: string,
  url: URL,
): Promise<Response> {
  const pepper = env.TOKEN_PEPPER;
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  const now = nowSeconds();
  if (
    !pepper ||
    !Number.isInteger(expires) ||
    expires <= now ||
    expires > now + DOWNLOAD_TTL_SECONDS ||
    !sameDigest(
      signature,
      await digest(pepper, `asset-download:${assetId}:${expires}`),
    )
  ) {
    return httpError(
      403,
      "invalid_signature",
      "Ask get_asset_download for a new URL.",
    );
  }
  const row = await env.DB.prepare(
    `SELECT a.user_id AS userId FROM assets a WHERE a.asset_id = ?`,
  )
    .bind(assetId)
    .first<{ userId: string }>();
  const asset = row ? await readAsset(env.DB, row.userId, assetId) : null;
  if (asset === null || asset.objectId === null) {
    return httpError(404, "not_found");
  }
  const delivered = await readAssetObject(env, asset);
  if (delivered === null) return httpError(404, "not_found");
  return fileResponse(delivered.metadata, delivered.object);
}

/** How long an archive viewer URL lives. */
export const ARCHIVE_TTL_SECONDS = 60 * 60;

/** What a saved page may load from its own folder. Anything else is 404. */
const ARCHIVE_TYPES = new Set([
  "text/html",
  "text/css",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
  "image/svg+xml",
  "image/x-icon",
  "font/woff2",
  "font/woff",
  "font/ttf",
  "font/otf",
]);

const ARCHIVE_PATH =
  /^\/archives\/(ast_[0-9a-f-]{36})\/(\d{1,12})\/([\w-]{43})\/([^/]+)$/;

/**
 * The viewer URL for one file of an archived page's folder. The capability
 * is the path prefix, not a query, so the page's relative URLs resolve to its
 * siblings under the same signature.
 */
export async function issueArchiveView(
  env: AssetEnv,
  folderId: string,
  fileName: string,
  origin: string,
): Promise<string> {
  const pepper = requirePepper(env);
  const expires = nowSeconds() + ARCHIVE_TTL_SECONDS;
  const signature = await digest(
    pepper,
    `asset-archive:${folderId}:${expires}`,
  );
  return new URL(
    `/archives/${folderId}/${expires}/${signature}/${encodeURIComponent(fileName)}`,
    origin,
  ).href;
}

/**
 * `GET /archives/{folder}/{expires}/{signature}/{name}`. The sandbox CSP
 * gives the page an opaque origin and no scripts, so it cannot read the
 * console's cookies or call its API; it may load only from this prefix.
 */
export async function serveArchiveFile(
  env: AssetEnv,
  url: URL,
): Promise<Response> {
  const match = ARCHIVE_PATH.exec(url.pathname);
  const pepper = env.TOKEN_PEPPER;
  const now = nowSeconds();
  const expires = Number(match?.[2]);
  if (
    match === null ||
    !pepper ||
    expires <= now ||
    expires > now + ARCHIVE_TTL_SECONDS ||
    !sameDigest(
      match[3],
      await digest(pepper, `asset-archive:${match[1]}:${expires}`),
    )
  ) {
    return httpError(
      403,
      "invalid_signature",
      "Open the page from Library again.",
    );
  }
  const [, folderId, , signature, encoded] = match;
  let name: string;
  try {
    name = decodeURIComponent(encoded);
  } catch {
    return httpError(404, "not_found");
  }
  const member = await env.DB.prepare(
    `SELECT a.asset_id AS assetId, a.user_id AS userId
       FROM asset_folder_files m
       JOIN asset_folders f ON f.folder_id = m.folder_id
       JOIN assets a ON a.asset_id = m.asset_id
      WHERE m.folder_id = ? AND m.user_id = f.user_id AND a.user_id = f.user_id
        AND a.file_name = ? AND a.state = 'ready'
        AND (a.expires_at IS NULL OR a.expires_at > ?)
      ORDER BY a.created_at DESC, a.asset_id DESC LIMIT 1`,
  )
    .bind(folderId, name, now)
    .first<{ assetId: string; userId: string }>();
  const asset = member
    ? await readAsset(env.DB, member.userId, member.assetId)
    : null;
  const stored = asset ? await readAssetObject(env, asset) : null;
  const type = stored?.metadata.contentType ?? "";
  if (stored === null || !ARCHIVE_TYPES.has(type))
    return httpError(404, "not_found");
  const prefix = `${url.origin}/archives/${folderId}/${expires}/${signature}/`;
  return new Response(stored.object.body, {
    headers: {
      "Content-Type":
        type === "text/html" || type === "text/css"
          ? `${type}; charset=utf-8`
          : type,
      "Content-Length": String(stored.object.size),
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
      // Not same-origin: Chrome blocks a no-cors load from the sandboxed
      // page's opaque origin under it (ERR_BLOCKED_BY_RESPONSE.NotSameOrigin).
      "Cross-Origin-Resource-Policy": "cross-origin",
      "Content-Security-Policy": `sandbox; default-src 'none'; img-src ${prefix} data:; style-src ${prefix} 'unsafe-inline'; font-src ${prefix} data:; base-uri 'none'; form-action 'none'`,
      // Font loads are CORS requests, and the sandboxed page's origin is opaque.
      ...(type.startsWith("font/")
        ? { "Access-Control-Allow-Origin": "*" }
        : {}),
    },
  });
}

/** The asset's stored bytes, with the object row a delivery path needs. */
export async function readAssetObject(
  env: AssetEnv,
  asset: Asset,
): Promise<{ metadata: DeliveredObject; object: R2ObjectBody } | null> {
  if (!deliverable(asset) || asset.objectId === null) return null;
  const row = await env.DB.prepare(
    `SELECT object_id AS objectId, user_id AS userId, r2_key AS r2Key, name,
            content_type AS contentType, size, sha256, created_at AS createdAt
       FROM objects WHERE object_id = ? AND user_id = ?`,
  )
    .bind(asset.objectId, asset.userId)
    .first<Omit<DeliveredObject, "expiresAt">>();
  if (row === null) return null;
  const object = await env.BUNDLES.get(row.r2Key);
  if (object === null) return null;
  return { metadata: { ...row, expiresAt: asset.expiresAt }, object };
}

/** Extracted text on the asset row, for outputs from before passages. */
const ASSET_BODY_CHARS = 65536;

/**
 * Key concepts from the current output, minus any the person dismissed.
 * Derived from the content like extracted text, so they search without an
 * accept step; they never touch title, summary, tags or project.
 */
const CURRENT_CONCEPTS = `COALESCE((SELECT group_concat(c.value, '; ')
      FROM json_each(o.suggestions_json, '$.concepts') c
     WHERE c.type = 'text' AND NOT EXISTS (SELECT 1 FROM asset_suggestion_decisions d
       WHERE d.processing_id = o.processing_id AND d.user_id = o.user_id
         AND d.field = 'concept' AND d.value = c.value AND d.decision = 'dismissed')), '')`;

/** Reads the asset back inside the batch, so only a ready one publishes. */
export function assetProjection(
  assetId: string,
  userId: string,
): ProjectionSelect {
  return {
    selectSql: `SELECT 'asset:' || asset_id, user_id, 'asset', asset_id, project, title,
                       file_name || char(10) || description || char(10) ||
                         COALESCE((SELECT ${CURRENT_CONCEPTS} || char(10) ||
                             CASE WHEN o.passages_json IS NULL THEN substr(o.text, 1, ${ASSET_BODY_CHARS}) ELSE '' END
                           FROM asset_processing_heads h
                           JOIN asset_processing_outputs o USING (processing_id)
                            WHERE h.asset_id = assets.asset_id AND h.user_id = assets.user_id
                              AND o.user_id = assets.user_id), ''),
                       COALESCE((SELECT group_concat(value, ' ')
                                   FROM json_each(assets.tags_json)
                                  WHERE type = 'text'), ''),
                       updated_at
                  FROM assets
                 WHERE asset_id = ? AND user_id = ? AND state = 'ready' AND archived_at IS NULL`,
    bindings: [assetId, userId],
  };
}

/** `asset:<id>#<n>`: passage n of the asset's current output. */
export function passageKey(assetId: string, ordinal: number): string {
  return `${assetRef(assetId)}#${ordinal}`;
}

/** Splits a passage key, `asset:<id>#<n>` or `source:<id>#<n>`. */
export function parsePassageKey(
  key: string,
): { concept: "asset" | "source"; id: string; ordinal: number } | null {
  const match = key.match(/^(asset|source):([^:#\s]+)#(\d+)$/);
  return match
    ? {
        concept: match[1] as "asset" | "source",
        id: match[2],
        ordinal: Number(match[3]),
      }
    : null;
}

/**
 * Every search row of one asset: its own row, for metadata and concepts, plus
 * one per passage of the current output, for the text. Each word of the file
 * is indexed once. A passage row's title is its locator alone and its tags are
 * empty, so a query for the book's title or a tag finds the asset once, not
 * every page; the project rides along because it is a filter column outside
 * the FTS index, and the tag filter reads the asset (`query.ts`). Passages are
 * cut from the output text inside D1, so the batch never carries the text
 * twice. ADR-0001, ADR-0015.
 */
export function assetSearchStatements(
  db: D1Database,
  assetId: string,
  userId: string,
): D1PreparedStatement[] {
  return [
    projectionStatement(
      db,
      assetProjection(assetId, userId),
      assetRef(assetId),
    ),
    passageUnpublishStatement(db, assetId, userId),
    db
      .prepare(
        `INSERT INTO search_docs (doc_key, user_id, concept, concept_id, project, title, body, tags, updated_at)
         SELECT 'asset:' || a.asset_id || '#' || p.key, a.user_id, 'asset', a.asset_id, a.project,
                COALESCE(json_extract(p.value, '$.label'), ''),
                substr(o.text, json_extract(p.value, '$.start') + 1, json_extract(p.value, '$.length')),
                '', a.updated_at
           FROM assets a
           JOIN asset_processing_heads h ON h.asset_id = a.asset_id AND h.user_id = a.user_id
           JOIN asset_processing_outputs o ON o.processing_id = h.processing_id AND o.user_id = a.user_id
           JOIN json_each(o.passages_json, '$.passages') p
          WHERE a.asset_id = ? AND a.user_id = ? AND a.state = 'ready' AND a.archived_at IS NULL
            AND o.passages_json IS NOT NULL`,
      )
      .bind(assetId, userId),
  ];
}

/** Archive and delete leave the ranking with every passage, not only the asset row. */
export function assetUnpublishStatements(
  db: D1Database,
  assetId: string,
  userId: string,
): D1PreparedStatement[] {
  return [
    projectionStatement(db, null, assetRef(assetId)),
    passageUnpublishStatement(db, assetId, userId),
  ];
}

function passageUnpublishStatement(
  db: D1Database,
  assetId: string,
  userId: string,
) {
  return db
    .prepare(
      `DELETE FROM search_docs WHERE user_id = ? AND concept = 'asset' AND concept_id = ?
         AND doc_key != 'asset:' || concept_id`,
    )
    .bind(userId, assetId);
}

function fromRow(row: AssetRow): Asset {
  const { tagsJson, ...rest } = row;
  let tags: string[] = [];
  try {
    const parsed: unknown = JSON.parse(tagsJson);
    if (Array.isArray(parsed))
      tags = parsed.filter((tag): tag is string => typeof tag === "string");
  } catch {
    tags = [];
  }
  return { ...rest, tags };
}

function expiryFrom(seconds: number | undefined): number | null {
  if (seconds === undefined) return null;
  if (!Number.isInteger(seconds) || seconds < 60) {
    throw new AssetRefused("An expiry must be at least 60 seconds away.");
  }
  if (seconds > MAX_EXPIRY_SECONDS) {
    throw new AssetRefused(
      "An expiry over a year away is a durable asset; leave the expiry out.",
    );
  }
  return nowSeconds() + seconds;
}

/**
 * The body, read until it ends or passes `limit`. Null once it passes, so an
 * oversize stream is cut off rather than buffered whole.
 */
async function readBounded(
  request: Request,
  limit: number,
): Promise<ArrayBuffer | null> {
  if (request.body === null) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(received);
  let at = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, at);
    at += chunk.byteLength;
  }
  return bytes.buffer;
}

function credential(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const bearer = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const query = new URL(request.url).searchParams.get("token");
  const token = bearer ?? query;
  return token && /^vlu_[A-Za-z0-9_-]{43}$/.test(token) ? token : null;
}

function httpError(status: number, error: string, message?: string) {
  return Response.json(
    { error, ...(message ? { message } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function requirePepper(env: AssetEnv): string {
  if (!env.TOKEN_PEPPER) {
    throw new Error("TOKEN_PEPPER is required to issue asset credentials.");
  }
  return env.TOKEN_PEPPER;
}

async function digest(pepper: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(pepper),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  return base64Url(new Uint8Array(signature));
}

function sameDigest(stored: string | null, presented: string): boolean {
  if (stored === null) return false;
  const a = new TextEncoder().encode(stored);
  const b = new TextEncoder().encode(presented);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

function randomBase64Url(bytes: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

export type PassageCitation = {
  /** The asset's title with the locator, for a search hit's title. */
  title: string;
  locator: string | null;
  first: number | null;
  last: number | null;
  citation: string;
};

/** Locator and pasteable citation for passage hits, from the current output only. */
export async function passageCitations(
  db: D1Database,
  userId: string,
  keys: string[],
): Promise<Map<string, PassageCitation>> {
  const wanted = keys.flatMap((key) => {
    const parsed = parsePassageKey(key);
    return parsed
      ? [[key, parsed.id, parsed.ordinal, parsed.concept] as const]
      : [];
  });
  if (!wanted.length) return new Map();
  // Assets cite their document's own author metadata; sources their byline.
  const { results } = await db
    .prepare(
      `SELECT w.value ->> '$[0]' AS docKey, a.title,
              json_extract(o.passages_json, '$.author') AS author,
              json_extract(o.passages_json, '$.passages[' || (w.value ->> '$[2]') || ']') AS passage
         FROM json_each(?1) w
         JOIN assets a ON a.asset_id = w.value ->> '$[1]' AND a.user_id = ?2
         JOIN asset_processing_heads h ON h.asset_id = a.asset_id AND h.user_id = a.user_id
         JOIN asset_processing_outputs o ON o.processing_id = h.processing_id AND o.user_id = a.user_id
        WHERE w.value ->> '$[3]' = 'asset'
       UNION ALL
       SELECT w.value ->> '$[0]', s.title,
              NULLIF((SELECT group_concat(value, ', ') FROM json_each(s.authors_json) WHERE type = 'text'), ''),
              json_extract(e.passages_json, '$.passages[' || (w.value ->> '$[2]') || ']')
         FROM json_each(?1) w
         JOIN sources s ON s.source_id = w.value ->> '$[1]' AND s.user_id = ?2
         JOIN source_enrichments e ON e.enrichment_id = (SELECT enrichment_id FROM source_enrichments
           WHERE source_id = s.source_id AND user_id = s.user_id AND state = 'ready'
           ORDER BY created_at DESC, rowid DESC LIMIT 1)
        WHERE w.value ->> '$[3]' = 'source'`,
    )
    .bind(JSON.stringify(wanted), userId)
    .all<{
      docKey: string;
      title: string;
      author: string | null;
      passage: string | null;
    }>();
  const out = new Map<string, PassageCitation>();
  for (const row of results) {
    if (!row.passage) continue;
    const passage = JSON.parse(row.passage) as Passage;
    out.set(row.docKey, {
      title: [row.title, passage.label].filter(Boolean).join(" · "),
      locator: passage.label,
      first: passage.first,
      last: passage.last,
      citation: passageCitation(row.author, row.title, passage.label),
    });
  }
  return out;
}
