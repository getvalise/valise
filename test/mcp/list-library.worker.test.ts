import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { authenticatedTool } from "./authenticated-call";

const OWNER = "local";
const OTHER = "usr_list_library_other";
const SCOPES = ["memories:read", "sources:read"];
const BODY = "A long body that must never be listed. ".repeat(40);
const NOTES = "Private notes that must never be listed.";
const ARTICLE = "Captured article text that must never be listed.";

const tool = (args: Record<string, unknown>, name: string, user = OWNER) =>
  authenticatedTool(user, SCOPES, name, args);

type Page<K extends string> = {
  next_cursor: string | null;
  has_more: boolean;
} & Record<K, Record<string, unknown>[]>;

async function page<K extends string>(
  name: string,
  key: K,
  args: Record<string, unknown>,
  user = OWNER,
) {
  const result = await tool(args, name, user);
  expect(result.isError, result.content[0]?.text).toBeFalsy();
  return result.structuredContent as unknown as Page<K>;
}

/** Every page of a listing, following next_cursor until null. */
async function all<K extends string>(
  name: string,
  key: K,
  args: Record<string, unknown>,
) {
  const ids: string[] = [];
  let cursor: string | null = null;
  do {
    const one: Page<K> = await page(name, key, { ...args, cursor });
    ids.push(...one[key].map((row) => row.id as string));
    cursor = one.next_cursor;
  } while (cursor);
  return ids;
}

