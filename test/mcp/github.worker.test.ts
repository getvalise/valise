import { env as worker } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURATED_SKILLS,
  curatedFor,
  curatedMatches,
  curatedName,
} from "~/concepts/curated-skills";
import {
  changeSkills,
  editSkill,
  getSkill,
  listSkillVersions,
  publishSkill,
} from "~/concepts/skills";
import {
  bundleDigest,
  classifyGithubSkills,
  downloadGithubSkill,
  importGithubSkills,
  listGithubSkills,
  parseGithubSource,
  parseSkillUrl,
} from "~/concepts/skills-github";
import {
  checkAllUpstream,
  checkUpstream,
  readUpstream,
  updateSkills,
} from "~/concepts/skills-upstream";
import { readSkillFile } from "~/mcp/resources";
import { sha256Hex } from "~/r2/bundles";

/**
 * GitHub is stubbed with a tarball built here, shaped like what
 * `codeload.github.com` serves: a pax global header naming the commit, one
 * `<repo>-<ref>/` folder, and symlinks as entries rather than folders.
 */

const SHA = "1ff034b88d776f06a65d8fbf7599248ac3828bb9";
const env = { GITHUB_CODELOAD_URL: "https://codeload.test" };
let requested: string[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  requested = [];
  for (const table of ["search_docs", "skill_versions", "skills"]) {
    await worker.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

type Entry =
  | { path: string; content: string | Uint8Array }
  | { path: string; link: string };

function skill(name: string, text = "Do it.") {
  return `---\nname: ${name}\ndescription: The ${name} skill.\n---\n\n${text}\n`;
}

/** The agent-skills layout: main copies, codex copies, claude symlinks. */
const AGENT_SKILLS: Entry[] = [
  {
    path: ".claude-plugin/marketplace.json",
    content: JSON.stringify({
      plugins: [
        { name: "dstack", source: "./plugins/claude/dstack" },
        { name: "tools", source: "./plugins/claude/tools" },
      ],
    }),
  },
  { path: "skills/dstack/architect/SKILL.md", content: skill("architect") },
  {
    path: "skills/dstack/architect/references/adr.md",
    content: "# ADR\n",
  },
  { path: "skills/tools/scraper/SKILL.md", content: skill("scraper") },
  {
    path: "plugins/codex/dstack/skills/architect/SKILL.md",
    content: skill("architect"),
  },
  { path: "plugins/claude/dstack/skills", link: "../../../skills/dstack" },
  { path: "plugins/claude/tools/skills", link: "../../../skills/tools" },
  { path: "docs/loose/SKILL.md", content: skill("loose") },
];

function serve(entries: Entry[], status = 200) {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    requested.push(String(input));
    if (status !== 200) return new Response("no", { status });
    const tar = new Blob([tarball("agent-skills-HEAD", entries)]);
    return new Response(
      tar.stream().pipeThrough(new CompressionStream("gzip")),
    );
  });
}

