import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { action, loader } from "~/routes/todos";
import { loader as suggest } from "~/routes/todos.suggest";
import { requireBrowserStore } from "~/store/tenant.server";

const settings = { ...env, SESSION_SECRET: "tenant-store-todo-secret" };
const OWNER = "local";
const OTHER = "usr_store_todo_other";

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, created_at, email_verified)
     VALUES (?, ?, unixepoch(), 1)`,
  )
    .bind(OTHER, OTHER)
    .run();
});

afterEach(async () => {
  for (const userId of [OWNER, OTHER])
    await env.TODO_COORDINATOR.getByName(
      `todos:${userId}`,
    ).resetForDevelopment();
  for (const table of [
    "todo_attachments",
    "objects",
    "todo_relations",
    "todo_relation_fences",
    "todo_comments",
    "todo_updates",
    "search_docs",
    "vector_pending",
    "todos",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

async function requestFor(userId: string, path = "/todos") {
  // Routing hints in the URL and headers must not choose the tenant.
  const url = `https://valise.test${path}${path.includes("?") ? "&" : "?"}userId=local&shard=other`;
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, { headers: { cookie, "x-valise-user": "local" } });
}

async function browser(userId: string) {
  return (await requireBrowserStore(settings, await requestFor(userId))).store;
}

const bare = (id: string) => id.slice("todo:".length);

async function seed() {
  const owner = await browser(OWNER);
  const other = await browser(OTHER);
  const mine = await owner.todos.create({
    title: "Private ranking work",
    project: "mine",
    body: "- [ ] first step",
    tags: ["owner:mine"],
  });
  const theirs = await other.todos.create({
    title: "Member ranking work",
    project: "theirs",
    body: "- [ ] their step",
    tags: ["owner:theirs"],
  });
  return { owner, other, mine: bare(mine.id), theirs: bare(theirs.id) };
}

function consoleArgs(request: Request, pattern: string) {
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  return { context, request, url: new URL(request.url), params: {}, pattern };
}

async function post(userId: string, fields: Record<string, string>) {
  const authenticated = await requestFor(userId);
  const url = new URL(authenticated.url);
  const request = new Request(url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(authenticated.headers),
      origin: url.origin,
    },
    body: new URLSearchParams(fields),
  });
  return action(consoleArgs(request, "/todos"));
}

describe("tenant-bound to-do store", () => {
  it("binds lists, counts, projects, detail, suggestions and child reads to one owner", async () => {
    const { owner, other, mine, theirs } = await seed();
    await other.todos.comment(theirs, "Their private note");

    expect((await owner.todos.list()).map((todo) => todo.id)).toEqual([
      `todo:${mine}`,
    ]);
    expect(await owner.todos.count()).toMatchObject({ total: 1 });
    expect(await owner.todos.projects()).toEqual([
      { project: "mine", count: 1 },
    ]);
    expect(await owner.todos.get(theirs)).toBeNull();
    expect(await owner.todos.suggest("ranking")).toMatchObject([
      { id: `todo:${mine}` },
    ]);
    expect(await owner.todos.updates([theirs])).toEqual(new Map());
    expect((await owner.todos.relations([theirs])).get(theirs)).toBeFalsy();
    expect(await owner.todos.attachments([theirs])).toEqual(new Map());
    expect(await owner.facets("todo")).toEqual([
      { key: "owner", value: "mine", tag: "owner:mine", count: 1 },
    ]);
    expect(
      (await owner.search({ query: "Member ranking" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual([`todo:${mine}`]);
    expect((await other.todos.updates([theirs])).get(theirs)).toHaveLength(1);
  });

  it("refuses every write to another tenant's to-do and leaves it unchanged", async () => {
    const { owner, other, mine, theirs } = await seed();
    const before = await other.todos.get(theirs);

    expect(await owner.todos.comment(theirs, "stolen")).toBeNull();
    expect(await owner.todos.toggleTask(theirs, 0, false)).toBeNull();
    expect(await owner.todos.addTask(theirs, "stolen step")).toBeNull();
    expect(await owner.todos.patch(theirs, { title: "stolen" })).toBeNull();
    const file = new File(["evidence"], "proof.txt", { type: "text/plain" });
    expect(await owner.todos.attach(theirs, file)).toBeNull();
    expect(await owner.todos.overrideState(theirs, "done", "stolen")).toEqual(
      expect.objectContaining({ ok: false }),
    );
    expect(
      await owner.todos.editRelations(mine, { addDependsOn: [theirs] }),
    ).toEqual(expect.objectContaining({ ok: false }));
    expect(
      await owner.todos.editRelations(theirs, { addDependsOn: [mine] }),
    ).toEqual(expect.objectContaining({ ok: false }));

    const attached = await other.todos.attach(theirs, file);
    if (!attached) throw new Error("fixture upload refused");
    for (const state of [false, true])
      expect(
        await owner.todos.setFileAttached(theirs, attached.objectId, state),
      ).toBe(false);

    expect(await other.todos.get(theirs)).toEqual(before);
    expect((await other.todos.updates([theirs])).get(theirs)).toBeUndefined();
    expect((await other.todos.attachments([theirs])).get(theirs)).toHaveLength(
      1,
    );
    expect(
      (await other.todos.relations([theirs])).get(theirs)?.depends_on ?? [],
    ).toEqual([]);
  });

  it("stamps a created to-do with the session's owner, not a routing hint", async () => {
    const other = await browser(OTHER);
    const created = await other.todos.create({
      title: "Owned by the session",
      project: null,
    });
    expect(
      await env.DB.prepare("SELECT user_id FROM todos WHERE todo_id = ?")
        .bind(bare(created.id))
        .first("user_id"),
    ).toBe(OTHER);
  });

  it("uses the bound store in the /todos loader, its mutations and suggestions", async () => {
    const { owner, mine } = await seed();
    const opened = await requestFor(OTHER, `/todos?open=todo:${mine}`);
    expect(await loader(consoleArgs(opened, "/todos"))).toMatchObject({
      detail: null,
      todos: [{ title: "Member ranking work" }],
      projects: [{ project: "theirs", count: 1 }],
      vocabulary: { projects: ["theirs"] },
    });

    const refused: Record<string, string>[] = [
      { intent: "edit-field", id: `todo:${mine}`, field: "title", value: "x" },
      { intent: "add-task", id: `todo:${mine}`, text: "stolen" },
      { intent: "comment", id: `todo:${mine}`, body: "stolen" },
    ];
    for (const fields of refused)
      await expect(post(OTHER, fields)).rejects.toMatchObject({ status: 404 });
    expect(
      await post(OTHER, {
        intent: "set-state",
        id: `todo:${mine}`,
        state: "done",
      }),
    ).toMatchObject({ init: { status: 409 } });
    expect(await owner.todos.get(mine)).toMatchObject({
      title: "Private ranking work",
      body: "- [ ] first step",
      state: "pending",
    });
    expect((await owner.todos.updates([mine])).get(mine)).toBeUndefined();

    const suggested = await suggest(
      consoleArgs(
        await requestFor(OTHER, "/todos/suggest?q=ranking"),
        "/todos/suggest",
      ),
    );
    expect(suggested.todos.map((todo) => todo.title)).toEqual([
      "Member ranking work",
    ]);
  });
});
