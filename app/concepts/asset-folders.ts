import {
  type Asset,
  AssetRefused,
  assetRef,
  FOLDER_FULL,
  readAssets,
} from "~/concepts/assets";
import {
  type LibraryPageOptions,
  libraryBoundary,
  libraryPage,
  libraryPageWhere,
} from "~/concepts/library-page";

export type AssetFolder = {
  folderId: string;
  title: string | null;
  createdAt: number;
  count: number;
  size: number;
  assetId: string;
};
const VISIBLE = `a.state = 'ready' AND (a.expires_at IS NULL OR a.expires_at > unixepoch())`;

/** Thirty containers, not thirty members: a group cannot split across pages. */
export async function listAssetFolders(
  db: D1Database,
  userId: string,
  archived: boolean,
  options: LibraryPageOptions = {},
) {
  // A selected tag matches a folder that carries it or holds a file that does.
  const match = libraryPageWhere("a", "asset_id", {
    ...options,
    after: undefined,
    query: undefined,
    tags: undefined,
  });
  const tags = options.tags?.slice(0, 20) ?? [];
  const after = libraryBoundary(options.after);
  let parameter = 4;
  const predicates = match.sql.replace(/\?/g, () => `?${parameter++}`);
  const { results } = await db
    .prepare(`SELECT f.folder_id AS folderId, f.title, f.created_at AS createdAt,
    (SELECT COUNT(*) FROM asset_folder_files m JOIN assets a USING(asset_id)
      WHERE m.folder_id = f.folder_id AND a.user_id = f.user_id AND ${VISIBLE} AND (a.archived_at IS NOT NULL) = ?1) AS count,
    (SELECT COALESCE(SUM(o.size), 0) FROM asset_folder_files m JOIN assets a USING(asset_id) JOIN objects o USING(object_id)
      WHERE m.folder_id = f.folder_id AND a.user_id = f.user_id AND ${VISIBLE} AND (a.archived_at IS NOT NULL) = ?1) AS size,
    (SELECT a.asset_id FROM asset_folder_files m JOIN assets a USING(asset_id)
      WHERE m.folder_id = f.folder_id AND a.user_id = f.user_id AND ${VISIBLE} AND (a.archived_at IS NOT NULL) = ?1
      ORDER BY (a.asset_id = m.folder_id) DESC, a.created_at, a.asset_id LIMIT 1) AS assetId
    FROM asset_folders f WHERE f.user_id = ?2
    AND EXISTS (SELECT 1 FROM asset_folder_files m JOIN assets a USING(asset_id)
      WHERE m.folder_id = f.folder_id AND a.user_id = f.user_id AND ${VISIBLE} AND (a.archived_at IS NOT NULL) = ?1 ${predicates}
      AND (?3 = '' OR instr(lower(COALESCE(f.title, '') || ' ' || f.notes || ' ' || f.tags_json || ' ' || a.title || ' ' || a.file_name || ' ' || a.description || ' ' || a.tags_json), lower(?3)) > 0)
      ${tags.map(() => `AND (EXISTS (SELECT 1 FROM json_each(f.tags_json) WHERE value = ?${parameter++}) OR EXISTS (SELECT 1 FROM json_each(a.tags_json) WHERE value = ?${parameter - 1}))`).join("\n      ")})
    ${after ? "AND (f.created_at < ? OR (f.created_at = ? AND f.folder_id < ?))" : ""}
    ORDER BY f.created_at DESC, f.folder_id DESC LIMIT 31`)
    .bind(
      archived ? 1 : 0,
      userId,
      options.query ?? "",
      ...match.values,
      ...tags,
      ...(after ? [after.createdAt, after.createdAt, after.id] : []),
    )
    .all<AssetFolder>();
  return libraryPage(results, (row) => ({
    createdAt: row.createdAt,
    id: row.folderId,
  }));
}

export async function readAssetFolder(
  db: D1Database,
  userId: string,
  assetId: string,
) {
  const row = await db
    .prepare(`SELECT f.folder_id AS folderId, f.title, f.created_at AS createdAt,
    f.tags_json AS tagsJson, f.notes
    FROM asset_folders f JOIN asset_folder_files m USING(folder_id)
    WHERE m.asset_id = ? AND f.user_id = ? AND m.user_id = f.user_id`)
    .bind(assetId, userId)
    .first<
      Omit<AssetFolder, "count" | "size" | "assetId"> & {
        tagsJson: string;
        notes: string;
      }
    >();
  if (!row) return null;
  const { tagsJson, ...folder } = row;
  return { ...folder, tags: folderTags(tagsJson) };
}

