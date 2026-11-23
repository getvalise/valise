import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  downloadOriginal,
  prepareLibrary,
  raindropApi,
  snapshotRaindrop,
  stableId,
} from "../scripts/raindrop.mjs";

const item = {
  _id: 123,
  link: "https://example.org/article",
  title: "A retained article",
  created: "2026-01-01T00:00:00Z",
  lastUpdate: "2026-02-01T00:00:00Z",
  type: "article",
  collection: { $id: 2 },
  tags: ["SQL", "日本語"],
  note: "My own note.",
  excerpt: "The supplied description.",
  highlights: [{ _id: "h1", text: "An exact quote.", note: "Why it matters." }],
};
const snapshot = {
  format: "raindrop-snapshot",
  version: 1,
  account_id: 99,
  exported_at: 1792850000,
  collections: [
    { _id: 1, title: "Data" },
    { _id: 2, title: "SQL", parent: { $id: 1 } },
  ],
  items: [item],
};

test("preserves notes, highlights, nested collections, tags, dates and a raw asset", () => {
  const { manifest, files } = prepareLibrary(snapshot);
  const source = manifest.sources[0];
  const revision = source.revisions[0];
  assert.equal(source.created_at, 1767225600);
  assert.equal(source.updated_at, 1769904000);
  assert.equal(revision.url, item.link);
  assert.equal(revision.kind, "bookmark");
  for (const text of [
    "My own note.",
    "The supplied description.",
    "An exact quote.",
    "Why it matters.",
    "Data / SQL",
    "123",
    "not indexed",
  ])
    assert.ok(revision.notes.includes(text));
  assert.deepEqual(revision.tags, [
    "SQL",
    "日本語",
    "raindrop",
    "collection:Data / SQL",
  ]);
  assert.deepEqual(revision.assets, [manifest.assets[0].id]);
  assert.deepEqual(JSON.parse(files.get(manifest.assets[0].file)), snapshot);
  assert.equal(manifest.assets[0].expires_at, null);
  assert.equal(source.provenance.session, "99");
});

test("source ids are stable across exports, account-scoped, and not URL-deduplicated", () => {
  const first = prepareLibrary(snapshot).manifest;
  const second = prepareLibrary({
    ...snapshot,
    exported_at: snapshot.exported_at + 1,
  }).manifest;
  assert.equal(first.sources[0].id, second.sources[0].id);
  assert.notEqual(first.assets[0].id, second.assets[0].id);
  assert.notEqual(stableId("source", 99, 123), stableId("source", 100, 123));
  const two = prepareLibrary({
    ...snapshot,
    items: [item, { ...item, _id: 124 }],
  });
  assert.notEqual(two.manifest.sources[0].id, two.manifest.sources[1].id);
  assert.match(first.sources[0].id, /^source:src_[a-f0-9-]{36}$/);
});

test("fails instead of dropping unsupported URLs, long notes, duplicate ids or missing evidence", () => {
  for (const patch of [
    { link: "javascript:alert(1)" },
    { note: "x".repeat(65536) },
    { created: "invalid" },
    { highlights: [{ _id: "h1" }] },
    { removed: true },
  ])
    assert.throws(() =>
      prepareLibrary({ ...snapshot, items: [{ ...item, ...patch }] }),
    );
  assert.throws(() => prepareLibrary({ ...snapshot, items: [item, item] }));
  assert.throws(() =>
    prepareLibrary({
      ...snapshot,
      collections: [{ _id: 2, title: "Cycle", parent: { $id: 2 } }],
    }),
  );
});

test("snapshots every page, excludes trash, deduplicates collection metadata and detects drift", async () => {
  const calls = [];
  const api = async (path) => {
    calls.push(path);
    if (path === "/user")
      return { user: { _id: 99, email: "not-retained@example.org" } };
    if (path.startsWith("/collections")) return { items: snapshot.collections };
    const page = Number(new URL(`https://x${path}`).searchParams.get("page"));
    return {
      count: 51,
      items: Array.from({ length: page ? 1 : 50 }, (_, i) => ({
        ...item,
        _id: page * 50 + i,
      })),
    };
  };
  const saved = await snapshotRaindrop(api);
  assert.equal(saved.items.length, 51);
  assert.equal(saved.collections.length, 2);
  assert.equal(saved.excludes_trash, true);
  assert.ok(calls.every((path) => !path.includes("-99")));
  assert.ok(!JSON.stringify(saved).includes("not-retained@example.org"));
  await assert.rejects(
    snapshotRaindrop(async (path) => {
      const result = await api(path);
      return path.includes("page=1") ? { ...result, count: 52 } : result;
    }),
    /changed/,
  );
});

