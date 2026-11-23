import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { readStartupBrief } from "~/concepts/startup-brief";
import { runOnWord } from "~/concepts/update-summary";
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

// The overnight opencode agent's summaries, with the spaces stripped out.
const MANGLED = "Haikufocused52f812a70D1+4realbackupPASS";

describe("runOnWord", () => {
  it.each([
    MANGLED,
    "Mergedin#140verifiedon52f812a70passed",
    "Status: Restoredrill41s2114rowsreindexedOK3times",
  ])("refuses %s", (text) => {
    expect(runOnWord(text)).not.toBeNull();
  });

  it.each([
    "Verified at 52f812a70d1e4b3c9f0a1b2c3d4e5f60718293a4 on main.",
    "Short SHA 52f812a passed verify.",
    "Merged https://github.com/getvalise/valise/pull/190?x=a1b2c3d4e5f6g7h8i9 today.",
    "Claimed todo:tdo_f4e6833b-7a1b-4406-98fa-5e201902eaab after tdu_01a17393-08a6-7000-97e5-d673624830ce.",
    "Deployment 3f2a9c1e-55b4-4d2e-9a7b-0c1d2e3f4a5b is live.",
    "ULID 01HZX3K9Q7ABCDEFGH12345678 written.",
    "workerd@1.20261012.1 installed; run 2026-10-24T21-33-41.json at 2026-10-25T10:00:00Z.",
    "Ran VALISE_TEST_PORT=4671 npm run verify:ci on claude-opus-5-5 and gpt-5.6-terra.",
    "Migration 0040_mcp_call_limiter_dimensions.sql applied to D1 and R2.",
    "Renamed migrateToV2SchemaForTodoUpdates in app/mcp/tools.ts:1117.",
    "Rotated `sk-ant-api03-abcdefgh12345678ijklmnop` in the vault.",
    "Internationalization responsibilities verified.",
    "Base64 dGhpcyBpcyBhIHRlc3Q= matches.",
  ])("passes %s", (text) => {
    expect(runOnWord(text)).toBeNull();
  });
});

