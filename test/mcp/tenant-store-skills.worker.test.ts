import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { action, loader } from "~/routes/skills";
import { requireBrowserStore } from "~/store/tenant.server";

const settings = {
  ...env,
  SESSION_SECRET: "tenant-store-skill-secret",
  // The loader's popular list must not reach a real registry from a test.
  SKILLS_REGISTRY_URL: "https://registry.invalid",
};
const OWNER = "local";
const OTHER = "usr_store_skill_other";

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, created_at, email_verified)
     VALUES (?, ?, unixepoch(), 1)`,
  )
    .bind(OTHER, OTHER)
    .run();
});

afterEach(async () => {
  for (const table of [
    "search_docs",
    "vector_pending",
    "skill_versions",
    "skills",
    "mcp_calls",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

// A list sort counts as filtering, so the loader skips the popular-skills fetch.
async function requestFor(userId: string, path = "/skills?sort=name") {
  // Routing hints in the URL and headers must not choose the tenant.
  const url = `https://valise.test${path}${path.includes("?") ? "&" : "?"}userId=local&shard=other`;
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, { headers: { cookie, "x-valise-user": "local" } });
}

async function browser(userId: string) {
  return (await requireBrowserStore(settings, await requestFor(userId))).store;
}

const body = (name: string, text: string) =>
  `---\nname: ${name}\ndescription: Tenant-local instructions.\n---\n${text}`;

async function seed() {
  const owner = await browser(OWNER);
  const other = await browser(OTHER);
  const mine = await owner.skills.publish({
    body: body("owner-only", "Owner private instructions."),
    files: [{ path: "guide.md", content: "Owner private file." }],
    tags: ["owner:mine"],
  });
  const theirs = await other.skills.publish({
    body: body("member-only", "Member private instructions."),
    files: [],
    tags: ["owner:theirs"],
  });
  if ("errors" in mine || "errors" in theirs) throw new Error("fixture");
  return { owner, other, mine, theirs };
}

function consoleArgs(request: Request) {
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  return {
    context,
    request,
    url: new URL(request.url),
    params: {},
    pattern: "/skills",
  };
}

async function post(userId: string, fields: Record<string, string>) {
  const authenticated = await requestFor(userId);
  const url = new URL(authenticated.url);
  const request = new Request(url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(authenticated.headers),
      origin: url.origin,
    },
    body: new URLSearchParams(fields),
  });
  return action(consoleArgs(request));
}

describe("tenant-bound skill store", () => {
  it("binds lists, detail, history, heads and previews to one owner", async () => {
    const { owner, other, mine, theirs } = await seed();

    expect((await owner.skills.list()).map((skill) => skill.name)).toEqual([
      "owner-only",
    ]);
    expect(await owner.skills.count()).toMatchObject({ total: 1 });
    expect(await owner.skills.get("member-only")).toBeNull();
    expect(await owner.skills.get("member-only", 1, "deleted")).toBeNull();
    expect(await owner.skills.nameForId(theirs.id)).toBeNull();
    expect(await owner.skills.nameForId(mine.id)).toBe("owner-only");
    expect(await owner.skills.versions("member-only")).toEqual([]);
    expect(await owner.skills.heads(["member-only"])).toEqual(new Map());
    expect(await owner.skills.upstream(["member-only"])).toEqual(new Map());
    expect(
      (await owner.skills.usage(["member-only"])).get("member-only"),
    ).toBeFalsy();
    // Adding a skill another tenant already has is new here, not an edit.
    expect(
      (await owner.skills.previewAdd(body("member-only", "Mine now"))).existing,
    ).toBeNull();
    expect(
      await owner.skills.reviewEdit("member-only", body("member-only", "x")),
    ).toHaveProperty("errors");
    expect(await owner.facets("skill")).toEqual([
      { key: "owner", value: "mine", tag: "owner:mine", count: 1 },
    ]);
    expect(
      (await owner.search({ query: "Member private" })).map((hit) => hit.title),
    ).not.toContain("member-only");
    expect(await other.skills.get("member-only")).toMatchObject({
      body: body("member-only", "Member private instructions."),
    });
  });

  it("refuses edits, labels, state changes and upstream checks on another tenant's skill", async () => {
    const { owner, other } = await seed();
    const before = await other.skills.get("member-only");

    expect(
      await owner.skills.edit("member-only", body("member-only", "stolen")),
    ).toHaveProperty("errors");
    expect(
      await owner.skills.setLabels("member-only", { project: "stolen" }),
    ).toBe(false);
    for (const change of ["disable", "delete"] as const)
      expect(await owner.skills.change(["member-only"], change)).toEqual({
        changed: [],
        skipped: [{ name: "member-only", reason: "missing" }],
      });
    expect(
      (await owner.skills.checkUpstream("member-only")).errors.length,
    ).toBeGreaterThan(0);
    expect((await owner.skills.update(["member-only"])).applied).toEqual([]);

    expect(await other.skills.get("member-only")).toEqual(before);
    expect(await other.skills.versions("member-only")).toHaveLength(1);
  });

  it("keeps a same-name skill independent per tenant", async () => {
    const owner = await browser(OWNER);
    const other = await browser(OTHER);
    for (const [store, text] of [
      [owner, "Owner copy."],
      [other, "Member copy."],
    ] as const)
      expect(
        await store.skills.publish({ body: body("shared", text), files: [] }),
      ).not.toHaveProperty("errors");
    expect(
      await owner.skills.edit("shared", body("shared", "Owner edit.")),
    ).not.toHaveProperty("errors");
    await owner.skills.change(["shared"], "delete");

    expect(await owner.skills.get("shared")).toBeNull();
    expect(await other.skills.get("shared")).toMatchObject({
      version: 1,
      body: body("shared", "Member copy."),
    });
    const rows = await env.DB.prepare(
      "SELECT user_id FROM skills WHERE name = 'shared' ORDER BY user_id",
    ).all<{ user_id: string }>();
    expect(rows.results.map((row) => row.user_id)).toEqual([OWNER, OTHER]);
  });

  it("uses the bound store in the /skills loader and its mutations", async () => {
    const { owner, mine } = await seed();
    const opened = await requestFor(
      OTHER,
      `/skills?sort=name&open=${encodeURIComponent(mine.id)}`,
    );
    expect(await loader(consoleArgs(opened))).toMatchObject({
      opened: null,
      detail: null,
      skills: [{ name: "member-only" }],
      vocabulary: { tags: ["owner:theirs"] },
    });
    const byName = await loader(
      consoleArgs(await requestFor(OTHER, "/skills?sort=name&open=owner-only")),
    );
    expect(byName).toMatchObject({ opened: "owner-only", detail: null });

    await expect(
      post(OTHER, {
        intent: "skill-field",
        skill: "owner-only",
        field: "project",
        value: "stolen",
      }),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await post(OTHER, {
        intent: "change",
        change: "delete",
        skill: "owner-only",
      }),
    ).toMatchObject({
      report: { changed: [], skipped: [{ name: "owner-only" }] },
    });
    expect(await owner.skills.get("owner-only")).toMatchObject({
      version: 1,
      project: null,
    });
  });
});
