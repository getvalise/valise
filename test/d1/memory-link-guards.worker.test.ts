import { env } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  archiveMemory,
  editMemory,
  getMemory,
  listMemoryRevisions,
  saveMemory,
} from "~/concepts/memories";
import {
  changeMemoryLink,
  listMemoryLinks,
  listMemoryLinkTargets,
  MemoryLinkError,
  memoryLinkStatements,
} from "~/concepts/memory-links";
import { memoryProjectionStatements } from "~/search/memory";
import { reindex } from "~/search/reindex";

const db = env.DB;
const provenance = {
  userId: "local",
  agent: "guard-test",
  client: "mcp",
  session: null,
};
const save = (title: string) =>
  saveMemory(
    env,
    { title, body: "guard claim", type: "fact", tags: [] },
    provenance,
  );
const raw = (id: string) => id.slice("memory:".length);
const memoryRow = (id: string, deletedAt: number | null = null) =>
  db
    .prepare(`INSERT INTO memories (memory_id, memory_type, title, body, tags_json,
    source_agent, source_client, created_at, updated_at, deleted_at)
    VALUES (?, 'fact', ?, 'restored claim', '[]', 'backup', 'mcp', 1, 1, ?)`)
    .bind(id, id, deletedAt);
const linkRow = (from: string, to: string, removedAt: number | null = null) =>
  db
    .prepare(`INSERT INTO memory_links (link_id, from_memory_id, to_memory_id, kind,
    asserted_by, source_agent, source_client, created_at, confirmed_at, confirmed_by,
    removed_at, removed_by)
    VALUES (?, ?, ?, 'supersedes', 'person', 'backup', 'web', 1, 1, 'local', ?, ?)`)
    .bind(
      `${from}-${to}`,
      from,
      to,
      removedAt,
      removedAt === null ? null : "local",
    );

