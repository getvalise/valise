import { env } from "cloudflare:test";
import { afterEach, beforeEach, expect, it } from "vitest";
import { readClientSessions } from "~/concepts/activity";
import { listSkillHeads, listSkillVersions } from "~/concepts/skills";

const userId = "navigation-performance-member";
const otherUserId = "navigation-performance-other";

beforeEach(async () => {
  for (const id of [userId, otherUserId]) {
    await env.DB.prepare(`INSERT INTO users (user_id, email, display_name, role, created_at)
      VALUES (?, ?, ?, 'member', 1)`)
      .bind(id, `${id}@example.test`, id)
      .run();
  }
});

afterEach(async () => {
  for (const table of ["skill_versions", "skills", "mcp_calls"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM users WHERE user_id IN (?, ?)")
    .bind(userId, otherUserId)
    .run();
});

it("measures weekly connection sessions without reading argument payloads", async () => {
  const now = Date.now();
  await env.DB.prepare(`WITH RECURSIVE n(i) AS (
    VALUES(0) UNION ALL SELECT i + 1 FROM n WHERE i < 1199
  ) INSERT INTO mcp_calls (call_id, at, transport, user_id, principal, session,
    method, outcome, status, duration_ms, client_info, session_name, args_json)
    SELECT 'perf-' || i, ? - i, 'oauth', ?, 'test-client', 'session-' || (i % 60),
      CASE WHEN i >= 1140 THEN 'initialize' ELSE 'tools/call' END,
      'ok', 200, 1, CASE WHEN i >= 1140 THEN 'client-' || (i % 60) ELSE NULL END,
      'Latest ' || i, ? FROM n`)
    .bind(now, userId, JSON.stringify({ body: "x".repeat(4096) }))
    .run();
  await env.DB.prepare(`INSERT INTO mcp_calls (call_id, at, transport, user_id,
    principal, session, method, outcome, status, duration_ms, client_info)
    VALUES ('foreign-shared-session', ?, 'oauth', ?, 'test-client', 'session-0',
      'tools/call', 'ok', 200, 1, 'Never shown'),
      ('foreign-only-session', ?, 'oauth', ?, 'test-client', 'foreign-session',
      'tools/call', 'ok', 200, 1, 'Foreign client')`)
    .bind(now + 1, otherUserId, now + 2, otherUserId)
    .run();
  const times: number[] = [];
  for (let sample = 0; sample < 5; sample += 1) {
    const start = performance.now();
    const sessions = await readClientSessions(env, userId, now);
    times.push(performance.now() - start);
    expect(sessions).toHaveLength(60);
    expect(sessions[0]).toMatchObject({
      session: "session-0",
      clientInfo: "client-0",
      sessionName: "Latest 0",
      toolCalls: 19,
      lastSeen: now,
    });
    expect(
      sessions.some((session) => session.clientInfo === "Never shown"),
    ).toBe(false);
    expect(
      sessions.some((session) => session.session === "foreign-session"),
    ).toBe(false);
  }
  const otherSessions = await readClientSessions(env, otherUserId, now);
  expect(otherSessions).toHaveLength(2);
  expect(otherSessions.map((session) => session.clientInfo)).toEqual([
    "Foreign client",
    "Never shown",
  ]);
  expect(otherSessions.every((session) => session.toolCalls === 1)).toBe(true);
  console.log(
    "Connections session query; 1200 calls / 60 sessions / 4KB arguments, local D1 ms",
    times,
  );
});

it("measures skill list history work with thirty heads and ninety versions", async () => {
  for (let row = 0; row < 30; row += 1) {
    await env.DB.prepare(`INSERT INTO skills (skill_id, user_id, name, head_version_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1)`)
      .bind(`perf-${row}`, userId, `perf-${row}`, `perf-${row}-3`)
      .run();
    for (let version = 1; version <= 3; version += 1) {
      await env.DB.prepare(`INSERT INTO skill_versions (version_id, skill_id, version,
        body_md, body_sha256, files_json, created_at, created_by)
        VALUES (?, ?, ?, ?, 'digest', '[]', 1, 'test')`)
        .bind(
          `perf-${row}-${version}`,
          `perf-${row}`,
          version,
          `---\nname: perf-${row}\ndescription: version ${version}\n---\n${"Instructions.\n".repeat(100)}`,
        )
        .run();
    }
  }
  const start = performance.now();
  const histories = await Promise.all(
    Array.from({ length: 30 }, (_, row) =>
      listSkillVersions(env.DB, userId, `perf-${row}`),
    ),
  );
  console.log(
    "Skill list history baseline; 30 queries, 90 versions, local D1",
    { ms: performance.now() - start, bytes: JSON.stringify(histories).length },
  );
  expect(histories.flat()).toHaveLength(90);
  const headsStart = performance.now();
  const heads = await listSkillHeads(
    env.DB,
    userId,
    Array.from({ length: 30 }, (_, row) => `perf-${row}`),
  );
  console.log("Skill list heads; 1 query, 30 versions, local D1", {
    ms: performance.now() - headsStart,
    bytes: JSON.stringify([...heads.values()]).length,
  });
  expect(heads.size).toBe(30);
  expect(JSON.stringify([...heads.values()]).length).toBeLessThan(
    JSON.stringify(histories).length,
  );
  for (const [name, head] of heads) {
    const history = histories[Number(name.split("-")[1])];
    expect(head.body).toBe(history.find((version) => version.isHead)?.body);
    expect(head.files).toBe(0);
  }
});

it("excludes another user's named head even when it is requested explicitly", async () => {
  for (const [owner, name] of [
    [userId, "own-performance-skill"],
    [otherUserId, "foreign-performance-skill"],
  ]) {
    await env.DB.prepare(`INSERT INTO skills (skill_id, user_id, name, head_version_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 1, 1)`)
      .bind(name, owner, name, `${name}-v1`)
      .run();
    await env.DB.prepare(`INSERT INTO skill_versions (version_id, skill_id, version, body_md,
      body_sha256, files_json, created_at, created_by)
      VALUES (?, ?, 1, ?, 'digest', '[]', 1, 'test')`)
      .bind(
        `${name}-v1`,
        name,
        `---\nname: ${name}\ndescription: Private to ${owner}\n---\nPrivate instructions.`,
      )
      .run();
  }
  const foreignOnly = await listSkillHeads(env.DB, userId, [
    "foreign-performance-skill",
  ]);
  expect(foreignOnly.size).toBe(0);
  const mixed = await listSkillHeads(env.DB, userId, [
    "own-performance-skill",
    "foreign-performance-skill",
  ]);
  expect([...mixed.keys()]).toEqual(["own-performance-skill"]);
  const otherHeads = await listSkillHeads(env.DB, otherUserId, [
    "own-performance-skill",
    "foreign-performance-skill",
  ]);
  expect([...otherHeads.keys()]).toEqual(["foreign-performance-skill"]);
  expect(otherHeads.get("foreign-performance-skill")?.body).toContain(
    `Private to ${otherUserId}`,
  );
});
