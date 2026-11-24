import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { CAPTURE_NUDGE, PROGRESS_NUDGE } from "~/mcp/tools";
import { callMcp } from "./fixture-worker";

const db = env.DB;

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_comments",
    "todo_updates",
    "todos",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

describe("todo claiming", () => {
  it("gives one concurrent claimant the lease and rejects the rest with its holder", async () => {
    const id = await createTodo();
    const attempts = await Promise.all(
      ["agent-1", "agent-2", "agent-3", "agent-4"].map((agent) =>
        tool("claim_todo", { id, ttl_seconds: 60 }, agent),
      ),
    );
    const winners = attempts.filter((attempt) => !attempt.isError);
    const losers = attempts.filter((attempt) => attempt.isError);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(3);
    for (const loser of losers) {
      expect(text(loser)).toContain("Current holder:");
    }
  });

  it("renews a lease and rejects stale updates and completion after a re-claim", async () => {
    const id = await createTodo();
    const first = await tool("claim_todo", { id, ttl_seconds: 5 }, "alice");
    const firstToken = token(first);
    const renewed = await tool(
      "update_todo",
      { id, token: firstToken, renew_ttl_seconds: 60 },
      "alice",
    );
    expect(expiresAt(renewed)).toBeGreaterThan(expiresAt(first));

    const stub = env.TODO_COORDINATOR.getByName("todos:local");
    expect(
      await stub.release(id.slice("todo:".length), "alice", firstToken),
    ).toMatchObject({
      ok: true,
    });
    const second = await tool("claim_todo", { id, ttl_seconds: 60 }, "bob");
    expect(token(second)).toBeGreaterThan(firstToken);

    const staleUpdate = await tool(
      "update_todo",
      { id, token: firstToken, body: "old finding" },
      "alice",
    );
    const staleComplete = await tool(
      "complete_todo",
      { id, token: firstToken, summary: "old result" },
      "alice",
    );
    expect(staleUpdate.isError).toBe(true);
    expect(staleComplete.isError).toBe(true);
    expect(text(staleUpdate)).toContain("Current holder: bob");
    expect(text(staleComplete)).toContain("Current holder: bob");
  });

  it("releases an expired lease through its alarm and reseeds above the D1 fence floor", async () => {
    const id = await createTodo();
    const first = await tool("claim_todo", { id, ttl_seconds: 5 }, "alice");
    const firstToken = token(first);
    const stub = env.TODO_COORDINATOR.getByName("todos:local");
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE coordinator_todos SET lease_expires_at = 0 WHERE todo_id = ?",
        id.slice("todo:".length),
      );
    });
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    const ready = await tool("list_ready", {});
    expect(ready.structuredContent).toMatchObject({ todos: [{ id }] });

    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.deleteAll();
      await state.storage.deleteAlarm();
    });
    const second = await tool("claim_todo", { id, ttl_seconds: 60 }, "bob");
    expect(token(second)).toBeGreaterThan(firstToken);
  });

  it("persists the fence synchronously and mirrors the newest state on alarm", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, "alice");
    const claimedToken = token(claimed);
    const todoId = id.slice("todo:".length);

    const beforeMirror = await db
      .prepare("SELECT state, fencing_token FROM todos WHERE todo_id = ?")
      .bind(todoId)
      .first<{ state: string; fencing_token: number }>();
    expect(beforeMirror).toEqual({
      state: "pending",
      fencing_token: claimedToken,
    });

    await tool(
      "complete_todo",
      { id, token: claimedToken, summary: "Finished before the first mirror." },
      "alice",
    );
    const stub = env.TODO_COORDINATOR.getByName("todos:local");
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    const afterMirror = await db
      .prepare(
        `SELECT state, lease_holder, lease_expires_at, completed_at,
                mirror_generation, fencing_token
           FROM todos WHERE todo_id = ?`,
      )
      .bind(todoId)
      .first<{
        state: string;
        lease_holder: string | null;
        lease_expires_at: number | null;
        completed_at: number | null;
        mirror_generation: number;
        fencing_token: number;
      }>();
    expect(afterMirror).toMatchObject({
      state: "done",
      lease_holder: null,
      lease_expires_at: null,
      completed_at: expect.any(Number),
      mirror_generation: 2,
      fencing_token: claimedToken,
    });
  });

  it("lets the console override a live claim and fences the agent that held it", async () => {
    const id = await createTodo();
    const todoId = id.slice("todo:".length);
    const claimed = await tool("claim_todo", { id, ttl_seconds: 600 }, "alice");
    const claimedToken = token(claimed);

    const stub = env.TODO_COORDINATOR.getByName("todos:local");
    const overridden = await stub.override(
      todoId,
      "console",
      "done",
      "completed from the console",
    );
    expect(overridden).toMatchObject({ ok: true });
    expect(overridden.ok && overridden.token).toBeGreaterThan(claimedToken);

    // The console path flushes its own mirror, so D1 is already current: the
    // browser redirects straight back into a read and must not see `claimed`.
    const mirrored = await db
      .prepare(
        `SELECT state, lease_holder, lease_expires_at, completed_at
           FROM todos WHERE todo_id = ?`,
      )
      .bind(todoId)
      .first<{
        state: string;
        lease_holder: string | null;
        lease_expires_at: number | null;
        completed_at: number | null;
      }>();
    expect(mirrored).toMatchObject({
      state: "done",
      lease_holder: null,
      lease_expires_at: null,
      completed_at: expect.any(Number),
    });

    // Alice is not told. She finds out on her next write, which is the whole
    // point of bumping the token rather than quietly releasing the lease.
    const stale = await tool(
      "update_todo",
      { id, token: claimedToken, body: "still working" },
      "alice",
    );
    expect(stale.isError).toBe(true);

    // The override is in the progress log, attributed, so the displaced agent
    // can read why its ticket moved.
    const logged = await db
      .prepare(
        "SELECT kind, author, body FROM todo_updates WHERE todo_id = ? AND kind = 'complete'",
      )
      .bind(todoId)
      .first<{ kind: string; author: string; body: string }>();
    expect(logged).toMatchObject({
      author: "console",
      body: "completed from the console",
    });

    // Reopening is the same lever in reverse, and it is idempotent.
    const reopened = await stub.override(
      todoId,
      "console",
      "pending",
      "reopened",
    );
    expect(reopened).toMatchObject({ ok: true });
    expect(
      await db
        .prepare("SELECT state FROM todos WHERE todo_id = ?")
        .bind(todoId)
        .first<{ state: string }>(),
    ).toEqual({ state: "pending" });
    const again = await stub.override(todoId, "console", "pending", "reopened");
    expect(again).toMatchObject({
      ok: true,
      token: reopened.ok && reopened.token,
    });
  });

  it("closes a to-do nobody holds without a claim, and refuses one somebody does", async () => {
    const id = await createTodo();
    const todoId = id.slice("todo:".length);

    const closed = await tool(
      "complete_todo",
      { id, summary: "Already shipped in PR #12." },
      "alice",
    );
    expect(closed.isError).not.toBe(true);
    expect(
      await db
        .prepare("SELECT state, completed_at FROM todos WHERE todo_id = ?")
        .bind(todoId)
        .first<{ state: string; completed_at: number | null }>(),
    ).toMatchObject({ state: "done", completed_at: expect.any(Number) });
    expect(
      await db
        .prepare(
          "SELECT author, body FROM todo_updates WHERE todo_id = ? AND kind = 'complete'",
        )
        .bind(todoId)
        .first(),
    ).toEqual({ author: "alice", body: "Already shipped in PR #12." });

    const twice = await tool(
      "complete_todo",
      { id, summary: "Again." },
      "alice",
    );
    expect(twice.isError).toBe(true);

    const held = await createTodo();
    await tool("claim_todo", { id: held, ttl_seconds: 600 }, "bob");
    const refused = await tool(
      "complete_todo",
      { id: held, summary: "Not mine." },
      "alice",
    );
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("Current holder: bob");
  });

  it("reopens a blocked to-do for the agent that claims it, and logs the blocker it resolved", async () => {
    const id = await createTodo();
    const todoId = id.slice("todo:".length);
    const first = await tool("claim_todo", { id, ttl_seconds: 60 }, "alice");
    const blocked = await tool(
      "update_todo",
      { id, token: token(first), blocked_on: "PR #32 has to merge" },
      "alice",
    );
    expect(blocked.isError).not.toBe(true);
    const stub = env.TODO_COORDINATOR.getByName("todos:local");
    await runDurableObjectAlarm(stub);
    expect((await tool("list_ready", {})).structuredContent?.todos).toEqual([]);
    // An agent finds it without knowing the id, blocker and all.
    expect(
      (
        await tool("list_ready", {
          project: "valise",
          include_blocked: true,
        })
      ).structuredContent?.todos,
    ).toMatchObject([{ id, blocked_on: "PR #32 has to merge" }]);
    expect(
      (
        await tool("list_ready", {
          project: "elsewhere",
          include_blocked: true,
        })
      ).structuredContent?.todos,
    ).toEqual([]);

    const reclaimed = await tool("claim_todo", { id, ttl_seconds: 60 }, "bob");
    expect(reclaimed.isError).not.toBe(true);
    expect(token(reclaimed)).toBeGreaterThan(token(first));
    await runDurableObjectAlarm(stub);

    const fetched = await tool("fetch", { id });
    expect(fetched.structuredContent?.metadata).toMatchObject({
      state: "claimed",
      lease_holder: "bob",
    });
    expect(fetched.structuredContent?.metadata).not.toHaveProperty(
      "blocked_on",
    );
    const logged = await db
      .prepare(
        "SELECT author, body FROM todo_updates WHERE todo_id = ? AND kind = 'claim' ORDER BY token DESC",
      )
      .bind(todoId)
      .first<{ author: string; body: string }>();
    expect(logged).toEqual({
      author: "bob",
      body: "resolved blocker: PR #32 has to merge",
    });

    expect(
      (await tool("list_ready", { include_blocked: true })).structuredContent
        ?.todos,
    ).toEqual([]);

    const done = await tool(
      "complete_todo",
      { id, token: token(reclaimed), summary: "Shipped after #32." },
      "bob",
    );
    expect(done.isError).not.toBe(true);
  });

  it("reopens a done to-do for the agent that claims it, and fences the old token", async () => {
    const id = await createTodo();
    const todoId = id.slice("todo:".length);
    const first = await tool("claim_todo", { id, ttl_seconds: 60 }, "alice");
    const firstToken = token(first);
    await tool(
      "complete_todo",
      { id, token: firstToken, summary: "Shipped." },
      "alice",
    );

    const reopened = await tool("claim_todo", { id, ttl_seconds: 60 }, "carol");
    expect(reopened.isError).not.toBe(true);
    expect(token(reopened)).toBeGreaterThan(firstToken);

    // The reopen writes its state with the fence, so D1 is current before
    // any mirror runs.
    expect(
      await db
        .prepare(
          "SELECT state, lease_holder, completed_at FROM todos WHERE todo_id = ?",
        )
        .bind(todoId)
        .first(),
    ).toEqual({ state: "claimed", lease_holder: "carol", completed_at: null });
    expect(
      await db
        .prepare(
          "SELECT author, body FROM todo_updates WHERE todo_id = ? AND kind = 'claim' ORDER BY created_at DESC, update_id DESC LIMIT 1",
        )
        .bind(todoId)
        .first(),
    ).toEqual({ author: "carol", body: "reopened a done to-do" });

    const stale = await tool(
      "complete_todo",
      { id, token: firstToken, summary: "Old result." },
      "alice",
    );
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("Current holder: carol");

    const again = await tool("claim_todo", { id, ttl_seconds: 60 }, "dave");
    expect(text(again)).toContain("Current holder: carol");
  });

  it("hands back a claim it cannot finish, ready at once, with the note as its status", async () => {
    const id = await createTodo();
    const todoId = id.slice("todo:".length);
    const stub = env.TODO_COORDINATOR.getByName("todos:local");
    const first = await tool("claim_todo", { id, ttl_seconds: 3600 }, "alice");
    const note =
      "Found the cause in the LIKE pattern. Next: switch search to FTS MATCH.";
    const released = await tool(
      "update_todo",
      { id, token: token(first), body: note, release: true },
      "alice",
    );
    expect(released.isError, text(released)).not.toBe(true);
    expect(released.structuredContent).toMatchObject({ expires_at: null });
    await runDurableObjectAlarm(stub);

    expect(
      (await tool("list_ready", { project: "valise" })).structuredContent
        ?.todos,
    ).toMatchObject([{ id, status: note }]);
    expect(
      (await tool("fetch", { id })).structuredContent?.metadata,
    ).toMatchObject({ state: "pending" });
    expect(
      (await tool("fetch", { id })).structuredContent?.metadata,
    ).not.toHaveProperty("lease_holder");
    const kinds = await db
      .prepare(
        "SELECT kind, author FROM todo_updates WHERE todo_id = ? AND kind != 'claim' ORDER BY rowid",
      )
      .bind(todoId)
      .all();
    expect(kinds.results).toEqual([
      { kind: "progress", author: "alice" },
      { kind: "release", author: "alice" },
    ]);

    const stale = await tool(
      "update_todo",
      { id, token: token(first), body: "late finding" },
      "alice",
    );
    expect(stale.isError).toBe(true);

    // A bare release keeps the last note as the status.
    const second = await tool("claim_todo", { id, ttl_seconds: 60 }, "bob");
    expect(token(second)).toBeGreaterThan(token(first));
    const bare = await tool(
      "update_todo",
      { id, token: token(second), release: true },
      "bob",
    );
    expect(bare.isError, text(bare)).not.toBe(true);
    await runDurableObjectAlarm(stub);
    expect(
      (await tool("list_ready", { project: "valise" })).structuredContent
        ?.todos,
    ).toMatchObject([{ id, status: note }]);
  });

  it("refuses a release that also blocks or renews", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, "alice");
    for (const extra of [
      { blocked_on: "PR #32 has to merge" },
      { renew_ttl_seconds: 600 },
    ]) {
      const refused = await tool(
        "update_todo",
        { id, token: token(claimed), release: true, ...extra },
        "alice",
      );
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("Missing or invalid: release.");
    }
    await runDurableObjectAlarm(env.TODO_COORDINATOR.getByName("todos:local"));
    expect(
      (await tool("fetch", { id })).structuredContent?.metadata,
    ).toMatchObject({ state: "claimed", lease_holder: "alice" });
  });

  it("takes a comment from anyone without a claim, threads it into the log, and makes it searchable", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, "alice");

    // Bob holds nothing and asks anyway; the lease and token stay Alice's.
    const asked = await tool(
      "comment_todo",
      { id, body: "Does the zirconium path need a migration?" },
      "bob",
    );
    expect(asked.isError).not.toBe(true);
    expect(asked.structuredContent).toMatchObject({
      id,
      comment_id: expect.stringMatching(/^tdc_/),
    });
    const answered = await tool(
      "update_todo",
      { id, token: token(claimed), body: "No, it is additive." },
      "alice",
    );
    expect(answered.isError).not.toBe(true);
    const fetched = await tool("fetch", { id }, "alice");
    const metadata = fetched.structuredContent?.metadata as {
      lease_holder: string;
      fencing_token: number;
      updates: { kind: string; author: string; body: string }[];
    };
    expect(metadata.fencing_token).toBe(token(claimed));
    // Only the holder sees the token. ADR-0002, amendment of 2026-11-24.
    expect(
      (await tool("fetch", { id }, "bob")).structuredContent?.metadata,
    ).not.toHaveProperty("fencing_token");
    expect(
      metadata.updates.map((update) => [update.kind, update.author]),
    ).toEqual([
      ["progress", "alice"],
      ["comment", "bob"],
      ["claim", "alice"],
    ]);

    const found = await tool("search", { query: "zirconium" });
    expect(
      (found.structuredContent?.results as { id: string }[]).map(
        (hit) => hit.id,
      ),
    ).toEqual([id]);

    const missing = await tool("comment_todo", {
      id: "todo:tdo_missing",
      body: "Anyone?",
    });
    expect(missing.isError).toBe(true);
  });

  it("carries the pointers and the origin from create to list_ready, fetch, and search", async () => {
    const created = await tool("create_todo", {
      title: "Repoint the pulsar sweep",
      project: "valise",
      body: "**Done when** the sweep reads from the new path.",
      refs: [
        { kind: "repo", value: "getvalise/valise" },
        { kind: "file", value: "app/search/pulsar.ts" },
      ],
    });
    const id = created.structuredContent?.id as string;
    // A link a model can hand a person, on the host the call reached.
    const page = `/todos?open=${encodeURIComponent(id)}`;
    expect(created.structuredContent?.url).toMatch(
      new RegExp(`^https?://[^/]+${page.replace(/[?]/g, "\\?")}$`),
    );

    // list_ready is the minimal starting point; the pointers live on fetch.
    const ready = await tool("list_ready", { project: "valise" });
    expect(
      Object.keys((ready.structuredContent as { todos: object[] }).todos[0]),
    ).toEqual(["id", "title", "status", "status_at", "project"]);

    // A path is a query an agent actually types, so it has to rank.
    const found = await tool("search", { query: "app/search/pulsar.ts" });
    expect(
      (found.structuredContent?.results as { id: string }[]).map(
        (hit) => hit.id,
      ),
    ).toContain(id);

    const fetched = await tool("fetch", { id });
    expect(fetched.structuredContent?.url).toBe(created.structuredContent?.url);
    expect(fetched.structuredContent?.metadata).toMatchObject({
      refs: [
        { kind: "repo", value: "getvalise/valise" },
        { kind: "file", value: "app/search/pulsar.ts" },
      ],
      source_agent: "vitest",
      source_client: "test",
    });
    expect(fetched.structuredContent?.metadata).not.toHaveProperty(
      "source_session",
    );

    // The claimant found the work somewhere else and says so.
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, "alice");
    await tool(
      "update_todo",
      {
        id,
        token: token(claimed),
        refs: [{ kind: "file", value: "app/search/quasar.ts" }],
      },
      "alice",
    );
    const repointed = await tool("fetch", { id });
    expect(repointed.structuredContent?.metadata).toMatchObject({
      refs: [{ kind: "file", value: "app/search/quasar.ts" }],
    });
    const stale = await tool("search", { query: "app/search/pulsar.ts" });
    expect(stale.structuredContent?.results).toEqual([]);
  });
});