afterEach(async () => {
  vi.restoreAllMocks();
  for (const table of [
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

describe("historical memory link restores in D1", () => {
  it("loads alphabetically ordered INSERTs before their endpoints with deferred foreign keys", async () => {
    await db.batch([
      db.prepare("PRAGMA defer_foreign_keys=TRUE"),
      linkRow("a", "b"),
      memoryRow("a"),
      memoryRow("b"),
    ]);
    expect(await listMemoryLinks(db, "local", "a")).toMatchObject([
      { id: "memory:b", confirmed: true },
    ]);
    await reindex(env, ["memory"]);
    expect(
      await db
        .prepare("SELECT doc_key FROM search_docs ORDER BY doc_key")
        .all(),
    ).toMatchObject({ results: [{ doc_key: "memory:a" }] });
  });

  it("retains live and removed links on archived endpoints without publishing them", async () => {
    await db.batch([memoryRow("a", 2), memoryRow("b")]);
    await db.batch([linkRow("a", "b"), linkRow("b", "a", 2)]);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memory_links").first(),
    ).toEqual({ n: 2 });
    expect(await listMemoryLinks(db, "local", "b", true)).toEqual([]);
    await reindex(env, ["memory"]);
    expect(
      await db
        .prepare("SELECT doc_key FROM search_docs ORDER BY doc_key")
        .all(),
    ).toMatchObject({ results: [{ doc_key: "memory:b" }] });
  });

  it.each([true, false])(
    "loads removed A→B and live B→A in either row order (removed first: %s)",
    async (removedFirst) => {
      await db.batch([memoryRow("a"), memoryRow("b")]);
      const rows = [linkRow("a", "b", 2), linkRow("b", "a")];
      await db.batch(removedFirst ? rows : rows.reverse());
      expect(
        await db.prepare("SELECT COUNT(*) AS n FROM memory_links").first(),
      ).toEqual({ n: 2 });
    },
  );
});

describe("application link guards in D1", () => {
  it.each(["source", "target", "missing", "reverse"] as const)(
    "rolls back content, revision and projection if %s changes after preflight",
    async (changed) => {
      const a = raw((await save("A")).id);
      const b = raw((await save("B")).id);
      const links = await memoryLinkStatements(
        db,
        a,
        [{ id: `memory:${b}`, kind: "part-of" }],
        provenance,
      );
      if (changed === "reverse") {
        await editMemory(env, b, {}, provenance, [
          { id: `memory:${a}`, kind: "part-of" },
        ]);
      } else if (changed === "missing") {
        await db
          .prepare("DELETE FROM memories WHERE memory_id = ?")
          .bind(b)
          .run();
      } else {
        await archiveMemory(env, "local", changed === "source" ? a : b);
      }
      const before = (
        await db.prepare("SELECT * FROM search_docs ORDER BY doc_key").all()
      ).results;
      await expect(
        db.batch([
          db
            .prepare(`INSERT INTO memory_revisions (revision_id, memory_id, revision, memory_type,
        body, tags_json, created_at, created_by) VALUES ('revision', ?, 1, 'fact', 'before', '[]', 1, 'test')`)
            .bind(a),
          db
            .prepare(
              "UPDATE memories SET title = 'must not land' WHERE memory_id = ?",
            )
            .bind(a),
          ...memoryProjectionStatements(db, a, {}),
          ...links,
        ]),
      ).rejects.toThrow();
      expect(
        await db
          .prepare("SELECT title FROM memories WHERE memory_id = ?")
          .bind(a)
          .first(),
      ).toEqual({ title: "A" });
      expect(await listMemoryRevisions(db, "local", a)).toEqual([]);
      expect(
        (await db.prepare("SELECT * FROM search_docs ORDER BY doc_key").all())
          .results,
      ).toEqual(before);
      expect(
        await db.prepare("SELECT COUNT(*) AS n FROM memory_links").first(),
      ).toEqual({ n: changed === "reverse" ? 1 : 0 });
    },
  );

  it("aborts the entire save if its target is archived between preflight and batch", async () => {
    const target = raw((await save("Target")).id);
    const batch = db.batch.bind(db);
    vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
      await archiveMemory(env, "local", target);
      return batch(statements);
    });
    await expect(
      saveMemory(
        env,
        {
          title: "Must not land",
          body: "claim",
          type: "fact",
          tags: [],
          relates: [{ id: `memory:${target}`, kind: "related" }],
        },
        provenance,
      ),
    ).rejects.toBeInstanceOf(MemoryLinkError);
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual({ n: 1 });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memory_links").first(),
    ).toEqual({ n: 0 });
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM search_docs").first(),
    ).toEqual({ n: 0 });
  });

  it("returns a domain conflict, not a database error, when restoring against an active reverse", async () => {
    const a = raw((await save("A")).id);
    const b = raw((await save("B")).id);
    await editMemory(env, a, {}, provenance, [
      { id: `memory:${b}`, kind: "part-of" },
    ]);
    const [link] = await listMemoryLinks(db, "local", a);
    await changeMemoryLink(env, a, link.link_id, "remove", "local");
    await editMemory(env, b, {}, provenance, [
      { id: `memory:${a}`, kind: "part-of" },
    ]);
    await expect(
      changeMemoryLink(env, a, link.link_id, "restore", "local"),
    ).rejects.toBeInstanceOf(MemoryLinkError);
    expect(
      (await listMemoryLinks(db, "local", a, true)).find(
        (row) => row.link_id === link.link_id,
      )?.removed_at,
    ).not.toBeNull();
    expect((await getMemory(db, "local", a))?.title).toBe("A");
  });

  it.each(["archive", "reverse"] as const)(
    "atomically rejects a restore if %s lands after its preflight",
    async (changed) => {
      const a = raw((await save("A")).id);
      const b = raw((await save("B")).id);
      await editMemory(env, a, {}, provenance, [
        { id: `memory:${b}`, kind: "supersedes" },
      ]);
      const [link] = await listMemoryLinks(db, "local", a);
      await changeMemoryLink(env, a, link.link_id, "confirm", "local");
      await changeMemoryLink(env, a, link.link_id, "remove", "local");
      const batch = db.batch.bind(db);
      vi.spyOn(db, "batch").mockImplementationOnce(async (statements) => {
        if (changed === "archive") await archiveMemory(env, "local", b);
        else
          await editMemory(env, b, {}, provenance, [
            { id: `memory:${a}`, kind: "supersedes" },
          ]);
        return batch(statements);
      });
      await expect(
        changeMemoryLink(env, a, link.link_id, "restore", "local"),
      ).rejects.toBeInstanceOf(MemoryLinkError);
      expect(
        await db
          .prepare("SELECT removed_at FROM memory_links WHERE link_id = ?")
          .bind(link.link_id)
          .first(),
      ).toEqual({ removed_at: expect.any(Number) });
      const before = (
        await db.prepare("SELECT * FROM search_docs ORDER BY doc_key").all()
      ).results;
      await reindex(env, ["memory"]);
      expect(
        (await db.prepare("SELECT * FROM search_docs ORDER BY doc_key").all())
          .results,
      ).toEqual(before);
    },
  );

  it("offers only live ids and titles, excluding the open memory, without selecting content", async () => {
    const a = raw((await save("A")).id);
    const b = await save("B");
    const archived = await save("Archived");
    await archiveMemory(env, "local", raw(archived.id));
    const prepare = vi.spyOn(db, "prepare");
    expect((await listMemoryLinkTargets(db, "local", a)).targets).toEqual([
      { id: b.id, title: "B" },
    ]);
    expect(prepare).toHaveBeenCalledOnce();
    expect(prepare.mock.calls[0][0]).toMatch(
      /^SELECT memory_id, title FROM memories/,
    );
    expect(prepare.mock.calls[0][0]).not.toMatch(
      /\b(body|tags_json|source_agent)\b/,
    );
  });
});
