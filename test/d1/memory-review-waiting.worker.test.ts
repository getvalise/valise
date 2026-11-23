import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { countWaitingQuestions } from "~/concepts/memory-review";

const db = env.DB;

async function group(userId: string, id: string, state: string) {
  await db
    .prepare(
      `INSERT INTO memory_review_groups (group_id, user_id, fingerprint, model, prompt_version, sources_json, state, created_at, updated_at)
       VALUES (?, ?, ?, 'm', 'v', '[]', ?, unixepoch(), unixepoch())`,
    )
    .bind(id, userId, `fp-${id}`, state)
    .run();
}

describe("countWaitingQuestions", () => {
  beforeEach(async () => {
    await db.prepare("DELETE FROM memory_review_groups").run();
  });

  it("counts only the person's own proposals", async () => {
    expect(await countWaitingQuestions(db, "local")).toBe(0);
    await group("local", "g1", "proposal");
    await group("local", "g2", "proposal");
    for (const [i, state] of [
      "running",
      "noop",
      "failed",
      "dismissed",
      "accepted",
    ].entries())
      await group("local", `d${i}`, state);
    await group("foreign", "f1", "proposal");
    expect(await countWaitingQuestions(db, "local")).toBe(2);
    expect(await countWaitingQuestions(db, "foreign")).toBe(1);
  });

  it("reads through the state index rather than scanning the table", async () => {
    const { results } = await db
      .prepare(
        "EXPLAIN QUERY PLAN SELECT COUNT(*) AS n FROM memory_review_groups WHERE user_id = ? AND state = 'proposal'",
      )
      .bind("local")
      .all<{ detail: string }>();
    expect(results.map((r) => r.detail).join(" ")).toMatch(
      /USING (COVERING )?INDEX memory_review_retry/,
    );
  });
});
