import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { archiveMemory, saveMemory } from "~/concepts/memories";
import { publishSkill } from "~/concepts/skills";
import { createTodo } from "~/concepts/todos";
import { readVocabulary } from "~/concepts/vocabulary";

const db = env.DB;
const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};

afterEach(async () => {
  for (const table of [
    "search_docs",
    "todos",
    "memory_revisions",
    "skill_versions",
    "skills",
    "memories",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("readVocabulary", () => {
  it("returns each project and tag written, once, across all three concepts", async () => {
    await saveMemory(
      env,
      {
        type: "fact",
        title: "One",
        body: "a",
        tags: ["duckdb", "search"],
        project: "valise",
      },
      provenance,
    );
    await createTodo(
      env,
      { title: "Two", project: "valise", tags: ["search", "priority:1"] },
      provenance,
    );
    const skill = await publishSkill(
      env,
      {
        body: "---\nname: vocab-skill\ndescription: d\n---\n\nBody.",
        project: "tools",
        tags: ["skills-only"],
        files: [],
      },
      provenance,
    );
    expect(skill).not.toHaveProperty("errors");

    const vocabulary = await readVocabulary(db, "local");
    // `search` is on two records and listed once, ahead of the singletons.
    expect(vocabulary.tags).toEqual([
      "search",
      "duckdb",
      "priority:1",
      "skills-only",
    ]);
    expect(vocabulary.projects).toEqual(["valise", "tools"]);
  });

  it("leaves out what was archived, and a record with no project", async () => {
    const saved = await saveMemory(
      env,
      { type: "fact", title: "Gone", body: "a", tags: ["archived-only"] },
      provenance,
    );
    await saveMemory(
      env,
      { type: "fact", title: "Kept", body: "b", tags: [], project: "kept" },
      provenance,
    );
    await archiveMemory(env, "local", saved.id.slice("memory:".length));

    expect(await readVocabulary(db, "local")).toEqual({
      projects: ["kept"],
      tags: [],
    });
  });
});
