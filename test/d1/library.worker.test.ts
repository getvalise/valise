import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { beginAssetUpload, readAssetRow, updateAsset } from "~/concepts/assets";
import {
  cleanupLibrary,
  deleteAsset,
  uploadAssetFile,
} from "~/concepts/library";
import { deleteSource, saveSource } from "~/concepts/sources";
import { objectKey, serveObject, uploadKey } from "~/r2/objects";
import { search } from "~/search/query";

const assetEnv = { DB: env.DB, BUNDLES: env.BUNDLES, TOKEN_PEPPER: "pepper" };
const provenance = {
  userId: "local",
  agent: "console",
  client: "console",
  session: null,
};
const now = () => Math.floor(Date.now() / 1000);

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "todo_attachments",
    "todos",
    "assets",
    "objects",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

function file(name: string, text = "hello, library") {
  return new File([text], name, { type: "text/plain" });
}

async function keys(prefix = "u/local/") {
  return (await env.BUNDLES.list({ prefix })).objects.map((o) => o.key);
}

describe("console upload and delete", () => {
  it("uploads through the same finalize an agent uses", async () => {
    const asset = await uploadAssetFile(
      assetEnv,
      file("notes.txt"),
      { title: "Sandpiper notes" },
      provenance,
    );
    expect(asset).toMatchObject({ state: "ready", size: 14 });
    expect(
      (
        await search(env, {
          userId: "local",
          query: "sandpiper",
          concepts: ["asset"],
        })
      ).length,
    ).toBe(1);
    expect(await keys("u/local/uploads/")).toEqual([]);
  });

  it("refuses to delete a file a source links, and deletes it once the source is gone", async () => {
    const asset = await uploadAssetFile(
      assetEnv,
      file("a.txt"),
      {},
      provenance,
    );
    const source = await saveSource(
      env,
      { kind: "document", title: "Cites a.txt", assetIds: [asset.assetId] },
      provenance,
    );
    expect(await deleteAsset(assetEnv, "local", asset.assetId)).toEqual({
      refusedBy: [`source:${source.sourceId}`],
    });

    await deleteSource(env.DB, "local", source.sourceId);
    expect(await deleteAsset(assetEnv, "local", asset.assetId)).toEqual({
      deleted: true,
    });
    expect(await readAssetRow(env.DB, "local", asset.assetId)).toBeNull();
    expect(await keys()).toEqual([]);
    expect(
      await search(env, {
        userId: "local",
        query: "a.txt",
        concepts: ["asset"],
      }),
    ).toEqual([]);
  });
});

describe("cleanupLibrary", () => {
  it("removes abandoned uploads with their staged bytes, and leaves live ones", async () => {
    const live = await beginAssetUpload(
      assetEnv,
      { fileName: "live.png", size: 3 },
      provenance,
    );
    const stale = await beginAssetUpload(
      assetEnv,
      { fileName: "stale.png", size: 3 },
      provenance,
    );
    await env.BUNDLES.put(uploadKey("local", stale.asset.assetId), "abc");
    await env.DB.prepare(
      "UPDATE assets SET upload_expires_at = 1 WHERE asset_id = ?",
    )
      .bind(stale.asset.assetId)
      .run();

    const report = await cleanupLibrary(assetEnv);
    expect(report).toMatchObject({ abandoned: 1, errors: [] });
    expect(await readAssetRow(env.DB, "local", stale.asset.assetId)).toBeNull();
    expect(
      (await readAssetRow(env.DB, "local", live.asset.assetId))?.state,
    ).toBe("pending");
    expect(await keys("u/local/uploads/")).toEqual([]);
  });

  it("purges expired assets nothing refers to, and spares protected ones", async () => {
    const loose = await uploadAssetFile(
      assetEnv,
      file("loose.txt"),
      { expiresInSeconds: 60 },
      provenance,
    );
    const held = await uploadAssetFile(
      assetEnv,
      file("held.txt"),
      {},
      provenance,
    );
    // An attachment protects the held file; expire both by hand.
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO todos (todo_id, title, source_agent, created_at, updated_at)
         VALUES ('tdo_hold', 'Holds a file', 'vitest', 1, 1)`,
      ),
      env.DB.prepare(
        "INSERT INTO todo_attachments (todo_id, object_id, created_at) VALUES ('tdo_hold', ?, 1)",
      ).bind(held.objectId),
      env.DB.prepare("UPDATE assets SET expires_at = ?").bind(now() - 1),
    ]);

    const report = await cleanupLibrary(assetEnv);
    expect(report).toMatchObject({ expired: 1, protected: 1, errors: [] });
    expect(await readAssetRow(env.DB, "local", loose.assetId)).toBeNull();
    expect(
      await env.DB.prepare("SELECT 1 FROM objects WHERE object_id = ?")
        .bind(loose.objectId)
        .first(),
    ).toBeNull();
    expect(await keys("u/local/objects/")).toEqual([
      objectKey("local", held.objectId ?? ""),
    ]);
    // Rerunning finds nothing left to do: every step is idempotent.
    expect(await cleanupLibrary(assetEnv)).toMatchObject({
      abandoned: 0,
      expired: 0,
    });
  });

  it("deletes stray staged bytes and day-old objects no row names", async () => {
    const kept = await uploadAssetFile(
      assetEnv,
      file("kept.txt"),
      {},
      provenance,
    );
    await env.BUNDLES.put(uploadKey("local", "ast_gone"), "stray");
    await env.BUNDLES.put(objectKey("local", "obj_orphan"), "orphan");

    // A fresh orphan may be a finalize in flight; a day later it is not.
    expect((await cleanupLibrary(assetEnv)).orphanObjects).toBe(0);
    const report = await cleanupLibrary(assetEnv, now() + 2 * 24 * 60 * 60);
    expect(report).toMatchObject({ orphanObjects: 1, errors: [] });
    expect(await keys()).toEqual([objectKey("local", kept.objectId ?? "")]);
    const served = await serveObject(assetEnv, "local", kept.objectId ?? "");
    expect(await served?.text()).toBe("hello, library");
  });

  it("does not let an expiry be set on a linked file even through the console", async () => {
    const asset = await uploadAssetFile(
      assetEnv,
      file("b.txt"),
      {},
      provenance,
    );
    await saveSource(
      env,
      { kind: "document", title: "Cites b.txt", assetIds: [asset.assetId] },
      provenance,
    );
    await expect(
      updateAsset(assetEnv, "local", asset.assetId, { expiresInSeconds: 60 }),
    ).rejects.toThrow(/source:/);
  });
});
