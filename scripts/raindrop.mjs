#!/usr/bin/env node
/**
 * Read-only Raindrop snapshot -> Valise's existing portable library format.
 * node --env-file=.env scripts/raindrop.mjs export <directory>
 * node scripts/raindrop.mjs prepare <snapshot.json> <directory>
 * node scripts/library.mjs import <origin> <directory>
 *
 * Private exports belong outside the repository. Nothing fetches bookmark
 * pages or permanent web caches; only Raindrop-uploaded originals are copied.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

const API = "https://api.raindrop.io/rest/v1";
const MAX_BYTES = 25 * 1024 * 1024;
const digest = (value) => createHash("sha256").update(value).digest("hex");

/** Stable, account-scoped ids; no URL-based merging of distinct bookmarks. */
export function stableId(kind, account, key) {
  const hex = digest(JSON.stringify(["raindrop", account, kind, key]));
  return `${kind}:${kind === "source" ? "src" : "ast"}_${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

export function raindropApi(token, fetcher = fetch, sleep = delay) {
  if (!token?.trim()) throw new Error("Set RAINDROP_TEST_TOKEN in .env.");
  return async (path) => {
    for (let attempt = 0; attempt < 5; attempt++) {
      const response = await fetcher(`${API}${path}`, {
        headers: { authorization: `Bearer ${token.trim()}` },
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
      if (response.status === 429 || response.status >= 500) {
        const seconds = Number(response.headers.get("retry-after"));
        await response.body?.cancel();
        if (attempt === 4)
          throw new Error(`Raindrop API HTTP ${response.status}.`);
        await sleep(
          Number.isFinite(seconds) && seconds > 0
            ? Math.min(seconds, 300) * 1000
            : 1000 * 2 ** attempt,
        );
        continue;
      }
      if (!response.ok)
        throw new Error(`Raindrop API HTTP ${response.status}.`);
      const data = await response.json();
      if (data.result !== true)
        throw new Error("Raindrop API refused the read.");
      await sleep(300);
      return data;
    }
  };
}

export async function snapshotRaindrop(api) {
  const { user } = await api("/user");
  if (!Number.isSafeInteger(user?._id))
    throw new Error("Missing Raindrop account id.");
  const root = await api("/collections");
  const children = await api("/collections/childrens");
  const collections = [
    ...new Map(
      [...root.items, ...children.items].map((c) => [c._id, c]),
    ).values(),
  ];
  const items = [];
  const ids = new Set();
  let count;
  for (let page = 0; page < 10000; page++) {
    const result = await api(
      `/raindrops/0?perpage=50&page=${page}&sort=created`,
    );
    if (!Array.isArray(result.items) || !Number.isSafeInteger(result.count)) {
      throw new Error("Raindrop returned an invalid bookmark page.");
    }
    count ??= result.count;
    if (count !== result.count)
      throw new Error("Bookmarks changed during export; retry.");
    for (const item of result.items) {
      if (!Number.isSafeInteger(item._id) || ids.has(item._id)) {
        throw new Error(
          "Duplicate or missing Raindrop id; retry the snapshot.",
        );
      }
      ids.add(item._id);
      items.push(item);
    }
    if (result.items.length < 50) break;
  }
  if (items.length !== count)
    throw new Error("Incomplete Raindrop snapshot; not preparing an import.");
  return {
    format: "raindrop-snapshot",
    version: 1,
    account_id: user._id,
    exported_at: Math.floor(Date.now() / 1000),
    excludes_trash: true,
    collections,
    items,
  };
}

function collectionPath(id, collections, seen = new Set()) {
  if (id === -1) return "Unsorted";
  const collection = collections.get(id);
  if (!collection) return `Collection ${id}`;
  if (seen.has(id)) throw new Error("Cyclic collection hierarchy.");
  seen.add(id);
  return collection.parent?.$id
    ? `${collectionPath(collection.parent.$id, collections, seen)} / ${collection.title}`
    : collection.title;
}

function timestamp(value) {
  const date = Date.parse(value);
  if (!Number.isFinite(date))
    throw new Error("Missing or invalid bookmark timestamp.");
  return Math.floor(date / 1000);
}

function sourceNotes(item, collection) {
  const highlights = (item.highlights ?? []).map((h) => {
    if (typeof h.text !== "string")
      throw new Error("Incomplete highlight text.");
    return [
      `Highlight ${h._id ?? ""}${h.created ? ` (${h.created})` : ""}:`,
      h.text,
      h.note ? `Highlight note: ${h.note}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  // Put supplied evidence first, before provenance, inside the 16 KiB search
  // projection. The raw snapshot retains every field without truncation.
  return [
    item.note ? `Notes\n${item.note}` : "",
    item.excerpt ? `Description\n${item.excerpt}` : "",
    highlights.length ? `Highlights\n${highlights.join("\n\n")}` : "",
    `Imported from Raindrop.io bookmark ${item._id}.`,
    `Collection: ${collection}`,
    `Original type: ${item.type ?? "link"}. Saved: ${item.created}. Updated: ${item.lastUpdate ?? item.created}.`,
    item.important ? "Favorite in Raindrop.io." : "",
    "Page and file contents are not indexed; only supplied metadata, notes and highlights are searchable.",
  ]
    .filter(Boolean)
    .join("\n\n");
}

