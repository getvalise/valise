import { env } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import {
  folderFiles,
  groupFolders,
  listAssetFolders,
  moveAssetToFolder,
  moveAssetToNewFolder,
  readAssetFolder,
  renameAssetFolder,
  setFolderDetails,
} from "~/concepts/asset-folders";
import { readAssetText } from "~/concepts/asset-processing";
import { readAsset, updateAsset } from "~/concepts/assets";
import {
  exportManifest,
  importAsset,
  uploadAssetFile,
} from "~/concepts/library";

const store = { DB: env.DB, BUNDLES: env.BUNDLES, TOKEN_PEPPER: "folder-test" };
const provenance = {
  userId: "local",
  agent: "vitest",
  client: "vitest",
  session: null,
};
const upload = (name: string) =>
  uploadAssetFile(
    store,
    new File([`original ${name}`], name, { type: "application/octet-stream" }),
    {},
    provenance,
  );

afterEach(async () => {
  for (const table of ["search_docs", "assets", "asset_folders", "objects"])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

it("every upload has a singleton folder; explicit grouping changes no original or search metadata", async () => {
  const html = await upload("page.html");
  const css = await upload("page.css");
  const image = await upload("screen.png");
  expect((await listAssetFolders(env.DB, "local", false)).items).toHaveLength(
    3,
  );
  await renameAssetFolder(
    env.DB,
    "local",
    html.assetId,
    "Saved page and supporting files",
  );
  await moveAssetToFolder(env.DB, "local", css.assetId, html.assetId);
  await moveAssetToFolder(env.DB, "local", image.assetId, html.assetId);
  const page = await listAssetFolders(env.DB, "local", false, {
    query: "supporting",
  });
  expect(page.items).toMatchObject([{ folderId: html.assetId, count: 3 }]);
  expect(
    (await folderFiles(env.DB, "local", html.assetId))
      .map((a) => a.assetId)
      .sort(),
  ).toEqual([html.assetId, css.assetId, image.assetId].sort());
  expect(await readAsset(env.DB, "local", css.assetId)).toEqual(css);
  expect(await readAssetFolder(env.DB, "other", css.assetId)).toBeNull();
  await expect(
    renameAssetFolder(env.DB, "other", html.assetId, "Foreign rename"),
  ).rejects.toThrow("no longer available");
  expect(await folderFiles(env.DB, "other", html.assetId)).toEqual([]);
  await expect(
    moveAssetToFolder(env.DB, "other", css.assetId, html.assetId),
  ).rejects.toThrow("unavailable");
  await env.DB.prepare(
    "INSERT INTO asset_folders(folder_id,user_id,created_at) VALUES ('foreign','other',1)",
  ).run();
  await expect(
    env.DB.prepare(
      "UPDATE asset_folder_files SET folder_id='foreign' WHERE asset_id=?",
    )
      .bind(css.assetId)
      .run(),
  ).rejects.toThrow("owner mismatch");
  expect(await readAssetText(env.DB, "other", html.assetId)).toBeNull();
});

it("pages containers, filters members before LIMIT, and never splits a group", async () => {
  const ids: string[] = [];
  for (let n = 0; n < 35; n++) {
    const asset = await upload(`file-${n}`);
    ids.push(asset.assetId);
    await env.DB.prepare(
      "UPDATE asset_folders SET created_at=? WHERE folder_id=?",
    )
      .bind(n, asset.assetId)
      .run();
  }
  await moveAssetToFolder(env.DB, "local", ids[0], ids[1]);
  await updateAsset(store, "local", ids[0], { tags: ["rare"] });
  const first = await listAssetFolders(env.DB, "local", false);
  expect(first.items).toHaveLength(30);
  expect(first.next).toBeTruthy();
  const second = await listAssetFolders(env.DB, "local", false, {
    after: first.next!,
  });
  expect(second.items).toHaveLength(4);
  expect(second.items.find((f) => f.folderId === ids[1])?.count).toBe(2);
  expect(
    (await listAssetFolders(env.DB, "local", false, { tags: ["rare"] })).items,
  ).toMatchObject([{ folderId: ids[1], count: 2 }]);
});

it("portable v1 exports keep folder names and membership, and old entries still import as singletons", async () => {
  const a = await upload("page.html");
  const b = await upload("style.css");
  await renameAssetFolder(env.DB, "local", a.assetId, "Portable page");
  await moveAssetToFolder(env.DB, "local", b.assetId, a.assetId);
  await setFolderDetails(env.DB, "local", a.assetId, {
    tags: ["portable"],
    notes: "Kept together on purpose.",
  });
  const manifest = await exportManifest(env.DB, "local");
  await env.DB.prepare("DELETE FROM assets").run();
  await env.DB.prepare("DELETE FROM asset_folders").run();
  // Reverse order: a folder's naming asset need not arrive first.
  for (const entry of [...manifest.assets].reverse())
    await importAsset(
      store,
      "local",
      entry,
      await new Blob([`original ${entry.file_name}`]).arrayBuffer(),
    );
  expect((await listAssetFolders(env.DB, "local", false)).items).toMatchObject([
    { folderId: a.assetId, title: "Portable page", count: 2 },
  ]);
  expect(await readAssetFolder(env.DB, "local", a.assetId)).toMatchObject({
    tags: ["portable"],
    notes: "Kept together on purpose.",
  });
  const legacy = {
    ...manifest.assets.find((entry) => entry.id === `asset:${b.assetId}`)!,
    folder: undefined,
  };
  await env.DB.prepare("DELETE FROM assets WHERE asset_id = ?")
    .bind(legacy.id.slice(6))
    .run();
  await importAsset(
    store,
    "local",
    legacy,
    await new Blob([`original ${legacy.file_name}`]).arrayBuffer(),
  );
  expect(
    (await readAssetFolder(env.DB, "local", legacy.id.slice(6)))?.folderId,
  ).toBe(legacy.id.slice(6));
});

it("refuses the 101st member atomically and keeps that file's singleton and original", async () => {
  const first = await upload("anchor.bin");
  for (let n = 0; n < 99; n++) {
    const asset = await upload(`member-${n}.bin`);
    await moveAssetToFolder(env.DB, "local", asset.assetId, first.assetId);
  }
  const extra = await upload("extra.bin");
  await expect(
    moveAssetToFolder(env.DB, "local", extra.assetId, first.assetId),
  ).rejects.toThrow("100 files");
  expect(await folderFiles(env.DB, "local", first.assetId)).toHaveLength(100);
  expect(
    (await readAssetFolder(env.DB, "local", extra.assetId))?.folderId,
  ).toBe(extra.assetId);
  expect(await readAsset(env.DB, "local", extra.assetId)).toEqual(extra);
  // Moving to the same full folder is idempotent, not a second admission.
  await moveAssetToFolder(env.DB, "local", first.assetId, first.assetId);
  await expect(
    env.DB.prepare(
      "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = ?",
    )
      .bind(first.assetId, extra.assetId)
      .run(),
  ).rejects.toThrow("folder file limit");
});

it("a folder keeps its own tags and notes, which the Library filter and search match", async () => {
  const page = await upload("icons-light.svg");
  const other = await upload("receipt.pdf");
  await moveAssetToFolder(
    env.DB,
    "local",
    (await upload("icons-dark.svg")).assetId,
    page.assetId,
  );
  await setFolderDetails(env.DB, "local", page.assetId, {
    tags: ["brand", " brand ", "icons"],
  });
  await setFolderDetails(env.DB, "local", page.assetId, {
    notes: "  Exported from the 2026 style guide.  ",
  });
  // One field per call: setting notes left the tags as they were.
  expect(await readAssetFolder(env.DB, "local", page.assetId)).toMatchObject({
    tags: ["brand", "icons"],
    notes: "Exported from the 2026 style guide.",
  });
  // No file carries the tag; the folder does, and only that folder matches.
  const tagged = await listAssetFolders(env.DB, "local", false, {
    tags: ["brand"],
  });
  expect(tagged.items.map((folder) => folder.folderId)).toEqual([page.assetId]);
  expect(
    (
      await listAssetFolders(env.DB, "local", false, { query: "style guide" })
    ).items.map((folder) => folder.folderId),
  ).toEqual([page.assetId]);
  // A file's own tag still matches its folder, alone or beside a folder tag.
  await updateAsset(store, "local", other.assetId, { tags: ["brand"] });
  expect(
    (await listAssetFolders(env.DB, "local", false, { tags: ["brand"] })).items
      .map((folder) => folder.folderId)
      .sort(),
  ).toEqual([page.assetId, other.assetId].sort());
  expect(
    (
      await listAssetFolders(env.DB, "local", false, {
        tags: ["brand", "icons"],
      })
    ).items.map((folder) => folder.folderId),
  ).toEqual([page.assetId]);
});

it("refuses oversized folder details and another owner's folder", async () => {
  const file = await upload("a.txt");
  await expect(
    setFolderDetails(env.DB, "local", file.assetId, {
      notes: "x".repeat(4001),
    }),
  ).rejects.toThrow("4,000");
  await expect(
    setFolderDetails(env.DB, "local", file.assetId, {
      tags: Array.from({ length: 21 }, (_, i) => `t${i}`),
    }),
  ).rejects.toThrow("20 folder tags");
  await expect(
    setFolderDetails(env.DB, "usr_other", file.assetId, { notes: "mine" }),
  ).rejects.toThrow("no longer available");
  expect((await readAssetFolder(env.DB, "local", file.assetId))?.notes).toBe(
    "",
  );
});

it("groups several folders into the largest, renamed, with their tags and notes, and leaves no empty folder", async () => {
  const pair = await upload("light.svg");
  await moveAssetToFolder(
    env.DB,
    "local",
    (await upload("dark.svg")).assetId,
    pair.assetId,
  );
  const lone = await upload("mono.svg");
  const other = await upload("wordmark.svg");
  await setFolderDetails(env.DB, "local", pair.assetId, {
    tags: ["brand"],
    notes: "From the style guide.",
  });
  await setFolderDetails(env.DB, "local", lone.assetId, {
    tags: ["icons", "brand"],
    notes: "Single-colour variant.",
  });
  const grouped = await groupFolders(
    env.DB,
    "local",
    [lone.assetId, pair.assetId, other.assetId],
    "Brand icons",
  );
  // The two-file folder wins over the first-selected singleton.
  expect(grouped).toEqual({ folderId: pair.assetId, moved: 2 });
  expect(await readAssetFolder(env.DB, "local", other.assetId)).toMatchObject({
    folderId: pair.assetId,
    title: "Brand icons",
    tags: ["brand", "icons"],
    notes: "From the style guide.\n\nSingle-colour variant.",
  });
  expect((await folderFiles(env.DB, "local", pair.assetId)).length).toBe(4);
  const { results } = await env.DB.prepare(
    "SELECT folder_id FROM asset_folders WHERE folder_id IN (?, ?)",
  )
    .bind(lone.assetId, other.assetId)
    .all();
  expect(results).toEqual([]);
});

it("refuses a group past 100 files or with one folder, and moves nothing", async () => {
  const big = await upload("anchor.bin");
  const statements = [];
  for (let n = 0; n < 99; n++) {
    const assetId = `ast_${crypto.randomUUID()}`;
    statements.push(
      env.DB.prepare(
        `INSERT INTO assets (asset_id, user_id, state, title, description, file_name, content_type,
           declared_size, tags_json, source_agent, source_client, created_at, updated_at)
         VALUES (?, 'local', 'pending', 'x', '', ?, 'text/plain', 1, '[]', 'test', 'test', 0, 0)`,
      ).bind(assetId, `f-${n}.txt`),
      env.DB.prepare(
        "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = ?",
      ).bind(big.assetId, assetId),
    );
  }
  await env.DB.batch(statements);
  const extra = await upload("one-more.txt");
  await expect(
    groupFolders(env.DB, "local", [big.assetId, extra.assetId]),
  ).rejects.toThrow("a folder holds 100");
  expect(
    (await readAssetFolder(env.DB, "local", extra.assetId))?.folderId,
  ).toBe(extra.assetId);
  await expect(
    groupFolders(env.DB, "local", [extra.assetId, extra.assetId]),
  ).rejects.toThrow("at least two folders");
  await expect(
    groupFolders(env.DB, "usr_other", [big.assetId, extra.assetId]),
  ).rejects.toThrow("no longer available");
});

it("takes one file out into a new named folder, or renames a file's own folder", async () => {
  const page = await upload("page.html");
  const css = await upload("page.css");
  await moveAssetToFolder(env.DB, "local", css.assetId, page.assetId);
  const folderId = await moveAssetToNewFolder(
    env.DB,
    "local",
    css.assetId,
    "Stylesheets",
  );
  expect(folderId).not.toBe(page.assetId);
  expect(await readAssetFolder(env.DB, "local", css.assetId)).toMatchObject({
    folderId,
    title: "Stylesheets",
  });
  expect((await folderFiles(env.DB, "local", page.assetId)).length).toBe(1);
  // Alone already: the folder stays and only its name changes.
  expect(await moveAssetToNewFolder(env.DB, "local", css.assetId, "CSS")).toBe(
    folderId,
  );
  expect((await readAssetFolder(env.DB, "local", css.assetId))?.title).toBe(
    "CSS",
  );
});
