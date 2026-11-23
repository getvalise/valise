import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import { listAssetsPage } from "~/concepts/assets";
import { linkedImportBackups } from "~/concepts/library";
import { LIBRARY_PAGE_SIZE } from "~/concepts/library-page";
import {
  listSourceRevisions,
  listSources,
  listSourcesPage,
  readSource,
} from "~/concepts/sources";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { loader } from "~/routes/library";

const owner = "library-scale-owner";
const other = "library-scale-other";

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    "search_docs",
    "source_articles",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  for (const table of ["sessions", "users"])
    await env.DB.prepare(`DELETE FROM ${table} WHERE user_id IN (?, ?)`)
      .bind(owner, other)
      .run();
});

async function seed() {
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO users (user_id,email,display_name,role,created_at,email_verified)
      VALUES (?, 'scale-owner@example.test','Scale owner','member',1,1),
             (?, 'scale-other@example.test','Scale other','member',1,1)`).bind(
      owner,
      other,
    ),
    env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<61)
      INSERT INTO objects (object_id,user_id,r2_key,name,content_type,size,sha256,created_at)
      SELECT printf('obj_%08x-0000-4000-8000-%012x',x,x),?,printf('scale/%d',x),'snapshot.json','application/json',2,'fixture-sha',1 FROM n`).bind(
      owner,
    ),
    env.DB.prepare(`INSERT INTO assets (asset_id,user_id,state,object_id,title,file_name,content_type,declared_size,
      project,tags_json,source_agent,source_client,created_at,updated_at,expires_at)
      SELECT replace(object_id,'obj_','ast_'),user_id,'ready',object_id,'Snapshot '||substr(object_id,5,8),name,content_type,size,
      'scale','["shared","scale"]','fixture','test',1,1,CASE WHEN substr(object_id,5,8)='0000003d' THEN 1 ELSE NULL END FROM objects`),
    env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<894)
      INSERT INTO sources (source_id,user_id,kind,title,url,notes,project,tags_json,revision,
      source_agent,source_client,created_at,updated_at)
      SELECT printf('src_%08x-0000-4000-8000-%012x',x,x),?,'bookmark','Bookmark '||x,'https://example.test/'||x,
      'Full notes and highlights '||x,CASE WHEN x=0 THEN 'rare-project' ELSE 'scale' END,
      CASE WHEN x=0 THEN '["shared","rare"]' ELSE '["shared","scale"]' END,1,'fixture','test',1000+(x/5),1000 FROM n`).bind(
      owner,
    ),
    env.DB.prepare(`INSERT INTO source_revisions (revision_id,source_id,revision,kind,title,url,notes,project,tags_json,source_agent,source_client,created_at)
      SELECT 'revision-'||source_id,source_id,revision,kind,title,url,notes,project,tags_json,source_agent,source_client,created_at FROM sources`),
    env.DB.prepare(`INSERT INTO source_revision_assets (source_id,revision,asset_id,position)
      SELECT source_id,revision,'ast_00000000-0000-4000-8000-000000000000',0 FROM sources`),
    env.DB.prepare(`INSERT INTO sources (source_id,user_id,kind,title,url,notes,tags_json,revision,source_agent,source_client,created_at,updated_at)
      VALUES ('src_ffffffff-0000-4000-8000-ffffffffffff',?,'bookmark','Other private source','https://private.test','Private notes','["rare"]',1,'fixture','test',9999,9999)`).bind(
      other,
    ),
  ]);
}

it("hydrates all 895 linked sources in two database calls, not 2,687 individual reads", async () => {
  await seed();
  const query = vi.spyOn(env.DB, "prepare");
  const rows = await listSources(env.DB, owner, false);
  expect(rows).toHaveLength(895);
  expect(query).toHaveBeenCalledTimes(2);
  expect(rows[0].assets).toEqual([
    expect.objectContaining({
      title: "Snapshot 00000000",
      available: true,
      size: 2,
    }),
  ]);
  expect(rows[894].notes).toBe("Full notes and highlights 0");
});

it("walks fixed keyset pages without dropping timestamp ties, duplicates, or fetching another tenant", async () => {
  await seed();
  const seen: string[] = [];
  let after: string | undefined;
  do {
    const query = vi.spyOn(env.DB, "prepare");
    query.mockClear();
    const page = await listSourcesPage(env.DB, owner, false, { after });
    expect(page.items.length).toBeLessThanOrEqual(LIBRARY_PAGE_SIZE);
    expect(query).toHaveBeenCalledTimes(2);
    seen.push(...page.items.map((row) => row.sourceId));
    after = page.next ?? undefined;
  } while (after);
  expect(seen).toHaveLength(895);
  expect(new Set(seen).size).toBe(895);
  expect(seen[0]).toContain("0000037e");
  expect(seen.at(-1)).toContain("00000000");
});

it("walks pages newest published first, with ties, article dates and undated sources last", async () => {
  await seed();
  // A third dated by the saver, in ties of five; a few by their article only.
  await env.DB.prepare(
    "UPDATE sources SET published_at = 1700000000 + (rowid / 5) * 60 WHERE user_id = ? AND rowid % 3 = 0",
  )
    .bind(owner)
    .run();
  await env.DB.prepare(
    `INSERT INTO source_articles (source_id, revision, user_id, detected, markdown, text,
       truncated, word_count, page_word_count, extractor, published, created_at)
     SELECT source_id, revision, user_id, 1, 'a', 'a', 0, 1, 1, 'fixture',
       '2030-01-0'||(rowid % 9 + 1), created_at
       FROM sources WHERE user_id = ? AND rowid % 3 = 1 AND rowid < 40`,
  )
    .bind(owner)
    .run();
  const seen: { id: string; published: number | null }[] = [];
  let after: string | undefined;
  do {
    const page = await listSourcesPage(env.DB, owner, false, {
      after,
      sort: "published",
    });
    seen.push(
      ...page.items.map((row) => ({
        id: row.sourceId,
        published: row.published,
      })),
    );
    after = page.next ?? undefined;
  } while (after);
  expect(seen).toHaveLength(895);
  expect(new Set(seen.map((row) => row.id)).size).toBe(895);
  const keys = seen.map((row) => row.published ?? 0);
  expect(keys).toEqual([...keys].sort((a, b) => b - a));
  // Article dates are the newest, so they lead.
  expect(seen[0].published).toBeGreaterThanOrEqual(
    Date.parse("2030-01-01") / 1000,
  );
  const dated = seen.filter((row) => row.published !== null).length;
  expect(seen.slice(dated).every((row) => row.published === null)).toBe(true);
  expect(dated).toBeGreaterThan(290);
});

it("applies project/all-tag/archive filters before the page limit and refuses malformed cursors", async () => {
  await seed();
  const rare = await listSourcesPage(env.DB, owner, false, {
    project: "rare-project",
    tags: ["shared", "rare"],
  });
  expect(rare.items.map((row) => row.title)).toEqual(["Bookmark 0"]);
  expect(rare.next).toBeNull();
  expect(
    (await listSourcesPage(env.DB, owner, false, { tags: ["scale", "rare"] }))
      .items,
  ).toEqual([]);
  await env.DB.prepare(
    "UPDATE sources SET archived_at=1 WHERE user_id=? AND project='rare-project'",
  )
    .bind(owner)
    .run();
  expect(
    (await listSourcesPage(env.DB, owner, false, { tags: ["rare"] })).items,
  ).toEqual([]);
  expect(
    (await listSourcesPage(env.DB, owner, true)).items.map((row) => row.title),
  ).toEqual(["Bookmark 0"]);
  await expect(
    listSourcesPage(env.DB, owner, false, { after: "not-a-cursor" }),
  ).rejects.toMatchObject({ status: 400 });
});

it("joins only current links, retaining unavailable placeholders without disclosing another owner's metadata", async () => {
  await seed();
  const id = "src_00000000-0000-4000-8000-000000000000";
  await env.DB.batch([
    env.DB.prepare("UPDATE sources SET revision=2 WHERE source_id=?").bind(id),
    env.DB.prepare(
      `UPDATE assets SET user_id=? WHERE asset_id='ast_00000001-0000-4000-8000-000000000001'`,
    ).bind(other),
    ...[1, 61, 2].map((x, position) =>
      env.DB.prepare(`INSERT INTO source_revision_assets(source_id,revision,asset_id,position)
      VALUES (?,2,printf('ast_%08x-0000-4000-8000-%012x',?,?),?)`).bind(
        id,
        x,
        x,
        position,
      ),
    ),
  ]);
  const page = await listSourcesPage(env.DB, owner, false, {
    project: "rare-project",
  });
  const expected = await readSource(env.DB, owner, id);
  expect(page.items[0]).toEqual(expected);
  expect(page.items[0].assets.map((a) => [a.available, a.title])).toEqual([
    [false, ""],
    [false, ""],
    [true, "Snapshot 00000002"],
  ]);
});

it("bounds files and durable linking choices independently and keeps their visibility predicates", async () => {
  await seed();
  const first = await listAssetsPage(env.DB, owner, false, {
    project: "scale",
    tags: ["shared"],
  });
  expect(first.items).toHaveLength(30);
  const second = await listAssetsPage(env.DB, owner, false, {
    after: first.next ?? undefined,
    durableOnly: true,
  });
  expect(second.items).toHaveLength(30);
  expect(second.items.every((asset) => asset.expiresAt === null)).toBe(true);
  const last = await listAssetsPage(env.DB, owner, false, {
    after: second.next ?? undefined,
  });
  expect(last.items).toHaveLength(1);
  expect(last.next).toBeNull();
  expect(
    new Set(
      [...first.items, ...second.items, ...last.items].map(
        (asset) => asset.assetId,
      ),
    ).size,
  ).toBe(61);
});

it("loads a signed-in 895-source Library with bounded cards, processing reads and query count", async () => {
  await seed();
  const settings = { ...env, SESSION_SECRET: "library-scale-session-secret" };
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  const url = new URL("https://valise.test/library");
  const cookie = await createSessionCookie(settings, new Request(url), owner);
  const query = vi.spyOn(env.DB, "prepare");
  const page = await loader({
    context,
    request: new Request(url, { headers: { cookie } }),
    params: {},
    url,
    pattern: "/library",
  });
  expect(page.sources).toHaveLength(30);
  expect(page.assets).toHaveLength(30);
  expect(page.linkable).toHaveLength(0);
  expect(Object.keys(page.processing)).toHaveLength(30);
  expect(query.mock.calls.length).toBeLessThan(20);
  expect(page.nextSources).toBeTruthy();
  expect(page.nextFiles).toBeTruthy();
  expect(page.nextLinks).toBeNull();
  expect(JSON.stringify(page).length).toBeLessThan(100_000);
  const attachUrl = new URL("https://valise.test/library?attach=new");
  const attach = await loader({
    context,
    request: new Request(attachUrl, { headers: { cookie } }),
    params: {},
    url: attachUrl,
    pattern: "/library",
  });
  expect(attach.linkable).toHaveLength(30);
  expect(attach.nextLinks).toBeTruthy();
});

it("loads only excerpts until a source is opened, while filtering and authoritative exports retain full notes", async () => {
  await seed();
  const id = "src_00000000-0000-4000-8000-000000000000";
  const notes = `${"Detailed saved passage ".repeat(2000)}needle-at-the-end`;
  await env.DB.prepare("UPDATE sources SET notes=? WHERE source_id=?")
    .bind(notes, id)
    .run();
  const compact = await listSourcesPage(env.DB, owner, false, {
    query: "needle-at-the-end",
  });
  expect(compact.items).toHaveLength(1);
  expect(compact.items[0].notes).toHaveLength(400);
  expect(
    (
      await listSourcesPage(env.DB, owner, false, {
        query: "needle-at-the-end",
        fullNotesFor: id,
      })
    ).items[0].notes,
  ).toBe(notes);
  expect((await readSource(env.DB, owner, id))?.notes).toBe(notes);
  expect(
    (await listSources(env.DB, owner, false)).find((row) => row.sourceId === id)
      ?.notes,
  ).toBe(notes);
  await env.DB.prepare(`WITH RECURSIVE n(x) AS (VALUES(2) UNION ALL SELECT x+1 FROM n WHERE x<16)
    INSERT INTO source_revisions(revision_id,source_id,revision,kind,title,notes,source_agent,source_client,created_at)
    SELECT 'history-'||x,?,x,'bookmark','Earlier title '||x,'Earlier note '||x,'fixture','test',x FROM n`)
    .bind(id)
    .run();
  expect(
    (await listSourceRevisions(env.DB, owner, id, 10)).map(
      (row) => row.revision,
    ),
  ).toEqual([16, 15, 14, 13, 12, 11, 10, 9, 8, 7]);
  expect(await listSourceRevisions(env.DB, other, id, 10)).toEqual([]);
});

it("does not mistake an ordinary JSON document or another owner's receipt for an import backup", async () => {
  await seed();
  const backup = "ast_00000000-0000-4000-8000-000000000000";
  const ordinary = "ast_00000001-0000-4000-8000-000000000001";
  const foreign = "ast_00000002-0000-4000-8000-000000000002";
  await env.DB.batch([
    env.DB.prepare(
      "UPDATE assets SET source_agent='raindrop-import',tags_json='[\"import-snapshot\"]' WHERE asset_id IN (?, ?)",
    ).bind(backup, foreign),
    env.DB.prepare("UPDATE assets SET user_id=? WHERE asset_id=?").bind(
      other,
      foreign,
    ),
  ]);
  expect(
    await linkedImportBackups(env.DB, owner, [backup, ordinary, foreign]),
  ).toEqual([backup]);
  const choices = await listAssetsPage(env.DB, owner, false, {
    durableOnly: true,
  });
  expect(choices.items.map((asset) => asset.assetId)).not.toContain(backup);
});