export function prepareLibrary(snapshot, originals = new Map()) {
  if (
    snapshot.format !== "raindrop-snapshot" ||
    snapshot.version !== 1 ||
    !Number.isSafeInteger(snapshot.account_id) ||
    !Array.isArray(snapshot.items)
  ) {
    throw new Error("Not a raindrop-snapshot version 1 file.");
  }
  const bytes = Buffer.from(`${JSON.stringify(snapshot, null, 2)}\n`);
  const hash = digest(bytes);
  const snapshotId = stableId("asset", snapshot.account_id, `snapshot:${hash}`);
  const provenance = {
    agent: "raindrop-import",
    client: "raindrop.io",
    session: String(snapshot.account_id),
  };
  const files = new Map();
  const assets = [];
  function asset(
    id,
    name,
    title,
    contentType,
    content,
    created,
    tags,
    description,
  ) {
    if (content.length === 0 || content.length > MAX_BYTES)
      throw new Error("Asset exceeds Valise's 25 MiB limit or is empty.");
    const file = `files/${id.slice("asset:".length)}/${name}`;
    files.set(file, content);
    assets.push({
      id,
      title,
      description,
      file_name: name,
      content_type: contentType,
      size: content.length,
      sha256: digest(content),
      project: "raindrop",
      tags,
      expires_at: null,
      archived_at: null,
      created_at: created,
      updated_at: created,
      finalized_at: snapshot.exported_at,
      provenance,
      file,
    });
  }
  asset(
    snapshotId,
    "raindrop-snapshot.json",
    "Raindrop.io bookmark snapshot",
    "application/json",
    bytes,
    snapshot.exported_at,
    ["raindrop", "import-snapshot"],
    "Read-only API snapshot of all non-trash bookmarks, collections, supplied notes and highlights. No web page contents or API credentials.",
  );
  const collections = new Map(snapshot.collections.map((c) => [c._id, c]));
  const ids = new Set();
  const sources = snapshot.items.map((item) => {
    if (!Number.isSafeInteger(item._id) || ids.has(item._id) || item.removed) {
      throw new Error("Duplicate, invalid or trashed bookmark in snapshot.");
    }
    ids.add(item._id);
    const collection = collectionPath(
      item.collection?.$id ?? item.collectionId,
      collections,
    );
    const notes = sourceNotes(item, collection);
    if (notes.length > 64 * 1024)
      throw new Error(
        `Bookmark ${item._id} exceeds the source notes limit; split explicitly.`,
      );
    const url = new URL(item.link);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error(
        `Bookmark ${item._id} has a non-web URL; review it explicitly.`,
      );
    const linked = [snapshotId];
    const tags = [
      ...new Set([
        ...(item.tags ?? []),
        "raindrop",
        `collection:${collection}`,
      ]),
    ];
    const original = originals.get(item._id);
    if (original) {
      // Content-addressed asset ids never alias changed original bytes.
      const id = stableId(
        "asset",
        snapshot.account_id,
        `original:${item._id}:${digest(original.bytes)}`,
      );
      const name = (item.file.name || "original").replace(
        /[/\\\x00-\x1f]/g,
        "_",
      );
      asset(
        id,
        name,
        item.title || name,
        original.contentType,
        original.bytes,
        timestamp(item.created),
        tags,
        `Raindrop.io uploaded original for bookmark ${item._id}. File contents are not indexed.`,
      );
      linked.push(id);
    }
    const created = timestamp(item.created);
    return {
      id: stableId("source", snapshot.account_id, item._id),
      revision: 1,
      archived_at: null,
      created_at: created,
      updated_at: timestamp(item.lastUpdate ?? item.created),
      provenance,
      revisions: [
        {
          revision: 1,
          kind: original ? "document" : "bookmark",
          title: item.title?.trim() || item.link,
          url: item.link,
          notes,
          project: "raindrop",
          tags,
          assets: linked,
          provenance,
          created_at: created,
        },
      ],
    };
  });
  return {
    manifest: {
      format: "valise-library",
      version: 1,
      exported_at: snapshot.exported_at,
      assets,
      sources,
    },
    files,
  };
}

