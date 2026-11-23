import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { action, loader } from "~/routes/library";
import { loader as archiveLoader } from "~/routes/library-archive";
import {
  action as readAction,
  loader as readLoader,
} from "~/routes/library-read";
import { loader as readFileLoader } from "~/routes/library-read-file";

const settings = {
  ...env,
  SESSION_SECRET: "tenant-store-library-pages-secret",
  TOKEN_PEPPER: "local-test-token-pepper",
};
const OWNER = "local";
const OTHER = "usr_library_pages_other";
const THEIR_ASSET = "ast_00000000-0000-4000-8000-0000000000d1";
const THEIR_SOURCE = "src_00000000-0000-4000-8000-0000000000d1";

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, display_name, created_at, email_verified)
       VALUES (?, ?, unixepoch(), 1)`,
    ).bind(OTHER, OTHER),
    env.DB.prepare(
      `INSERT INTO objects (object_id, user_id, r2_key, name, content_type, size, sha256, created_at)
       VALUES ('obj_d1', ?, 'fixture/obj_d1', 'page.html', 'text/html', 5, 'fixture-sha', 1)`,
    ).bind(OTHER),
    env.DB.prepare(
      `INSERT INTO assets (asset_id, user_id, state, object_id, title, file_name, content_type,
         declared_size, tags_json, source_agent, source_client, created_at, updated_at, finalized_at)
       VALUES (?, ?, 'ready', 'obj_d1', 'Member archived page', 'page.html', 'text/html', 5, '[]',
         'fixture', 'test', 1, 1, 1)`,
    ).bind(THEIR_ASSET, OTHER),
    // Inserting an asset gives it a folder of its own; name that folder.
    env.DB.prepare(
      "UPDATE asset_folders SET title = 'Member folder' WHERE folder_id = ?",
    ).bind(THEIR_ASSET),
    env.DB.prepare(
      `INSERT INTO sources (source_id, user_id, kind, title, notes, tags_json,
         revision, source_agent, source_client, created_at, updated_at)
       VALUES (?, ?, 'bookmark', 'Member bookmark', 'Member notes', '[]', 1, 'fixture', 'test', 1, 1)`,
    ).bind(THEIR_SOURCE, OTHER),
    env.DB.prepare(
      `INSERT INTO source_revisions (revision_id, source_id, revision, kind, title, notes, tags_json,
         source_agent, source_client, created_at)
       VALUES ('rev_d1', ?, 1, 'bookmark', 'Member bookmark', 'Member notes', '[]', 'fixture', 'test', 1)`,
    ).bind(THEIR_SOURCE),
  ]);
});

afterEach(async () => {
  for (const table of [
    "library_ratings",
    "library_use_events",
    "asset_folder_files",
    "asset_folders",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
    "search_docs",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

async function requestFor(
  userId: string,
  path: string,
  init: RequestInit = {},
) {
  const url = `https://valise.test${path}${path.includes("?") ? "&" : "?"}userId=${OTHER}`;
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, {
    ...init,
    headers: {
      cookie,
      "x-valise-user": OTHER,
      origin: "https://valise.test",
      ...(init.headers ?? {}),
    },
  });
}

