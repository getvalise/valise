import { env } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { changeSkills } from "~/concepts/skills";
import { callMcp } from "./fixture-worker";

const OWNER = "local";
const MEMBER = "usr_same_name";
const NAME = "shared-name";

afterEach(async () => {
  for (const table of ["search_docs", "skill_versions", "skills", "mcp_calls"])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

async function rpc(
  userId: string,
  method: string,
  params: Record<string, unknown>,
) {
  const { response, value, raw } = await callMcp(
    method,
    params,
    "vitest",
    "application/json, text/event-stream",
    { "x-valise-user": userId },
  );
  expect(response.status, raw).toBe(200);
  return value;
}

async function tool(
  userId: string,
  name: string,
  args: Record<string, unknown>,
) {
  return (await rpc(userId, "tools/call", { name, arguments: args })).result;
}

function body(text: string) {
  return `---\nname: ${NAME}\ndescription: Tenant-local instructions.\n---\n${text}`;
}

it("keeps same-name skill bodies, files, versions, prompts and deletion independent", async () => {
  const owner = await tool(OWNER, "publish_skill", {
    body: body("Owner private instructions."),
    files: [{ path: "guide.md", content: "Owner private attachment." }],
  });
  const member = await tool(MEMBER, "publish_skill", {
    body: body("Member private instructions."),
    files: [{ path: "guide.md", content: "Member private attachment." }],
  });
  expect(owner.isError).toBeFalsy();
  expect(member.isError).toBeFalsy();
  const ownerId = owner.structuredContent?.id;
  const memberId = member.structuredContent?.id;
  expect(ownerId).toEqual(expect.any(String));
  expect(memberId).toEqual(expect.any(String));
  expect(ownerId).not.toBe(memberId);

  // The database, not a preflight read, settles concurrent same-tenant names.
  await expect(
    env.DB.prepare(
      "INSERT INTO skills (skill_id, user_id, name, created_at, updated_at) VALUES ('skl_duplicate', ?, ?, 1, 1)",
    )
      .bind(MEMBER, NAME)
      .run(),
  ).rejects.toThrow(/UNIQUE constraint failed/);

  for (const [user, label, foreignId] of [
    [OWNER, "Owner", memberId],
    [MEMBER, "Member", ownerId],
  ] as const) {
    expect(
      (await tool(user, "get_skill", { name: NAME })).structuredContent?.body,
    ).toContain(`${label} private instructions.`);
    expect(
      (await tool(user, "read_skill_file", { name: NAME, path: "guide.md" }))
        .structuredContent?.text,
    ).toBe(`${label} private attachment.`);
    expect(
      JSON.stringify((await rpc(user, "prompts/get", { name: NAME })).result),
    ).toContain(`${label} private instructions.`);
    expect(
      JSON.stringify(
        (
          await rpc(user, "resources/read", {
            uri: `skill://${NAME}/SKILL.md`,
          })
        ).result,
      ),
    ).toContain(`${label} private instructions.`);
    expect((await tool(user, "fetch", { id: foreignId })).isError).toBe(true);
    const search = await tool(user, "search", {
      query: "instructions",
      type: "skill",
    });
    const results = search.structuredContent?.results as { id: string }[];
    expect(results.map((row) => row.id)).toEqual([
      user === OWNER ? ownerId : memberId,
    ]);
  }

  const edited = await tool(MEMBER, "publish_skill", {
    body: body("Member revised instructions."),
    files: [],
  });
  expect(edited.isError).toBeFalsy();
  expect(edited.structuredContent).toMatchObject({ id: memberId, version: 2 });
  expect(
    (await tool(OWNER, "get_skill", { name: NAME })).structuredContent,
  ).toMatchObject({ id: ownerId, version: 1 });
  expect(
    (await tool(MEMBER, "get_skill", { name: NAME, version: 1 }))
      .structuredContent?.body,
  ).toContain("Member private instructions.");

  await changeSkills(env, MEMBER, [NAME], "delete");
  expect((await tool(MEMBER, "get_skill", { name: NAME })).isError).toBe(true);
  expect(
    (await tool(OWNER, "get_skill", { name: NAME })).structuredContent?.body,
  ).toContain("Owner private instructions.");
  const counts = await env.DB.prepare(
    "SELECT user_id, COUNT(*) AS n FROM skills WHERE name = ? GROUP BY user_id ORDER BY user_id",
  )
    .bind(NAME)
    .all();
  expect(counts.results).toEqual([
    { user_id: OWNER, n: 1 },
    { user_id: MEMBER, n: 1 },
  ]);
});