const sourceUuid = (n: number) =>
  `src_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

function memory(
  id: string,
  {
    user = OWNER,
    type = "reference",
    title = `Memory ${id}` as string | null,
    project = "valise" as string | null,
    tags = ["meos"],
    created = 100 as number,
    updated = undefined as number | undefined,
    deleted = null as number | null,
  } = {},
) {
  return env.DB.prepare(
    `INSERT INTO memories (memory_id, user_id, memory_type, title, body, project,
       tags_json, source_agent, source_client, created_at, updated_at, deleted_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'fixture', 'test', ?, ?, ?)`,
  ).bind(
    id,
    user,
    type,
    title,
    BODY,
    project,
    JSON.stringify(tags),
    created,
    updated ?? created,
    deleted,
  );
}

function source(
  n: number,
  {
    user = OWNER,
    kind = "bookmark",
    project = "valise" as string | null,
    tags = ["meos"],
    authors = [] as string[],
    url = `https://example.test/${n}` as string | null,
    created = 100,
    archived = null as number | null,
  } = {},
) {
  return env.DB.prepare(
    `INSERT INTO sources (source_id, user_id, kind, title, url, notes, project,
       tags_json, authors_json, revision, source_agent, source_client,
       created_at, updated_at, archived_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 'fixture', 'test', ?, ?, ?)`,
  ).bind(
    sourceUuid(n),
    user,
    kind,
    `Source ${n}`,
    url,
    NOTES,
    project,
    JSON.stringify(tags),
    JSON.stringify(authors),
    created,
    created,
    archived,
  );
}

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, created_at, email_verified)
     VALUES (?, ?, unixepoch(), 1)`,
  )
    .bind(OTHER, OTHER)
    .run();
});

afterEach(async () => {
  for (const table of ["memories", "source_articles", "sources", "mcp_calls"])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

describe("list_memories", () => {
  it("pages newest first, stable across an edit and an insert between pages", async () => {
    // Five share one second, so the id tiebreak carries the order.
    await env.DB.batch([
      memory("mem_a", { created: 200 }),
      memory("mem_b", { created: 100 }),
      memory("mem_c", { created: 100 }),
      memory("mem_d", { created: 100 }),
      memory("mem_e", { created: 100 }),
      memory("mem_f", { created: 100 }),
      memory("mem_g", { created: 50 }),
    ]);
    const first = await page("list_memories", "memories", { limit: 3 });
    expect(first.memories.map((row) => row.id)).toEqual([
      "memory:mem_a",
      "memory:mem_b",
      "memory:mem_c",
    ]);
    expect(first.has_more).toBe(true);

    // An edit bumps updated_at; a backdated insert lands inside the window.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE memories SET updated_at = 999, title = 'Edited' WHERE memory_id = 'mem_f'",
      ),
      memory("mem_cc", { created: 100 }),
    ]);
    const rest: string[] = [];
    let cursor = first.next_cursor;
    while (cursor) {
      const next = await page("list_memories", "memories", {
        limit: 3,
        cursor,
      });
      rest.push(...next.memories.map((row) => row.id as string));
      cursor = next.next_cursor;
    }
    expect(rest).toEqual([
      "memory:mem_d",
      "memory:mem_e",
      "memory:mem_f",
      "memory:mem_g",
    ]);

    // A fresh listing sees the insert.
    expect(await all("list_memories", "memories", { limit: 2 })).toContain(
      "memory:mem_cc",
    );
  });

  it("returns compact rows without the body, and leaves out empty fields", async () => {
    await env.DB.batch([
      memory("mem_full", { created: 200, updated: 300 }),
      memory("mem_bare", { title: null, project: null, tags: [] }),
    ]);
    const result = await tool({}, "list_memories");
    expect(JSON.stringify(result)).not.toContain(BODY);
    const [full, bare] = (
      result.structuredContent as { memories: Record<string, unknown>[] }
    ).memories;
    expect(full).toEqual({
      id: "memory:mem_full",
      title: "Memory mem_full",
      summary: expect.stringMatching(
        /^A long body that must never be listed\./,
      ),
      memory_type: "reference",
      project: "valise",
      tags: ["meos"],
      created_at: 200,
      updated_at: 300,
    });
    expect((full?.summary as string).length).toBeLessThanOrEqual(160);
    // No title: the summary becomes the title and is not sent twice.
    expect(bare).toEqual({
      id: "memory:mem_bare",
      title: expect.stringMatching(/^A long body/),
      memory_type: "reference",
      created_at: 100,
      updated_at: 100,
    });
  });

  it("filters by project, type, every tag and the updated window", async () => {
    await env.DB.batch([
      memory("mem_1", { type: "Feedback", tags: ["meos", "ui"], updated: 150 }),
      memory("mem_2", { type: "reference", tags: ["meos"], updated: 250 }),
      memory("mem_3", { project: "tools", tags: ["MEOS", "ui"], updated: 350 }),
      memory("mem_gone", { deleted: 400 }),
      memory("mem_theirs", { user: OTHER }),
    ]);
    const ids = (args: Record<string, unknown>) =>
      all("list_memories", "memories", args);

    expect(await ids({})).toEqual([
      "memory:mem_1",
      "memory:mem_2",
      "memory:mem_3",
    ]);
    expect(await ids({ project: "tools" })).toEqual(["memory:mem_3"]);
    expect(await ids({ memory_type: "feedback" })).toEqual(["memory:mem_1"]);
    expect(await ids({ tags: ["ui", "meos"] })).toEqual([
      "memory:mem_1",
      "memory:mem_3",
    ]);
    expect(await ids({ updated_since: 250 })).toEqual([
      "memory:mem_2",
      "memory:mem_3",
    ]);
    expect(await ids({ updated_since: 150, updated_before: 350 })).toEqual([
      "memory:mem_1",
      "memory:mem_2",
    ]);
    // Each tenant lists only its own; the owner's list above has no mem_theirs.
    const theirs = await page("list_memories", "memories", {}, OTHER);
    expect(theirs.memories.map((row) => row.id)).toEqual(["memory:mem_theirs"]);
  });

  it("refuses a cursor reused with other filters, or one that is not a cursor", async () => {
    await env.DB.batch([memory("mem_1"), memory("mem_2"), memory("mem_3")]);
    const { next_cursor } = await page("list_memories", "memories", {
      limit: 1,
    });
    expect(next_cursor).toBeTruthy();
    const changed = await tool(
      { limit: 1, cursor: next_cursor, project: "valise" },
      "list_memories",
    );
    expect(changed.isError).toBe(true);
    expect(changed.content[0]?.text).toContain("Invalid cursor");
    // The limit is not a filter: a page size can change mid-listing.
    expect(
      (await tool({ limit: 2, cursor: next_cursor }, "list_memories")).isError,
    ).toBeFalsy();
    expect(
      (await tool({ cursor: "not-a-cursor" }, "list_memories")).isError,
    ).toBe(true);
    // Another tenant's cursor is refused, not read as theirs.
    expect(
      (await tool({ limit: 1, cursor: next_cursor }, "list_memories", OTHER))
        .isError,
    ).toBe(true);
    // null starts a listing, as list_todos accepts.
    expect((await tool({ cursor: null }, "list_memories")).isError).toBeFalsy();
  });
});

describe("list_sources", () => {
  it("pages newest saved first, stable across a revision and an insert between pages", async () => {
    await env.DB.batch([
      source(1, { created: 200 }),
      source(2),
      source(3),
      source(4),
      source(5, { created: 50 }),
    ]);
    const first = await page("list_sources", "sources", { limit: 2 });
    expect(first.sources.map((row) => row.id)).toEqual([
      `source:${sourceUuid(1)}`,
      `source:${sourceUuid(2)}`,
    ]);
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE sources SET revision = 2, updated_at = 999, title = 'Revised' WHERE source_id = ?",
      ).bind(sourceUuid(4)),
      source(6),
    ]);
    const rest: string[] = [];
    let cursor = first.next_cursor;
    while (cursor) {
      const next = await page("list_sources", "sources", { limit: 2, cursor });
      rest.push(...next.sources.map((row) => row.id as string));
      cursor = next.next_cursor;
    }
    expect(rest).toEqual([3, 4, 5].map((n) => `source:${sourceUuid(n)}`));
  });

  it("returns compact rows without notes or article text", async () => {
    await env.DB.batch([
      source(1, { authors: ["Luke Wroblewski"], created: 200 }),
      source(2, { url: null, project: null, tags: [], kind: "reference" }),
      env.DB.prepare(
        `INSERT INTO source_articles (source_id, revision, user_id, detected,
           markdown, text, word_count, page_word_count, extractor, created_at)
         VALUES (?, 1, ?, 1, ?, ?, 7, 7, 'fixture', 200)`,
      ).bind(sourceUuid(1), OWNER, ARTICLE, ARTICLE),
    ]);
    const result = await tool({}, "list_sources");
    const text = JSON.stringify(result);
    expect(text).not.toContain(NOTES);
    expect(text).not.toContain(ARTICLE);
    const [one, two] = (
      result.structuredContent as { sources: Record<string, unknown>[] }
    ).sources;
    expect(one).toEqual({
      id: `source:${sourceUuid(1)}`,
      title: "Source 1",
      url: "https://example.test/1",
      kind: "bookmark",
      project: "valise",
      tags: ["meos"],
      authors: ["Luke Wroblewski"],
      created_at: 200,
      updated_at: 200,
    });
    expect(two).toEqual({
      id: `source:${sourceUuid(2)}`,
      title: "Source 2",
      kind: "reference",
      created_at: 100,
      updated_at: 100,
    });
  });

  it("filters by project, kind, every tag, archived and the saved window", async () => {
    await env.DB.batch([
      source(1, { kind: "document", tags: ["meos", "pdf"], created: 150 }),
      source(2, { created: 250 }),
      source(3, { project: "tools", tags: ["MEOS", "pdf"], created: 350 }),
      source(4, { archived: 400 }),
      source(5, { user: OTHER }),
    ]);
    const ids = async (args: Record<string, unknown>) =>
      (await all("list_sources", "sources", args)).map((id) =>
        Number(id.slice(-12)),
      );

    expect(await ids({})).toEqual([3, 2, 1]);
    expect(await ids({ project: "tools" })).toEqual([3]);
    expect(await ids({ kind: "document" })).toEqual([1]);
    expect(await ids({ tags: ["pdf", "meos"] })).toEqual([3, 1]);
    expect(await ids({ archived: true })).toEqual([4]);
    expect(await ids({ saved_since: 250 })).toEqual([3, 2]);
    expect(await ids({ saved_since: 150, saved_before: 350 })).toEqual([2, 1]);

    const archivedRow = (
      await page("list_sources", "sources", { archived: true })
    ).sources[0];
    expect(archivedRow).toMatchObject({ archived_at: 400 });

    const first = await page("list_sources", "sources", { limit: 1 });
    const flipped = await tool(
      { limit: 1, cursor: first.next_cursor, archived: true },
      "list_sources",
    );
    expect(flipped.isError).toBe(true);
  });
});