describe("unreadable summaries at write time", () => {
  it("refuses a run-on summary on update_todo, comment_todo and complete_todo, and writes nothing", async () => {
    const id = await createTodo("Overnight coordination");
    const t = token(await tool("claim_todo", { id, ttl_seconds: 600 }));

    const updated = await call("update_todo", {
      id,
      token: t,
      body: "Backup check passed.",
      summary: MANGLED,
    });
    expect(updated.isError).toBe(true);
    expect(text(updated)).toContain(`"${MANGLED}"`);
    expect(text(updated)).toContain("plain sentence");

    // Without a summary the body's opening sentences are the line, so they are judged.
    const fromBody = await call("update_todo", {
      id,
      token: t,
      body: `${MANGLED}\n\nMore detail.`,
    });
    expect(fromBody.isError).toBe(true);
    expect(text(fromBody)).toContain("summary taken from the body");

    const commented = await call("comment_todo", { id, body: MANGLED });
    expect(commented.isError).toBe(true);

    const completed = await call("complete_todo", {
      id,
      token: t,
      summary: MANGLED,
    });
    expect(completed.isError).toBe(true);

    const counts = await db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM todo_updates WHERE todo_id = ?1 AND kind <> 'claim') AS updates,
                (SELECT COUNT(*) FROM todo_comments WHERE todo_id = ?1) AS comments`,
      )
      .bind(bare(id))
      .first<{ updates: number; comments: number }>();
    expect(counts).toEqual({ updates: 0, comments: 0 });

    // The same facts written as a sentence go through, ids and SHA included.
    await tool("update_todo", {
      id,
      token: t,
      body: "Haiku is the focus. Backup restore passed on D1 at 52f812a70.",
      summary: `Backup restore passed on D1 at 52f812a70 for ${id}.`,
    });
  });
});

describe("a to-do's status", () => {
  it("follows progress, comments and blockers, ignores claims and releases, and leads every read", async () => {
    const id = await createTodo("Status through a thread");
    const quiet = await createTodo("Never touched");
    const t = token(await tool("claim_todo", { id, ttl_seconds: 600 }));
    expect(await fetchedStatus(id)).toEqual({ status: null, status_at: null });

    await tool("update_todo", {
      id,
      token: t,
      body: "Long finding. It goes on.",
      summary: "Slice 1 passes verify.",
    });
    expect((await fetchedStatus(id)).status).toBe("Slice 1 passes verify.");

    await tool("comment_todo", {
      id,
      body: "Is slice 2 blocked?\n\nAsking because the branch is quiet.",
    });
    expect((await fetchedStatus(id)).status).toBe("Is slice 2 blocked?");

    // A renewal and a new claim say who holds it, not how far it got.
    await tool("update_todo", { id, token: t, renew_ttl_seconds: 900 });
    await db
      .prepare(
        `INSERT INTO todo_updates (update_id, todo_id, kind, author, token, body, summary, created_at)
         VALUES ('tdu_zzzz_release', ?, 'release', 'console', 2, '', NULL, ?)`,
      )
      .bind(bare(id), Math.floor(Date.now() / 1000) + 5)
      .run();
    const fetched = await tool("fetch", { id });
    const metadata = fetched.structuredContent?.metadata as Record<
      string,
      unknown
    >;
    expect(Object.keys(metadata).slice(0, 2)).toEqual(["status", "status_at"]);
    // The newest update is the release, which leaves the status alone.
    expect(metadata.status).toBe("Is slice 2 blocked?");
    expect((metadata.updates as { kind: string }[])[0].kind).toBe("release");

    // list_ready lists pending work, so this one is commented on, not claimed.
    const pending = await createTodo("Pending with a question");
    await tool("comment_todo", { id: pending, body: "Which branch is it on?" });
    const found = await tool("search", { query: "pending question" });
    const hit = (
      found.structuredContent as {
        results: { id: string; metadata: Record<string, unknown> }[];
      }
    ).results.find((one) => one.id === pending);
    expect(hit?.metadata).toMatchObject({
      status: "Which branch is it on?",
      status_at: expect.any(Number),
    });

    // Claude Code shows a model structuredContent only, so every list puts
    // the status in its structured rows, right after the title.
    for (const [name, args] of [
      ["list_ready", { project: "valise" }],
      ["list_todos", { project: "valise" }],
      ["get_brief", { project: "valise" }],
      ["list_ready", { project: "valise", activity: true }],
    ] as const) {
      const result = await tool(name, args);
      const content = result.structuredContent ?? {};
      const rows = (
        "todos" in content
          ? content.todos
          : ["ready", "claimed", "blocked", "completed"].flatMap(
              (key) => (content[key] as { items: unknown[] }).items,
            )
      ) as Record<string, unknown>[];
      // list_todos and get_brief leave out a status a row does not have.
      for (const row of rows)
        expect(Object.keys(row).slice(0, 4), name).toEqual(
          "status" in row
            ? ["id", "title", "status", "status_at"]
            : ["id", "title", ...Object.keys(row).slice(2, 4)],
        );
      const byId = new Map(rows.map((row) => [row.id, row]));
      expect(byId.get(pending), name).toMatchObject({
        status: "Which branch is it on?",
        status_at: expect.any(Number),
      });
      if (name !== "list_ready" || "activity" in args)
        expect(byId.get(id), name).toMatchObject({
          status: "Is slice 2 blocked?",
        });
      // A to-do nobody has updated has no status: list_ready keeps the null
      // its cached schema requires, list_todos and get_brief leave it out.
      if (byId.has(quiet)) {
        const quietRow = byId.get(quiet) as Record<string, unknown>;
        expect(quietRow.status ?? null, name).toBeNull();
        expect(quietRow.status_at ?? null, name).toBeNull();
      }
    }

    // The release above was dated five seconds ahead, so a blocker written
    // now would sort before it and read as already resolved.
    await db
      .prepare("DELETE FROM todo_updates WHERE update_id = 'tdu_zzzz_release'")
      .run();
    await tool("update_todo", { id, token: t, blocked_on: "Review of #195." });
    expect((await fetchedStatus(id)).status).toBe("Review of #195.");
  });

  it("is the completion summary once done", async () => {
    const id = await createTodo("Finish me");
    const t = token(await tool("claim_todo", { id, ttl_seconds: 600 }));
    await tool("complete_todo", { id, token: t, summary: "Merged in #196." });
    expect((await fetchedStatus(id)).status).toBe("Merged in #196.");
    // The SessionStart hook text carries it too.
    const hook = await readStartupBrief(db, "local");
    expect(hook).toMatch(/\n {2}status \d+: Merged in #196\./);
  });

  // J3 acceptance, 2026-10-29: a reopened to-do still read "Completed".
  it("drops a completion or a blocker once a later claim or release moved the to-do on", async () => {
    const id = await createTodo("Reopen me");
    await tool("comment_todo", { id, body: "Needs the fixture first." });
    const t = token(await tool("claim_todo", { id, ttl_seconds: 600 }));
    await tool("complete_todo", { id, token: t, summary: "Merged in #197." });
    expect(await statusEverywhere(id)).toEqual("Merged in #197.");

    // The console's reopen writes a release, a second later.
    await db
      .prepare(
        `INSERT INTO todo_updates (update_id, todo_id, kind, author, token, body, summary, created_at)
         VALUES ('tdu_zzzz_reopen', ?, 'release', 'console', 3, 'reopened from the console', 'reopened from the console', ?)`,
      )
      .bind(bare(id), Math.floor(Date.now() / 1000) + 1)
      .run();
    await db
      .prepare(
        "UPDATE todos SET state = 'pending', completed_at = NULL WHERE todo_id = ?",
      )
      .bind(bare(id))
      .run();
    expect(await statusEverywhere(id)).toEqual("Needs the fixture first.");

    // A claim on a blocked to-do resolves its blocker.
    const blocked = await createTodo("Block me");
    const b = token(
      await tool("claim_todo", { id: blocked, ttl_seconds: 600 }),
    );
    await tool("update_todo", {
      id: blocked,
      token: b,
      blocked_on: "Waiting on review.",
    });
    expect(await statusEverywhere(blocked)).toEqual("Waiting on review.");
    await db
      .prepare(
        "UPDATE todo_updates SET created_at = created_at - 5 WHERE todo_id = ?",
      )
      .bind(bare(blocked))
      .run();
    await tool("claim_todo", { id: blocked, ttl_seconds: 600 });
    expect(await statusEverywhere(blocked)).toBeNull();
  });
});

/** The status fetch reports, after checking list_todos reports the same. */
async function statusEverywhere(id: string): Promise<string | null> {
  const fetched = (await fetchedStatus(id)).status;
  const listed = (
    (await tool("list_todos", { project: "valise" })).structuredContent as {
      todos: { id: string; status: string | null }[];
    }
  ).todos.find((row) => row.id === id);
  expect(listed?.status ?? null, "list_todos and fetch disagree").toBe(fetched);
  return fetched;
}

describe("fetch pages a to-do's updates", () => {
  it("returns ten newest first with a cursor, follows it to the oldest, and keeps full inside the page", async () => {
    const id = await createTodo("A 127-update night, smaller");
    const t = token(await tool("claim_todo", { id, ttl_seconds: 600 }));
    for (let n = 1; n <= 24; n++)
      await tool("update_todo", { id, token: t, body: `Step ${n} done.` });

    const first = thread(await tool("fetch", { id }));
    expect(first.update_count).toBe(25);
    expect(
      first.updates.map((update) => update.body ?? update.summary),
    ).toEqual(Array.from({ length: 10 }, (_, i) => `Step ${24 - i} done.`));
    expect(first.updates.map((update) => "body" in update)).toEqual([
      ...Array(3).fill(true),
      ...Array(7).fill(false),
    ]);
    const { results: ids } = await db
      .prepare(
        "SELECT update_id FROM todo_updates WHERE todo_id = ? ORDER BY created_at DESC, update_id DESC",
      )
      .bind(bare(id))
      .all<{ update_id: string }>();
    expect(first.next_cursor).toBe(ids[9].update_id);
    expect(first.updates_note).toContain(`cursor: "${first.next_cursor}"`);

    const second = thread(
      await tool("fetch", { id, cursor: first.next_cursor, full: true }),
    );
    expect(second.updates.map((update) => update.body)).toEqual(
      Array.from({ length: 10 }, (_, i) => `Step ${14 - i} done.`),
    );

    const last = thread(
      await tool("fetch", { id, cursor: second.next_cursor, limit: 10 }),
    );
    expect(last.updates.map((update) => update.summary)).toEqual([
      ...Array.from({ length: 4 }, (_, i) => `Step ${4 - i} done.`),
      null,
    ]);
    expect(last.updates.at(-1)?.kind).toBe("claim");
    expect(last.updates.some((update) => "body" in update)).toBe(false);
    // The oldest page has no next one, so it sends no cursor.
    expect(last).not.toHaveProperty("next_cursor");

    // A new update arriving between pages does not shift the next page.
    await tool("update_todo", { id, token: t, body: "Step 25 done." });
    const again = thread(
      await tool("fetch", { id, cursor: first.next_cursor, limit: 3 }),
    );
    expect(again.updates.map((update) => update.summary)).toEqual([
      "Step 14 done.",
      "Step 13 done.",
      "Step 12 done.",
    ]);

    const stale = await call("fetch", { id, cursor: "tdu_not_here" });
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("Fetch without cursor");
  });
});

type Thread = {
  status: string | null;
  update_count: number;
  next_cursor: string | null;
  updates_note?: string;
  updates: {
    kind: string;
    summary?: string | null;
    body?: string;
  }[];
};

function thread(result: { structuredContent?: Record<string, unknown> }) {
  return result.structuredContent?.metadata as Thread;
}

async function fetchedStatus(id: string) {
  const metadata = thread(await tool("fetch", { id })) as unknown as {
    status: string | null;
    status_at: number | null;
  };
  // fetch leaves out a status it does not have (2026-11-15).
  return {
    status: metadata.status ?? null,
    status_at: metadata.status_at ?? null,
  };
}

function text(result: { content?: unknown }) {
  return (result.content as { text: string }[])[0].text;
}

function bare(id: string) {
  return id.slice("todo:".length);
}

async function createTodo(title: string): Promise<string> {
  const result = await tool("create_todo", { title, project: "valise" });
  return result.structuredContent?.id as string;
}

async function call(name: string, args: Record<string, unknown>) {
  const { response, raw, value } = await callMcp(
    "tools/call",
    { name, arguments: args },
    "vitest",
  );
  expect(response.status, raw).toBe(200);
  return value.result as {
    isError?: boolean;
    content?: unknown;
    structuredContent?: Record<string, unknown>;
  };
}

async function tool(name: string, args: Record<string, unknown>) {
  const result = await call(name, args);
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  return result;
}

function token(result: { structuredContent?: Record<string, unknown> }) {
  const value = result.structuredContent?.token;
  expect(value).toEqual(expect.any(Number));
  return value as number;
}
