import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  AssetRefused,
  beginAssetUpload,
  finalizeAssetUpload,
  issueAssetDownload,
  MAX_ASSET_BYTES,
  readAsset,
  readAssetRow,
  receiveAssetUpload,
  serveAssetDownload,
  updateAsset,
} from "~/concepts/assets";
import { serveObject, sha256Hex, uploadKey } from "~/r2/objects";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";

const assetEnv = { DB: env.DB, BUNDLES: env.BUNDLES, TOKEN_PEPPER: "pepper" };
const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};
const PNG = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_attachments",
    "assets",
    "objects",
    "todos",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  const listed = await env.BUNDLES.list();
  if (listed.objects.length) {
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
  }
});

async function begin(
  overrides: Partial<Parameters<typeof beginAssetUpload>[1]> = {},
) {
  return beginAssetUpload(
    assetEnv,
    {
      fileName: "heron.png",
      contentType: "image/png",
      size: PNG.byteLength,
      title: "Heron dashboard screenshot",
      description: "The cost panel after the cache change",
      project: "valise",
      tags: ["screenshot"],
      ...overrides,
    },
    provenance,
  );
}

function put(assetId: string, token: string, body: Uint8Array) {
  return receiveAssetUpload(
    assetEnv,
    assetId,
    new Request(`http://127.0.0.1/uploads/${assetId}?token=${token}`, {
      method: "PUT",
      headers: { "content-type": "image/png" },
      body,
    }),
  );
}

async function hits(query: string) {
  return (
    await search(env, { userId: "local", query, concepts: ["asset"] })
  ).map((hit) => hit.docKey);
}

async function objectKeys(prefix = "u/local/objects/") {
  return (await env.BUNDLES.list({ prefix })).objects.map((o) => o.key);
}

describe("asset uploads", () => {
  it("stays pending and undiscoverable until the PUT verifies and finalizes the bytes", async () => {
    const { asset, token } = await begin();
    expect(asset.state).toBe("pending");
    expect(await hits("heron")).toEqual([]);
    expect(await readAsset(env.DB, "local", asset.assetId)).toBeNull();

    const uploaded = await put(asset.assetId, token, PNG);
    expect(uploaded.status).toBe(200);
    expect(await uploaded.json()).toMatchObject({
      id: `asset:${asset.assetId}`,
      state: "ready",
      size: PNG.byteLength,
      sha256: await sha256Hex(PNG.buffer),
    });
    for (const term of ["heron", "panel", "screenshot"]) {
      expect(await hits(term)).toEqual([`asset:${asset.assetId}`]);
    }
    // The staging copy is gone once the object row commits.
    expect(
      await env.BUNDLES.head(uploadKey("local", asset.assetId)),
    ).toBeNull();
    // The credential is spent: a repeat cannot write the asset again.
    expect((await put(asset.assetId, token, PNG)).status).toBe(401);
  });

  it("finalizes idempotently, and a race commits one object", async () => {
    const { asset, token } = await begin();
    await put(asset.assetId, token, PNG);
    const [first, second] = await Promise.all([
      finalizeAssetUpload(assetEnv, "local", asset.assetId),
      finalizeAssetUpload(assetEnv, "local", asset.assetId),
    ]);
    const again = await finalizeAssetUpload(assetEnv, "local", asset.assetId);
    const objectIds = [first, second, again].map((outcome) =>
      outcome.ok ? outcome.asset.objectId : null,
    );
    expect(new Set(objectIds).size).toBe(1);
    expect(objectIds[0]).toMatch(/^obj_/);
    const { results } = await env.DB.prepare(
      "SELECT object_id FROM objects",
    ).all();
    expect(results).toHaveLength(1);
    // The loser deleted the copy it wrote: one object in R2.
    expect(await objectKeys()).toHaveLength(1);
  });

  it("leaves an interrupted upload pending and retryable", async () => {
    const { asset, token } = await begin();
    expect(
      await finalizeAssetUpload(assetEnv, "local", asset.assetId),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("no bytes") });

    const short = await put(asset.assetId, token, PNG.subarray(0, 5));
    expect(short.status).toBe(400);
    expect(await short.json()).toMatchObject({ error: "size_mismatch" });
    expect((await readAssetRow(env.DB, "local", asset.assetId))?.state).toBe(
      "pending",
    );
    expect(await objectKeys()).toEqual([]);

    expect((await put(asset.assetId, token, PNG)).status).toBe(200);
    expect(
      (await finalizeAssetUpload(assetEnv, "local", asset.assetId)).ok,
    ).toBe(true);
  });

  it("refuses an oversize declaration, a wrong checksum, and a wrong token", async () => {
    await expect(begin({ size: MAX_ASSET_BYTES + 1 })).rejects.toBeInstanceOf(
      AssetRefused,
    );

    const { asset, token } = await begin({ sha256: "0".repeat(64) });
    const mismatched = await put(asset.assetId, token, PNG);
    expect(mismatched.status).toBe(400);
    expect(await mismatched.json()).toMatchObject({
      error: "checksum_mismatch",
    });
    expect(
      await env.BUNDLES.head(uploadKey("local", asset.assetId)),
    ).toBeNull();

    const forged = await put(asset.assetId, `vlu_${"A".repeat(43)}`, PNG);
    expect(forged.status).toBe(401);
  });

  it("never lets the upload credential change finalized bytes", async () => {
    const { asset, token } = await begin();
    await put(asset.assetId, token, PNG);
    const finalized = await finalizeAssetUpload(
      assetEnv,
      "local",
      asset.assetId,
    );
    if (!finalized.ok) throw new Error(finalized.reason);

    const replaced = await put(
      asset.assetId,
      token,
      new Uint8Array(PNG.byteLength).fill(7),
    );
    expect(replaced.status).toBeGreaterThanOrEqual(400);
    const served = await serveObject(
      assetEnv,
      "local",
      finalized.asset.objectId ?? "",
    );
    expect(
      new Uint8Array((await served?.arrayBuffer()) ?? new ArrayBuffer(0)),
    ).toEqual(PNG);
  });

  it("refuses an upload whose credential has expired", async () => {
    const { asset, token } = await begin();
    await env.DB.prepare(
      "UPDATE assets SET upload_expires_at = 1 WHERE asset_id = ?",
    )
      .bind(asset.assetId)
      .run();
    expect((await put(asset.assetId, token, PNG)).status).toBe(410);
  });
});

