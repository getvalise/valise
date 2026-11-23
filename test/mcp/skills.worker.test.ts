import { env } from "cloudflare:test";
import { CfWorkerJsonSchemaValidator } from "@modelcontextprotocol/server/validators/cf-worker";
import { afterEach, describe, expect, it } from "vitest";
import {
  changeSkills,
  editSkill,
  getSkill,
  publishSkill,
  readSkillUsage,
  reviewSkillEdit,
  setSkillLabels,
} from "~/concepts/skills";
import { readUpstream } from "~/concepts/skills-upstream";
import { sha256Hex } from "~/r2/bundles";
import { search } from "~/search/query";
import { callMcp } from "./fixture-worker";

type SkillEntry = {
  uri: string;
  frontmatter: Record<string, string>;
  resources: { uri: string; digest: string; size: number }[];
};

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

describe("skill publication", () => {
  it("reads only text supporting files in an active skill's published manifest", async () => {
    await publishSkill(
      env,
      {
        body: skillBody("Read references/guide.md when needed."),
        files: [
          {
            path: "references/guide.md",
            content: "Exact supporting instructions.",
          },
          { path: "image.png", content: new Uint8Array([0x89, 0x50, 0xff]) },
        ],
      },
      { userId: "local", agent: "test", client: "test", session: null },
    );
    const result = await tool("read_skill_file", {
      name: "capture-this",
      path: "references/guide.md",
    });
    expect(result.structuredContent).toEqual({
      uri: "skill://capture-this/references/guide.md",
      mimeType: "text/markdown",
      text: "Exact supporting instructions.",
    });
    expect(
      (
        await rpc("resources/read", {
          uri: "skill://capture-this/references/guide.md",
        })
      ).contents,
    ).toEqual([result.structuredContent]);
    for (const path of [
      "SKILL.md",
      "../outside",
      "/outside",
      "missing.md",
      "image.png",
    ]) {
      expect(
        (await tool("read_skill_file", { name: "capture-this", path })).isError,
        path,
      ).toBe(true);
    }
    await changeSkills(env, "local", ["capture-this"], "disable");
    expect(
      (
        await tool("read_skill_file", {
          name: "capture-this",
          path: "references/guide.md",
        })
      ).isError,
    ).toBe(true);
    await changeSkills(env, "local", ["capture-this"], "delete");
    expect(
      (
        await tool("read_skill_file", {
          name: "capture-this",
          path: "references/guide.md",
        })
      ).isError,
    ).toBe(true);
  });
  it("lists prompt metadata and returns the same current instructions as the tool and resource", async () => {
    expect((await rpc("prompts/list", {})).prompts).toEqual([]);
    await tool("publish_skill", {
      body: skillBody("First instructions."),
      files: [{ path: "references/check.md", content: "Supporting detail." }],
    });
    expect((await rpc("prompts/list", {})).prompts).toEqual([
      { name: "capture-this", description: "Save a durable, typed memory." },
    ]);
    await tool("publish_skill", {
      body: skillBody("Current instructions."),
      files: [{ path: "references/check.md", content: "Supporting detail." }],
    });
    const prompt = await rpc("prompts/get", { name: "capture-this" });
    const resource = await rpc("resources/read", {
      uri: "skill://capture-this/SKILL.md",
    });
    const called = await tool("skill_capture-this", {});
    expect(prompt.messages).toEqual([
      {
        role: "user",
        content: { type: "text", text: called.structuredContent?.body },
      },
      {
        role: "user",
        content: {
          type: "text",
          text: expect.stringContaining(
            "skill://capture-this/references/check.md",
          ),
        },
      },
    ]);
    expect(resource.contents).toEqual([
      expect.objectContaining({ text: called.structuredContent?.body }),
    ]);
    expect(JSON.stringify(prompt)).not.toContain("Supporting detail.");
    const logs = await db
      .prepare(
        "SELECT method, required_scope FROM mcp_calls WHERE method IN ('prompts/list', 'prompts/get')",
      )
      .all();
    expect(logs.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "prompts/list",
          required_scope: "skills:read",
        }),
        expect.objectContaining({
          method: "prompts/get",
          required_scope: "skills:read",
        }),
      ]),
    );
  });

  it("rejects missing, disabled and deleted prompt names, and restores enabled ones", async () => {
    expect(
      (await callMcp("prompts/get", { name: "missing" })).value.error?.code,
    ).toBe(-32602);
    await tool("publish_skill", { body: skillBody("Instructions.") });
    for (const change of ["disable", "delete"] as const) {
      await changeSkills(env, "local", ["capture-this"], change);
      expect((await rpc("prompts/list", {})).prompts).toEqual([]);
      expect(
        (await callMcp("prompts/get", { name: "capture-this" })).value.error
          ?.code,
      ).toBe(-32602);
    }
    await changeSkills(env, "local", ["capture-this"], "restore");
    await changeSkills(env, "local", ["capture-this"], "enable");
    expect(
      (await rpc("prompts/get", { name: "capture-this" })).messages,
    ).toEqual([
      {
        role: "user",
        content: { type: "text", text: skillBody("Instructions.").trim() },
      },
    ]);
  });

  it("publishes immutable versions, only indexes the head, and serves both doors", async () => {
    const first = await tool("publish_skill", {
      body: skillBody("Capture durable context with a zeppelin marker."),
      project: "valise",
      tags: ["memory", "capture"],
      files: [{ path: "scripts/run.py", content: "print('capture')\n" }],
    });
    expect(first.structuredContent).toMatchObject({
      name: "capture-this",
      version: 1,
      files: [
        {
          path: "scripts/run.py",
          r2Key: expect.stringContaining("/1/scripts/run.py"),
        },
      ],
    });

    const repeated = await tool("publish_skill", {
      body: skillBody("Capture durable context with a zeppelin marker."),
    });
    expect(repeated.structuredContent).toMatchObject({ version: 1 });
    expect((await env.BUNDLES.list()).objects).toHaveLength(1);

    const second = await tool("publish_skill", {
      body: skillBody("Capture durable context with a quasar marker."),
    });
    expect(second.isError, JSON.stringify(second)).not.toBe(true);
    expect(second.structuredContent).toMatchObject({ version: 2 });

    const head = await tool("get_skill", { name: "capture-this" });
    expect(head.structuredContent).toMatchObject({
      version: 2,
      body: expect.stringContaining("quasar"),
    });
    const pinned = await tool("get_skill", {
      name: "capture-this",
      version: 1,
    });
    expect(pinned.structuredContent).toMatchObject({
      version: 1,
      body: expect.stringContaining("zeppelin"),
    });

    expect(await search(env, { userId: "local", query: "zeppelin" })).toEqual(
      [],
    );
    expect(
      (await search(env, { userId: "local", query: "quasar" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual([expect.stringMatching(/^skill:/)]);

    const listed = await rpc("resources/list", {});
    expect(listed.resources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ uri: "skill://capture-this/SKILL.md" }),
        expect.objectContaining({ uri: "skill://index.json" }),
      ]),
    );
    const resource = await rpc("resources/read", {
      uri: "skill://capture-this/SKILL.md",
    });
    expect(resource.contents).toEqual([
      expect.objectContaining({ text: expect.stringContaining("quasar") }),
    ]);
  });

  it("serves one tool per skill, carrying the skill's own description", async () => {
    await tool("publish_skill", { body: skillBody("Capture it.") });

    const tools = (await rpc("tools/list", {})).tools as {
      name: string;
      description: string;
    }[];
    const skillTool = tools.find(
      (entry) => entry.name === "skill_capture-this",
    );
    expect(skillTool?.description).toContain("Save a durable, typed memory.");

    const called = await tool("skill_capture-this", {});
    expect(called.structuredContent).toMatchObject({
      name: "capture-this",
      uri: "skill://capture-this/SKILL.md",
      body: expect.stringContaining("Capture it."),
    });
  });

  it("serves a bundled image as a base64 blob whose digest matches its bytes", async () => {
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
    ]);
    await publishSkill(
      env,
      {
        body: skillBody("Capture it."),
        files: [{ path: "stamp.png", content: png }],
      },
      { userId: "local", agent: "test", client: "test", session: null },
    );

    const listed = await rpc("skills/list", {});
    const entry = (listed.skills as SkillEntry[])[0];
    const image = entry.resources.find((file) =>
      file.uri.endsWith("stamp.png"),
    );
    const read = await rpc("resources/read", { uri: image?.uri });
    const [content] = read.contents as { mimeType: string; blob: string }[];
    expect(content.mimeType).toBe("image/png");
    const bytes = Uint8Array.from(atob(content.blob), (char) =>
      char.charCodeAt(0),
    );
    expect(bytes).toEqual(png);
    expect(`sha256:${await sha256Hex(bytes)}`).toBe(image?.digest);
    expect(bytes.length).toBe(image?.size);
  });

  it("publishes SEP-2640 manifests whose digests match the bytes served", async () => {
    await tool("publish_skill", {
      body: skillBody("Capture it."),
      files: [{ path: "scripts/run.py", content: "print('capture')\n" }],
    });

    const listed = await rpc("skills/list", {});
    expect(listed).toMatchObject({ resultType: "complete" });
    const entry = (listed.skills as SkillEntry[])[0];
    expect(entry.uri).toBe("skill://capture-this/SKILL.md");
    expect(entry.frontmatter).toEqual({
      name: "capture-this",
      description: "Save a durable, typed memory.",
    });

    for (const file of entry.resources) {
      const read = await rpc("resources/read", { uri: file.uri });
      const text = (read.contents as { text: string }[])[0].text;
      expect(`sha256:${await sha256Hex(text)}`).toBe(file.digest);
      expect(new TextEncoder().encode(text).length).toBe(file.size);
    }

    const got = await rpc("skills/get", { uri: entry.uri });
    expect(got.skill).toEqual(entry);

    const { value } = await callMcp("skills/get", {
      uri: "skill://nope/SKILL.md",
    });
    expect(value).toMatchObject({ error: { code: -32602 } });
  });

  it("returns repairable errors without rows or objects for malformed frontmatter", async () => {
    const response = await tool("publish_skill", {
      body: "# Missing frontmatter\n",
    });
    expect(response.isError).toBe(true);
    expect(response.content).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: expect.stringContaining("frontmatter"),
        }),
      ]),
    );
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM skills")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect((await env.BUNDLES.list()).objects).toHaveLength(0);
  });

  it("allocates above history when a head pointer lags", async () => {
    await tool("publish_skill", { body: skillBody("Version one.") });
    await tool("publish_skill", { body: skillBody("Version two.") });
    await db
      .prepare(
        `UPDATE skills
            SET head_version_id = (
              SELECT version_id
                FROM skill_versions
               WHERE skill_id = skills.skill_id AND version = 1
            )`,
      )
      .run();

    const published = await tool("publish_skill", {
      body: skillBody("Version three."),
    });
    expect(published.structuredContent).toMatchObject({ version: 3 });
  });

  it("returns skill payloads that pass each tool's own output schema", async () => {
    // Claude Code validates structuredContent against outputSchema and drops
    // a result that fails, so a field the schema does not declare loses the
    // whole answer.
    const published = await tool("publish_skill", {
      body: skillBody("Check the payload against the schema."),
      project: "valise",
      tags: ["schema"],
    });
    const listedSkills = await tool("list_skills", {});
    const calls: [string, unknown][] = [
      ["publish_skill", published],
      ["list_skills", listedSkills],
      ["get_skill", await tool("get_skill", { name: "capture-this" })],
    ];
    const listed = await rpc("tools/list", {});
    const schemas = new Map(
      (listed.tools as { name: string; outputSchema: unknown }[]).map(
        (entry) => [entry.name, entry.outputSchema],
      ),
    );
    const validator = new CfWorkerJsonSchemaValidator();
    for (const [name, result] of calls) {
      const { structuredContent, isError } = result as {
        structuredContent: unknown;
        isError?: boolean;
      };
      expect(isError, name).not.toBe(true);
      const check = validator.getValidator(
        schemas.get(name) as Parameters<typeof validator.getValidator>[0],
      )(structuredContent);
      expect(check.errorMessage, name).toBeUndefined();
    }
    expect(listedSkills.structuredContent?.skills).toHaveLength(1);
  });
});