async function createTodo(): Promise<string> {
  const result = await tool("create_todo", {
    title: "Coordinate the durable work",
    project: "valise",
    tags: ["coordination"],
  });
  return result.structuredContent?.id as string;
}

async function tool(
  name: string,
  args: Record<string, unknown>,
  agent = "vitest",
) {
  const { response, raw, value } = await callMcp(
    "tools/call",
    { name, arguments: args },
    agent,
  );
  expect(response.status, raw).toBe(200);
  return value.result;
}

function token(
  result: Record<string, unknown> & {
    structuredContent?: Record<string, unknown>;
  },
) {
  const value = result.structuredContent?.token;
  expect(value).toEqual(expect.any(Number));
  return value as number;
}

function expiresAt(
  result: Record<string, unknown> & {
    structuredContent?: Record<string, unknown>;
  },
) {
  const value = result.structuredContent?.expires_at;
  expect(value).toEqual(expect.any(Number));
  return value as number;
}

function text(
  result: Record<string, unknown> & { content?: Array<{ text?: string }> },
) {
  return result.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}

describe("the progress nudge on claim_todo", () => {
  it("asks every claim for progress, and keeps the token readable", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 });
    expect(text(claimed)).toContain(PROGRESS_NUDGE);
    const [first] = claimed.content as Array<{ text: string }>;
    expect(JSON.parse(first.text)).toMatchObject({
      id,
      token: token(claimed),
    });
  });
});

