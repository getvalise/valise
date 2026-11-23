import type { AssetEnv } from "~/concepts/assets";
import {
  type Allowance,
  ATTACHMENT_LIMITS,
  MAX_SOURCE_IMAGES,
} from "~/concepts/attachment-limits";
import { uploadAssetFile } from "~/concepts/library";
import type { Provenance } from "~/concepts/memories";
import {
  type Fetcher,
  fetchableUrl,
  fetchFollowing,
  readBytesCapped,
  robotsAllow,
} from "~/concepts/source-fetch";
import { fileSize, sha256Hex } from "~/r2/objects";

/**
 * A bookmark's images, fetched by Valise from URLs its client saw on the
 * page, such as an X post's photos. Each is fetched once per save as
 * ValiseBot, robots.txt asked first, and kept as an ordinary asset linked
 * to the bookmark. An image the owner already holds, byte for byte, is
 * linked rather than stored again, so a rerun capture adds nothing.
 * ADR-0015, amendment of 2026-10-30 (images).
 */

const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

export type ImageCapture =
  | { url: string; assetId: string; created: boolean }
  | { url: string; refused: string };

/**
 * Fetches and keeps each image within the bookmark's remaining bytes and the
 * account's per-image limit. Refusals are per image; the save goes ahead.
 */
export async function captureImages(
  env: AssetEnv,
  provenance: Provenance,
  urls: readonly string[],
  allowance: Allowance,
  linked: { assetId: string; size: number | null }[],
  fetcher: Fetcher = fetch,
): Promise<ImageCapture[]> {
  const heldBytes = linked.reduce((sum, asset) => sum + (asset.size ?? 0), 0);
  const linkedIds = new Set(linked.map((asset) => asset.assetId));
  const limits = ATTACHMENT_LIMITS[allowance];
  let left = limits.perBookmark - heldBytes;
  const captured: ImageCapture[] = [];
  for (const url of [...new Set(urls)].slice(0, MAX_SOURCE_IMAGES)) {
    const cap = Math.min(limits.perFile.image, left);
    const outcome = await captureOne(
      env,
      provenance,
      url,
      cap,
      linkedIds,
      fetcher,
    );
    if ("size" in outcome) left -= outcome.size;
    captured.push(
      "assetId" in outcome
        ? { url, assetId: outcome.assetId, created: outcome.created }
        : {
            url,
            refused:
              outcome.refused === "too_large"
                ? `larger than the ${fileSize(cap)} this bookmark has left for images`
                : outcome.refused,
          },
    );
  }
  return captured;
}

async function captureOne(
  env: AssetEnv,
  provenance: Provenance,
  raw: string,
  cap: number,
  linked: ReadonlySet<string>,
  fetcher: Fetcher,
): Promise<
  { assetId: string; size: number; created: boolean } | { refused: string }
> {
  const url = fetchableUrl(raw);
  if (!url) return { refused: "not a public http(s) URL" };
  if (cap <= 0) return { refused: "too_large" };
  if (!(await robotsAllow(url, fetcher)))
    return { refused: "the site's robots.txt asks not to be fetched" };
  const response = await fetchFollowing(
    url,
    Object.keys(IMAGE_TYPES).join(", "),
    fetcher,
  );
  if (!response?.ok) return { refused: "the image could not be fetched" };
  const type = (response.headers.get("content-type") ?? "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  const extension = IMAGE_TYPES[type];
  if (!extension) {
    await response.body?.cancel();
    return {
      refused: `not a PNG, JPEG, GIF or WebP image (${type || "no type"})`,
    };
  }
  if (Number(response.headers.get("content-length")) > cap) {
    await response.body?.cancel();
    return { refused: "too_large" };
  }
  const { bytes, over } = await readBytesCapped(response, cap);
  if (over) return { refused: "too_large" };
  if (!bytes.byteLength) return { refused: "the image was empty" };
  const held = await heldAsset(
    env.DB,
    provenance.userId,
    await sha256Hex(bytes.buffer as ArrayBuffer),
  );
  // Already this bookmark's: nothing new. Held elsewhere: linked, and counted.
  if (held && linked.has(held))
    return { assetId: held, size: 0, created: false };
  if (held) return { assetId: held, size: bytes.byteLength, created: false };
  const name = `${url.pathname.split("/").filter(Boolean).at(-1) ?? "image"}`
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .slice(0, 120);
  const asset = await uploadAssetFile(
    env,
    new File([bytes], `${name || "image"}.${extension}`, { type }),
    { title: `Image from ${url.hostname}` },
    provenance,
  );
  return { assetId: asset.assetId, size: bytes.byteLength, created: true };
}

/** A ready, durable asset of the owner's with exactly these bytes. */
async function heldAsset(
  db: D1Database,
  userId: string,
  sha256: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT a.asset_id AS assetId FROM assets a
         JOIN objects o ON o.object_id = a.object_id AND o.user_id = a.user_id
        WHERE a.user_id = ? AND o.sha256 = ? AND a.state = 'ready'
          AND a.expires_at IS NULL AND a.archived_at IS NULL
        ORDER BY a.created_at LIMIT 1`,
    )
    .bind(userId, sha256)
    .first<{ assetId: string }>();
  return row?.assetId ?? null;
}
