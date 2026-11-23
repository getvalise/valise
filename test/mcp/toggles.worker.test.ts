import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { syncBuiltinSkills } from "~/concepts/builtin-skills";
import { changeSkills, listSkills, listSkillVersions } from "~/concepts/skills";
import { search } from "~/search/query";
import captureThis from "../../skills/capture-this/SKILL.md?raw";
import { callMcp } from "./fixture-worker";

const db = env.DB;

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todo_updates",
    "todos",
    "memory_revisions",
    "skill_versions",
    "skills",
    "memories",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length) {
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
  }
});

describe("skill toggles", () => {
  it("closes every agent door when disabled, and reopens them when enabled", async () => {
    const published = await tool("publish_skill", {
      body: skillBody("toggle-proof", "Mentions a zeppelin marker."),
    });
    const id = (published.structuredContent as { id: string }).id;

    expect(await toolNames()).toContain("skill_toggle-proof");
    expect(await searchHits("zeppelin")).toHaveLength(1);

    expect(
      await changeSkills(env, "local", ["toggle-proof"], "disable"),
    ).toEqual({
      changed: ["toggle-proof"],
      skipped: [],
    });

    expect(await toolNames()).not.toContain("skill_toggle-proof");
    const gotten = await tool("get_skill", { name: "toggle-proof" });
    expect(gotten.isError).toBe(true);
    const fetched = await tool("fetch", { id });
    expect(fetched.isError).toBe(true);
    expect(await searchHits("zeppelin")).toHaveLength(0);
    const resources = await rpc("resources/list", {});
    expect(resources.resources).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "skill://toggle-proof/SKILL.md" }),
      ]),
    );

    expect(
      await changeSkills(env, "local", ["toggle-proof"], "enable"),
    ).toEqual({
      changed: ["toggle-proof"],
      skipped: [],
    });

    expect(await toolNames()).toContain("skill_toggle-proof");
    expect(await searchHits("zeppelin")).toHaveLength(1);
    const head = await tool("get_skill", { name: "toggle-proof" });
    expect(head.structuredContent).toMatchObject({ name: "toggle-proof" });
  });

  it("keeps a disabled skill publishable and keeps it unpublished", async () => {
    await tool("publish_skill", {
      body: skillBody("toggle-proof", "First body."),
    });
    await changeSkills(env, "local", ["toggle-proof"], "disable");

    const second = await tool("publish_skill", {
      body: skillBody("toggle-proof", "Second body with a quasar marker."),
    });
    expect(second.structuredContent).toMatchObject({ version: 2 });
    // The new version landed, the off switch did not flip.
    expect(await searchHits("quasar")).toHaveLength(0);
    expect(await toolNames()).not.toContain("skill_toggle-proof");
  });

  it("changes many skills in one call, and leaves a name already there alone", async () => {
    for (const name of ["bulk-one", "bulk-two", "bulk-three"]) {
      await tool("publish_skill", { body: skillBody(name, "A comet marker.") });
    }
    await changeSkills(env, "local", ["bulk-one"], "disable");

    expect(
      await changeSkills(
        env,
        "local",
        ["bulk-one", "bulk-two", "nope"],
        "disable",
      ),
    ).toEqual({
      changed: ["bulk-two"],
      skipped: [{ name: "nope", reason: "missing" }],
    });
    expect(await toolNames()).toEqual(
      expect.not.arrayContaining(["skill_bulk-one", "skill_bulk-two"]),
    );
    expect(await toolNames()).toContain("skill_bulk-three");
    expect(await searchHits("comet")).toHaveLength(1);
  });

  it("deletes a skill out of every door and the default list, and restores it whole", async () => {
    await tool("publish_skill", {
      body: skillBody("gone-soon", "A nebula marker."),
    });
    await tool("publish_skill", {
      body: skillBody("gone-soon", "A nebula marker, v2."),
    });
    await changeSkills(env, "local", ["gone-soon"], "disable");

    await changeSkills(env, "local", ["gone-soon"], "delete");

    expect(await listSkills(db, "local", {}, "disabled")).toEqual([]);
    expect(await listSkills(db, "local", {}, "deleted")).toEqual([
      expect.objectContaining({ name: "gone-soon", deleted: true, version: 2 }),
    ]);
    expect(await searchHits("nebula")).toHaveLength(0);

    await changeSkills(env, "local", ["gone-soon"], "restore");

    // Back as it was: still off, history intact.
    expect(await listSkills(db, "local", {}, "disabled")).toEqual([
      expect.objectContaining({
        name: "gone-soon",
        deleted: false,
        disabled: true,
        version: 2,
      }),
    ]);
    expect(await listSkillVersions(db, "local", "gone-soon")).toHaveLength(2);
  });

  it("brings a deleted name back on publish rather than colliding with it", async () => {
    await tool("publish_skill", { body: skillBody("phoenix", "First life.") });
    await changeSkills(env, "local", ["phoenix"], "delete");

    const again = await tool("publish_skill", {
      body: skillBody("phoenix", "Second life, with a pulsar marker."),
    });

    expect(again.isError).not.toBe(true);
    expect(again.structuredContent).toMatchObject({ version: 2 });
    expect(await searchHits("pulsar")).toHaveLength(1);
    expect(await toolNames()).toContain("skill_phoenix");
  });

  it("restores a deleted skill republished word for word, without a new version", async () => {
    const body = skillBody("echo", "Same words twice.");
    await tool("publish_skill", { body });
    await changeSkills(env, "local", ["echo"], "delete");

    const again = await tool("publish_skill", { body });

    expect(again.structuredContent).toMatchObject({ version: 1 });
    expect(await toolNames()).toContain("skill_echo");
  });

  it("keeps a built-in from being deleted, since the next deploy would re-add it", async () => {
    await syncBuiltinSkills(env, "local");

    expect(
      await changeSkills(env, "local", ["capture-this"], "delete"),
    ).toEqual({
      changed: [],
      skipped: [{ name: "capture-this", reason: "builtin" }],
    });
    expect(await toolNames()).toContain("skill_capture-this");
  });
});