describe("reading a pasted URL", () => {
  it("resolves files, folders, repos and skills.sh links", () => {
    expect(
      parseSkillUrl("https://github.com/o/r/blob/main/skills/a/SKILL.md"),
    ).toEqual({
      kind: "github",
      owner: "o",
      repo: "r",
      ref: "main",
      path: "skills/a",
      scope: "skill",
    });
    expect(
      parseSkillUrl("https://raw.githubusercontent.com/o/r/v1/SKILL.md"),
    ).toMatchObject({ ref: "v1", path: "", scope: "skill" });
    expect(parseSkillUrl("github.com/o/r/tree/main/skills/a/")).toMatchObject({
      path: "skills/a",
      scope: "skill",
    });
    expect(parseSkillUrl("o/r")).toMatchObject({ ref: "HEAD", scope: "repo" });
    expect(parseSkillUrl("https://github.com/o/r.git")).toMatchObject({
      repo: "r",
      scope: "repo",
    });
    expect(parseSkillUrl("o/r/s")).toEqual({ kind: "skills.sh", id: "o/r/s" });
    expect(parseSkillUrl("https://www.skills.sh/o/r/s")).toEqual({
      kind: "skills.sh",
      id: "o/r/s",
    });
    expect(parseSkillUrl("https://github.com/o/r/blob/main/README.md")).toEqual(
      { errors: [expect.stringContaining("not a GitHub file")] },
    );
    expect(parseSkillUrl("https://example.com/o/r")).toHaveProperty("errors");
  });

  it("round-trips the source it records", () => {
    expect(parseGithubSource(`github:o/r@${SHA}:skills/a`)).toEqual({
      owner: "o",
      repo: "r",
      sha: SHA,
      path: "skills/a",
    });
    expect(parseGithubSource(`github:o/r@${SHA}:.`)).toMatchObject({
      path: "",
    });
    expect(parseGithubSource(`github:o/r@${SHA}:../x`)).toBeNull();
  });
});

describe("downloading from GitHub", () => {
  it("takes one skill with the files beside it, pinned to the commit", async () => {
    serve(AGENT_SKILLS);
    const got = await downloadGithubSkill(
      env,
      "acme",
      "agent-skills",
      "main",
      "skills/dstack/architect",
    );
    expect(requested).toEqual([
      "https://codeload.test/acme/agent-skills/tar.gz/main",
    ]);
    expect(got).toMatchObject({
      source: `github:acme/agent-skills@${SHA}:skills/dstack/architect`,
      body: skill("architect"),
      files: [{ path: "references/adr.md", content: "# ADR\n" }],
    });
    expect("hash" in got && got.hash).toBe(
      await bundleDigest(skill("architect"), [
        { path: "references/adr.md", content: "# ADR\n" },
      ]),
    );
  });

  it("lists every skill in a repo once, grouped by plugin", async () => {
    serve(AGENT_SKILLS);
    const listed = await listGithubSkills(env, "acme", "agent-skills", "HEAD");
    expect(listed).toMatchObject({
      sha: SHA,
      groups: [
        {
          plugin: "dstack",
          skills: [{ name: "architect", path: "skills/dstack/architect" }],
        },
        {
          plugin: "tools",
          skills: [{ name: "scraper", path: "skills/tools/scraper" }],
        },
        { plugin: null, skills: [{ name: "loose", path: "docs/loose" }] },
      ],
    });
  });

  it("answers with a message, not a throw, for the ways it fails", async () => {
    serve([], 404);
    expect(await listGithubSkills(env, "o", "nope", "HEAD")).toEqual({
      errors: [expect.stringContaining("no public o/nope")],
    });

    serve([{ path: "skills/a/README.md", content: "no skill" }]);
    expect(
      await downloadGithubSkill(env, "o", "r", "HEAD", "skills/a"),
    ).toEqual({ errors: ["There is no SKILL.md in skills/a."] });

    serve([
      { path: "s/SKILL.md", content: new Uint8Array([0x89, 0xff, 0xfe]) },
    ]);
    expect(await downloadGithubSkill(env, "o", "r", "HEAD", "s")).toEqual({
      errors: ["s/SKILL.md is not UTF-8 text."],
    });

    serve([
      { path: "s/SKILL.md", content: skill("s") },
      ...Array.from({ length: 51 }, (_, i) => ({
        path: `s/f${i}.md`,
        content: "x",
      })),
    ]);
    expect(await downloadGithubSkill(env, "o", "r", "HEAD", "s")).toEqual({
      errors: ["That skill carries more than 50 files."],
    });
  });
});