function args<P extends Record<string, string>>(
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

const post = async (fields: Record<string, string>) =>
  requestFor(OWNER, "/library", {
    method: "POST",
    body: new URLSearchParams(fields),
  });

describe("library pages on the tenant store", () => {
  it("lists, details and history show nothing of another tenant's library", async () => {
    const page = await loader(
      args(
        await requestFor(
          OWNER,
          `/library?details=source:${THEIR_SOURCE}&history=source:${THEIR_SOURCE}&processing=asset:${THEIR_ASSET}`,
        ),
      ),
    );
    expect(page.sources).toEqual([]);
    expect(page.assets).toEqual([]);
    expect(page.openArticle).toBeNull();
    expect(page.openEnrichment).toBeNull();
    expect(page.selectedAsset).toBeNull();
    expect(page.processingAsset).toBeNull();
    expect(page.processingUnavailable).toBe(true);
    expect(page.history?.revisions).toEqual([]);
    const theirs = await loader(args(await requestFor(OTHER, "/library")));
    expect(theirs.sources.map((s) => s.title)).toEqual(["Member bookmark"]);
  });

  it("refuses every write to another tenant's file, folder and bookmark", async () => {
    const writes: Record<string, string>[] = [
      { intent: "asset-archive", id: `asset:${THEIR_ASSET}` },
      { intent: "asset-delete", id: `asset:${THEIR_ASSET}` },
      { intent: "source-archive", id: `source:${THEIR_SOURCE}` },
      { intent: "source-delete", id: `source:${THEIR_SOURCE}` },
      {
        intent: "source-tag-dismiss",
        id: `source:${THEIR_SOURCE}`,
        enrichment: "enr_x",
        tag: "x",
      },
    ];
    for (const fields of writes) {
      const outcome = await action(args(await post(fields))).catch(
        (thrown: unknown) => thrown,
      );
      expect(outcome, fields.intent).toMatchObject({ status: 404 });
    }
    const renamed = await action(
      args(
        await post({
          intent: "folder-name",
          id: `asset:${THEIR_ASSET}`,
          value: "stolen",
        }),
      ),
    );
    expect(renamed).toMatchObject({ init: { status: 404 } });
    const edited = await action(
      args(
        await post({
          intent: "source-field",
          id: `source:${THEIR_SOURCE}`,
          field: "title",
          value: "stolen",
          revision: "1",
        }),
      ),
    );
    expect(edited).toMatchObject({ init: { status: 409 } });
    const intoTheirFolder = await action(
      args(
        await requestFor(OWNER, "/library", {
          method: "POST",
          body: (() => {
            const form = new FormData();
            form.set("intent", "upload");
            form.set("folderId", THEIR_ASSET);
            form.set("file", new File(["x"], "x.txt", { type: "text/plain" }));
            return form;
          })(),
        }),
      ),
    );
    expect(intoTheirFolder).toMatchObject({ init: { status: 404 } });

    expect(
      await env.DB.prepare(
        "SELECT title, archived_at FROM sources WHERE source_id = ?",
      )
        .bind(THEIR_SOURCE)
        .first(),
    ).toEqual({ title: "Member bookmark", archived_at: null });
    expect(
      await env.DB.prepare("SELECT archived_at FROM assets WHERE asset_id = ?")
        .bind(THEIR_ASSET)
        .first("archived_at"),
    ).toBeNull();
    expect(
      await env.DB.prepare(
        "SELECT title FROM asset_folders WHERE folder_id = ?",
      )
        .bind(THEIR_ASSET)
        .first("title"),
    ).toBe("Member folder");
    expect(
      await env.DB.prepare("SELECT COUNT(*) AS n FROM assets WHERE user_id = ?")
        .bind(OWNER)
        .first("n"),
    ).toBe(0);
  });

  it("answers 404 for another tenant's bookmark, file and archive in the reader", async () => {
    await expect(
      readLoader(
        args(await requestFor(OWNER, `/library/read/${THEIR_SOURCE}`), {
          sourceId: THEIR_SOURCE,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readAction(
        args(
          await requestFor(OWNER, `/library/read/${THEIR_SOURCE}`, {
            method: "POST",
            body: new URLSearchParams({ stars: "3" }),
          }),
          { sourceId: THEIR_SOURCE },
        ),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      readFileLoader(
        args(await requestFor(OWNER, `/library/read-file/${THEIR_ASSET}`), {
          assetId: THEIR_ASSET,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    await expect(
      archiveLoader(
        args(await requestFor(OWNER, `/library/archive/${THEIR_ASSET}`), {
          assetId: THEIR_ASSET,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
    // The owner of the archive gets its signed view.
    const view = await archiveLoader(
      args(await requestFor(OTHER, `/library/archive/${THEIR_ASSET}`), {
        assetId: THEIR_ASSET,
      }),
    );
    expect(view.status).toBe(303);
    expect(
      await env.DB.prepare(
        "SELECT COUNT(*) AS n FROM library_use_events",
      ).first("n"),
    ).toBe(0);
  });
});
