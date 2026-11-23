import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { action, loader } from "~/routes/memories";
import { requireAdminStore } from "~/store/admin.server";
import { tenantStorage } from "~/store/routing.server";
import { mcpTenantStore, requireBrowserStore } from "~/store/tenant.server";

const settings = { ...env, SESSION_SECRET: "tenant-store-test-secret" };
const OTHER = "usr_store_other";
const PENDING = "usr_store_pending";
const input = (title: string) => ({
  title,
  type: "insight",
  body: `Evidence for ${title}`,
  project: title,
  tags: [`owner:${title}`],
});

beforeEach(async () => {
  for (const [id, verified] of [
    [OTHER, 1],
    [PENDING, 0],
  ] as const) {
    await env.DB.prepare(
      `INSERT INTO users (user_id, display_name, created_at, email_verified)
       VALUES (?, ?, unixepoch(), ?)`,
    )
      .bind(id, id, verified)
      .run();
  }
});

afterEach(async () => {
  for (const table of [
    "memory_attachments",
    "objects",
    "memory_links",
    "memory_revisions",
    "search_docs",
    "vector_pending",
    "memories",
    "mcp_calls",
    "sessions",
    "invites",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id IN (?, ?)")
    .bind(OTHER, PENDING)
    .run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

async function requestFor(userId: string) {
  const url = "https://valise.test/memories?userId=local&shard=other";
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, {
    headers: { cookie, "x-valise-user": "local" },
  });
}

async function browser(userId: string) {
  return requireBrowserStore(settings, await requestFor(userId));
}

function bare(id: string) {
  return id.slice("memory:".length);
}

describe("tenant-bound store", () => {
  it("requires an admitted session and ignores caller routing hints", async () => {
    await expect(
      requireBrowserStore(
        settings,
        new Request("https://valise.test/memories"),
      ),
    ).rejects.toMatchObject({ status: 302 });
    await expect(browser(PENDING)).rejects.toMatchObject({ status: 302 });
    await expect(browser("usr_missing")).rejects.toMatchObject({ status: 302 });
    expect(() => tenantStorage(env, { userId: "" })).toThrow(/principal/);
    expect(() => tenantStorage(env, { userId: " local" })).toThrow(/principal/);

    const { user, provenance, store } = await browser(OTHER);
    expect(user.userId).toBe(OTHER);
    expect(provenance.userId).toBe(OTHER);
    expect(store.storage).toBe("shared-primary");
    expect(store).not.toHaveProperty("DB");
    expect(store).not.toHaveProperty("admin");
    expect(Object.isFrozen(store)).toBe(true);
    expect(Object.isFrozen(store.memories)).toBe(true);

    // Even mutating the returned identity cannot repoint an already-bound store.
    user.userId = "local";
    const saved = await store.memories.save(input("member"));
    expect(
      await env.DB.prepare("SELECT user_id FROM memories WHERE memory_id = ?")
        .bind(bare(saved.id))
        .first("user_id"),
    ).toBe(OTHER);
  });

  it("binds search, lists, counts, history, facets and vocabulary to one owner", async () => {
    const { store: owner } = await browser("local");
    const { store: other } = await browser(OTHER);
    const mine = await owner.memories.save(input("mine"));
    const theirs = await other.memories.save(input("theirs"));
    await other.memories.edit(bare(theirs.id), { body: "Changed evidence" });

    expect(await owner.memories.count()).toBe(1);
    expect((await owner.memories.list()).map((row) => row.id)).toEqual([
      mine.id,
    ]);
    expect(await owner.memories.get(bare(theirs.id))).toBeNull();
    expect(await owner.memories.revisions(bare(theirs.id))).toEqual([]);
    expect(await other.memories.revisions(bare(theirs.id))).toHaveLength(1);
    expect(await owner.memories.types()).toEqual([
      { type: "insight", count: 1 },
    ]);
    expect(await owner.vocabulary()).toEqual({
      projects: ["mine"],
      tags: ["owner:mine"],
    });
    expect(await owner.facets("memory")).toEqual([
      { key: "owner", value: "mine", tag: "owner:mine", count: 1 },
    ]);
    expect(await owner.search({ query: "theirs" })).toEqual([]);
    // A runtime caller cannot smuggle the legacy owner field through the API.
    const forged = { query: "theirs", userId: OTHER };
    expect(await owner.search(forged)).toEqual([]);
    expect(await other.search({ query: "theirs" })).toMatchObject([
      { docKey: theirs.id },
    ]);
    expect(
      await owner.memories.edit(bare(theirs.id), { title: "stolen" }),
    ).toBeNull();
    expect(await owner.memories.archive(bare(theirs.id))).toBe(false);
    expect(await other.memories.get(bare(theirs.id))).toMatchObject({
      title: "theirs",
    });
  });

  it("keeps the selected binding even if the caller later changes its environment", async () => {
    const mutable = { ...settings };
    const { store } = await requireBrowserStore(
      mutable,
      await requestFor(OTHER),
    );
    mutable.DB = new Proxy(env.DB, {
      get() {
        throw new Error("An existing store must not resolve a different DB.");
      },
    });
    await store.memories.save(input("captured"));
    expect(await store.memories.count()).toBe(1);
  });

  it("uses the bound store in the console loader and mutation adapter", async () => {
    const { store: owner } = await browser("local");
    const { store: other } = await browser(OTHER);
    const mine = await owner.memories.save(input("private"));
    await other.memories.save(input("member"));
    await owner.memories.edit(bare(mine.id), { body: "Owner revision" });
    const context = new RouterContextProvider();
    context.set(consoleContext, {
      env: settings,
      ctx: createExecutionContext(),
    });
    const authenticated = await requestFor(OTHER);
    const url = new URL(authenticated.url);
    url.searchParams.set("open", mine.id);
    const request = new Request(url, { headers: authenticated.headers });
    const args = { context, request, url, params: {}, pattern: "/memories" };
    expect(await loader(args)).toMatchObject({
      tab: "all",
      list: {
        detail: null,
        links: [],
        files: [],
        revisions: [],
        memories: [{ title: "member" }],
        vocabulary: { projects: ["member"] },
      },
    });
    const write = new Request(url, {
      method: "POST",
      headers: {
        ...Object.fromEntries(authenticated.headers),
        origin: url.origin,
      },
      body: new URLSearchParams({
        id: mine.id,
        field: "title",
        value: "stolen",
      }),
    });
    await expect(action({ ...args, request: write })).rejects.toMatchObject({
      status: 404,
    });
    expect(await owner.memories.get(bare(mine.id))).toMatchObject({
      title: "private",
    });
  });

  it("keeps P11 archive receipts, errors and document redirects through the bound adapter", async () => {
    const { store: owner } = await browser("local");
    const memory = await owner.memories.save(input("archive"));
    const context = new RouterContextProvider();
    context.set(consoleContext, {
      env: settings,
      ctx: createExecutionContext(),
    });
    async function archive(userId: string, via = "") {
      const authenticated = await requestFor(userId);
      const url = new URL(authenticated.url);
      const request = new Request(url, {
        method: "POST",
        headers: {
          ...Object.fromEntries(authenticated.headers),
          origin: url.origin,
        },
        body: new URLSearchParams({ id: memory.id, intent: "archive", via }),
      });
      return action({
        context,
        request,
        url,
        params: {},
        pattern: "/memories",
      });
    }

    expect(await archive(OTHER, "fetcher")).toMatchObject({
      data: { archiveError: "Memory not found. No memory was archived." },
      init: { status: 404 },
    });
    expect(await owner.memories.get(bare(memory.id))).not.toBeNull();
    expect(await archive("local", "fetcher")).toEqual({ saved: true });
    expect(await owner.memories.get(bare(memory.id))).toBeNull();
    const document = await archive("local");
    expect(document).toBeInstanceOf(Response);
    if (!(document instanceof Response)) throw new Error("Expected redirect");
    expect(document.status).toBe(302);
    expect(document.headers.get("location")).toBe("/memories");
  });

  it("refuses foreign links before changing content or projections", async () => {
    const { store: owner } = await browser("local");
    const { store: other } = await browser(OTHER);
    const theirs = await other.memories.save(input("foreign"));
    const mine = await owner.memories.save(input("mine"));
    await expect(
      owner.memories.save({
        ...input("refused"),
        relates: [{ kind: "related", id: theirs.id }],
      }),
    ).rejects.toThrow(/no active memory/);
    await expect(
      owner.memories.edit(bare(mine.id), { title: "refused" }, [
        { kind: "related", id: theirs.id },
      ]),
    ).rejects.toThrow(/no active memory/);
    await expect(
      owner.personMemoryLinks.assert(bare(mine.id), {
        kind: "related",
        id: theirs.id,
      }),
    ).rejects.toThrow(/no active memory/);
    expect(await owner.memories.count()).toBe(1);
    expect(await owner.memories.revisions(bare(mine.id))).toEqual([]);
    expect(await owner.search({ query: "refused" })).toEqual([]);
    expect(await owner.memories.get(bare(mine.id))).toMatchObject({
      title: "mine",
    });

    // A malformed legacy link must not make a foreign parent an access path.
    await env.DB.prepare(
      `INSERT INTO memory_links (link_id, from_memory_id, to_memory_id, kind,
       asserted_by, source_agent, source_client, created_at)
       VALUES ('mln_bad', ?, ?, 'related', 'model', 'test', 'test', unixepoch())`,
    )
      .bind(...[bare(mine.id), bare(theirs.id)].sort())
      .run();
    for (const store of [owner, other]) {
      for (const id of [mine.id, theirs.id]) {
        expect(await store.memories.links(bare(id), true)).toEqual([]);
        expect(
          await store.personMemoryLinks.change(bare(id), "mln_bad", "confirm"),
        ).toBe(false);
      }
    }
    expect((await owner.memories.linkTargets(bare(theirs.id))).targets).toEqual(
      [],
    );
    expect((await other.memories.linkTargets(bare(mine.id))).targets).toEqual(
      [],
    );
  });

  it("requires owned parents and objects for child reads, attachment and reversal", async () => {
    const { store: owner } = await browser("local");
    const { store: other } = await browser(OTHER);
    const mine = await owner.memories.save(input("mine"));
    const theirs = await other.memories.save(input("theirs"));
    const file = new File(["evidence"], "proof.txt", { type: "text/plain" });
    expect(await owner.memories.attach(bare(theirs.id), file)).toBeNull();
    const attached = await owner.memories.attach(bare(mine.id), file);
    if (!attached) throw new Error("fixture upload refused");
    expect(await other.memories.attachments([bare(mine.id)])).toEqual(
      new Map(),
    );
    for (const state of [true, false]) {
      expect(
        await owner.memories.setFileAttached(
          bare(theirs.id),
          attached.objectId,
          state,
        ),
      ).toBe(false);
      expect(
        await other.memories.setFileAttached(
          bare(theirs.id),
          attached.objectId,
          state,
        ),
      ).toBe(false);
    }

    // Deliberately seed an invalid link: the reader must check the parent too.
    await env.DB.prepare(
      "INSERT INTO memory_attachments(memory_id, object_id, created_at) VALUES (?, ?, unixepoch())",
    )
      .bind(bare(theirs.id), attached.objectId)
      .run();
    expect(await owner.memories.attachments([bare(theirs.id)])).toEqual(
      new Map(),
    );
    expect(await other.memories.attachments([bare(theirs.id)])).toEqual(
      new Map(),
    );
    expect(
      await owner.memories.setFileAttached(
        bare(mine.id),
        attached.objectId,
        false,
      ),
    ).toBe(true);
    expect(
      await owner.memories.setFileAttached(
        bare(mine.id),
        attached.objectId,
        true,
      ),
    ).toBe(true);
    expect(
      (await owner.memories.attachments([bare(mine.id)])).get(bare(mine.id)),
    ).toHaveLength(1);
  });

  it("keeps cross-tenant administration behind a separate owner-session factory", async () => {
    await expect(
      requireAdminStore(settings, await requestFor(OTHER)),
    ).rejects.toMatchObject({ status: 404 });
    const { admin } = await requireAdminStore(
      settings,
      await requestFor("local"),
    );
    expect((await admin.listUsers()).map((user) => user.userId)).toContain(
      OTHER,
    );
    const forged = { label: "Friends", createdBy: OTHER };
    expect(await admin.createInvite(forged)).toMatchObject({
      createdBy: "local",
    });
    expect(admin).not.toHaveProperty("DB");
    expect(admin).not.toHaveProperty("memories");
  });

  it("builds an MCP store only from admitted provider context, never browser assertion authority", async () => {
    const ctx = createExecutionContext();
    expect(await mcpTenantStore(env, ctx)).toBeNull();
    Reflect.set(ctx, "auth", {
      scope: ["memories:read"],
      clientId: "store-test",
    });
    for (const userId of [PENDING, "usr_missing"]) {
      Reflect.set(ctx, "props", { userId });
      expect(await mcpTenantStore(env, ctx)).toBeNull();
    }
    Reflect.set(ctx, "props", { userId: OTHER });
    const bound = await mcpTenantStore(env, ctx, {
      session: "plugin-session",
      sessionName: "worktree-a",
    });
    // OAuth carries no session, so the plugin's headers supply it.
    expect(bound?.provenance).toEqual({
      userId: OTHER,
      agent: "store-test",
      client: "oauth",
      session: "plugin-session",
      sessionName: "worktree-a",
    });
    const store = bound?.store;
    expect(store?.storage).toBe("shared-primary");
    expect(store).not.toHaveProperty("personMemoryLinks");
    expect(store).not.toHaveProperty("admin");
    const { store: owner } = await browser("local");
    const mine = await owner.memories.save(input("owner-only"));
    expect(await store?.memories.get(bare(mine.id))).toBeNull();
  });
});
