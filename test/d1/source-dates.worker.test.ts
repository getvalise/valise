import { env } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { exportManifest, importSources } from "~/concepts/library";
import { readSource, saveSource } from "~/concepts/sources";

const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_articles",
    "source_revision_assets",
    "source_revisions",
    "sources",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

it("carries each revision's publication time through a portable export and import", async () => {
  const saved = await saveSource(
    env,
    {
      kind: "bookmark",
      title: "@petrel: dawn count",
      url: "https://x.example/petrel/status/3",
      notes: "Forty petrels at dawn.",
      published: 1_791_794_400,
    },
    provenance,
  );
  const cleared = await saveSource(
    env,
    { sourceId: saved.sourceId, expectedRevision: 1, published: null },
    provenance,
  );
  expect(cleared.published).toBeNull();
  const manifest = await exportManifest(env.DB, "local");
  expect(
    manifest.sources[0].revisions.map((revision) => revision.published_at),
  ).toEqual([1_791_794_400, null]);

  await env.DB.prepare("DELETE FROM source_revisions").run();
  await env.DB.prepare("DELETE FROM sources").run();
  const edited = {
    ...manifest.sources[0],
    revisions: manifest.sources[0].revisions.map((revision) => ({
      ...revision,
      published_at: revision.revision === 2 ? 1_791_800_000 : "yesterday",
    })),
  };
  await importSources(env.DB, "local", [
    edited as unknown as (typeof manifest.sources)[number],
  ]);
  expect((await readSource(env.DB, "local", saved.sourceId))?.published).toBe(
    1_791_800_000,
  );
  const { results } = await env.DB.prepare(
    "SELECT published_at AS publishedAt FROM source_revisions ORDER BY revision",
  ).all();
  expect(results).toEqual([
    { publishedAt: null },
    { publishedAt: 1_791_800_000 },
  ]);
});