/** Credentials go to the API only, never to uploaded-file hosts or redirects. */
export async function downloadOriginal(item, fetcher = fetch, token) {
  let url = new URL(item.link);
  if (
    !Number.isSafeInteger(item.file?.size) ||
    item.file.size <= 0 ||
    item.file.size > MAX_BYTES
  ) {
    throw new Error(
      `Bookmark ${item._id}: uploaded file is empty or over 25 MiB.`,
    );
  }
  // Older bookmarks retain an obsolete v2 file URL. Resolve uploaded files
  // through the documented permanent-copy API, not that legacy link. Never
  // invoke this for ordinary web bookmarks or send the API token to S3.
  if (url.origin !== "https://up.raindrop.io") {
    if (!token?.trim() || !Number.isSafeInteger(item._id)) {
      throw new Error(
        "Uploaded original needs RAINDROP_TEST_TOKEN to resolve its download.",
      );
    }
    const resolved = await fetcher(`${API}/raindrop/${item._id}/cache`, {
      headers: { authorization: `Bearer ${token.trim()}` },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    });
    await resolved.body?.cancel();
    const location = resolved.headers.get("location");
    if (![302, 303, 307].includes(resolved.status) || !location) {
      throw new Error(
        `Original lookup HTTP ${resolved.status}; no download location.`,
      );
    }
    url = new URL(location);
  }
  const uploadHost = url.hostname === "up.raindrop.io";
  const s3Upload =
    /^s3\.[a-z0-9-]+\.amazonaws\.com$/.test(url.hostname) &&
    url.pathname.startsWith("/up.raindrop.io/raindrop/files/");
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (!uploadHost && !s3Upload)
  ) {
    throw new Error("Original download is not on a Raindrop upload host.");
  }
  const response = await fetcher(url, {
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok)
    throw new Error(`Original download HTTP ${response.status}.`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > item.file.size) {
      await reader.cancel();
      throw new Error("Original download exceeded its declared size.");
    }
    chunks.push(Buffer.from(value));
  }
  if (size !== item.file.size)
    throw new Error("Original download size mismatch.");
  return {
    bytes: Buffer.concat(chunks),
    contentType:
      response.headers.get("content-type")?.split(";")[0] ||
      "application/octet-stream",
  };
}

async function main() {
  const [command, input, output] = process.argv.slice(2);
  if (
    !input ||
    !["export", "prepare"].includes(command) ||
    (command === "prepare" && !output)
  ) {
    throw new Error(
      "usage: raindrop.mjs export <directory> | prepare <snapshot.json> <directory>",
    );
  }
  const dir = resolve(command === "export" ? input : output);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const snapshot =
    command === "export"
      ? await snapshotRaindrop(raindropApi(process.env.RAINDROP_TEST_TOKEN))
      : JSON.parse(await readFile(input, "utf8"));
  // Keep the complete snapshot even if an original fails to transfer.
  await writeFile(
    join(dir, "snapshot.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    { mode: 0o600 },
  );
  const originals = new Map();
  for (const item of snapshot.items.filter((item) => item.file)) {
    originals.set(
      item._id,
      await downloadOriginal(item, fetch, process.env.RAINDROP_TEST_TOKEN),
    );
  }
  const { manifest, files } = prepareLibrary(snapshot, originals);
  for (const [file, bytes] of files) {
    await mkdir(dirname(join(dir, file)), { recursive: true, mode: 0o700 });
    await writeFile(join(dir, file), bytes, { mode: 0o600 });
  }
  await writeFile(
    join(dir, "manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      sources: manifest.sources.length,
      assets: manifest.assets.length,
      originals: originals.size,
      directory: dir,
      excludes_trash: true,
    }),
  );
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