describe("importing many skills from one listing", () => {
  const actor = {
    userId: "local",
    agent: "console",
    client: "console",
    session: null,
  };
  const both = { ...worker, ...env };
  const pinned = (paths: string[]) => ({
    owner: "acme",
    repo: "agent-skills",
    sha: SHA,
    paths,
  });
  const listed = [
    { name: "architect", path: "skills/dstack/architect" },
    { name: "scraper", path: "skills/tools/scraper" },
    { name: "loose", path: "docs/loose" },
  ];

  it("lists and imports a skill with a literal description", async () => {
    const body = `---
name: docs
description: |-
  Find docs: first.
  Then search.
license: MIT
---
`;
    serve([{ path: "docs/SKILL.md", content: body }]);
    expect(await listGithubSkills(env, "o", "r", "HEAD")).toMatchObject({
      groups: [
        {
          skills: [
            { name: "docs", description: "Find docs: first.\nThen search." },
          ],
        },
      ],
    });
    expect(
      await importGithubSkills(
        both,
        { owner: "o", repo: "r", sha: SHA, paths: ["docs"] },
        {},
        actor,
      ),
    ).toMatchObject({ imported: [{ name: "docs", version: 1 }], failed: [] });
    expect(await getSkill(worker.DB, "local", "docs")).toMatchObject({
      body,
      description: "Find docs: first.\nThen search.",
      frontmatter: { license: "MIT" },
    });
  });

  it("publishes every ticked skill from one tarball, labelled and pinned", async () => {
    serve(AGENT_SKILLS);
    const report = await importGithubSkills(
      both,
      pinned(["skills/dstack/architect", "skills/tools/scraper"]),
      { project: "valise", tags: ["dstack"] },
      actor,
    );

    expect(requested).toEqual([
      `https://codeload.test/acme/agent-skills/tar.gz/${SHA}`,
    ]);
    expect(report).toEqual({
      imported: [
        { name: "architect", version: 1 },
        { name: "scraper", version: 1 },
      ],
      taken: [],
      failed: [],
    });
    expect(await getSkill(worker.DB, "local", "architect")).toMatchObject({
      source: `github:acme/agent-skills@${SHA}:skills/dstack/architect`,
      project: "valise",
      tags: ["dstack"],
      files: [expect.objectContaining({ path: "references/adr.md" })],
    });
    expect(
      await classifyGithubSkills(
        worker.DB,
        "local",
        "acme",
        "agent-skills",
        listed,
      ),
    ).toEqual(
      new Map([
        ["skills/dstack/architect", "added"],
        ["skills/tools/scraper", "added"],
        ["docs/loose", "new"],
      ]),
    );
  });

  it("skips a name another skill owns, and reports a bad path without stopping", async () => {
    await publishSkill(
      worker,
      { body: skill("scraper", "Written here."), files: [] },
      actor,
    );
    expect(
      await classifyGithubSkills(
        worker.DB,
        "local",
        "acme",
        "agent-skills",
        listed,
      ),
    ).toEqual(
      new Map([
        ["skills/dstack/architect", "new"],
        ["skills/tools/scraper", "taken"],
        ["docs/loose", "new"],
      ]),
    );

    serve(AGENT_SKILLS);
    const report = await importGithubSkills(
      both,
      pinned(["skills/tools/scraper", "docs/missing", "docs/loose"]),
      {},
      actor,
    );

    expect(report).toEqual({
      imported: [{ name: "loose", version: 1 }],
      taken: [{ name: "scraper", path: "skills/tools/scraper" }],
      failed: [
        {
          path: "docs/missing",
          errors: ["There is no SKILL.md in docs/missing."],
        },
      ],
    });
    // The hand-written scraper is untouched.
    expect(await getSkill(worker.DB, "local", "scraper")).toMatchObject({
      version: 1,
      source: null,
    });
  });

  it("bundles an image as bytes and serves it back over skill:// as a blob", async () => {
    // Not UTF-8: a PNG signature and a byte no text encoding produces here.
    const png = new Uint8Array([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0xff,
    ]);
    serve([
      { path: "s/SKILL.md", content: skill("stamped") },
      { path: "s/assets/stamp.png", content: png },
      { path: "s/notes.md", content: "Plain text.\n" },
    ]);
    const report = await importGithubSkills(
      both,
      { owner: "o", repo: "r", sha: SHA, paths: ["s"] },
      {},
      actor,
    );
    expect(report).toEqual({
      imported: [{ name: "stamped", version: 1 }],
      taken: [],
      failed: [],
    });

    const stored = await getSkill(worker.DB, "local", "stamped");
    expect(stored?.files).toEqual([
      expect.objectContaining({ path: "assets/stamp.png", size: 9 }),
      expect.objectContaining({ path: "notes.md", size: 12 }),
    ]);
    expect(stored?.sourceHash).toBe(
      await bundleDigest(skill("stamped"), [
        { path: "assets/stamp.png", content: png },
        { path: "notes.md", content: "Plain text.\n" },
      ]),
    );

    const image = await readSkillFile(
      worker.BUNDLES,
      { get: (name) => getSkill(worker.DB, "local", name) },
      "skill://stamped/assets/stamp.png",
    );
    expect(image).toEqual({
      mimeType: "image/png",
      blob: btoa(String.fromCharCode(...png)),
    });
    const text = await readSkillFile(
      worker.BUNDLES,
      { get: (name) => getSkill(worker.DB, "local", name) },
      "skill://stamped/notes.md",
    );
    expect(text).toEqual({ mimeType: "text/markdown", text: "Plain text.\n" });
  });

  it("hashes a text file the same as a string or as its bytes", async () => {
    const text = "Plain text, with a ü.\n";
    expect(await sha256Hex(new TextEncoder().encode(text))).toBe(
      await sha256Hex(text),
    );
  });

  it("lists a deleted skill as new, and importing it restores it", async () => {
    serve(AGENT_SKILLS);
    await importGithubSkills(both, pinned(["docs/loose"]), {}, actor);
    await changeSkills(worker, "local", ["loose"], "delete");
    expect(
      await classifyGithubSkills(worker.DB, "local", "acme", "agent-skills", [
        listed[2],
      ]),
    ).toEqual(new Map([["docs/loose", "new"]]));

    serve(AGENT_SKILLS);
    await importGithubSkills(both, pinned(["docs/loose"]), {}, actor);

    expect(await getSkill(worker.DB, "local", "loose")).toMatchObject({
      version: 1,
      deleted: false,
    });
  });
});

