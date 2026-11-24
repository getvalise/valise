import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { callMcp } from "./fixture-worker";

// The lease holder is the agent plus its session when the claim recorded one.
// ADR-0002, amendment of 2026-11-24.

const db = env.DB;
const stub = () => env.TODO_COORDINATOR.getByName("todos:local");

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_comments",
    "todo_relations",
    "todo_updates",
    "todos",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

type Caller = { agent: string; session?: string };

const S1 = "11111111-1111-4111-8111-111111111111";
const S2 = "22222222-2222-4222-8222-222222222222";
const holder: Caller = { agent: "claude-code", session: S1 };
const sibling: Caller = { agent: "claude-code", session: S2 };
const sessionless: Caller = { agent: "claude-code" };
const stranger: Caller = { agent: "chatgpt", session: S1 };

describe("who holds a lease", () => {
  it("shows the fencing token on fetch to the holding session only", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 600 }, holder);
    // The holder rides with the fence: no alarm has mirrored the claim yet.
    expect(await fetchedToken(id, holder)).toBe(token(claimed));
    expect(await fetchedToken(id, sibling)).toBeUndefined();
    expect(await fetchedToken(id, sessionless)).toBeUndefined();
    expect(await fetchedToken(id, stranger)).toBeUndefined();

    // Everyone still sees who holds it.
    await runDurableObjectAlarm(stub());
    expect(await metadata(id, sibling)).toMatchObject({
      state: "claimed",
      lease_holder: "claude-code",
    });
  });

  it("keys a claim from a client without a session on its agent alone", async () => {
    const id = await createTodo();
    const claimed = await tool(
      "claim_todo",
      { id, ttl_seconds: 600 },
      sessionless,
    );
    expect(await fetchedToken(id, sessionless)).toBe(token(claimed));
    expect(await fetchedToken(id, holder)).toBe(token(claimed));
    expect(await fetchedToken(id, stranger)).toBeUndefined();
  });

  it("gives the holding session its current token back on a re-claim, and refuses every other session", async () => {
    const id = await createTodo();
    const first = await tool("claim_todo", { id, ttl_seconds: 60 }, holder);

    for (const other of [sibling, sessionless, stranger]) {
      const refused = await tool("claim_todo", { id }, other);
      expect(refused.isError).toBe(true);
      expect(text(refused)).toContain("already claimed");
    }

    const again = await tool("claim_todo", { id, ttl_seconds: 900 }, holder);
    expect(again.isError, text(again)).not.toBe(true);
    expect(token(again)).toBe(token(first));
    expect(expiresAt(again)).toBeGreaterThan(expiresAt(first));
    // A recovery is not a new claim: the log keeps the one claim entry.
    expect(await kinds(id)).toEqual(["claim"]);

    const written = await tool(
      "update_todo",
      { id, token: token(again), body: "carried on" },
      holder,
    );
    expect(written.isError, text(written)).not.toBe(true);
  });
});

describe("an expired lease nobody re-claimed", () => {
  it("revives on its holder's next write after the alarm released it", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, holder);
    await expire(id);
    expect(await runDurableObjectAlarm(stub())).toBe(true);
    expect(await metadata(id, holder)).toMatchObject({ state: "pending" });

    const before = Math.floor(Date.now() / 1000);
    const written = await tool(
      "update_todo",
      { id, token: token(claimed), body: "still on it" },
      holder,
    );
    expect(written.isError, text(written)).not.toBe(true);
    expect(token(written)).toBe(token(claimed));
    expect(expiresAt(written)).toBeGreaterThanOrEqual(before + 30 * 60);

    await runDurableObjectAlarm(stub());
    expect(await metadata(id, holder)).toMatchObject({
      state: "claimed",
      lease_holder: "claude-code",
      fencing_token: token(claimed),
    });
    expect(await kinds(id)).toEqual(["claim", "release", "claim", "progress"]);
    const revival = await db
      .prepare(
        "SELECT body FROM todo_updates WHERE todo_id = ? AND kind = 'claim' ORDER BY rowid DESC LIMIT 1",
      )
      .bind(id.slice("todo:".length))
      .first<{ body: string }>();
    expect(revival?.body).toBe("revived its expired lease");

    const done = await tool(
      "complete_todo",
      { id, token: token(claimed), summary: "Finished." },
      holder,
    );
    expect(done.isError, text(done)).not.toBe(true);
  });

  it("revives before the alarm has run, and completes in the same call", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, holder);
    await expire(id);
    const done = await tool(
      "complete_todo",
      { id, token: token(claimed), summary: "Finished late." },
      holder,
    );
    expect(done.isError, text(done)).not.toBe(true);
    expect(await kinds(id)).toEqual(["claim", "claim", "complete"]);
  });

  it("refuses the old token once another session has claimed over it", async () => {
    const id = await createTodo();
    const first = await tool("claim_todo", { id, ttl_seconds: 60 }, holder);
    await expire(id);
    await runDurableObjectAlarm(stub());
    const second = await tool("claim_todo", { id, ttl_seconds: 60 }, sibling);
    expect(token(second)).toBeGreaterThan(token(first));

    const stale = await tool(
      "update_todo",
      { id, token: token(first), body: "late finding" },
      holder,
    );
    expect(stale.isError).toBe(true);
    expect(text(stale)).toContain("stale fencing token");
  });

  it("refuses another agent holding the token", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, holder);
    await expire(id);
    await runDurableObjectAlarm(stub());
    const refused = await tool(
      "update_todo",
      { id, token: token(claimed), body: "not mine" },
      stranger,
    );
    expect(refused.isError).toBe(true);
  });

  it("does not revive a lease its holder released", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 600 }, holder);
    const released = await tool(
      "update_todo",
      { id, token: token(claimed), release: true },
      holder,
    );
    expect(released.isError, text(released)).not.toBe(true);
    const stale = await tool(
      "update_todo",
      { id, token: token(claimed), body: "changed my mind" },
      holder,
    );
    expect(stale.isError).toBe(true);
  });

  it("keeps structured prerequisites added while it lapsed", async () => {
    const id = await createTodo();
    const prerequisite = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 60 }, holder);
    await expire(id);
    await runDurableObjectAlarm(stub());
    const related = await tool(
      "update_todo",
      { id, relations: { add_depends_on: [prerequisite] } },
      holder,
    );
    expect(related.isError, text(related)).not.toBe(true);

    const refused = await tool(
      "update_todo",
      { id, token: token(claimed), body: "carrying on" },
      holder,
    );
    expect(refused.isError).toBe(true);
    expect(text(refused)).toContain("unfinished dependencies");
  });
});

