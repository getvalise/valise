/**
 * Per-user file storage on R2, for any concept that holds files. ADR-0011.
 *
 * The bytes go to `u/{userId}/objects/{objectId}`, beside the skill bundles
 * under `u/{userId}/skills/`, so everything one user stored is one prefix.
 * The `objects` row in D1 is the authority on who owns a file and how it is
 * served; the R2 key is never read from a request. A concept links to an
 * object from its own table and never writes the `objects` row itself.
 */

type ObjectEnv = { DB: D1Database; BUNDLES: R2Bucket };

/** 10 MiB. Screenshots and PDFs, buffered in a 128 MB isolate. ADR-0011. */
export const MAX_OBJECT_BYTES = 10 * 1024 * 1024;

/** Raster formats a browser renders without running anything. */
const INLINE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/avif",
]);

/**
 * Whether `/files/<id>` serves this type inline, so an `<img>` can show it.
 * Everything else arrives as a download, which an `<img>` cannot render.
 */
export function servedInline(contentType: string): boolean {
  return INLINE_TYPES.has(contentType);
}

export type StoredObject = {
  objectId: string;
  userId: string;
  r2Key: string;
  name: string;
  contentType: string;
  size: number;
  sha256: string;
  createdAt: number;
};

/**
 * A stored object as a delivery path sees it: the row plus the expiry of the
 * asset that publishes it, if one does. ADR-0015 makes every delivery path
 * enforce that expiry, and an expiring file loses the immutable cache policy.
 */
export type DeliveredObject = StoredObject & { expiresAt: number | null };

export class ObjectRefused extends Error {}

export function objectKey(userId: string, objectId: string): string {
  return `u/${keySegment(userId)}/objects/${objectId}`;
}

/**
 * Where an asset upload's bytes wait for finalize, beside the
 * user's objects. The upload credential can write only here; finalization
 * copies verified bytes to a fresh object key that nothing writes again.
 * ADR-0015.
 */
export function uploadKey(userId: string, assetId: string): string {
  return `u/${keySegment(userId)}/uploads/${assetId}`;
}

/** Every staged upload a user has, for the cleanup sweep. */
export function uploadPrefix(userId: string): string {
  return `u/${keySegment(userId)}/uploads/`;
}

function keySegment(userId: string): string {
  if (!userId || userId.includes("/") || userId === "..") {
    throw new Error(`user id cannot be a key segment: ${userId}`);
  }
  return userId;
}

/**
 * Writes the bytes to R2 and returns the row to insert, without inserting it,
 * so the caller can batch the `objects` row with its own link row. A failed
 * batch leaves an R2 object no row names; ADR-0011 accepts that.
 */
export async function putObject(
  bucket: R2Bucket,
  userId: string,
  file: File,
): Promise<StoredObject> {
  if (file.size === 0) throw new ObjectRefused("That file is empty.");
  if (file.size > MAX_OBJECT_BYTES) {
    throw new ObjectRefused(
      `That file is ${fileSize(file.size)}; the limit is ${fileSize(MAX_OBJECT_BYTES)}.`,
    );
  }
  const bytes = await file.arrayBuffer();
  const objectId = `obj_${crypto.randomUUID()}`;
  const stored: StoredObject = {
    objectId,
    userId,
    r2Key: objectKey(userId, objectId),
    name: cleanName(file.name),
    contentType: cleanType(file.type),
    size: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    createdAt: Math.floor(Date.now() / 1000),
  };
  await bucket.put(stored.r2Key, bytes, {
    httpMetadata: { contentType: stored.contentType },
    customMetadata: { sha256: stored.sha256 },
  });
  return stored;
}

export function insertObject(
  db: D1Database,
  stored: StoredObject,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO objects (
         object_id, user_id, r2_key, name, content_type, size, sha256, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      stored.objectId,
      stored.userId,
      stored.r2Key,
      stored.name,
      stored.contentType,
      stored.size,
      stored.sha256,
      stored.createdAt,
    );
}

/**
 * The file as an HTTP response, or null when this user owns no such object.
 * Another user's id answers exactly like a missing one.
 */
export async function serveObject(
  env: ObjectEnv,
  userId: string,
  objectId: string,
): Promise<Response | null> {
  const stored = await readObject(env, userId, objectId);
  if (stored === null) return null;
  return fileResponse(stored.metadata, stored.object);
}

/**
 * The response every file delivery path sends: inline only for raster images,
 * never sniffed, sandboxed. An object never changes, so a durable one caches
 * for a year; one an asset will expire is never cached, because a cached copy
 * would outlive the expiry. Only its owner's session or a signed capability
 * reaches this.
 */
export function fileResponse(
  row: DeliveredObject,
  object: R2ObjectBody,
): Response {
  const inline = servedInline(row.contentType);
  return new Response(object.body, {
    headers: {
      "Content-Type": inline ? row.contentType : "application/octet-stream",
      "Content-Length": String(object.size),
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(row.name)}`,
      "Cache-Control":
        row.expiresAt === null
          ? "private, max-age=31536000, immutable"
          : "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
}

/**
 * The ownership lookup is shared by console responses and MCP resources. An
 * object whose asset has expired answers missing here, before cleanup has
 * removed it, so no path that reads through this can deliver it. ADR-0015.
 */
export async function readObject(
  env: ObjectEnv,
  userId: string,
  objectId: string,
): Promise<{ metadata: DeliveredObject; object: R2ObjectBody } | null> {
  const row = await env.DB.prepare(
    `SELECT o.object_id AS objectId, o.user_id AS userId, o.r2_key AS r2Key,
            o.name, o.content_type AS contentType, o.size, o.sha256,
            o.created_at AS createdAt, a.expires_at AS expiresAt
       FROM objects o
       LEFT JOIN assets a ON a.object_id = o.object_id
      WHERE o.object_id = ? AND o.user_id = ?`,
  )
    .bind(objectId, userId)
    .first<DeliveredObject>();
  if (row === null) return null;
  if (row.expiresAt !== null && row.expiresAt <= nowSeconds()) return null;
  const object = await env.BUNDLES.get(row.r2Key);
  if (object === null) return null;
  return { metadata: row, object };
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function cleanName(name: string): string {
  const base = name.replaceAll("\\", "/").split("/").pop() ?? "";
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return cleaned.slice(0, 200) || "file";
}

export function cleanType(type: string): string {
  return /^[\w.+-]+\/[\w.+-]+$/.test(type)
    ? type.toLowerCase()
    : "application/octet-stream";
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
