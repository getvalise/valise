import { env } from "cloudflare:test";
import { expect, it } from "vitest";
import {
  readOnboarding,
  STARTER_SOURCES,
  setOnboardingDismissed,
} from "~/concepts/onboarding";

async function user(userId: string) {
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, display_name, role, plan, email_verified, created_at)
     VALUES (?, ?, ?, 'member', 'free', 1, 1)`,
  )
    .bind(userId, `${userId}@example.test`, userId)
    .run();
}

async function skill(userId: string, name: string, source: string | null) {
  await env.DB.prepare(
    `INSERT INTO skills (skill_id, user_id, name, head_version_id, source, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 1)`,
  )
    .bind(`skl_${crypto.randomUUID()}`, userId, name, `ver_${name}`, source)
    .run();
}

it("ticks each step from what the store holds, and never from a built-in", async () => {
  const userId = `onboarding-${crypto.randomUUID().slice(0, 8)}`;
  await user(userId);
  const read = () => readOnboarding(env.DB, env.DB, userId);

  const fresh = await read();
  expect(fresh).toMatchObject({
    dismissedAt: null,
    connected: false,
    firstSkill: false,
    complete: false,
  });
  expect(fresh.starters.map((one) => one.name)).toEqual([
    "grill-me",
    "conversation-history",
    "tdd",
  ]);
  expect(fresh.starters.every((one) => !one.added)).toBe(true);

  // A built-in is published for every account; it is not their first skill.
  await skill(userId, `capture-this-${userId}`, "builtin:capture-this");
  expect((await read()).firstSkill).toBe(false);

  // A starter imported from GitHub at any commit counts, and ticks its row.
  await skill(
    userId,
    `conversation-history-${userId}`,
    "github:getvalise/valise@0123456789abcdef0123456789abcdef01234567:skills/conversation-history",
  );
  const added = await read();
  expect(added.firstSkill).toBe(true);
  expect(
    added.starters.find((one) => one.name === "conversation-history")?.added,
  ).toBe(true);
  expect(added.complete).toBe(false);

  // One recorded call from any client is the connection.
  await env.DB.prepare(
    `INSERT INTO mcp_calls (call_id, at, transport, user_id, method, outcome, status, duration_ms)
     VALUES (?, ?, 'oauth', ?, 'tools/list', 'ok', 200, 1)`,
  )
    .bind(`cal_${crypto.randomUUID()}`, Date.now(), userId)
    .run();
  expect(await read()).toMatchObject({ connected: true, complete: true });
});

it("keeps a dismissal on the account until it is brought back", async () => {
  const userId = `onboarding-${crypto.randomUUID().slice(0, 8)}`;
  await user(userId);
  await setOnboardingDismissed(env.DB, userId, true, 1_800_000_000);
  expect((await readOnboarding(env.DB, env.DB, userId)).dismissedAt).toBe(
    1_800_000_000,
  );
  await setOnboardingDismissed(env.DB, userId, false);
  expect((await readOnboarding(env.DB, env.DB, userId)).dismissedAt).toBe(null);
});

it("offers only starters the Add skill dialog already suggests", () => {
  expect(STARTER_SOURCES).toHaveLength(3);
});