describe("built-in sync", () => {
  it("publishes the bundled skill, then reports current", async () => {
    expect(await syncBuiltinSkills(env, "local")).toEqual([
      { name: "capture-this", outcome: "published" },
    ]);

    const head = await tool("get_skill", { name: "capture-this" });
    expect(head.structuredContent).toMatchObject({ body: captureThis });

    const row = await db
      .prepare("SELECT source, source_hash FROM skills WHERE name = ?")
      .bind("capture-this")
      .first<{ source: string; source_hash: string }>();
    expect(row?.source).toBe("builtin:capture-this");
    expect(row?.source_hash).toHaveLength(64);

    expect(await syncBuiltinSkills(env, "local")).toEqual([
      { name: "capture-this", outcome: "current" },
    ]);
  });

  it("holds the update when the head was edited past the last sync", async () => {
    await syncBuiltinSkills(env, "local");
    const edited = skillBody("capture-this", "A local edit on top.");
    await tool("publish_skill", { body: edited });

    const report = await syncBuiltinSkills(env, "local");
    expect(report).toEqual([
      expect.objectContaining({ name: "capture-this", outcome: "held" }),
    ]);
    // The edited head survived the sync.
    const head = await tool("get_skill", { name: "capture-this" });
    expect(head.structuredContent).toMatchObject({
      body: expect.stringContaining("A local edit on top."),
    });
  });

  it("holds an authored skill of the same name", async () => {
    await tool("publish_skill", {
      body: skillBody("capture-this", "Written here before built-ins."),
    });

    expect(await syncBuiltinSkills(env, "local")).toEqual([
      expect.objectContaining({ name: "capture-this", outcome: "held" }),
    ]);

    const head = await tool("get_skill", { name: "capture-this" });
    expect(head.structuredContent).toMatchObject({ version: 1 });
    const first = await tool("get_skill", { name: "capture-this", version: 1 });
    expect(first.structuredContent).toMatchObject({
      body: expect.stringContaining("Written here before built-ins."),
    });
  });
});

async function tool(name: string, args: Record<string, unknown>) {
  const { response, raw, value } = await callMcp("tools/call", {
    name,
    arguments: args,
  });
  expect(response.status, raw).toBe(200);
  return value.result;
}

async function rpc(method: string, params: Record<string, unknown>) {
  const { response, raw, value } = await callMcp(method, params);
  expect(response.status, raw).toBe(200);
  return value.result;
}

async function toolNames(): Promise<string[]> {
  const listed = await rpc("tools/list", {});
  return (listed.tools as { name: string }[]).map((entry) => entry.name);
}

async function searchHits(query: string) {
  return (
    await search(env, { userId: "local", query, concepts: ["skill"] })
  ).map((hit) => hit.docKey);
}

function skillBody(name: string, instruction: string): string {
  return `---
name: ${name}
description: Toggle and sync test subject.
---

${instruction}
`;
}
