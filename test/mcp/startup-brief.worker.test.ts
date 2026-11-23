import { env, runDurableObjectAlarm, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectBrief, renderStartupBrief } from "~/concepts/startup-brief";
import { mintBearerToken } from "~/concepts/tokens";
import { getBriefOutput, listTodosOutput } from "~/mcp/contracts";
import { callMcp } from "./fixture-worker";

const db = env.DB;
const NOW = 1792785600;
const DAY = 86400;
const tokenEnv = { DB: db, TOKEN_PEPPER: "local-test-token-pepper" };
beforeEach(clear);
afterEach(clear);
async function clear() {
  for (const table of [
    "search_docs",
    "memory_links",
    "mcp_calls",
    "todo_updates",
    "todo_comments",
    "todo_relations",
    "todos",
    "memories",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
}

async function getBrief(...scopes: string[]) {
  return getBriefAt("", ...scopes);
}

/** Two briefs fetched one after the other can straddle a second boundary. */
function withoutClock(text: string) {
  return text.replace(
    /^Generated \d+; completion and memory window \d+–\d+ /m,
    "Generated <clock> ",
  );
}

async function getBriefAt(query: string, ...scopes: string[]) {
  const { token } = await mintBearerToken(tokenEnv, {
    userId: "local",
    label: "hook",
    scopes,
  });
  return SELF.fetch(
    new Request(`http://localhost/config/brief${query}`, {
      headers: { host: "localhost", authorization: `Bearer ${token}` },
    }),
  );
}

function todo(
  id: string,
  state = "pending",
  project = "valise",
  created = NOW,
  completed: number | null = null,
  user = "local",
) {
  return db
    .prepare(`INSERT INTO todos (todo_id, user_id, title, project, state,
    source_agent, created_at, updated_at, completed_at, blocked_on, lease_holder)
    VALUES (?, ?, ?, ?, ?, 'test', ?, ?, ?, ?, ?)`)
    .bind(
      id,
      user,
      `Task ${id}`,
      project,
      state,
      created,
      NOW,
      completed,
      state === "blocked" ? "Awaiting PR review" : null,
      state === "claimed" ? "other-agent" : null,
    );
}
function memory(
  id: string,
  updated = NOW,
  tags: string[] = [],
  deleted: number | null = null,
  user = "local",
) {
  return db
    .prepare(`INSERT INTO memories (memory_id, user_id, memory_type, title, body,
    project, tags_json, source_agent, source_client, created_at, updated_at, deleted_at)
    VALUES (?, ?, 'decision', ?, 'Evidence to fetch', 'valise', ?, 'test', 'test', ?, ?, ?)`)
    .bind(
      id,
      user,
      `Claim ${id}`,
      JSON.stringify(tags),
      updated,
      updated,
      deleted,
    );
}
function dependency(from: string, to: string, user = "local") {
  return db
    .prepare(`INSERT INTO todo_relations(user_id, from_todo_id, to_todo_id, kind, created_at)
    VALUES (?, ?, ?, 'depends-on', ?)`)
    .bind(user, from, to, NOW);
}
async function tool(
  name: string,
  args: Record<string, unknown> = {},
  user = "local",
) {
  const result = await callMcp(
    "tools/call",
    { name, arguments: args },
    "new-agent",
    undefined,
    { "x-valise-user": user },
  );
  expect(result.response.status, result.raw).toBe(200);
  expect(result.value.result.isError, result.raw).not.toBe(true);
  return result.value.result.structuredContent;
}

describe("bounded orientation shared by MCP and hooks", () => {
  it("keeps HTTP config:read authorization and empty hook output", async () => {
    expect((await getBrief("search:read")).status).toBe(403);
    const response = await getBrief("config:read");
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("");
    const empty = getBriefOutput.parse(await tool("get_brief"));
    expect(empty.ready.items).toEqual([]);
    expect(empty.window.until - empty.window.since).toBe(DAY);
  });

  it("separates ready, claimed, blockers and actual completion windows without keyword guesses", async () => {
    await db.batch([
      todo("ready"),
      todo("claimed", "claimed"),
      todo("blocked", "blocked"),
      todo("done", "done", "valise", NOW - 10 * DAY, NOW - 100),
      // Recently edited, but completed outside the window.
      todo("old-completion", "done", "valise", NOW - 20 * DAY, NOW - 2 * DAY),
      todo("future-completion", "done", "valise", NOW, NOW + 1),
      todo("elsewhere", "pending", "blog"),
      todo("foreign", "claimed", "valise", NOW, null, "foreign"),
      memory("changed"),
      memory("old", NOW - 2 * DAY),
      memory("deleted", NOW, [], NOW),
      memory("foreign-memory", NOW, [], null, "foreign"),
      db
        .prepare(`INSERT INTO todo_comments (comment_id, todo_id, author, source_client, body, created_at)
        VALUES ('tdc_latest', 'ready', 'previous-agent', 'test', 'Four slices pass; branch work/partial. Merge awaits review.', ?)`)
        .bind(NOW - 10),
    ]);
    const read = await readProjectBrief(
      db,
      "local",
      { project: "valise" },
      NOW,
    );
    const brief = getBriefOutput.parse(read);
    expect(brief.ready.items.map((row) => row.id)).toEqual(["todo:ready"]);
    expect(brief.claimed.items).toMatchObject([
      { id: "todo:claimed", lease_holder: "other-agent", state: "claimed" },
    ]);
    expect(brief.blocked.items).toMatchObject([
      { id: "todo:blocked", blocked_on: "Awaiting PR review" },
    ]);
    expect(brief.completed.items.map((row) => row.id)).toEqual(["todo:done"]);
    expect(brief.changed_memories.items.map((row) => row.id)).toEqual([
      "memory:changed",
    ]);
    expect(brief.ready.items[0]).toMatchObject({
      update_count: 1,
      last_update_author: "previous-agent",
      last_update_summary:
        "Four slices pass; branch work/partial. Merge awaits review.",
    });
    const text = renderStartupBrief(read);
    expect(text).toContain("todo:ready [pending]");
    expect(text).toContain("Four slices pass; branch work/partial.");
    expect(text).toContain("completion and memory window");
    expect(text).not.toContain("foreign");
    const mcp = getBriefOutput.parse(
      await tool("get_brief", { project: "valise", since: NOW - DAY }),
    );
    expect(mcp.ready.items[0].id).toBe("todo:ready");
    expect(
      await db
        .prepare(
          "SELECT required_scope FROM mcp_calls WHERE tool = 'get_brief'",
        )
        .first("required_scope"),
    ).toBe("search:read");
  });

  it("samples effective blockers within project and owner bounds without changing stored-state enumeration", async () => {
    await db.batch([
      // Cross-project prerequisites still gate the dependent's scoped brief.
      todo("prerequisite", "pending", "platform"),
      ...Array.from({ length: 7 }, (_, i) =>
        todo(`waiting-${i}`, i === 0 ? "blocked" : "pending"),
      ),
      todo("held-dependent", "claimed"),
      todo("done-dependent", "done", "valise", NOW, NOW),
      todo("blog-dependent", "pending", "blog"),
      todo("foreign-prerequisite", "pending", "platform", NOW, null, "foreign"),
      todo("foreign-dependent", "pending", "valise", NOW, null, "foreign"),
      db.prepare(
        "UPDATE todos SET blocked_on = 'Keep this manual reason' WHERE todo_id = 'waiting-1'",
      ),
      ...Array.from({ length: 7 }, (_, i) =>
        dependency(`waiting-${i}`, "prerequisite"),
      ),
      dependency("held-dependent", "prerequisite"),
      dependency("done-dependent", "prerequisite"),
      dependency("blog-dependent", "prerequisite"),
      dependency("foreign-dependent", "foreign-prerequisite", "foreign"),
    ]);
    const before = getBriefOutput.parse(
      // This fixture's completion is fixed at NOW, not the real last 24h.
      await tool("get_brief", { project: "valise", since: NOW - DAY }),
    );
    expect(before.ready.items).toEqual([]);
    expect(before.blocked).toMatchObject({ limit: 5, has_more: true });
    expect(before.blocked.items.map((row) => row.id)).toEqual([
      "todo:waiting-0",
      "todo:waiting-1",
      "todo:waiting-2",
      "todo:waiting-3",
      "todo:waiting-4",
    ]);
    expect(before.blocked.items[0]).toMatchObject({
      state: "blocked",
      blocked_on: "Awaiting PR review",
    });
    expect(before.blocked.items[1]).toMatchObject({
      state: "pending",
      blocked_on: "Keep this manual reason",
    });
    expect(before.blocked.items[2]).toMatchObject({ state: "pending" });
    // A row leaves out what it has nothing to say about (2026-11-15).
    expect(before.blocked.items[2]).not.toHaveProperty("blocked_on");
    expect(before.claimed.items.map((row) => row.id)).toEqual([
      "todo:held-dependent",
    ]);
    expect(before.completed.items.map((row) => row.id)).toEqual([
      "todo:done-dependent",
    ]);
    expect(before.note).toContain(
      "pending work waiting on manual reasons or unfinished dependencies",
    );
    const hook = renderStartupBrief(
      await readProjectBrief(db, "local", {
        project: "valise",
        since: NOW - DAY,
      }),
    );
    expect(hook).toContain("todo:waiting-2 [pending]");
    expect(hook).toContain("state and blocked_on are unchanged");
    const blog = getBriefOutput.parse(
      await tool("get_brief", { project: "blog" }),
    );
    expect(blog.blocked).toMatchObject({ limit: 5, has_more: false });
    expect(blog.blocked.items.map((row) => row.id)).toEqual([
      "todo:blog-dependent",
    ]);
    const foreign = getBriefOutput.parse(
      await tool("get_brief", { project: "valise" }, "foreign"),
    );
    expect(foreign.blocked).toMatchObject({ limit: 5, has_more: false });
    expect(foreign.blocked.items.map((row) => row.id)).toEqual([
      "todo:foreign-dependent",
    ]);
    const platform = getBriefOutput.parse(
      await tool("get_brief", { project: "platform" }),
    );
    expect(platform.blocked.items).toEqual([]);
    expect(platform.blocked.has_more).toBe(false);

    const pending = listTodosOutput.parse(
      await tool("list_todos", { project: "valise", state: "pending" }),
    );
    expect(pending.todos.map((row) => row.id)).toEqual(
      Array.from({ length: 6 }, (_, i) => `todo:waiting-${i + 1}`),
    );
    const storedBlocked = listTodosOutput.parse(
      await tool("list_todos", { project: "valise", state: "blocked" }),
    );
    expect(storedBlocked.todos.map((row) => row.id)).toEqual([
      "todo:waiting-0",
    ]);
    const all = listTodosOutput.parse(
      await tool("list_todos", { project: "valise" }),
    );
    expect(all.todos).toHaveLength(9);
    // This read path never writes state or fabricates a dependency reason.
    expect(
      await db
        .prepare(
          "SELECT state, blocked_on FROM todos WHERE todo_id = 'waiting-2'",
        )
        .first(),
    ).toEqual({ state: "pending", blocked_on: null });
  });

  it("caps every section with has_more, cuts titles and summaries, and selects only recent project rollups", async () => {
    await db.batch([
      ...Array.from({ length: 7 }, (_, i) => todo(`ready-${i}`)),
      ...Array.from({ length: 6 }, (_, i) => todo(`held-${i}`, "claimed")),
      ...Array.from({ length: 6 }, (_, i) => todo(`blocked-${i}`, "blocked")),
      ...Array.from({ length: 6 }, (_, i) =>
        todo(`done-${i}`, "done", "valise", NOW, NOW),
      ),
      ...Array.from({ length: 5 }, (_, i) => memory(`mem-${i}`, NOW - i)),
      ...Array.from({ length: 5 }, (_, i) =>
        todo(`project-${i}`, "pending", `project-${i}`, NOW - i),
      ),
      memory("rollup-old", NOW - 100, ["rollup"]),
      memory("rollup", NOW - 10, ["rollup", "covers_up_to:2026-10-22"]),
      memory("rollup-deleted", NOW, ["rollup"], NOW),
      db
        .prepare("UPDATE todos SET title = ? WHERE todo_id = 'ready-0'")
        .bind("x".repeat(500)),
      db
        .prepare("UPDATE todos SET updated_at = ? WHERE project <> 'valise'")
        .bind(NOW - 100),
    ]);
    const brief = getBriefOutput.parse(
      await readProjectBrief(db, "local", {}, NOW),
    );
    for (const section of [
      brief.ready,
      brief.claimed,
      brief.blocked,
      brief.completed,
    ]) {
      expect(section.items).toHaveLength(5);
      expect(section.has_more).toBe(true);
    }
    expect(
      brief.ready.items.find((row) => row.id === "todo:ready-0")?.title.length,
    ).toBe(160);
    expect(brief.changed_memories.items).toHaveLength(3);
    expect(brief.changed_memories.has_more).toBe(true);
    expect(brief.projects.items).toHaveLength(3);
    expect(brief.projects.has_more).toBe(true);
    expect(
      brief.projects.items.find((row) => row.project === "valise"),
    ).toMatchObject({ rollup_id: "memory:rollup", covers_up_to: "2026-10-22" });
    const text = await (await getBrief("config:read")).text();
    expect(text).toContain("more omitted");
    expect(text).toContain("overview memory:rollup");
    expect(text).not.toContain("rollup-deleted");
  });

  it("omits confirmed superseded memories but restores one if its successor is archived", async () => {
    await db.batch([
      memory("old"),
      memory("new", NOW - 1),
      db
        .prepare(`INSERT INTO memory_links (link_id, from_memory_id, to_memory_id, kind,
        asserted_by, source_agent, source_client, created_at, confirmed_at, confirmed_by)
         VALUES ('link', 'new', 'old', 'supersedes', 'person', 'test', 'test', ?, ?, 'local')`)
        .bind(NOW, NOW),
    ]);
    expect(
      (await readProjectBrief(db, "local", {}, NOW)).changed_memories.items.map(
        (row) => row.id,
      ),
    ).toEqual(["memory:new"]);
    await db
      .prepare("UPDATE memories SET deleted_at = ? WHERE memory_id = 'new'")
      .bind(NOW)
      .run();
    expect(
      (await readProjectBrief(db, "local", {}, NOW)).changed_memories.items.map(
        (row) => row.id,
      ),
    ).toEqual(["memory:old"]);
  });
  it("prioritizes fresh progress on older work and bounds hook text below the client's 8000-character limit", async () => {
    const project = "p".repeat(200);
    await db.batch([
      ...Array.from({ length: 7 }, (_, i) =>
        todo(`recent-${i}`, "pending", project, NOW - i),
      ),
      todo("older-progress", "pending", project, NOW - DAY),
      db
        .prepare(
          "UPDATE todos SET updated_at = ? WHERE todo_id = 'older-progress'",
        )
        .bind(NOW - DAY),
      db
        .prepare(`INSERT INTO todo_comments (comment_id, todo_id, author, source_client, body, created_at)
        VALUES ('fresh-comment', 'older-progress', 'previous-agent', 'test', 'Resume on branch work/partial; four slices verified.', ?)`)
        .bind(NOW + 1),
      ...Array.from({ length: 5 }, (_, i) =>
        todo(`held-long-${i}`, "claimed", project),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        todo(`blocked-long-${i}`, "blocked", project),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        todo(`done-long-${i}`, "done", project, NOW, NOW),
      ),
      db
        .prepare(
          "UPDATE todos SET title = ?, blocked_on = CASE WHEN state = 'blocked' THEN ? ELSE NULL END",
        )
        .bind("x".repeat(500), "b".repeat(500)),
      ...Array.from({ length: 3 }, (_, i) => memory(`long-memory-${i}`)),
    ]);
    const brief = await readProjectBrief(db, "local", {}, NOW + 2);
    expect(brief.ready.items[0]).toMatchObject({
      id: "todo:older-progress",
      last_update_summary:
        "Resume on branch work/partial; four slices verified.",
    });
    const huge = {
      ...brief,
      ready: {
        ...brief.ready,
        items: brief.ready.items.map((row) => ({
          ...row,
          last_update_summary: "s".repeat(160),
        })),
      },
    };
    const text = renderStartupBrief(huge);
    expect(text.length).toBeLessThanOrEqual(7800);
    // Even pathological legacy titles cannot cause the hook to discard its refresh.
    expect(text).toContain("todo:older-progress");
  });

  it("lets a second agent discover a partial task and fetch its actual evidence without reclaiming another agent's work", async () => {
    const created = await callMcp(
      "tools/call",
      {
        name: "create_todo",
        arguments: {
          title: "Partial handoff",
          project: "valise",
          body: "Keep the approved design. Evidence in test/mcp/startup-brief.worker.test.ts.",
        },
      },
      "first-agent",
    );
    const id = created.value.result.structuredContent?.id as string;
    const claim = await callMcp(
      "tools/call",
      { name: "claim_todo", arguments: { id, ttl_seconds: 600 } },
      "first-agent",
    );
    const token = claim.value.result.structuredContent?.token;
    await callMcp(
      "tools/call",
      {
        name: "update_todo",
        arguments: {
          id,
          token,
          body: "Part 1 verified on branch handoff/partial. Awaiting PR #180 review; do not repeat part 1.",
          summary: "Part 1 verified; PR #180 awaits review.",
        },
      },
      "first-agent",
    );
    await runDurableObjectAlarm(env.TODO_COORDINATOR.getByName("todos:local"));
    const brief = getBriefOutput.parse(
      await tool("get_brief", { project: "valise" }),
    );
    expect(brief.claimed.items).toMatchObject([
      {
        id,
        lease_holder: "first-agent",
        status: "Part 1 verified; PR #180 awaits review.",
      },
    ]);
    expect(brief.ready.items).toEqual([]);
    const fetched = await tool("fetch", { id });
    expect(JSON.stringify(fetched)).toContain("do not repeat part 1");
    expect(JSON.stringify(fetched)).toContain("handoff/partial");
    expect(
      await db
        .prepare(
          "SELECT COUNT(*) AS n FROM mcp_calls WHERE agent = 'new-agent' AND tool IN ('search', 'save_memory', 'claim_todo')",
        )
        .first("n"),
    ).toBe(0);
  });
});

describe("the hook's brief for a working directory", () => {
  function worktree(id: string, path: string) {
    return db
      .prepare("UPDATE todos SET refs_json = ? WHERE todo_id = ?")
      .bind(JSON.stringify([{ kind: "worktree", value: path }]), id)
      .run();
  }

  it("puts this worktree's claims first and briefs the cwd's project", async () => {
    await db.batch([
      todo("here", "claimed", "valise"),
      todo("elsewhere", "claimed", "valise"),
      todo("ready-valise", "pending", "valise"),
      todo("ready-other", "pending", "other"),
    ]);
    await worktree("here", "/wt/hook-brief/");
    await worktree("elsewhere", "/wt/other");
    const response = await getBriefAt(
      `?project=valise&cwd=${encodeURIComponent("/wt/hook-brief/app")}`,
      "config:read",
    );
    expect(response.status).toBe(200);
    const text = await response.text();
    const [claims, brief] = text.split("\n\n");
    expect(claims).toBe(
      "Claimed in this worktree (/wt/hook-brief/app); fetch the to-do for its fencing token and history before continuing:\n" +
        "- todo:here Task here · valise",
    );
    expect(brief).toContain("todo:ready-valise");
    expect(brief).not.toContain("todo:ready-other");

    // Resume and compaction read the claims alone.
    const only = await getBriefAt(
      `?only=claimed&cwd=${encodeURIComponent("/wt/hook-brief")}`,
      "config:read",
    );
    expect(only.headers.get("x-valise-brief")).toBe("claimed");
    expect(await only.text()).toBe(
      claims.replace("/wt/hook-brief/app", "/wt/hook-brief"),
    );
    // A sibling directory sharing the prefix is not the worktree.
    const sibling = await getBriefAt(
      `?only=claimed&cwd=${encodeURIComponent("/wt/hook-brief-2")}`,
      "config:read",
    );
    expect(await sibling.text()).toBe("");
  });

  it("falls back to the unscoped brief for a project with nothing to brief", async () => {
    await db.batch([todo("ready-valise", "pending", "valise")]);
    const text = await (
      await getBriefAt("?project=no-such-project&cwd=%2Fx", "config:read")
    ).text();
    expect(text).toContain("todo:ready-valise");
    const unscoped = await (await getBrief("config:read")).text();
    expect(withoutClock(text)).toBe(withoutClock(unscoped));
    expect(withoutClock(text)).not.toBe(text);
  });

  it("refuses claims without a cwd and oversized parameters", async () => {
    expect((await getBriefAt("?only=claimed", "config:read")).status).toBe(400);
    expect(
      (await getBriefAt(`?project=${"p".repeat(201)}`, "config:read")).status,
    ).toBe(400);
    expect(
      (await getBriefAt("?only=claimed&cwd=%2Fx", "search:read")).status,
    ).toBe(403);
  });
});

describe("list_todos keyset continuation", () => {
  it("pages tied timestamps exactly once despite edits and backdated inserts", async () => {
    await db.batch([
      todo("a"),
      todo("b"),
      todo("c"),
      todo("d", "pending", "blog"),
      todo("foreign", "pending", "valise", NOW, null, "foreign"),
    ]);
    const first = listTodosOutput.parse(
      await tool("list_todos", { project: "valise", limit: 2 }),
    );
    expect(first.todos.map((row) => row.id)).toEqual(["todo:a", "todo:b"]);
    expect(first.next_cursor).toEqual(expect.any(String));
    await db.batch([
      todo("backdated", "pending", "valise", NOW - 1),
      db
        .prepare("UPDATE todos SET updated_at = ? WHERE todo_id = 'c'")
        .bind(NOW + 10),
    ]);
    const second = listTodosOutput.parse(
      await tool("list_todos", {
        project: "valise",
        limit: 1,
        cursor: first.next_cursor,
      }),
    );
    expect(second.todos.map((row) => row.id)).toEqual(["todo:c"]);
    expect(second.next_cursor).toBeNull();
    expect(second.as_of).toBe(first.as_of);
    expect(
      await db
        .prepare(
          "SELECT required_scope FROM mcp_calls WHERE tool = 'list_todos' LIMIT 1",
        )
        .first("required_scope"),
    ).toBe("todos:read");
  });

  it("uses completed_at inclusively, not edited_at, and implies done when state is omitted", async () => {
    await db.batch([
      todo("edge", "done", "valise", NOW - DAY, NOW - DAY),
      todo("old", "done", "valise", NOW, NOW - DAY - 1),
      todo("pending"),
    ]);
    const page = listTodosOutput.parse(
      await tool("list_todos", { completed_since: NOW - DAY }),
    );
    expect(page.todos.map((row) => row.id)).toEqual(["todo:edge"]);
    const result = await callMcp("tools/call", {
      name: "list_todos",
      arguments: { completed_since: NOW, state: "pending" },
    });
    expect(result.value.result.isError).toBe(true);
  });

  it("refuses malformed cursors, changed filters and another user's cursor, logging each refusal", async () => {
    await db.batch([todo("a"), todo("b")]);
    const first = listTodosOutput.parse(await tool("list_todos", { limit: 1 }));
    for (const [args, user] of [
      [{ cursor: "not-a-cursor" }, "local"],
      [{ cursor: first.next_cursor, project: "blog" }, "local"],
      [{ cursor: first.next_cursor, state: "done" }, "local"],
      [{ cursor: first.next_cursor }, "foreign"],
    ] as const) {
      const result = await callMcp(
        "tools/call",
        { name: "list_todos", arguments: args },
        "test",
        undefined,
        { "x-valise-user": user },
      );
      expect(result.value.result.isError, result.raw).toBe(true);
      expect(result.raw).toContain("Invalid cursor");
    }
    expect(
      await db
        .prepare("SELECT COUNT(*) FROM mcp_calls WHERE tool = 'list_todos'")
        .first("COUNT(*)"),
    ).toBe(5);
  });

  it("keeps project and completed-window filters on every cursor page", async () => {
    const since = NOW - DAY;
    await db.batch([
      todo("done-a", "done", "valise", NOW, since),
      todo("done-b", "done", "valise", NOW, since + 1),
      todo("done-c", "done", "valise", NOW - 1, NOW),
      todo("other-project", "done", "blog", NOW, NOW),
      todo("old-completion", "done", "valise", NOW, since - 1),
      todo("foreign-completion", "done", "valise", NOW, NOW, "foreign"),
      todo("still-pending"),
    ]);
    const filters = {
      project: "valise",
      state: "done",
      completed_since: since,
      limit: 2,
    };
    const first = listTodosOutput.parse(await tool("list_todos", filters));
    expect(first.todos.map((row) => row.id)).toEqual([
      "todo:done-a",
      "todo:done-b",
    ]);
    expect(first.has_more).toBe(true);
    const second = listTodosOutput.parse(
      await tool("list_todos", { ...filters, cursor: first.next_cursor }),
    );
    expect(second.todos.map((row) => row.id)).toEqual(["todo:done-c"]);
    expect(second.next_cursor).toBeNull();
    expect(second.has_more).toBe(false);
    expect(second.as_of).toBe(first.as_of);
    const changedWindow = await callMcp("tools/call", {
      name: "list_todos",
      arguments: {
        ...filters,
        completed_since: since + 1,
        cursor: first.next_cursor,
      },
    });
    expect(changedWindow.value.result.isError, changedWindow.raw).toBe(true);
    expect(changedWindow.raw).toContain("Invalid cursor");
  });

  it("reports an exact [completed_since, completed_before) window on every page, by completion time", async () => {
    const since = NOW - DAY;
    const before = NOW;
    await db.batch([
      todo("at-start", "done", "valise", NOW, since),
      todo("inside", "done", "valise", NOW - 1, before - 1),
      // Created and edited long after it completed: still in the window.
      todo("edited-old", "done", "valise", NOW - 2, since + 10),
      todo("at-end", "done", "valise", NOW, before),
      todo("before-start", "done", "valise", NOW, since - 1),
      todo("other-project", "done", "blog", NOW, since + 5),
    ]);
    await db
      .prepare("UPDATE todos SET updated_at = ? WHERE todo_id = 'edited-old'")
      .bind(NOW + DAY)
      .run();
    const filters = {
      project: "valise",
      completed_since: since,
      completed_before: before,
      limit: 2,
    };
    const first = listTodosOutput.parse(await tool("list_todos", filters));
    expect(first.next_cursor).toEqual(expect.any(String));
    const second = listTodosOutput.parse(
      await tool("list_todos", { ...filters, cursor: first.next_cursor }),
    );
    expect(second.next_cursor).toBeNull();
    expect(
      [...first.todos, ...second.todos].map((row) => row.id).sort(),
    ).toEqual(["todo:at-start", "todo:edited-old", "todo:inside"]);
    for (const args of [
      { ...filters, completed_before: before + 1, cursor: first.next_cursor },
      { completed_since: since, completed_before: since },
      { completed_before: before, state: "pending" },
    ]) {
      const result = await callMcp("tools/call", {
        name: "list_todos",
        arguments: args,
      });
      expect(result.value.result.isError, result.raw).toBe(true);
    }
    const open = listTodosOutput.parse(
      await tool("list_todos", { project: "valise", completed_before: since }),
    );
    expect(open.todos.map((row) => row.id)).toEqual(["todo:before-start"]);
  });

  it("starts a new listing for a null or empty cursor and still refuses invented ones", async () => {
    await db.batch([todo("a"), todo("b")]);
    for (const cursor of [null, ""]) {
      const page = listTodosOutput.parse(
        await tool("list_todos", { limit: 1, cursor }),
      );
      expect(page.todos.map((row) => row.id)).toEqual(["todo:a"]);
    }
    for (const cursor of [".", "0", " ", "null", "start", "eyJvZmZzZXQiOjB9"]) {
      const result = await callMcp("tools/call", {
        name: "list_todos",
        arguments: { cursor },
      });
      expect(result.value.result.isError, cursor).toBe(true);
      expect(result.raw).toContain("Invalid cursor");
    }
  });

  it("advertises scopes, rejects excessive limits, future briefs and millisecond inputs", async () => {
    const { value } = await callMcp("tools/list", {});
    expect(value.result.tools).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "get_brief",
          securitySchemes: [{ type: "oauth2", scopes: ["search:read"] }],
        }),
        expect.objectContaining({
          name: "list_todos",
          securitySchemes: [{ type: "oauth2", scopes: ["todos:read"] }],
        }),
      ]),
    );
    for (const [name, args] of [
      ["list_todos", { limit: 101 }],
      ["get_brief", { since: Date.now() }],
      ["get_brief", { since: Math.floor(Date.now() / 1000) + DAY }],
    ] as const) {
      const result = await callMcp("tools/call", { name, arguments: args });
      expect(result.value.result.isError).toBe(true);
    }
  });
});

