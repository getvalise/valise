import { env, runDurableObjectAlarm } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
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

/**
 * list_ready's result entry as clients discover it from 2026-10-25: the
 * trimmed row plus the status pair, inside it because Claude Code shows a
 * model structuredContent only (ADR-0003). A
 * client validates against the JSON Schema it cached, which forbids extra
 * properties; `.strict()` is the same rule. Frozen: do not derive from
 * today's contracts.
 */
const cachedListReadyOutput = z
  .object({
    todos: z.array(
      z
        .object({
          id: z.string(),
          title: z.string(),
          status: z.string().nullable(),
          status_at: z.number().nullable(),
          project: z.string().nullable(),
          blocked_on: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict();

/**
 * search's result entry as clients discover it from 2026-10-25: a to-do hit
 * carries its status pair in metadata, for the same reason. Frozen, except
 * for created_at and saved_by: a client holding this closed shape rejects
 * them until it reconnects, the break ADR-0003's 2026-11-03 amendment accepts.
 */
const cachedSearchOutput = z
  .object({
    results: z.array(
      z
        .object({
          id: z.string(),
          type: z.enum(["skill", "memory", "todo"]),
          title: z.string(),
          snippet: z.string(),
          score: z.number(),
          metadata: z
            .object({
              project: z.string().nullable(),
              created_at: z.number(),
              saved_by: z.string(),
              updated_at: z.number(),
              status: z.string().nullable().optional(),
              status_at: z.number().nullable().optional(),
            })
            .strict(),
        })
        .strict(),
    ),
  })
  .strict();

/** A paragraph the size of a real progress update. */
function finding(n: number) {
  return `Slice ${n} verified on feat/assets-finalize. ${"The finalize path retries on a 409 and keeps the object key stable across attempts, so a second upload of the same bytes lands on the same row. ".repeat(4)}`;
}

describe("update summaries", () => {
  it("writes the author's summary, else the body's opening sentences, on every kind", async () => {
    const id = await createTodo("Summarise every update");
    const claimed = await tool("claim_todo", { id, ttl_seconds: 600 }, "alice");
    const t = token(claimed);
    await tool(
      "update_todo",
      { id, token: t, body: finding(1), summary: "Slice 1 is green." },
      "alice",
    );
    await tool("update_todo", { id, token: t, body: finding(2) }, "alice");
    await tool(
      "comment_todo",
      {
        id,
        body: "Does finalize need the migration first?\n\nAsking before I rebase.",
      },
      "bob",
    );
    await tool(
      "comment_todo",
      { id, body: "Long question body.", summary: "Rebase question" },
      "carol",
    );
    await tool(
      "update_todo",
      { id, token: t, blocked_on: "Review of PR #153. Then merge." },
      "alice",
    );

    const { results } = await db
      .prepare(
        `SELECT kind, summary FROM todo_updates WHERE todo_id = ?
         UNION ALL
         SELECT 'comment', summary FROM todo_comments WHERE todo_id = ?`,
      )
      .bind(bare(id), bare(id))
      .all<{ kind: string; summary: string | null }>();
    expect(results).toEqual(
      expect.arrayContaining([
        { kind: "claim", summary: null },
        { kind: "progress", summary: "Slice 1 is green." },
        {
          kind: "progress",
          summary: "Slice 2 verified on feat/assets-finalize.",
        },
        { kind: "blocked", summary: "Review of PR #153. Then merge." },
        { kind: "comment", summary: "Does finalize need the migration first?" },
        { kind: "comment", summary: "Rebase question" },
      ]),
    );
  });

  it("cuts a summary at read time for a row written before the column", async () => {
    const id = await createTodo("Legacy thread");
    await db
      .prepare(
        `INSERT INTO todo_updates (update_id, todo_id, kind, author, token, body, created_at)
         VALUES ('tdu_legacy', ?, 'progress', 'old-agent', 1, ?, 100)`,
      )
      .bind(bare(id), "**Merged** in #140. Follow-up filed.")
      .run();
    const fetched = await tool("fetch", { id });
    // The cut summary is the status; the first page's newest update already
    // says what last_update_ would, so those are left out (2026-11-15).
    expect(fetched.structuredContent?.metadata).toMatchObject({
      status: "Merged in #140. Follow-up filed.",
      update_count: 1,
      updates: [
        {
          kind: "progress",
          author: "old-agent",
          body: "**Merged** in #140. Follow-up filed.",
        },
      ],
    });
  });
});

describe("fetch's thread digest", () => {
  it("returns bodies for the newest three of ten updates, summaries for all, and every body on full", async () => {
    const id = await createTodo("A long thread");
    const claimed = await tool("claim_todo", { id, ttl_seconds: 600 }, "alice");
    for (let n = 1; n <= 9; n++) {
      await tool(
        "update_todo",
        { id, token: token(claimed), body: finding(n) },
        "alice",
      );
    }
    const fetched = await tool("fetch", { id });
    const metadata = fetched.structuredContent?.metadata as Thread;
    expect(metadata.updates).toHaveLength(10);
    expect(metadata.updates.map((update) => "body" in update)).toEqual([
      ...Array(3).fill(true),
      ...Array(7).fill(false),
    ]);
    // Body or summary, never both; no ids or tokens, and the to-do's own
    // author is not repeated on every entry.
    expect(
      metadata.updates.every(
        (update) =>
          "body" in update !== "summary" in update &&
          !("id" in update) &&
          !("token" in update),
      ),
    ).toBe(true);
    expect(metadata.updates.map((update) => update.summary ?? null)).toEqual([
      null,
      null,
      null,
      ...Array.from(
        { length: 6 },
        (_, i) => `Slice ${6 - i} verified on feat/assets-finalize.`,
      ),
      null,
    ]);
    expect(metadata).toMatchObject({
      status: "Slice 9 verified on feat/assets-finalize.",
      update_count: 10,
    });
    expect(metadata).not.toHaveProperty("last_update_summary");
    expect(metadata.updates_note).toContain("full: true");

    const full = await tool("fetch", { id, full: true });
    const all = full.structuredContent?.metadata as Thread;
    expect(all.updates.map((update) => update.body)).toEqual([
      ...Array.from({ length: 9 }, (_, i) => finding(9 - i).trim()),
      "",
    ]);
    expect(all.updates_note).toBeUndefined();
  });

  it("is smaller by default than the full thread for a to-do with twelve updates", async () => {
    const id = await createTodo("Twelve updates");
    const claimed = await tool("claim_todo", { id, ttl_seconds: 600 }, "alice");
    for (let n = 1; n <= 9; n++) {
      await tool(
        "update_todo",
        { id, token: token(claimed), body: finding(n) },
        "alice",
      );
    }
    await tool("comment_todo", { id, body: finding(10) }, "bob");
    await tool("comment_todo", { id, body: finding(11) }, "carol");
    const now = (await tool("fetch", { id })).structuredContent;
    const full = (await tool("fetch", { id, full: true, limit: 50 }))
      .structuredContent as { metadata: Thread };
    // The shape a default fetch had before the digest: every body, no ids,
    // no summaries, no freshness fields.
    const before = {
      ...full,
      metadata: Object.fromEntries(
        Object.entries({
          ...full.metadata,
          updates: full.metadata.updates,
        }).filter(
          ([key]) =>
            !key.startsWith("last_update_") &&
            !key.startsWith("status") &&
            !["update_count", "next_cursor"].includes(key),
        ),
      ),
    };
    const sizes = {
      before: JSON.stringify(before).length,
      after: JSON.stringify(now).length,
    };
    console.log(`fetch of a 12-update to-do, bytes: ${JSON.stringify(sizes)}`);
    expect(full.metadata.updates).toHaveLength(12);
    expect(sizes.after).toBeLessThan(sizes.before * 0.6);
  });
});

describe("freshness on list_ready and search", () => {
  it("puts each to-do's status in the structured result and sends no second block", async () => {
    const busy = await createTodo("Pending but busy");
    const idle = await createTodo("Pending and idle");
    await tool("comment_todo", { id: busy, body: "Four slices pass verify." });

    const ready = await tool("list_ready", { project: "valise" });
    expect(
      cachedListReadyOutput.safeParse(ready.structuredContent).success,
    ).toBe(true);
    expect(ready.content).toHaveLength(1);

    const found = await tool("search", { query: "pending" });
    expect(cachedSearchOutput.safeParse(found.structuredContent).success).toBe(
      true,
    );
    expect(found.content).toHaveLength(1);
    const results = (
      found.structuredContent as {
        results: { id: string; metadata: Record<string, unknown> }[];
      }
    ).results;
    expect(results.find((hit) => hit.id === busy)?.metadata).toMatchObject({
      status: "Four slices pass verify.",
      status_at: expect.any(Number),
    });
    expect(results.find((hit) => hit.id === idle)?.metadata).toMatchObject({
      status: null,
      status_at: null,
    });
  });

  it("answers activity with claimed, pending, blocked and recent done work, grouped, newest activity first", async () => {
    const now = Math.floor(Date.now() / 1000);
    const pendingOld = await createTodo("Pending, edited long ago");
    const pendingBusy = await createTodo("Pending with fresh progress");
    const claimedOne = await createTodo("Claimed now");
    const blockedOne = await createTodo("Blocked on review");
    const doneRecent = await createTodo("Done yesterday");
    const doneOld = await createTodo("Done last month");
    const elsewhere = await createTodo("Other project", "homelab");
    await db.batch([
      db
        .prepare("UPDATE todos SET updated_at = ? WHERE todo_id IN (?, ?)")
        .bind(now - 5000, bare(pendingOld), bare(pendingBusy)),
      db
        .prepare(
          "UPDATE todos SET state = 'done', completed_at = ? WHERE todo_id = ?",
        )
        .bind(now - 86_400, bare(doneRecent)),
      db
        .prepare(
          "UPDATE todos SET state = 'done', completed_at = ? WHERE todo_id = ?",
        )
        .bind(now - 30 * 86_400, bare(doneOld)),
    ]);
    await tool("comment_todo", {
      id: pendingBusy,
      body: "Merge waits on PR #153.",
    });
    await tool("claim_todo", { id: claimedOne, ttl_seconds: 600 }, "alice");
    const held = await tool(
      "claim_todo",
      { id: blockedOne, ttl_seconds: 600 },
      "bob",
    );
    await tool(
      "update_todo",
      { id: blockedOne, token: token(held), blocked_on: "PR review" },
      "bob",
    );

    // The coordinator mirrors state into D1 on its alarm.
    await runDurableObjectAlarm(env.TODO_COORDINATOR.getByName("todos:local"));
    const status = await tool("list_ready", {
      project: "valise",
      activity: true,
    });
    const todos = status.structuredContent?.todos as Record<string, unknown>[];
    expect(todos.map((todo) => [todo.id, todo.state])).toEqual([
      [claimedOne, "claimed"],
      [pendingBusy, "pending"],
      [pendingOld, "pending"],
      [blockedOne, "blocked"],
      [doneRecent, "done"],
    ]);
    expect(todos.map((todo) => todo.id)).not.toContain(doneOld);
    expect(todos.map((todo) => todo.id)).not.toContain(elsewhere);
    // A latest summary that is the status is sent once, as the status.
    expect(todos[1]).toMatchObject({
      status: "Merge waits on PR #153.",
      update_count: 1,
      last_update_kind: "comment",
    });
    expect(todos[1]).not.toHaveProperty("last_update_summary");
    // No updates: the freshness fields are left out, not sent empty.
    for (const key of ["update_count", "last_update_at", "last_update_summary"])
      expect(todos[2]).not.toHaveProperty(key);
    expect(todos[0]).toMatchObject({ lease_holder: "alice" });
    expect(todos[3]).toMatchObject({
      blocked_on: "PR review",
      last_update_kind: "blocked",
    });
  });
});

type Thread = {
  update_count: number;
  updates_note?: string;
  updates: { kind: string; summary?: string | null; body?: string }[];
};

function bare(id: string) {
  return id.slice("todo:".length);
}

async function createTodo(title: string, project = "valise"): Promise<string> {
  const result = await tool("create_todo", { title, project });
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
  expect(value.result.isError, raw).not.toBe(true);
  return value.result;
}

function token(result: { structuredContent?: Record<string, unknown> }) {
  const value = result.structuredContent?.token;
  expect(value).toEqual(expect.any(Number));
  return value as number;
}