describe("asset downloads and expiry", () => {
  async function ready(overrides = {}) {
    const { asset, token } = await begin(overrides);
    await put(asset.assetId, token, PNG);
    const finalized = await finalizeAssetUpload(
      assetEnv,
      "local",
      asset.assetId,
    );
    if (!finalized.ok) throw new Error(finalized.reason);
    return finalized.asset;
  }

  it("serves the unchanged original through a signed, short-lived URL", async () => {
    const asset = await ready();
    const { url, expiresAt } = await issueAssetDownload(
      assetEnv,
      asset,
      "http://127.0.0.1",
    );
    expect(expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(900);
    const response = await serveAssetDownload(
      assetEnv,
      asset.assetId,
      new URL(url),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/png");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);

    const tampered = new URL(url);
    tampered.searchParams.set("expires", String(expiresAt + 1));
    expect(
      (await serveAssetDownload(assetEnv, asset.assetId, tampered)).status,
    ).toBe(403);
  });

  it("denies an expired asset on every path before cleanup runs", async () => {
    const asset = await ready({ expiresInSeconds: 3600 });
    const { url } = await issueAssetDownload(
      assetEnv,
      asset,
      "http://127.0.0.1",
    );
    const durable = await serveObject(assetEnv, "local", asset.objectId ?? "");
    // An expiring file is never cached past its expiry.
    expect(durable?.headers.get("cache-control")).toBe("private, no-store");
    await durable?.body?.cancel();

    await env.DB.prepare("UPDATE assets SET expires_at = ? WHERE asset_id = ?")
      .bind(Math.floor(Date.now() / 1000) - 1, asset.assetId)
      .run();

    expect(await readAsset(env.DB, "local", asset.assetId)).toBeNull();
    expect(
      (await serveAssetDownload(assetEnv, asset.assetId, new URL(url))).status,
    ).toBe(404);
    expect(
      await serveObject(assetEnv, "local", asset.objectId ?? ""),
    ).toBeNull();
    // The bytes are still in R2: denial does not wait for cleanup.
    expect(await objectKeys()).toHaveLength(1);
  });

  it("keeps a durable file on the year-long immutable cache policy", async () => {
    const asset = await ready();
    const served = await serveObject(assetEnv, "local", asset.objectId ?? "");
    expect(served?.headers.get("cache-control")).toBe(
      "private, max-age=31536000, immutable",
    );
    await served?.body?.cancel();
  });

  it("refuses an expiry while a to-do attachment refers to the file", async () => {
    const asset = await ready();
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO todos (todo_id, title, source_agent, created_at, updated_at)
         VALUES ('tdo_ref', 'Holds the screenshot', 'vitest', 1, 1)`,
      ),
      env.DB.prepare(
        "INSERT INTO todo_attachments (todo_id, object_id, created_at) VALUES ('tdo_ref', ?, 1)",
      ).bind(asset.objectId),
    ]);
    await expect(
      updateAsset(assetEnv, "local", asset.assetId, { expiresInSeconds: 600 }),
    ).rejects.toThrow(/todo:tdo_ref/);

    const renamed = await updateAsset(assetEnv, "local", asset.assetId, {
      title: "Egret cost chart",
    });
    expect(renamed?.title).toBe("Egret cost chart");
    expect(renamed?.expiresAt).toBeNull();
    // The title left the index; the file name still finds it.
    expect(await hits("dashboard")).toEqual([]);
    expect(await hits("egret")).toEqual([`asset:${asset.assetId}`]);
    expect(await hits("heron")).toEqual([`asset:${asset.assetId}`]);
  });

  it("hides another user's asset and rebuilds from the authoritative rows", async () => {
    const asset = await ready();
    expect(await readAsset(env.DB, "someone-else", asset.assetId)).toBeNull();

    await env.DB.prepare("DELETE FROM search_docs").run();
    const report = await reindex(env, ["asset"]);
    expect(report.published.asset).toBe(1);
    expect(await hits("heron")).toEqual([`asset:${asset.assetId}`]);
  });
});