function folderTags(json: string): string[] {
  try {
    const parsed: unknown = JSON.parse(json);
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * The folder's own tags or notes, beside each file's: a group kept as a
 * whole (owner, 2026-11-02). One field per call (P2). Folders have no
 * search projection; the Library's filter and search read these columns.
 */
export async function setFolderDetails(
  db: D1Database,
  userId: string,
  folderId: string,
  patch: { tags?: string[]; notes?: string },
) {
  const notes = patch.notes?.trim();
  if (notes !== undefined && notes.length > 4000)
    throw new AssetRefused("Keep folder notes under 4,000 characters.");
  const tags =
    patch.tags === undefined
      ? undefined
      : [...new Set(patch.tags.map((tag) => tag.trim()).filter(Boolean))];
  if (tags && (tags.length > 20 || tags.some((tag) => tag.length > 100)))
    throw new AssetRefused("Use at most 20 folder tags of 100 characters.");
  const result = await db
    .prepare(
      `UPDATE asset_folders SET tags_json = COALESCE(?, tags_json), notes = COALESCE(?, notes)
        WHERE folder_id = ? AND user_id = ?`,
    )
    .bind(
      tags === undefined ? null : JSON.stringify(tags),
      notes ?? null,
      folderId,
      userId,
    )
    .run();
  if (!result.meta.changes)
    throw new AssetRefused(
      "This folder is no longer available. Reload Library before editing it.",
    );
}

/** At most 100 members. Moves refuse the 101st rather than hiding files. */
export async function folderFiles(
  db: D1Database,
  userId: string,
  folderId: string,
): Promise<Asset[]> {
  const { results } = await db
    .prepare(`SELECT a.asset_id AS assetId FROM asset_folder_files m JOIN assets a USING(asset_id)
    WHERE m.folder_id = ? AND m.user_id = ? AND a.user_id = m.user_id AND ${VISIBLE}
    ORDER BY (a.asset_id = m.folder_id) DESC, a.created_at, a.asset_id LIMIT 100`)
    .bind(folderId, userId)
    .all<{ assetId: string }>();
  // Only the open folder hydrates its members; list rows carry one original.
  const assets = await readAssets(
    db,
    userId,
    results.map((row) => row.assetId),
  );
  const byId = new Map(assets.map((asset) => [asset.assetId, asset]));
  return results.flatMap((row) =>
    byId.has(row.assetId) ? [byId.get(row.assetId)!] : [],
  );
}

/**
 * The folder a new upload may join: the one the user's ready asset is in,
 * with room for another file. Pending members count, as the trigger counts them.
 */
export async function joinableFolder(
  db: D1Database,
  userId: string,
  assetId: string,
): Promise<string> {
  const row = await db
    .prepare(`SELECT m.folder_id AS folderId,
    (SELECT COUNT(*) FROM asset_folder_files c WHERE c.folder_id = m.folder_id) AS files
    FROM asset_folder_files m JOIN assets a USING(asset_id)
    WHERE m.asset_id = ? AND m.user_id = ? AND a.user_id = m.user_id AND ${VISIBLE}`)
    .bind(assetId, userId)
    .first<{ folderId: string; files: number }>();
  if (row === null)
    throw new AssetRefused(
      `No ready asset exists for ${assetRef(assetId)}. Nothing was uploaded.`,
    );
  if (row.files >= 100) throw new AssetRefused(FOLDER_FULL);
  return row.folderId;
}

export async function moveAssetToFolder(
  db: D1Database,
  userId: string,
  assetId: string,
  folderId: string,
) {
  const result = await db
    .prepare(`UPDATE asset_folder_files SET folder_id = ?
    WHERE asset_id = ? AND user_id = ? AND EXISTS (SELECT 1 FROM asset_folders f WHERE f.folder_id = ? AND f.user_id = ?)
    AND (folder_id = ? OR (SELECT COUNT(*) FROM asset_folder_files WHERE folder_id = ?) < 100)`)
    .bind(folderId, assetId, userId, folderId, userId, folderId, folderId)
    .run();
  if (!result.meta.changes)
    throw new AssetRefused(
      "Folder unavailable or full (100 files). Nothing was moved.",
    );
}

export async function renameAssetFolder(
  db: D1Database,
  userId: string,
  folderId: string,
  title: string,
) {
  const name = title.trim();
  if (!name || name.length > 200)
    throw new AssetRefused("Use a folder name of 1 to 200 characters.");
  const result = await db
    .prepare(
      "UPDATE asset_folders SET title = ? WHERE folder_id = ? AND user_id = ?",
    )
    .bind(name, folderId, userId)
    .run();
  if (!result.meta.changes)
    throw new AssetRefused(
      "This folder is no longer available. Reload Library before renaming it.",
    );
}

/** How many files a folder holds, or null when it is not this owner's. */
export async function folderFill(
  db: D1Database,
  userId: string,
  folderId: string,
): Promise<number | null> {
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM asset_folder_files
                WHERE folder_id = f.folder_id AND user_id = f.user_id) AS count
         FROM asset_folders f WHERE f.folder_id = ? AND f.user_id = ?`,
    )
    .bind(folderId, userId)
    .first<{ count: number }>();
  return row?.count ?? null;
}

/**
 * Puts the files of several folders into one: the selected folder holding
 * the most files (the first given on a tie), renamed when a name is given.
 * Its tags gain the others' and their notes follow its own. Every refusal is
 * found before the one write batch, so a refused call moves nothing; the
 * emptied folders are deleted by the membership trigger. Owner, 2026-11-02.
 */
export async function groupFolders(
  db: D1Database,
  userId: string,
  assetIds: string[],
  name?: string,
): Promise<{ folderId: string; moved: number }> {
  const title = name?.trim() || undefined;
  if (title !== undefined && title.length > 200)
    throw new AssetRefused("Use a folder name of 1 to 200 characters.");
  const folders: {
    folderId: string;
    title: string | null;
    tags: string[];
    notes: string;
    count: number;
  }[] = [];
  for (const assetId of [...new Set(assetIds)].slice(0, 100)) {
    const folder = await readAssetFolder(db, userId, assetId);
    if (!folder)
      throw new AssetRefused(
        "A selected file is no longer available. Nothing was moved.",
      );
    if (folders.some((seen) => seen.folderId === folder.folderId)) continue;
    folders.push({
      ...folder,
      count: (await folderFill(db, userId, folder.folderId)) ?? 0,
    });
  }
  if (folders.length < 2)
    throw new AssetRefused("Select files from at least two folders to group.");
  const target = folders.reduce((best, folder) =>
    folder.count > best.count ? folder : best,
  );
  const others = folders.filter((folder) => folder !== target);
  const total = folders.reduce((sum, folder) => sum + folder.count, 0);
  if (total > 100)
    throw new AssetRefused(
      `Together these hold ${total} files; a folder holds 100. Nothing was moved.`,
    );
  // The kept folder's own tags and notes lead; the others' follow.
  const tags = [
    ...new Set([target, ...others].flatMap((folder) => folder.tags)),
  ];
  if (tags.length > 20)
    throw new AssetRefused(
      "Together these folders carry more than 20 tags. Remove some first; nothing was moved.",
    );
  const notes = [target, ...others]
    .map((folder) => folder.notes.trim())
    .filter(Boolean)
    .join("\n\n");
  if (notes.length > 4000)
    throw new AssetRefused(
      "Together these folders' notes pass 4,000 characters. Shorten them first; nothing was moved.",
    );
  const ids = JSON.stringify(others.map((folder) => folder.folderId));
  await db.batch([
    db
      .prepare(
        `UPDATE asset_folders SET tags_json = ?, notes = ?, title = COALESCE(?, title)
          WHERE folder_id = ? AND user_id = ?`,
      )
      .bind(
        JSON.stringify(tags),
        notes,
        title ?? null,
        target.folderId,
        userId,
      ),
    db
      .prepare(
        `UPDATE asset_folder_files SET folder_id = ?
          WHERE user_id = ? AND folder_id IN (SELECT value FROM json_each(?))`,
      )
      .bind(target.folderId, userId, ids),
  ]);
  return { folderId: target.folderId, moved: total - target.count };
}

/**
 * Takes one file out of its folder into a new one of its own, named. A file
 * already alone keeps its folder and only the name changes.
 */
export async function moveAssetToNewFolder(
  db: D1Database,
  userId: string,
  assetId: string,
  name: string,
): Promise<string> {
  const title = name.trim();
  if (!title || title.length > 200)
    throw new AssetRefused("Use a folder name of 1 to 200 characters.");
  const folder = await readAssetFolder(db, userId, assetId);
  if (!folder)
    throw new AssetRefused("This file is no longer available. Reload Library.");
  if (((await folderFill(db, userId, folder.folderId)) ?? 0) <= 1) {
    await renameAssetFolder(db, userId, folder.folderId, title);
    return folder.folderId;
  }
  const folderId = `ast_${crypto.randomUUID()}`;
  await db.batch([
    db
      .prepare(
        "INSERT INTO asset_folders (folder_id, user_id, title, created_at) VALUES (?, ?, ?, unixepoch())",
      )
      .bind(folderId, userId, title),
    db
      .prepare(
        "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = ? AND user_id = ?",
      )
      .bind(folderId, assetId, userId),
  ]);
  return folderId;
}
