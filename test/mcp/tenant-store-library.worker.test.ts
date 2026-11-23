import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import {
  action as processAction,
  loader as processLoader,
} from "~/routes/asset-process";
import { loader as documentsLoader } from "~/routes/library.documents";
import { loader as authorLoader } from "~/routes/library-author";
import { loader as authorsLoader } from "~/routes/library-authors";
import { requireBrowserStore } from "~/store/tenant.server";

const settings = { ...env, SESSION_SECRET: "tenant-store-library-secret" };
const OWNER = "local";
const OTHER = "usr_store_library_other";
const MINE = "ast_00000000-0000-4000-8000-00000000000a";
const THEIRS = "ast_00000000-0000-4000-8000-00000000000b";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, display_name, created_at, email_verified)
       VALUES (?, ?, unixepoch(), 1)`,
    ).bind(OTHER, OTHER),
    ...[
      [MINE, OWNER, "Owner field notes"],
      [THEIRS, OTHER, "Member field notes"],
    ].flatMap(([asset, userId, title]) => {
      const object = asset.replace("ast_", "obj_");
      return [
        env.DB.prepare(
          `INSERT INTO objects (object_id, user_id, r2_key, name, content_type, size, sha256, created_at)
           VALUES (?, ?, ?, 'notes.txt', 'text/plain', 5, 'fixture-sha', 1)`,
        ).bind(object, userId, `fixture/${object}`),
        env.DB.prepare(
          `INSERT INTO assets (asset_id, user_id, state, object_id, title, file_name, content_type,
             declared_size, tags_json, source_agent, source_client, created_at, updated_at)
           VALUES (?, ?, 'ready', ?, ?, 'notes.txt', 'text/plain', 5, '[]', 'fixture', 'test', 1, 1)`,
        ).bind(asset, userId, object, title),
      ];
    }),
    ...[
      [OWNER, "src_00000000-0000-4000-8000-00000000000a", "Ada Owner"],
      [OTHER, "src_00000000-0000-4000-8000-00000000000b", "Grace Member"],
    ].map(([userId, source, author]) =>
      env.DB.prepare(
        `INSERT INTO sources (source_id, user_id, kind, title, notes, tags_json, authors_json,
           revision, source_agent, source_client, created_at, updated_at)
         VALUES (?, ?, 'bookmark', ?, '', '[]', ?, 1, 'fixture', 'test', 1, 1)`,
      ).bind(source, userId, `${author} essay`, JSON.stringify([author])),
    ),
  ]);
});

afterEach(async () => {
  for (const table of [
    "asset_processing_outputs",
    "asset_processing_heads",
    "asset_processing_admissions",
    "asset_processing",
    "assets",
    "objects",
    "sources",
    "search_docs",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

async function requestFor(userId: string, path: string) {
  // Routing hints in the URL and headers must not choose the tenant.
  const url = `https://valise.test${path}${path.includes("?") ? "&" : "?"}userId=local&shard=other`;
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, { headers: { cookie, "x-valise-user": "local" } });
}

async function browser(userId: string) {
  return (await requireBrowserStore(settings, await requestFor(userId, "/")))
    .store;
}

function consoleArgs<P extends Record<string, string>>(
  request: Request,
  params: P = {} as P,
) {
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  return {
    context,
    request,
    url: new URL(request.url),
    params,
    pattern: new URL(request.url).pathname,
  };
}

describe("tenant-bound library files and authors", () => {
  it("binds file reads, pages, folders, text, processing and authors to one owner", async () => {
    const owner = await browser(OWNER);

    expect(await owner.library.asset(THEIRS)).toBeNull();
    expect((await owner.library.asset(MINE))?.title).toBe("Owner field notes");
    expect(
      (await owner.library.assets([MINE, THEIRS])).map((a) => a.assetId),
    ).toEqual([MINE]);
    expect(
      (await owner.library.assetsPage(false)).items.map((a) => a.assetId),
    ).toEqual([MINE]);
    expect(
      (await owner.library.folders(false)).items.map((f) => f.assetId),
    ).not.toContain(THEIRS);
    expect(await owner.library.assetText(THEIRS)).toBeNull();
    expect(await owner.library.processing(THEIRS)).toBeNull();
    expect((await owner.library.authors()).map((a) => a.name)).toEqual([
      "Ada Owner",
    ]);
    expect(await owner.library.author("grace-member")).toBeNull();
    expect(await owner.library.author("ada-owner")).not.toBeNull();
  });

  it("refuses to queue processing or decide suggestions on another tenant's file", async () => {
    const owner = await browser(OWNER);
    await expect(owner.library.queueProcessing(THEIRS, true)).rejects.toThrow(
      /unavailable/,
    );
    for (const decide of [
      () => owner.library.acceptSuggestion(THEIRS, "out_fixture", "title", "x"),
      () =>
        owner.library.dismissSuggestion(THEIRS, "out_fixture", "title", "x"),
    ])
      await expect(decide()).rejects.toThrow();
    expect(
      await env.DB.prepare("SELECT title FROM assets WHERE asset_id = ?")
        .bind(THEIRS)
        .first("title"),
    ).toBe("Member field notes");
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM asset_processing WHERE asset_id = ?",
      )
        .bind(THEIRS)
        .first("n"),
    ).toBe(0);
  });

  it("answers 404 for another tenant's file on the processing page and its actions", async () => {
    const path = `/library/${THEIRS}/process`;
    await expect(
      processLoader(
        consoleArgs(await requestFor(OWNER, path), { assetId: THEIRS }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    const authenticated = await requestFor(OWNER, path);
    const url = new URL(authenticated.url);
    const post = new Request(url, {
      method: "POST",
      headers: {
        ...Object.fromEntries(authenticated.headers),
        origin: url.origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({ intent: "process" }),
    });
    await expect(
      processAction(consoleArgs(post, { assetId: THEIRS })),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await processLoader(
        consoleArgs(await requestFor(OTHER, path), { assetId: THEIRS }),
      ),
    ).toMatchObject({ asset: { assetId: THEIRS } });
  });

  it("lists only the session's documents and authors in the library pickers and pages", async () => {
    const documents = await documentsLoader(
      consoleArgs(await requestFor(OTHER, "/library/documents")),
    );
    expect(documents.options.map((option) => option.label)).toEqual([
      "Member field notes",
    ]);
    expect(
      (
        await authorsLoader(
          consoleArgs(await requestFor(OTHER, "/library/authors")),
        )
      ).authors.map((author) => author.name),
    ).toEqual(["Grace Member"]);
    await expect(
      authorLoader(
        consoleArgs(await requestFor(OTHER, "/library/authors/ada-owner"), {
          slug: "ada-owner",
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
