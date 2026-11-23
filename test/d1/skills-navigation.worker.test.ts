import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, expect, it, vi } from "vitest";
import * as skills from "~/concepts/skills";
import { consoleContext, requireConsoleActor } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { loader } from "~/routes/skills";

const userId = "skills-navigation-member";
const otherUserId = "skills-navigation-other";

async function signedIn(id: string) {
  await env.DB.prepare(`INSERT INTO users (user_id, email, display_name, role, created_at, email_verified)
    VALUES (?, ?, ?, 'member', 1, 1)`)
    .bind(id, `${id}@example.test`, id)
    .run();
  const consoleEnv = {
    ...env,
    SESSION_SECRET: "skills-navigation-test-session-secret",
  };
  const context = new RouterContextProvider();
  context.set(consoleContext, {
    env: consoleEnv,
    ctx: createExecutionContext(),
  });
  const cookie = (
    await createSessionCookie(
      consoleEnv,
      new Request("https://valise.test/skills"),
      id,
    )
  ).split(";")[0];
  const request = (url: string) => new Request(url, { headers: { cookie } });
  const actor = await requireConsoleActor(
    context,
    request("https://valise.test/skills"),
  );
  expect(actor.user.userId).toBe(id);
  return { context, request, actor };
}

const registry = vi.hoisted(() => {
  let resolve!: (hits: []) => void;
  const promise = new Promise<[]>((done) => {
    resolve = done;
  });
  return { promise, resolve };
});

vi.mock("~/concepts/skills-registry", async (original) => ({
  ...(await original<typeof import("~/concepts/skills-registry")>()),
  readPopular: () => registry.promise,
}));

afterEach(async () => {
  registry.resolve([]);
  vi.restoreAllMocks();
  for (const table of ["search_docs", "skill_versions", "skills"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
  await env.DB.prepare("DELETE FROM sessions WHERE user_id IN (?, ?)")
    .bind(userId, otherUserId)
    .run();
  await env.DB.prepare("DELETE FROM users WHERE user_id IN (?, ?)")
    .bind(userId, otherUserId)
    .run();
});

it("loads the list before optional registry results and reads history only for the opened skill", async () => {
  const member = await signedIn(userId);
  const other = await signedIn(otherUserId);
  for (const name of ["opened-skill", "another-skill"]) {
    for (const version of [1, 2]) {
      const published = await skills.publishSkill(
        env,
        {
          body: `---\nname: ${name}\ndescription: version ${version}\n---\nVersion ${version}.`,
          files: [],
        },
        member.actor.provenance,
      );
      expect(published).not.toHaveProperty("errors");
    }
  }
  const foreign = await skills.publishSkill(
    env,
    {
      body: "---\nname: private-other-skill\ndescription: Other member's summary\n---\nOther member's instructions.",
      files: [],
    },
    other.actor.provenance,
  );
  expect(foreign).not.toHaveProperty("errors");
  const history = vi.spyOn(skills, "listSkillVersions");
  const args = {
    context: member.context,
    params: {},
    pattern: "/skills",
  };
  // An unresolved registry promise is deterministic: awaiting it here would
  // prevent the loader from returning at all, not merely miss a timing budget.
  const list = await loader({
    ...args,
    request: member.request("https://valise.test/skills"),
    url: new URL("https://valise.test/skills"),
  });
  expect(history).not.toHaveBeenCalled();
  expect(list.skills).toHaveLength(2);
  expect(list.skills.map((skill) => skill.name)).toEqual([
    "another-skill",
    "opened-skill",
  ]);
  expect(list.skills[0]).not.toHaveProperty("versions");
  expect(list.skills[0].body).toContain("Version 2.");
  expect(list.detail).toBeNull();
  expect(list.popular).toBeInstanceOf(Promise);

  const detail = await loader({
    ...args,
    request: member.request(
      "https://valise.test/skills?q=not-listed&open=opened-skill",
    ),
    url: new URL("https://valise.test/skills?q=not-listed&open=opened-skill"),
  });
  expect(history.mock.calls.map((call) => [call[1], call[2]])).toEqual([
    [userId, "opened-skill"],
  ]);
  expect(detail.skills).toHaveLength(0);
  expect(detail.detail?.versions.map((version) => version.version)).toEqual([
    2, 1,
  ]);
  const foreignDetail = await loader({
    ...args,
    request: member.request(
      "https://valise.test/skills?q=private-other-skill&open=private-other-skill",
    ),
    url: new URL(
      "https://valise.test/skills?q=private-other-skill&open=private-other-skill",
    ),
  });
  expect(foreignDetail.skills).toHaveLength(0);
  expect(foreignDetail.detail).toBeNull();
  const ownForeignDetail = await loader({
    ...args,
    context: other.context,
    request: other.request(
      "https://valise.test/skills?q=private-other-skill&open=private-other-skill",
    ),
    url: new URL(
      "https://valise.test/skills?q=private-other-skill&open=private-other-skill",
    ),
  });
  expect(ownForeignDetail.skills.map((skill) => skill.name)).toEqual([
    "private-other-skill",
  ]);
  expect(ownForeignDetail.detail?.versions).toHaveLength(1);
  expect(ownForeignDetail.detail?.versions[0].body).toContain(
    "Other member's instructions.",
  );
  registry.resolve([]);
  expect(await list.popular).toEqual([]);
});