describe("a release", () => {
  it("mirrors at once instead of at the old lease's expiry", async () => {
    const id = await createTodo();
    const claimed = await tool("claim_todo", { id, ttl_seconds: 3600 }, holder);
    await runDurableObjectAlarm(stub());
    await tool(
      "update_todo",
      { id, token: token(claimed), release: true },
      holder,
    );
    const alarm = await runInDurableObject(stub(), (_instance, state) =>
      state.storage.getAlarm(),
    );
    // Null when it already ran; the bug left it at the lease's expiry.
    expect(alarm === null || alarm < Date.now() + 5_000).toBe(true);
    await runDurableObjectAlarm(stub());
    expect(await metadata(id, holder)).toMatchObject({ state: "pending" });
  });
});

async function createTodo(): Promise<string> {
  const result = await tool(
    "create_todo",
    { title: "Hold the durable work", project: "valise" },
    holder,
  );
  return result.structuredContent?.id as string;
}

/**
 * Moves the lease's expiry into the past without waiting for it, and parks
 * the alarm an hour out so it runs only when a test runs it.
 */
async function expire(id: string) {
  await runInDurableObject(stub(), async (_instance, state) => {
    state.storage.sql.exec(
      "UPDATE coordinator_todos SET lease_expires_at = 1 WHERE todo_id = ?",
      id.slice("todo:".length),
    );
    await state.storage.setAlarm(Date.now() + 3_600_000);
  });
}

async function kinds(id: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT kind FROM todo_updates WHERE todo_id = ? ORDER BY rowid")
    .bind(id.slice("todo:".length))
    .all<{ kind: string }>();
  return results.map((row) => row.kind);
}

async function metadata(id: string, caller: Caller) {
  const fetched = await tool("fetch", { id }, caller);
  expect(fetched.isError, text(fetched)).not.toBe(true);
  return fetched.structuredContent?.metadata as Record<string, unknown>;
}

async function fetchedToken(id: string, caller: Caller) {
  return (await metadata(id, caller)).fencing_token;
}

async function tool(
  name: string,
  args: Record<string, unknown>,
  caller: Caller,
) {
  const { response, raw, value } = await callMcp(
    "tools/call",
    { name, arguments: args },
    caller.agent,
    undefined,
    caller.session ? { "x-valise-session": caller.session } : {},
  );
  expect(response.status, raw).toBe(200);
  return value.result as Record<string, unknown> & {
    isError?: boolean;
    structuredContent?: Record<string, unknown>;
    content?: Array<{ text?: string }>;
  };
}

function token(result: { structuredContent?: Record<string, unknown> }) {
  const value = result.structuredContent?.token;
  expect(value).toEqual(expect.any(Number));
  return value as number;
}

function expiresAt(result: { structuredContent?: Record<string, unknown> }) {
  const value = result.structuredContent?.expires_at;
  expect(value).toEqual(expect.any(Number));
  return value as number;
}

function text(result: { content?: Array<{ text?: string }> }) {
  return result.content?.map((entry) => entry.text ?? "").join("\n") ?? "";
}