describe("checking imported skills for upstream updates", () => {
  const actor = {
    userId: "local",
    agent: "console",
    client: "console",
    session: null,
  };
  const both = { ...worker, ...env };

  async function importArchitect(entries: Entry[]) {
    serve(entries);
    const got = await downloadGithubSkill(
      env,
      "acme",
      "agent-skills",
      "HEAD",
      "skills/dstack/architect",
    );
    if ("errors" in got) throw new Error(got.errors.join(" "));
    await publishSkill(worker, { body: got.body, files: got.files }, actor, {
      source: got.source,
      sourceHash: got.hash,
    });
  }

  it("reports nothing until upstream changes, then the update and a local edit", async () => {
    await importArchitect(AGENT_SKILLS);
    expect(await readUpstream(worker.DB, "local", ["architect"])).toEqual(
      new Map([
        [
          "architect",
          {
            hash: null,
            source: null,
            checkedAt: null,
            available: false,
            editedHere: false,
          },
        ],
      ]),
    );

    serve(AGENT_SKILLS);
    expect(await checkUpstream(both, "local", "architect")).toEqual({
      errors: [],
      applied: [],
      held: [],
    });
    expect(
      (await readUpstream(worker.DB, "local", ["architect"])).get("architect"),
    ).toMatchObject({ available: false, checkedAt: expect.any(Number) });

    // Only a bundled file changes upstream; that is still an update.
    const changed = AGENT_SKILLS.map((entry) =>
      entry.path === "skills/dstack/architect/references/adr.md"
        ? { path: entry.path, content: "# ADR, revised\n" }
        : entry,
    );
    await editSkill(
      worker,
      "architect",
      skill("architect", "Edited here."),
      actor,
    );
    requested = [];
    serve(changed);
    // The cron path: one tarball for the repository.
    // Auto-update is off, so nothing is applied or held.
    expect(await checkAllUpstream(both)).toEqual({
      errors: [],
      applied: [],
      held: [],
    });
    expect(requested).toHaveLength(1);
    const state = (await readUpstream(worker.DB, "local", ["architect"])).get(
      "architect",
    );
    expect(state).toMatchObject({ available: true, editedHere: true });

    // Publishing the upstream copy clears both.
    serve(changed);
    const update = await downloadGithubSkill(
      env,
      "acme",
      "agent-skills",
      "HEAD",
      "skills/dstack/architect",
    );
    if ("errors" in update) throw new Error(update.errors.join(" "));
    await publishSkill(
      worker,
      { body: update.body, files: update.files },
      actor,
      { source: update.source, sourceHash: update.hash },
    );
    expect(await getSkill(worker.DB, "local", "architect")).toMatchObject({
      version: 3,
    });
    expect(
      (await readUpstream(worker.DB, "local", ["architect"])).get("architect"),
    ).toMatchObject({ available: false, editedHere: false });
  });

  it("refuses a skill that was not imported", async () => {
    await publishSkill(worker, { body: skill("local"), files: [] }, actor);
    expect(await checkUpstream(both, "local", "local")).toEqual({
      errors: ["local was not imported."],
      applied: [],
      held: [],
    });
  });

  const revised = AGENT_SKILLS.map((entry) =>
    entry.path === "skills/dstack/architect/SKILL.md"
      ? { path: entry.path, content: skill("architect", "Revised upstream.") }
      : entry,
  );

  it("publishes upstream's change on the cron when the skill auto-updates", async () => {
    await importArchitect(AGENT_SKILLS);
    await changeSkills(worker, "local", ["architect"], "auto-on");

    serve(revised);
    expect(await checkAllUpstream(both)).toEqual({
      errors: [],
      applied: ["architect"],
      held: [],
    });

    const head = await getSkill(worker.DB, "local", "architect");
    expect(head).toMatchObject({ version: 2, autoUpdate: true });
    expect(head?.body).toContain("Revised upstream.");
    // The applied version is an import: nothing pending, nothing edited.
    expect(
      (await readUpstream(worker.DB, "local", ["architect"])).get("architect"),
    ).toMatchObject({ available: false, editedHere: false });
    const [latest] = await listSkillVersions(worker.DB, "local", "architect");
    expect(latest.createdBy).toBe("auto-update");

    // A second run finds nothing new.
    serve(revised);
    expect(await checkAllUpstream(both)).toEqual({
      errors: [],
      applied: [],
      held: [],
    });
  });

  it("holds an auto-updating skill that was edited here", async () => {
    await importArchitect(AGENT_SKILLS);
    await changeSkills(worker, "local", ["architect"], "auto-on");
    await editSkill(worker, "architect", skill("architect", "Mine."), actor);

    serve(revised);
    expect(await checkAllUpstream(both)).toEqual({
      errors: [],
      applied: [],
      held: ["architect"],
    });
    expect((await getSkill(worker.DB, "local", "architect"))?.body).toContain(
      "Mine.",
    );
  });

  it("updates the named skills on demand whatever their setting, still holding edits", async () => {
    await importArchitect(AGENT_SKILLS);
    serve(AGENT_SKILLS);
    await importGithubSkills(
      both,
      {
        owner: "acme",
        repo: "agent-skills",
        sha: SHA,
        paths: ["skills/tools/scraper"],
      },
      {},
      actor,
    );
    await editSkill(worker, "scraper", skill("scraper", "Mine."), actor);
    const changed = revised.map((entry) =>
      entry.path === "skills/tools/scraper/SKILL.md"
        ? { path: entry.path, content: skill("scraper", "Revised upstream.") }
        : entry,
    );

    serve(changed);
    expect(await updateSkills(both, ["architect", "scraper"], actor)).toEqual({
      errors: [],
      applied: ["architect"],
      held: ["scraper"],
    });
    expect((await getSkill(worker.DB, "local", "architect"))?.body).toContain(
      "Revised upstream.",
    );
    expect((await getSkill(worker.DB, "local", "scraper"))?.body).toContain(
      "Mine.",
    );
  });

  it("sets auto-update only on imported skills", async () => {
    await importArchitect(AGENT_SKILLS);
    await publishSkill(worker, { body: skill("local"), files: [] }, actor);

    expect(
      await changeSkills(worker, "local", ["architect", "local"], "auto-on"),
    ).toEqual({
      changed: ["architect"],
      skipped: [{ name: "local", reason: "no-upstream" }],
    });
    expect(await getSkill(worker.DB, "local", "architect")).toMatchObject({
      autoUpdate: true,
    });
  });
});

