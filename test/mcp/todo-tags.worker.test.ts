import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { editTodoTags } from "~/concepts/todo-tags";
import { patchTodoContent } from "~/concepts/todos";
import { capBody, projectTodo } from "~/search/project";
import { callMcp } from "./fixture-worker";

const db = env.DB;

afterEach(async () => {
  await env.TODO_COORDINATOR.getByName("todos:local").resetForDevelopment();
  for (const table of [
    "todo_relations",
    "todo_relation_fences",
    "search_docs",
    "todo_comments",
    "todo_updates",
    "todos",
    "mcp_calls",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

async function tool(
  name: string,
  args: Record<string, unknown>,
  user = "local",
  agent = "tag-editor",
) {
  const { response, raw, value } = await callMcp(
    "tools/call",
    { name, arguments: args },
    agent,
    "application/json, text/event-stream",
    { "x-valise-user": user },
  );
  expect(response.status, raw).toBe(200);
  return value.result;
}

async function create(
  tags = ["library", "priority:4"],
  body = "A useful body.",
) {
  const created = await tool("create_todo", {
    title: "Review the library",
    project: "valise",
    tags,
    body,
    refs: [{ kind: "file", value: "app/library.ts" }],
  });
  return created.structuredContent?.id as string;
}

async function row(id: string) {
  return db
    .prepare("SELECT * FROM todos WHERE todo_id = ?")
    .bind(id.slice("todo:".length))
    .first();
}

async function projection(id: string) {
  return db
    .prepare("SELECT * FROM search_docs WHERE doc_key = ?")
    .bind(id)
    .first();
}

describe("MCP to-do tag edits", () => {
  it("replaces a priority without taking the active lease or rewriting any other content", async () => {
    const id = await create();
    const claimed = await tool(
      "claim_todo",
      { id, ttl_seconds: 600 },
      "local",
      "worker",
    );
    await runDurableObjectAlarm(env.TODO_COORDINATOR.getByName("todos:local"));
    await tool("comment_todo", { id, body: "Remember the zirconium path." });
    const before = await row(id);
    const saved = await tool("edit_todo_tags", {
      id,
      remove_tags: ["priority:4"],
      add_tags: ["priority:1", "library", "priority:1"],
    });
    expect(saved.isError, JSON.stringify(saved)).not.toBe(true);
    expect(saved.structuredContent).toEqual({
      id,
      tags: ["library", "priority:1"],
      updated_at: expect.any(Number),
    });
    expect(await row(id)).toEqual({
      ...before,
      tags_json: '["library","priority:1"]',
      updated_at: saved.structuredContent?.updated_at,
    });
    expect(await projection(id)).toMatchObject({
      tags: "library priority:1",
      body: "A useful body.\napp/library.ts\nRemember the zirconium path.",
    });
    expect(
      (await tool("fetch", { id })).structuredContent?.metadata,
    ).toMatchObject({
      tags: ["library", "priority:1"],
      lease_holder: "worker",
    });
    expect(
      (await tool("search", { query: "zirconium", tags: ["priority:1"] }))
        .structuredContent?.results,
    ).toMatchObject([{ id }]);
    expect(
      (await tool("search", { query: "zirconium", tags: ["priority:4"] }))
        .structuredContent?.results,
    ).toEqual([]);
    const logged = await db
      .prepare(
        "SELECT target_id, outcome, required_scope FROM mcp_calls WHERE tool = 'edit_todo_tags'",
      )
      .first();
    expect(logged).toMatchObject({
      target_id: id,
      outcome: "ok",
      required_scope: "todos:write",
    });
    expect(
      (
        await tool(
          "update_todo",
          { id, token: claimed.structuredContent?.token, body: "Still held." },
          "local",
          "worker",
        )
      ).isError,
    ).not.toBe(true);
  });

  it("removes the final tag and makes repeated edits idempotent", async () => {
    const id = await create(["obsolete"]);
    for (let i = 0; i < 2; i++) {
      expect(
        (
          await tool("edit_todo_tags", {
            id,
            remove_tags: ["obsolete", "missing"],
          })
        ).structuredContent?.tags,
      ).toEqual([]);
      expect(await projection(id)).toMatchObject({ tags: "" });
    }
  });

  it("edits a minimal to-do with no body, refs or comments and trims input tags", async () => {
    const created = await tool("create_todo", {
      title: "Minimal",
      project: "valise",
    });
    const id = created.structuredContent?.id as string;
    expect(
      (await tool("edit_todo_tags", { id, add_tags: [" priority:3 "] }))
        .structuredContent?.tags,
    ).toEqual(["priority:3"]);
    expect(await projection(id)).toMatchObject({
      body: "",
      tags: "priority:3",
    });
  });

  it("does not clear manual blockers or change completion/dependency state", async () => {
    const parent = await create();
    const child = (
      await tool("create_todo", {
        title: "Child",
        project: "valise",
        depends_on: [parent],
      })
    ).structuredContent?.id as string;
    const claimed = await tool("claim_todo", { id: parent, ttl_seconds: 600 });
    await tool("update_todo", {
      id: parent,
      token: claimed.structuredContent?.token,
      blocked_on: "Owner approval",
    });
    await runDurableObjectAlarm(env.TODO_COORDINATOR.getByName("todos:local"));
    const before = await row(parent);
    await tool("edit_todo_tags", { id: parent, add_tags: ["priority:1"] });
    expect(await row(parent)).toMatchObject({
      state: before?.state,
      blocked_on: "Owner approval",
      fencing_token: before?.fencing_token,
    });
    expect((await tool("claim_todo", { id: child })).isError).toBe(true);
    const lease = await tool("claim_todo", { id: parent });
    await tool("complete_todo", {
      id: parent,
      token: lease.structuredContent?.token,
      summary: "Done",
    });
    await runDurableObjectAlarm(env.TODO_COORDINATOR.getByName("todos:local"));
    const done = await row(parent);
    await tool("edit_todo_tags", { id: parent, remove_tags: ["library"] });
    expect(await row(parent)).toMatchObject({
      state: "done",
      completed_at: done?.completed_at,
      fencing_token: done?.fencing_token,
    });
  });

  it("hides foreign IDs exactly as missing ones and makes no writes", async () => {
    const id = await create();
    const before = await row(id);
    const beforeProjection = await projection(id);
    const foreign = await tool(
      "edit_todo_tags",
      { id, add_tags: ["foreign"] },
      "usr_other",
    );
    const missing = await tool(
      "edit_todo_tags",
      { id: "todo:missing", add_tags: ["foreign"] },
      "usr_other",
    );
    expect(foreign.isError).toBe(true);
    expect(foreign.content).toEqual(missing.content);
    expect(await row(id)).toEqual(before);
    expect(await projection(id)).toEqual(beforeProjection);
  });

  it("enforces the final cap atomically while allowing a replacement at the cap", async () => {
    const tags = Array.from({ length: 20 }, (_, n) => `tag-${n}`);
    const id = await create(tags);
    const before = await row(id);
    const beforeProjection = await projection(id);
    expect(
      (await tool("edit_todo_tags", { id, add_tags: ["extra"] })).isError,
    ).toBe(true);
    expect(await row(id)).toEqual(before);
    expect(await projection(id)).toEqual(beforeProjection);
    expect(
      (
        await tool("edit_todo_tags", {
          id,
          add_tags: ["extra"],
          remove_tags: ["tag-0"],
        })
      ).structuredContent?.tags,
    ).toEqual([...tags.slice(1), "extra"]);
  });

  it("keeps concurrent additions and permits only one addition at capacity", async () => {
    const id = await create([]);
    const bare = id.slice(5);
    const results = await Promise.all(
      ["one", "two", "three"].map((tag) =>
        editTodoTags(db, "local", bare, { add_tags: [tag] }),
      ),
    );
    expect(results.every((result) => !("error" in result))).toBe(true);
    expect(JSON.parse(String((await row(id))?.tags_json)).sort()).toEqual([
      "one",
      "three",
      "two",
    ]);
    const full = await create(Array.from({ length: 19 }, (_, n) => `tag-${n}`));
    const attempts = await Promise.all(
      ["one", "two"].map((tag) =>
        editTodoTags(db, "local", full.slice(5), { add_tags: [tag] }),
      ),
    );
    expect(attempts.filter((result) => "error" in result)).toHaveLength(1);
    expect(JSON.parse(String((await row(full))?.tags_json))).toHaveLength(20);
    expect(await projection(full)).toMatchObject({
      tags: JSON.parse(String((await row(full))?.tags_json)).join(" "),
    });
  });

  it("projects content and comments committed while a tag request is in flight", async () => {
    const id = await create();
    let resume = () => {};
    const held = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const delayed = new Proxy(db, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await held;
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const editing = editTodoTags(delayed, "local", id.slice(5), {
      add_tags: ["priority:1"],
      remove_tags: ["priority:4"],
    });
    try {
      await patchTodoContent({ DB: db }, "local", id.slice(5), {
        title: "Latest title",
        body: "Latest body",
      });
      await tool("comment_todo", { id, body: "Latest comment" });
    } finally {
      resume();
    }
    expect(await editing).toMatchObject({ tags: ["library", "priority:1"] });
    expect(await projection(id)).toMatchObject({
      title: "Latest title",
      body: "Latest body\napp/library.ts\nLatest comment",
      tags: "library priority:1",
    });
  });

  it.each([
    {},
    { add_tags: [], remove_tags: [] },
    { add_tags: [""] },
    { add_tags: [" "] },
    { add_tags: ["x".repeat(101)] },
    { add_tags: Array(21).fill("x") },
    { add_tags: ["x"], token: 1 },
    { add_tags: ["x"], state: "done" },
    { add_tags: ["x"], remove_tags: ["x"] },
    { add_tags: ["project:other"] },
    { add_tags: ["state:done"] },
    { add_tags: ["type:memory"] },
  ])("rejects invalid or reserved changes: %j", async (edit) => {
    const id = await create();
    const before = await row(id);
    expect((await tool("edit_todo_tags", { id, ...edit })).isError).toBe(true);
    expect(await row(id)).toEqual(before);
  });

  it.each(["", "aaa" + "🧳".repeat(4096), "aa" + "€".repeat(5462)])(
    "rebuilds the full projection with the same UTF-8 cap",
    async (body) => {
      const id = await create([], body);
      await tool("comment_todo", { id, body: "A comment" });
      // The tag path also repairs an absent projection from authoritative data.
      await db
        .prepare("DELETE FROM search_docs WHERE doc_key = ?")
        .bind(id)
        .run();
      await tool("edit_todo_tags", { id, add_tags: ["test"] });
      const expected = projectTodo({
        todoId: id.slice(5),
        userId: "local",
        title: "Review the library",
        body,
        project: "valise",
        tagsJson: '["test"]',
        refsJson: '[{"kind":"file","value":"app/library.ts"}]',
        comments: "A comment",
        updatedAt: Number((await row(id))?.updated_at),
      });
      expect((await projection(id))?.body).toBe(expected?.body);
      expect((await projection(id))?.body).toBe(
        capBody(
          [body, "app/library.ts", "A comment"].filter(Boolean).join("\n"),
        ),
      );
    },
  );

  it("rolls back the tag update when publication fails", async () => {
    const id = await create();
    const before = await row(id);
    await db
      .prepare(
        "CREATE TRIGGER fail_tag_projection BEFORE UPDATE ON search_docs BEGIN SELECT RAISE(ABORT, 'publication failed'); END",
      )
      .run();
    try {
      await expect(
        editTodoTags(db, "local", id.slice(5), { add_tags: ["rollback"] }),
      ).rejects.toThrow("publication failed");
    } finally {
      await db.prepare("DROP TRIGGER fail_tag_projection").run();
    }
    expect(await row(id)).toEqual(before);
  });
});
