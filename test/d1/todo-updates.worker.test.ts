import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  commentTodo,
  createTodo,
  listTodoUpdates,
  listTodoUpdatesFor,
} from "~/concepts/todos";

const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};

afterEach(async () => {
  for (const table of [
    "todo_comments",
    "todo_updates",
    "search_docs",
    "todos",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function todo(title: string): Promise<string> {
  const created = await createTodo(
    env,
    { title, project: "valise" },
    provenance,
  );
  return created.id.slice("todo:".length);
}

async function progress(todoId: string, body: string, at: number) {
  await env.DB.prepare(
    `INSERT INTO todo_updates (update_id, todo_id, kind, author, token, body, created_at)
     VALUES (?, ?, 'progress', 'vitest', 1, ?, ?)`,
  )
    .bind(`tdu_${crypto.randomUUID()}`, todoId, body, at)
    .run();
}

describe("listTodoUpdatesFor", () => {
  it("reads every listed to-do's log in one query, each in its own order", async () => {
    const first = await todo("First");
    const second = await todo("Second");
    const quiet = await todo("No log");
    await progress(first, "old progress", 100);
    await commentTodo(env, first, "a comment", provenance);
    await progress(second, "second's only update", 200);

    const logs = await listTodoUpdatesFor(env.DB, "local", [
      first,
      second,
      quiet,
    ]);

    // Newest first, comments and updates interleaved by time, as one row's
    // log always read.
    expect(logs.get(first)?.map((update) => update.body)).toEqual([
      "a comment",
      "old progress",
    ]);
    expect(logs.get(second)?.map((update) => update.kind)).toEqual([
      "progress",
    ]);
    expect(logs.has(quiet)).toBe(false);
    // The single-row read is the same query, so the two cannot drift.
    expect(await listTodoUpdates(env.DB, "local", first)).toEqual(
      logs.get(first),
    );
  });

  it("answers an empty list without querying", async () => {
    expect((await listTodoUpdatesFor(env.DB, "local", [])).size).toBe(0);
  });
});