describe("get_brief for the plugin's hooks", () => {
  /** The tool result's text, which an mcp_tool hook reads as hook output. */
  async function hookText(args: Record<string, unknown>) {
    const result = await callMcp(
      "tools/call",
      { name: "get_brief", arguments: args },
      "new-agent",
      undefined,
      { "x-valise-user": "local" },
    );
    expect(result.value.result.isError, result.raw).not.toBe(true);
    return JSON.parse(
      (result.value.result.content as { text: string }[])[0].text,
    );
  }

  it("re-injects the worktree's claims after a compaction, and nothing without one", async () => {
    await db.batch([todo("here", "claimed", "valise")]);
    await db
      .prepare("UPDATE todos SET refs_json = ? WHERE todo_id = 'here'")
      .bind(JSON.stringify([{ kind: "worktree", value: "/wt/compact" }]))
      .run();
    const answer = await hookText({
      cwd: "/wt/compact/app",
      hook: "SessionStart",
    });
    expect(answer.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      additionalContext:
        "Claimed in this worktree (/wt/compact/app); fetch the to-do for its fencing token and history before continuing:\n" +
        "- todo:here Task here · valise",
    });
    // The brief's own keys ride along, and Claude Code ignores them.
    expect(getBriefOutput.parse(answer).claimed.items[0].id).toBe("todo:here");
    expect(
      (await hookText({ cwd: "/wt/elsewhere", hook: "SessionStart" }))
        .hookSpecificOutput,
    ).toBeUndefined();
  });

  it("says when a project has nothing filed and lists the active ones", async () => {
    await db.batch([
      todo("ready-valise", "pending", "valise"),
      todo("ready-blog", "pending", "blog"),
    ]);
    const brief = getBriefOutput.parse(
      await tool("get_brief", { project: "valise-fork" }),
    );
    expect(brief.project).toBe("valise-fork");
    expect(brief.note).toMatch(
      /^No to-dos or memories are filed under project "valise-fork"\. Active projects: (valise, blog|blog, valise)\. Ask the user which one this work belongs to; to make it stick for a repository, commit \.valise\.json with \{"project": "<name>"\} at its root\. Bounded orientation/,
    );
    expect(brief.projects.items.map((row) => row.project).sort()).toEqual([
      "blog",
      "valise",
    ]);
    expect(brief.ready.items).toEqual([]);

    // A known project keeps the plain note.
    const known = getBriefOutput.parse(
      await tool("get_brief", { project: "valise" }),
    );
    expect(known.note).toMatch(/^Bounded orientation/);
  });
});