describe("curated suggestions", () => {
  const github = {
    source:
      "https://github.com/acme/agent-skills/tree/HEAD/skills/dstack/unslop",
    reason: "Because.",
  };
  const registry = { source: "mattpocock/skills/tdd", reason: "Because." };

  it("matches an import of the same skill, at any commit", () => {
    expect(curatedName(github)).toBe("unslop");
    expect(
      curatedMatches(
        github,
        `github:acme/agent-skills@${SHA}:skills/dstack/unslop`,
      ),
    ).toBe(true);
    expect(
      curatedMatches(
        github,
        `github:acme/agent-skills@${SHA}:skills/dstack/how`,
      ),
    ).toBe(false);
    expect(curatedMatches(registry, "mattpocock/skills/tdd")).toBe(true);
    expect(curatedMatches(registry, "other/skills/tdd")).toBe(false);
  });

  it("ships entries that each parse as a source the dialog can open", () => {
    expect(CURATED_SKILLS.length).toBeGreaterThan(0);
    for (const entry of CURATED_SKILLS) {
      expect(parseSkillUrl(entry.source), entry.source).not.toHaveProperty(
        "errors",
      );
      expect(curatedFor(entry.source)).toBe(entry);
    }
  });
});

/** A ustar archive with a pax global header, as `git archive` writes. */
function tarball(top: string, entries: Entry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  const pax = `52 comment=${SHA}\n`;
  blocks.push(header("pax_global_header", pax.length, "g"), pad(pax));
  blocks.push(header(`${top}/`, 0, "5"));
  for (const entry of entries) {
    if ("link" in entry) {
      blocks.push(header(`${top}/${entry.path}`, 0, "2", entry.link));
    } else {
      const bytes =
        typeof entry.content === "string"
          ? new TextEncoder().encode(entry.content)
          : entry.content;
      blocks.push(
        header(`${top}/${entry.path}`, bytes.length, "0"),
        pad(bytes),
      );
    }
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, block) => n + block.length, 0));
  let at = 0;
  for (const block of blocks) {
    out.set(block, at);
    at += block.length;
  }
  return out;
}

function header(name: string, size: number, type: string, link = "") {
  const block = new Uint8Array(512);
  const put = (text: string, at: number) =>
    block.set(new TextEncoder().encode(text), at);
  put(name, 0);
  put("0000644\0", 100);
  put(`${size.toString(8).padStart(11, "0")}\0`, 124);
  put(type, 156);
  put(link, 157);
  put("ustar\0" + "00", 257);
  put("        ", 148);
  const sum = block.reduce((n, byte) => n + byte, 0);
  put(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  return block;
}

function pad(content: string | Uint8Array): Uint8Array {
  const bytes =
    typeof content === "string" ? new TextEncoder().encode(content) : content;
  const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  out.set(bytes);
  return out;
}
