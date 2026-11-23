import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { parseDocument } from "yaml";
import { previewSkillAdd, readFrontmatter } from "~/concepts/skills";
import { sha256Hex } from "~/r2/bundles";
import { callMcp } from "./fixture-worker";

// The published web-scraper v1 header, including colons inside its folded text.
const WEB_SCRAPER = `---
name: web-scraper
description: >
  Build reliable, production-grade web scrapers: settle who the job is for,
  find the best data source on the site, then generate a Python script for
  scheduled extraction. Use this skill whenever the user wants
  to scrape a website, extract data from web pages, build a crawler, set up
  recurring data collection, reverse-engineer a site's API, or find hidden data
  endpoints. Also trigger when the user mentions "scrape", "crawl", "extract
  from site", "web data", "pull data from URL", "scheduled scraping",
  "monitor a page", "embed endpoint", "oEmbed", "syndication endpoint", or
  asks how to get data from a specific website or how to reach content
  without logging in. Assumes the user is authorized by the site owner
  unless they say otherwise, so it covers pulling data out of your own or a
  client's site as well as scraping a third party, and it covers red-teaming
  a site's scraping defenses: "how exposed is our data", "test our bot
  protection", "what could a scraper get from us", "scraping resilience".
---

# Web Scraper Skill
`;