test("API reads retry 429, do not follow redirects and never expose provider bodies", async () => {
  const calls = [];
  const waits = [];
  const api = raindropApi(
    "test-secret",
    async (url, init) => {
      calls.push({ url, init });
      return calls.length === 1
        ? new Response("private provider error", {
            status: 429,
            headers: { "retry-after": "2" },
          })
        : Response.json({ result: true, items: [] });
    },
    async (ms) => {
      waits.push(ms);
    },
  );
  await api("/collections");
  assert.deepEqual(waits, [2000, 300]);
  assert.equal(calls[0].init.redirect, "error");
  assert.equal(calls[0].init.method, undefined);
  const denied = raindropApi(
    "test-secret",
    async () => new Response("test-secret", { status: 401 }),
  );
  await assert.rejects(
    denied("/user"),
    (e) => e.message === "Raindrop API HTTP 401.",
  );
});

test("downloaded originals are bounded, credential-free and immutable asset links", async () => {
  const uploaded = {
    ...item,
    link: "https://up.raindrop.io/raindrop/123/file.pdf",
    file: { name: "../paper.pdf", size: 3 },
  };
  const original = await downloadOriginal(uploaded, async (_url, init) => {
    assert.equal(init.headers, undefined);
    assert.equal(init.redirect, "error");
    return new Response("pdf", {
      headers: { "content-type": "application/pdf" },
    });
  });
  const { manifest } = prepareLibrary(
    { ...snapshot, items: [uploaded] },
    new Map([[123, original]]),
  );
  assert.equal(manifest.assets.length, 2);
  assert.equal(manifest.assets[1].file_name, ".._paper.pdf");
  assert.equal(manifest.sources[0].revisions[0].kind, "document");
  assert.equal(manifest.sources[0].revisions[0].assets.length, 2);
  await assert.rejects(
    downloadOriginal({ ...uploaded, link: item.link }),
    /RAINDROP_TEST_TOKEN/,
  );
  await assert.rejects(
    downloadOriginal(uploaded, async () => new Response("too large")),
    /exceeded/,
  );
  await assert.rejects(
    downloadOriginal(uploaded, async () => new Response("p")),
    /mismatch/,
  );
});

test("legacy uploaded-file URLs resolve through the documented API without leaking the token to S3", async () => {
  const uploaded = {
    ...item,
    link: "https://api.raindrop.io/v2/raindrop/123/file",
    file: { name: "paper.pdf", size: 3 },
  };
  const calls = [];
  await downloadOriginal(
    uploaded,
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (calls.length === 1)
        return new Response(null, {
          status: 303,
          headers: {
            location:
              "https://s3.eu-central-1.amazonaws.com/up.raindrop.io/raindrop/files/123/paper.pdf?signed=capability",
          },
        });
      return new Response("pdf");
    },
    "private-token",
  );
  assert.equal(
    calls[0].url,
    "https://api.raindrop.io/rest/v1/raindrop/123/cache",
  );
  assert.equal(calls[0].init.headers.authorization, "Bearer private-token");
  assert.equal(calls[1].init.headers, undefined);
});

test("existing library CLI imports a large source list in bounded batches", async () => {
  const dir = await mkdtemp(join(tmpdir(), "valise-raindrop-test-"));
  const batches = [];
  const server = createServer(async (req, res) => {
    assert.equal(req.url, "/library/import/sources");
    assert.equal(req.headers.authorization, "Bearer test-only");
    let body = "";
    for await (const chunk of req) body += chunk;
    const { sources } = JSON.parse(body);
    batches.push(sources.length);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ imported: sources.length, existing: 0 }));
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await writeFile(
      join(dir, "manifest.json"),
      JSON.stringify({
        format: "valise-library",
        version: 1,
        assets: [],
        sources: Array.from({ length: 25 }, (_, id) => ({ id })),
      }),
    );
    const child = spawn(
      process.execPath,
      [
        "scripts/library.mjs",
        "import",
        `http://127.0.0.1:${server.address().port}`,
        dir,
      ],
      { env: { ...process.env, VALISE_LIBRARY_TOKEN: "test-only" } },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    assert.equal(
      await new Promise((resolve) => child.on("close", resolve)),
      0,
      output,
    );
    assert.deepEqual(batches, [10, 10, 5]);
    assert.match(output, /sources: 25 imported/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await rm(dir, { recursive: true, force: true });
  }
});
