import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  archiveMemory,
  editMemory,
  getMemory,
  listMemoryRevisions,
  saveMemory,
} from "~/concepts/memories";
import {
  assertPersonMemoryLink,
  changeMemoryLink,
  listMemoryLinks,
} from "~/concepts/memory-links";
import { capBody } from "~/search/project";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";

const db = env.DB;
const model = {
  userId: "local",
  agent: "model-a",
  client: "mcp",
  session: "session-a",
};
const person = {
  userId: "local",
  agent: "console",
  client: "web",
  session: null,
};
const raw = (id: string) => id.slice("memory:".length);
const save = (title: string, body = "claimmarker") =>
  saveMemory(
    env,
    { title, body, type: "fact", tags: ["tests"], project: "valise" },
    model,
  );
const hits = async () =>
  (
    await search(env, { userId: "local", query: "claimmarker", limit: 100 })
  ).map((hit) => hit.docKey);

afterEach(async () => {
  for (const table of [
    "search_docs",
    "memory_links",
    "memory_revisions",
    "memories",
  ])
    await db.prepare(`DELETE FROM ${table}`).run();
});

describe("typed memory links", () => {
  it("suggests, confirms, removes and restores a replacement without content revisions", async () => {
    const old = await save("Old claim");
    const fresh = await saveMemory(
      env,
      {
        title: "New claim",
        body: "claimmarker",
        type: "fact",
        tags: ["tests"],
        relates: [{ id: old.id, kind: "supersedes" }],
      },
      model,
    );
    const [link] = await listMemoryLinks(db, "local", raw(fresh.id));
    expect(link).toMatchObject({
      kind: "supersedes",
      id: old.id,
      confirmed: false,
      asserted_by: "model",
    });
    expect((await listMemoryLinks(db, "local", raw(old.id)))[0].kind).toBe(
      "superseded-by",
    );
    expect(await hits()).toContain(old.id);
    await changeMemoryLink(
      env,
      raw(fresh.id),
      link.link_id,
      "confirm",
      "local",
    );
    expect(await hits()).not.toContain(old.id);
    expect(await getMemory(db, "local", raw(old.id))).not.toBeNull();
    await editMemory(
      env,
      raw(old.id),
      { title: "Still readable", body: "claimmarker edited" },
      model,
    );
    expect(await hits()).not.toContain(old.id);
    await reindex(env, ["memory"]);
    expect(await hits()).not.toContain(old.id);
    await changeMemoryLink(env, raw(old.id), link.link_id, "remove", "local");
    expect(await hits()).toContain(old.id);
    expect(await listMemoryLinks(db, "local", raw(fresh.id))).toEqual([]);
    await changeMemoryLink(
      env,
      raw(fresh.id),
      link.link_id,
      "restore",
      "local",
    );
    expect(await hits()).not.toContain(old.id);
    await archiveMemory(env, "local", raw(fresh.id));
    expect(await hits()).toContain(old.id);
    expect(await listMemoryLinks(db, "local", raw(old.id))).toEqual([]);
    expect(await listMemoryRevisions(db, "local", raw(fresh.id))).toEqual([]);
  });

  it("canonicalizes symmetric pairs and remembers a person's rejection on retries", async () => {
    const a = await save("A");
    const b = await save("B");
    await editMemory(env, raw(a.id), {}, model, [
      { id: b.id, kind: "related" },
    ]);
    await editMemory(env, raw(b.id), {}, model, [
      { id: a.id, kind: "related" },
    ]);
    const [link] = await listMemoryLinks(db, "local", raw(a.id));
    await changeMemoryLink(env, raw(a.id), link.link_id, "remove", "local");
    await editMemory(env, raw(b.id), {}, { ...model, agent: "model-b" }, [
      { id: a.id, kind: "related" },
    ]);
    expect(await listMemoryLinks(db, "local", raw(a.id))).toEqual([]);
    const rejected = await listMemoryLinks(db, "local", raw(a.id), true);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({
      link_id: link.link_id,
      removed_at: expect.any(Number),
      confirmed: false,
    });
    expect(await listMemoryRevisions(db, "local", raw(a.id))).toEqual([]);
    expect(await listMemoryRevisions(db, "local", raw(b.id))).toEqual([]);
    const stored = await db
      .prepare("SELECT source_agent FROM memory_links WHERE link_id = ?")
      .bind(link.link_id)
      .first();
    expect(stored).toEqual({ source_agent: "model-a" });
  });

  it("rejects self, archived targets, missing targets and direct reverse links atomically", async () => {
    const a = await save("A");
    const b = await save("B");
    await editMemory(env, raw(a.id), {}, model, [
      { id: b.id, kind: "part-of" },
    ]);
    await expect(
      editMemory(env, raw(b.id), { title: "Should not land" }, model, [
        { id: a.id, kind: "part-of" },
      ]),
    ).rejects.toThrow("reverse");
    await expect(
      editMemory(env, raw(a.id), { title: "Should not land" }, model, [
        { id: a.id, kind: "related" },
      ]),
    ).rejects.toThrow("itself");
    const before = await db
      .prepare("SELECT COUNT(*) AS n FROM memories")
      .first();
    await expect(
      saveMemory(
        env,
        {
          title: "Bad save",
          body: "claimmarker",
          type: "fact",
          tags: ["tests"],
          relates: [
            { id: a.id, kind: "related" },
            { id: "memory:missing", kind: "related" },
          ],
        },
        model,
      ),
    ).rejects.toThrow("memory:missing");
    expect(
      await db.prepare("SELECT COUNT(*) AS n FROM memories").first(),
    ).toEqual(before);
    expect((await getMemory(db, "local", raw(b.id)))?.title).toBe("B");
    expect(await listMemoryRevisions(db, "local", raw(b.id))).toEqual([]);
    await archiveMemory(env, "local", raw(b.id));
    await expect(
      editMemory(env, raw(a.id), {}, model, [{ id: b.id, kind: "related" }]),
    ).rejects.toThrow(b.id);
  });

  it("person assertions publish immediately and unrelated link ids cannot be changed", async () => {
    const a = await save("A");
    const b = await save("B");
    const c = await save("C");
    await assertPersonMemoryLink(
      env,
      raw(b.id),
      { id: a.id, kind: "supersedes" },
      person,
    );
    const [link] = await listMemoryLinks(db, "local", raw(b.id));
    expect(link).toMatchObject({ confirmed: true, asserted_by: "person" });
    expect(await hits()).not.toContain(a.id);
    expect(
      await changeMemoryLink(env, raw(c.id), link.link_id, "remove", "local"),
    ).toBe(false);
    expect(await hits()).not.toContain(a.id);
  });

  it("selects revisions and partial edits inside the transaction under concurrent editors", async () => {
    const a = await save("Before");
    await Promise.all([
      editMemory(env, raw(a.id), { title: "After" }, model),
      editMemory(
        env,
        raw(a.id),
        { body: "claimmarker new body", project: "new-project" },
        { ...model, agent: "model-b" },
      ),
    ]);
    expect(await getMemory(db, "local", raw(a.id))).toMatchObject({
      title: "After",
      body: "claimmarker new body",
      project: "new-project",
    });
    const revisions = await listMemoryRevisions(db, "local", raw(a.id));
    expect(revisions.map((row) => row.revision)).toEqual([2, 1]);
    expect(revisions[1]).toMatchObject({
      title: "Before",
      body: "claimmarker",
    });
    const rows = await db
      .prepare(
        "SELECT project, source_client, source_session FROM memory_revisions ORDER BY revision",
      )
      .all();
    expect(rows.results[0]).toMatchObject({
      project: "valise",
      source_client: "mcp",
      source_session: "session-a",
    });
  });

  it("confirmation racing an archive still republishes the predecessor", async () => {
    const a = await save("A");
    const b = await save("B");
    await editMemory(env, raw(b.id), {}, model, [
      { id: a.id, kind: "supersedes" },
    ]);
    const [link] = await listMemoryLinks(db, "local", raw(b.id));
    await Promise.all([
      changeMemoryLink(env, raw(b.id), link.link_id, "confirm", "local"),
      archiveMemory(env, "local", raw(b.id)),
    ]);
    expect(await hits()).toContain(a.id);
    const before = await db
      .prepare("SELECT * FROM search_docs ORDER BY doc_key")
      .all();
    await reindex(env, ["memory"]);
    expect(
      (await db.prepare("SELECT * FROM search_docs ORDER BY doc_key").all())
        .results,
    ).toEqual(before.results);
  });

  it("SQL publication and reindex use the same UTF-8 byte cap", async () => {
    for (const body of [
      "a".repeat(16383) + "é",
      "a".repeat(16382) + "€",
      "a".repeat(16381) + "😀",
      "😀".repeat(5000),
      "x".repeat(18000),
      "before\0after",
      "a\0" + "a".repeat(16381) + "€",
    ]) {
      const memory = await save("Cap proof", body);
      const projected = await db
        .prepare("SELECT body FROM search_docs WHERE doc_key = ?")
        .bind(memory.id)
        .first<{ body: string }>();
      expect(projected?.body).toBe(capBody(body));
    }
    const before = (
      await db.prepare("SELECT * FROM search_docs ORDER BY doc_key").all()
    ).results;
    await reindex(env, ["memory"]);
    expect(
      (await db.prepare("SELECT * FROM search_docs ORDER BY doc_key").all())
        .results,
    ).toEqual(before);
  });

  it("confirms an existing suggestion when a person asserts it without changing its origin", async () => {
    const a = await save("A");
    const b = await save("B");
    await editMemory(env, raw(b.id), {}, model, [
      { id: a.id, kind: "supersedes" },
    ]);
    // The outer link UPSERT must not override a trigger's queue conflict
    // policy. Both already-pending endpoints must refresh without duplicates.
    await db
      .prepare(
        "UPDATE memory_review_pending SET enqueued_at = 1 WHERE memory_id IN (?, ?)",
      )
      .bind(raw(a.id), raw(b.id))
      .run();
    await assertPersonMemoryLink(
      env,
      raw(b.id),
      { id: a.id, kind: "supersedes" },
      person,
    );
    const [link] = await listMemoryLinks(db, "local", raw(b.id));
    expect(link).toMatchObject({ confirmed: true, asserted_by: "model" });
    expect(await hits()).not.toContain(a.id);
    const pending = await db
      .prepare(
        "SELECT memory_id, enqueued_at FROM memory_review_pending WHERE memory_id IN (?, ?)",
      )
      .bind(raw(a.id), raw(b.id))
      .all<{ memory_id: string; enqueued_at: number }>();
    expect(pending.results).toHaveLength(2);
    expect(pending.results.every((row) => row.enqueued_at > 1)).toBe(true);
  });

  it("does not recreate a removed directional suggestion when its reverse exists", async () => {
    const a = await save("A");
    const b = await save("B");
    await editMemory(env, raw(a.id), {}, model, [
      { id: b.id, kind: "part-of" },
    ]);
    const [link] = await listMemoryLinks(db, "local", raw(a.id));
    await changeMemoryLink(env, raw(a.id), link.link_id, "remove", "local");
    await editMemory(env, raw(b.id), {}, model, [
      { id: a.id, kind: "part-of" },
    ]);
    await editMemory(env, raw(a.id), {}, model, [
      { id: b.id, kind: "part-of" },
    ]);
    expect(
      (await listMemoryLinks(db, "local", raw(a.id), true)).find(
        (row) => row.link_id === link.link_id,
      )?.removed_at,
    ).not.toBeNull();
    await expect(
      changeMemoryLink(env, raw(a.id), link.link_id, "restore", "local"),
    ).rejects.toThrow("reverse memory link");
  });
});