describe("editing a skill from the console", () => {
  const editor = {
    userId: "local",
    agent: "console",
    client: "console",
    session: null,
  };

  it("publishes N+1 with the head's bundle, project, tags and source", async () => {
    await tool("publish_skill", {
      body: skillBody("Before the edit."),
      project: "valise",
      tags: ["capture"],
      files: [{ path: "scripts/run.py", content: "print('capture')\n" }],
    });
    await db
      .prepare("UPDATE skills SET source = 'owner/repo/capture-this'")
      .run();
    const v1 = await getSkill(db, "local", "capture-this");

    const review = await reviewSkillEdit(
      db,
      "local",
      "capture-this",
      skillBody("After the edit."),
    );
    expect(review).toMatchObject({ version: 2, unchanged: false });
    expect("diff" in review && review.diff).toEqual(
      expect.arrayContaining([
        { op: "del", text: "Before the edit." },
        { op: "add", text: "After the edit." },
      ]),
    );

    const edited = await editSkill(
      env,
      "capture-this",
      skillBody("After the edit."),
      editor,
    );
    expect(edited).toMatchObject({
      version: 2,
      project: "valise",
      tags: ["capture"],
      source: "owner/repo/capture-this",
      files: v1?.files,
    });
    // The bundle is carried by manifest, so no second copy lands in R2.
    expect((await env.BUNDLES.list()).objects).toHaveLength(1);
    const read = await rpc("resources/read", {
      uri: "skill://capture-this/scripts/run.py",
    });
    expect(read.contents).toEqual([
      expect.objectContaining({ text: "print('capture')\n" }),
    ]);
  });

  it("refuses a rename and writes nothing for an untouched CRLF submit", async () => {
    await tool("publish_skill", { body: skillBody("Stay put.") });

    const renamed = await editSkill(
      env,
      "capture-this",
      skillBody("Stay put.").replace("name: capture-this", "name: other"),
      editor,
    );
    expect(renamed).toEqual({
      errors: [expect.stringContaining("keeps name: capture-this")],
    });

    // What a browser posts back from a textarea holding the stored LF body.
    const crlf = skillBody("Stay put.").trim().replaceAll("\n", "\r\n");
    expect(
      await reviewSkillEdit(db, "local", "capture-this", crlf),
    ).toMatchObject({
      unchanged: true,
      version: 1,
    });
    expect(await editSkill(env, "capture-this", crlf, editor)).toMatchObject({
      version: 1,
    });
    expect(
      (
        await db
          .prepare("SELECT count(*) AS n FROM skill_versions")
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
  });
});

describe("reading per-skill columns for a long list", () => {
  it("answers for more names than D1 binds in one statement", async () => {
    await tool("publish_skill", { body: skillBody("Counted.") });
    await tool("skill_capture-this", {});
    const names = [
      ...Array.from({ length: 150 }, (_, i) => `absent-${i}`),
      "capture-this",
    ];
    // The call log is shared across tests, so this asserts a count arrived.
    expect(
      (await readSkillUsage(db, "local", names)).get("capture-this")?.asTool,
    ).toBeGreaterThan(0);
    expect((await readUpstream(db, "local", names)).size).toBe(0);
  });
});

describe("labelling a skill from the console", () => {
  it("moves project and tags and the search filter, without a version", async () => {
    await tool("publish_skill", {
      body: skillBody("Label me."),
      tags: ["stale"],
    });
    expect(
      await setSkillLabels(env, "local", "capture-this", {
        project: "valise",
        tags: ["fresh"],
      }),
    ).toBe(true);
    expect(await getSkill(db, "local", "capture-this")).toMatchObject({
      version: 1,
      project: "valise",
      tags: ["fresh"],
    });
    expect(
      (
        await search(env, { userId: "local", query: "Label", tags: ["fresh"] })
      ).map((hit) => hit.docKey),
    ).toEqual([expect.stringMatching(/^skill:/)]);
    expect(
      await search(env, { userId: "local", query: "Label", tags: ["stale"] }),
    ).toEqual([]);
    expect(await setSkillLabels(env, "local", "nope", { tags: [] })).toBe(
      false,
    );
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

function skillBody(instruction: string): string {
  return `---
name: capture-this
description: Save a durable, typed memory.
---

${instruction}
`;
}
