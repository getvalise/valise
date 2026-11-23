import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  groupTrail,
  readTrail,
  timeRange,
  trailHref,
  trailOutcomes,
  trailWindow,
} from "~/concepts/trail";
import { callMcp } from "./fixture-worker";

/**
 * J9: a member's activity trail. Rows come from the writes themselves, by
 * real tool calls under two users, so a foreign write with the same project
 * and the same title is the distractor the trail must not show.
 */

const db = env.DB;
const MEMBER = "usr_trail_member";
const OTHER = "usr_trail_other";

afterEach(async () => {
  for (const table of [
    "search_docs",
    "memory_revisions",
    "memories",
    "todo_comments",
    "todo_updates",
    "todos",
    "skill_versions",
    "skills",
    "mcp_calls",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

async function tool(
  user: string,
  agent: string,
  name: string,
  args: Record<string, unknown>,
) {
  const { response, raw, value } = await callMcp(
    "tools/call",
    { name, arguments: args },
    agent,
    "application/json, text/event-stream",
    { "x-valise-user": user },
  );
  expect(response.status, raw).toBe(200);
  expect(value.result.isError, raw).not.toBe(true);
  return value.result.structuredContent as Record<string, any>;
}

const now = () => trailWindow(new URL("http://x/activity"));

describe("readTrail", () => {
  it("lists one tenant's writes newest first, by session, with outcomes and links", async () => {
    const todo = await tool(MEMBER, "agent-a", "create_todo", {
      title: "Trail task",
      project: "trail",
    });
    const lease = await tool(MEMBER, "agent-a", "claim_todo", { id: todo.id });
    await tool(MEMBER, "agent-a", "complete_todo", {
      id: todo.id,
      token: lease.token,
      summary: "Trail task finished.",
    });
    await tool(MEMBER, "agent-b", "save_memory", {
      title: "Trail memory",
      body: "A synthetic decision for the trail.",
      type: "decision",
      project: "trail",
      tags: ["trail"],
    });
    // Whole-second timestamps: date the to-do's lifecycle before the memory.
    for (const table of ["todos", "todo_updates"])
      await db
        .prepare(`UPDATE ${table} SET created_at = created_at - 10`)
        .run();
    // The same title and project in another tenant.
    await tool(OTHER, "agent-a", "create_todo", {
      title: "Trail task",
      project: "trail",
    });

    const { events, counts, truncated } = await readTrail(db, MEMBER, now());
    expect(truncated).toBe(false);
    expect(events.map((event) => [event.concept, event.action])).toEqual([
      ["memory", "saved"],
      ["todo", "complete"],
      ["todo", "claim"],
      ["todo", "created"],
    ]);
    expect(events.every((event) => event.title.startsWith("Trail"))).toBe(true);
    expect(events.filter((event) => event.concept === "todo")).toHaveLength(3);
    expect(trailOutcomes(counts)).toEqual([
      "1 to-do completed",
      "1 to-do created",
      "1 memory saved",
    ]);
    const runs = groupTrail(events);
    expect(runs.map((run) => [run.agent, run.events.length])).toEqual([
      ["agent-b", 1],
      ["agent-a", 3],
    ]);
    expect(trailHref(events[1])).toBe(
      `/todos?open=${encodeURIComponent(todo.id)}`,
    );
    expect(trailHref(events[0])).toMatch(/^\/memories\?open=memory%3Amem_/);

    const other = await readTrail(db, OTHER, now());
    expect(other.events).toHaveLength(1);
  });

  it("narrows to a project and to one UTC day", async () => {
    await tool(MEMBER, "agent-a", "create_todo", {
      title: "In trail",
      project: "trail",
    });
    await tool(MEMBER, "agent-a", "create_todo", {
      title: "Elsewhere",
      project: "other",
    });
    const url = new URL("http://x/activity?project=trail");
    const narrowed = await readTrail(db, MEMBER, trailWindow(url));
    expect(narrowed.events.map((event) => event.title)).toEqual(["In trail"]);

    const today = new Date().toISOString().slice(0, 10);
    const day = trailWindow(new URL(`http://x/activity?day=${today}`));
    expect(day.until - day.since).toBe(86_400);
    expect((await readTrail(db, MEMBER, day)).events).toHaveLength(2);
    const before = trailWindow(new URL("http://x/activity?day=2000-01-01"));
    expect((await readTrail(db, MEMBER, before)).events).toHaveLength(0);
    // A malformed day falls back to the default window, not to everything.
    const junk = trailWindow(new URL("http://x/activity?day=yesterday"));
    expect(junk.day).toBeNull();
    expect(junk.until - junk.since).toBe(7 * 86_400);
  });
});

describe("timeRange", () => {
  // J9 production run, 2026-10-29: a block read "12:48–12:48 UTC".
  it("shows one time for a block inside one minute", () => {
    const at = Date.parse("2026-10-29T12:48:05Z") / 1000;
    expect(timeRange(at, at + 40)).toBe("12:48");
    expect(timeRange(at, at + 60)).toBe("12:48–12:49");
  });
});
