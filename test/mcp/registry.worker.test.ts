import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSkill, previewSkillAdd, publishSkill } from "~/concepts/skills";
import {
  downloadFromRegistry,
  isFailure,
  readPopular,
  searchRegistry,
} from "~/concepts/skills-registry";

/**
 * The registry is someone else's undocumented endpoint, so everything that
 * crosses from it into the store is checked here rather than trusted. The
 * upstream is stubbed: a test that depends on skills.sh being up is a test
 * that fails for reasons that have nothing to do with this repository.
 */

const registry = { SKILLS_REGISTRY_URL: "https://registry.test" };
const db = env.DB;

let requested: string[] = [];

function reply(payload: unknown, status = 200) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(JSON.stringify(payload), {
      status,
      headers: { "content-type": "application/json" },
    });
  });
}

beforeEach(() => {
  requested = [];
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.prepare("DELETE FROM skill_versions").run();
  await db.prepare("DELETE FROM skills WHERE name LIKE 'imported-%'").run();
  await db.prepare("DELETE FROM search_docs").run();
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

describe("searching the registry", () => {
  it("asks the configured base with the query and the limit", async () => {
    reply({ skills: [] });
    await searchRegistry(registry, "duckdb", 5);
    expect(requested[0]).toBe(
      "https://registry.test/api/search?q=duckdb&limit=5",
    );
  });

  it("calls nothing for an empty query", async () => {
    reply({ skills: [] });
    expect(await searchRegistry(registry, "   ")).toEqual([]);
    expect(requested).toEqual([]);
  });

  it("drops the bare-domain sources that cannot be downloaded", async () => {
    reply({
      skills: [
        {
          id: "duckdb/duckdb-skills/duckdb-docs",
          source: "duckdb/duckdb-skills",
          skillId: "duckdb-docs",
          name: "duckdb-docs",
          installs: 1235,
        },
        // Real rows from the live index, and `/api/download` 404s on them.
        {
          id: "docs.stripe.com/stripe-directory",
          source: "docs.stripe.com",
          skillId: "stripe-directory",
          name: "stripe-directory",
          installs: 10,
        },
      ],
    });

    const hits = await searchRegistry(registry, "duckdb");
    expect(isFailure(hits)).toBe(false);
    expect(hits).toMatchObject([
      {
        id: "duckdb/duckdb-skills/duckdb-docs",
        source: "duckdb/duckdb-skills",
        installs: 1235,
        listingUrl: "https://www.skills.sh/duckdb/duckdb-skills/duckdb-docs",
      },
    ]);
  });

  it("reports an upstream failure rather than throwing", async () => {
    reply({ error: "nope" }, 503);
    const hits = await searchRegistry(registry, "duckdb");
    expect(isFailure(hits) && hits.errors[0]).toContain("503");
  });
});

describe("downloading from the registry", () => {
  it("refuses an id that is not owner/repo/skill before it builds a url", async () => {
    reply({ files: [] });
    for (const id of ["owner/repo", "owner/repo/../../etc", "a/b/c/d"]) {
      const result = await downloadFromRegistry(registry, id);
      expect(isFailure(result)).toBe(true);
    }
    expect(requested).toEqual([]);
  });

  it("refuses a bundle whose path escapes it", async () => {
    reply({
      hash: "abc",
      files: [
        { path: "SKILL.md", contents: "---\nname: x\ndescription: y\n---\n" },
        { path: "../outside.md", contents: "no" },
      ],
    });
    const result = await downloadFromRegistry(registry, "a/b/c");
    expect(isFailure(result) && result.errors[0]).toContain("escapes");
  });

  it("refuses a download with no SKILL.md at its root", async () => {
    reply({ hash: "abc", files: [{ path: "docs/SKILL.md", contents: "x" }] });
    const result = await downloadFromRegistry(registry, "a/b/c");
    expect(isFailure(result) && result.errors[0]).toContain("no SKILL.md");
  });

  it("refuses a bundle past the size cap", async () => {
    reply({
      hash: "abc",
      files: [
        { path: "SKILL.md", contents: "---\nname: x\ndescription: y\n---\n" },
        { path: "big.md", contents: "x".repeat(3 * 1024 * 1024) },
      ],
    });
    const result = await downloadFromRegistry(registry, "a/b/c");
    expect(isFailure(result) && result.errors[0]).toContain("larger than 2MB");
  });

  it("splits the SKILL.md from the bundle it carries", async () => {
    reply({
      hash: "4cd752440e",
      files: [
        { path: "references/SYNTAX.md", contents: "# Syntax\n" },
        {
          path: "SKILL.md",
          contents:
            "---\nname: imported-sql\ndescription: Look up SQL syntax.\nlicense: MIT\n---\n\nBody.",
        },
      ],
    });

    const result = await downloadFromRegistry(
      registry,
      "acme/agent-skills/imported-sql",
    );
    expect(isFailure(result)).toBe(false);
    if (isFailure(result)) return;
    expect(requested[0]).toBe(
      "https://registry.test/api/download/acme/agent-skills/imported-sql",
    );
    expect(result.body).toContain("name: imported-sql");
    expect(result.files).toEqual([
      { path: "references/SYNTAX.md", content: "# Syntax\n" },
    ]);
    expect(result.hash).toBe("4cd752440e");
  });
});

describe("importing what the registry returned", () => {
  it("publishes it as a normal version that get_skill serves, with its source", async () => {
    reply({
      hash: "deadbeef",
      files: [
        { path: "references/checklist.md", contents: "# Checklist\n" },
        {
          path: "SKILL.md",
          contents:
            "---\nname: imported-review\ndescription: >-\n  Review a\n  diff.\nlicense: MIT\n---\n\nRead the diff.",
        },
      ],
    });
    const downloaded = await downloadFromRegistry(
      registry,
      "owner/repo/imported-review",
    );
    expect(isFailure(downloaded)).toBe(false);
    if (isFailure(downloaded)) return;

    expect(await previewSkillAdd(db, "local", downloaded.body)).toMatchObject({
      errors: [],
      frontmatter: { description: "Review a diff.", license: "MIT" },
    });

    // The stub is still in place, and `writeBundle` must not go near it.
    vi.unstubAllGlobals();
    const published = await publishSkill(
      env,
      { body: downloaded.body, files: downloaded.files },
      { userId: "local", agent: "vitest", client: "test", session: null },
      { source: downloaded.id, sourceHash: downloaded.hash },
    );
    expect("errors" in published).toBe(false);

    const served = await getSkill(db, "local", "imported-review");
    expect(served).toMatchObject({
      version: 1,
      source: "owner/repo/imported-review",
      description: "Review a diff.",
    });
    expect(served?.files.map((file) => file.path)).toEqual([
      "references/checklist.md",
    ]);
    expect(served?.frontmatter.license).toBe("MIT");
  });
});

describe("the popular list", () => {
  const row = (skillId: string, weekly: number[]) => ({
    source: "o/r",
    skillId,
    name: skillId,
    installs: 1000,
    weeklyInstalls: weekly,
  });

  it("reads page 0 once, works out the trend, and serves the cache after", async () => {
    // Its own base, so no other test's cached answer is in the way.
    const env = { SKILLS_REGISTRY_URL: "https://popular-once.test" };
    reply({
      total: 2,
      hasMore: false,
      page: 0,
      skills: [
        row("steady", [10, 10, 10, 10, 10, 10, 10, 10]),
        row("rising", [2, 2, 2, 2, 2, 2, 2, 18]),
        { source: "docs.stripe.com", skillId: "bare-domain", installs: 9 },
      ],
    });
    const first = await readPopular(env);
    expect(requested).toEqual([
      "https://popular-once.test/api/skills/all-time/0",
    ]);
    expect(first.map((hit) => [hit.id, hit.trend])).toEqual([
      ["o/r/steady", 1],
      ["o/r/rising", 4.5],
    ]);

    expect(await readPopular(env)).toEqual(first);
    expect(requested).toHaveLength(1);
  });

  it("is empty, not an error, when the answer is unusable", async () => {
    reply({ skills: "not a list" });
    expect(
      await readPopular({ SKILLS_REGISTRY_URL: "https://popular-bad.test" }),
    ).toEqual([]);
    reply({}, 503);
    expect(
      await readPopular({ SKILLS_REGISTRY_URL: "https://popular-down.test" }),
    ).toEqual([]);
    // A failure is cached too, so the page does not wait on every load.
    requested = [];
    reply({ skills: [row("back", [1, 1, 1, 1, 1, 1, 1, 1])] });
    expect(
      await readPopular({ SKILLS_REGISTRY_URL: "https://popular-bad.test" }),
    ).toEqual([]);
    expect(requested).toEqual([]);
  });
});