describe("the capture nudge on complete_todo", () => {
  afterEach(async () => {
    await db.prepare("DELETE FROM mcp_calls").run();
  });

  async function complete(headers: Record<string, string>) {
    const id = await createTodo();
    const call = async (name: string, args: Record<string, unknown>) =>
      (
        await callMcp(
          "tools/call",
          { name, arguments: args },
          "vitest",
          undefined,
          headers,
        )
      ).value.result;
    const claimed = await call("claim_todo", { id, ttl_seconds: 60 });
    const done = await call("complete_todo", {
      id,
      token: token(claimed),
      summary: "Done.",
    });
    expect(done.isError).not.toBe(true);
    return text(done);
  }

  it("nudges a client without the plugin once per session", async () => {
    const session = { "x-valise-session": crypto.randomUUID() };
    expect(await complete(session)).toContain(CAPTURE_NUDGE);
    expect(await complete(session)).not.toContain(CAPTURE_NUDGE);
    expect(
      await complete({ "x-valise-session": crypto.randomUUID() }),
    ).toContain(CAPTURE_NUDGE);
  });

  it("nudges every completion when the client sends no session", async () => {
    expect(await complete({})).toContain(CAPTURE_NUDGE);
    expect(await complete({})).toContain(CAPTURE_NUDGE);
  });

  it("leaves the nudge to the plugin's Stop hook when the plugin is there", async () => {
    expect(
      await complete({
        "x-valise-plugin": "0.3.0",
        "x-valise-session": crypto.randomUUID(),
      }),
    ).not.toContain(CAPTURE_NUDGE);
  });
});