afterEach(async () => {
  for (const table of ["search_docs", "skill_versions", "skills"]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

describe("SKILL.md frontmatter", () => {
  it("keeps nested metadata reparsable without changing its key hierarchy", () => {
    const frontmatter = readFrontmatter(`---
name: docs
description: Find docs.
metadata:
  credits:
    name: author
  version: 001
---
`);
    const metadata = parseDocument(frontmatter.metadata, {
      schema: "failsafe",
    });
    expect(metadata.errors).toEqual([]);
    expect(metadata.toJS()).toEqual({
      credits: { name: "author" },
      version: "001",
    });
  });

  it("folds the web-scraper description without inventing metadata keys", async () => {
    const description = `${WEB_SCRAPER.split("description: >\n")[1]
      .split("\n---")[0]
      .split("\n")
      .map((line) => line.slice(2))
      .join(" ")}\n`;
    expect(readFrontmatter(WEB_SCRAPER)).toEqual({
      name: "web-scraper",
      description,
    });
    expect(await previewSkillAdd(env.DB, "local", WEB_SCRAPER)).toMatchObject({
      errors: [],
      frontmatter: { description },
      existing: null,
    });
  });

  it.each([
    [">", "Read the docs.\n"],
    [">-", "Read the docs."],
    [">+", "Read the docs.\n\n"],
    ["|", "Read the\ndocs.\n"],
    ["|-", "Read the\ndocs."],
    ["|+", "Read the\ndocs.\n\n"],
  ])("honors %s folding and chomping before another key", (style, expected) => {
    expect(
      readFrontmatter(`---
name: docs
description: ${style} # a header comment
  Read the
  docs.

license: MIT
---
`).description,
    ).toBe(expected);
  });

  it.each([
    [">-", "First paragraph.\nNext paragraph.\n  code: value\nLast line."],
    ["|-", "First paragraph.\n\nNext paragraph.\n  code: value\nLast line."],
  ])("preserves paragraphs and extra indentation for %s", (style, expected) => {
    expect(
      readFrontmatter(`---
name: docs
description: ${style}
  First paragraph.

  Next paragraph.
    code: value
  Last line.
---
`).description,
    ).toBe(expected);
  });

  it.each(["|2-", "|-2", ">2-", ">-2"])(
    "honors explicit indentation for %s with CRLF and a final fence",
    (style) => {
      const body = `---\nname: docs\ndescription: ${style}\n    indented\n---`;
      expect(readFrontmatter(body.replaceAll("\n", "\r\n"))).toEqual({
        name: "docs",
        description: "  indented",
      });
    },
  );

  it("keeps structured metadata under its own key and scalars as strings", () => {
    const metadata = `credits:
    name: someone-else
    description: not the skill description
    license: Apache-2.0
  version: 001
`;
    expect(
      readFrontmatter(`---
name: docs
description: >-
  Find docs: use "search".
metadata:
  ${metadata}license: MIT
version: 001
enabled: false
allowed-tools: [Read, "Web: Fetch"]
__proto__: inert
---
`),
    ).toEqual({
      name: "docs",
      description: 'Find docs: use "search".',
      metadata: `  ${metadata}`,
      license: "MIT",
      version: "001",
      enabled: "false",
      "allowed-tools": '[Read, "Web: Fetch"]',
      ["__proto__"]: "inert",
    });
  });

  it("decodes quoted scalars without stripping embedded quotes or comments", () => {
    expect(
      readFrontmatter(`---
name: docs
description: "Use \\"search\\".\\nRead docs." # comment
license: 'It''s MIT'
---
`),
    ).toEqual({
      name: "docs",
      description: 'Use "search".\nRead docs.',
      license: "It's MIT",
    });
  });

  it.each([
    "description: >\n",
    "description: |-\n  \n",
    "description: [not, text]\n",
    "description: {text: nope}\n",
    "description: *alias\n",
    "description: !custom text\n",
    "description: First\ndescription: Second\n",
    "description: |\n    first\n  invalid indentation\n",
  ])("returns repairable preview errors for %j", async (description) => {
    const body = `---\nname: docs\n${description}---\n`;
    const preview = await previewSkillAdd(env.DB, "local", body);
    expect(preview.errors.length).toBeGreaterThan(0);
    expect(preview.frontmatter).toEqual({});
    const result = await callMcp("tools/call", {
      name: "publish_skill",
      arguments: { body },
    });
    expect(result.value.result.isError).toBe(true);
    expect(
      await env.DB.prepare("SELECT count(*) AS n FROM skills").first("n"),
    ).toBe(0);
  });

  it.each([
    [">-", "Read docs: first. Then search."],
    ["|", "Read docs: first.\nThen search.\n"],
  ])(
    "serves %s descriptions through MCP tools and resources",
    async (style, description) => {
      const body = `---
name: docs
description: ${style}
  Read docs: first.
  Then search.
license: MIT
---

# Docs
`.trimEnd();
      const published = await callMcp("tools/call", {
        name: "publish_skill",
        arguments: { body },
      });
      expect(published.value.result.isError).not.toBe(true);
      expect(published.value.result.structuredContent).toMatchObject({
        name: "docs",
        description,
        body,
      });
      for (const name of ["get_skill", "skill_docs"]) {
        const called = await callMcp("tools/call", {
          name,
          arguments: name === "get_skill" ? { name: "docs" } : {},
        });
        expect(called.value.result.structuredContent).toMatchObject({
          description,
          body,
        });
      }
      const tools = await callMcp("tools/list", {});
      expect(tools.value.result.tools).toContainEqual(
        expect.objectContaining({
          name: "skill_docs",
          description: expect.stringContaining(description),
        }),
      );
      const legacy = await callMcp("tools/call", {
        name: "list_skills",
        arguments: {},
      });
      expect(legacy.value.result.structuredContent?.skills).toContainEqual(
        expect.objectContaining({ description }),
      );
      const entry = {
        uri: "skill://docs/SKILL.md",
        frontmatter: { name: "docs", description, license: "MIT" },
        resources: [
          {
            uri: "skill://docs/SKILL.md",
            digest: `sha256:${await sha256Hex(body)}`,
            size: new TextEncoder().encode(body).length,
          },
        ],
      };
      expect((await callMcp("skills/list", {})).value.result.skills).toEqual([
        entry,
      ]);
      expect(
        (await callMcp("skills/get", { uri: entry.uri })).value.result.skill,
      ).toEqual(entry);
      const resources = await callMcp("resources/list", {});
      expect(resources.value.result.resources).toContainEqual(
        expect.objectContaining({ uri: entry.uri, description }),
      );
      const read = await callMcp("resources/read", { uri: entry.uri });
      expect(read.value.result.contents).toEqual([
        expect.objectContaining({ text: body }),
      ]);
      const index = await callMcp("resources/read", {
        uri: "skill://index.json",
      });
      const contents = index.value.result.contents;
      if (!Array.isArray(contents)) throw new Error("Expected index contents");
      const content: unknown = contents[0];
      if (
        typeof content !== "object" ||
        content === null ||
        !("text" in content) ||
        typeof content.text !== "string"
      )
        throw new Error("Expected a text index");
      expect(JSON.parse(content.text).skills).toContainEqual(
        expect.objectContaining({ name: "docs", description }),
      );
    },
  );
});
