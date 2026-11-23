import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { normalizeMcpScopes } from "~/auth/scopes";
import {
  archiveMemory,
  editMemory,
  listMemories,
  saveMemory,
} from "~/concepts/memories";
import { listSkills, listSkillVersions } from "~/concepts/skills";
import { editTodoContent, listTodos } from "~/concepts/todos";
import {
  capBody,
  MAX_BODY_BYTES,
  projectMemory,
  projectSkill,
} from "~/search/project";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";
import { seed } from "~/search/seed";
import { projectionStatement, upsertProjection } from "~/search/write";

const db = env.DB;

/**
 * Every case ends on an FTS integrity check, because a projection that ranks
 * correctly while its index is internally corrupt is the failure this design
 * is most exposed to.
 */
async function integrityCheck() {
  await db
    .prepare(
      "INSERT INTO search_docs_fts(search_docs_fts) VALUES('integrity-check')",
    )
    .run();
}

async function reset() {
  for (const table of [
    "search_docs",
    "assets",
    "objects",
    "todo_updates",
    "todos",
    "memory_revisions",
    "skill_versions",
    "skills",
    "memories",
    "bearer_token_scopes",
    "bearer_tokens",
    "sessions",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
}

async function docKeys(query: string): Promise<string[]> {
  const hits = await search(env, { userId: "local", query });
  return hits.map((hit) => hit.docKey);
}

/**
 * Every term in the index with its document and occurrence counts, read through
 * `search_docs_vocab`. This compares index content rather than the raw
 * shadow-table blocks, which differ by segment layout between an incrementally
 * built index and a rebuilt one even when both hold exactly the same postings.
 */
async function ftsFingerprint(): Promise<string> {
  const { results } = await db
    .prepare(
      "SELECT term, col, doc, cnt FROM search_docs_vocab ORDER BY term, col",
    )
    .all<{ term: string; col: string; doc: number; cnt: number }>();
  return results.map((r) => `${r.term}|${r.col}|${r.doc}|${r.cnt}`).join("\n");
}

afterEach(reset);

describe("migrations", () => {
  it("apply from empty and leave a usable index", async () => {
    const { results } = await db
      .prepare(
        "SELECT name, type FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all<{ name: string; type: string }>();
    const names = results.map((r) => r.name);

    for (const table of [
      "skills",
      "skill_versions",
      "memories",
      "memory_revisions",
      "todos",
      "todo_updates",
      "sessions",
      "bearer_tokens",
      "bearer_token_scopes",
      "search_docs",
      "search_docs_fts",
      "search_docs_vocab",
    ]) {
      expect(names).toContain(table);
    }
    for (const trigger of [
      "search_docs_ai",
      "search_docs_ad",
      "search_docs_au",
    ]) {
      expect(names).toContain(trigger);
    }

    await integrityCheck();
  });

  it("forwards writes to the retired search_index into search_docs", async () => {
    // A Worker deployed before 0022 still writes the old table until the new
    // one replaces it. Its upsert, its update and its delete all land here.
    const legacyUpsert = (title: string) =>
      db
        .prepare(
          `INSERT INTO search_index (doc_key, concept, concept_id, project, title, body, tags, updated_at)
           VALUES ('todo:legacy', 'todo', 'legacy', 'valise', ?, 'written by the old worker', 'cutover', 1)
           ON CONFLICT(doc_key) DO UPDATE SET title = excluded.title`,
        )
        .bind(title)
        .run();

    await legacyUpsert("flamingo handoff");
    expect(await docKeys("flamingo")).toEqual(["todo:legacy"]);

    await legacyUpsert("pelican handoff");
    expect(await docKeys("flamingo")).toEqual([]);
    expect(await docKeys("pelican")).toEqual(["todo:legacy"]);

    await db
      .prepare("DELETE FROM search_index WHERE doc_key = 'todo:legacy'")
      .run();
    expect(await docKeys("pelican")).toEqual([]);
    await integrityCheck();
  });

  it("admits a concept the retired table's CHECK refused", async () => {
    await expect(
      db
        .prepare(
          `INSERT INTO search_index (doc_key, concept, concept_id, title, body, tags, updated_at)
           VALUES ('asset:a1', 'asset', 'a1', '', '', '', 1)`,
        )
        .run(),
    ).rejects.toThrow();
    // Runtime library search also validates the authoritative owned asset;
    // a stray projection row alone is no longer a deliverable search hit.
    await db.batch([
      db.prepare(`INSERT INTO objects (object_id, user_id, r2_key, name, content_type, size, sha256, created_at)
        VALUES ('obj_schema_asset', 'local', 'schema/asset', 'heron.png', 'image/png', 1, 'schema', 1)`),
      db.prepare(`INSERT INTO assets (asset_id, user_id, state, object_id, title, file_name, content_type,
        declared_size, source_agent, source_client, created_at, updated_at)
        VALUES ('a1', 'local', 'ready', 'obj_schema_asset', 'heron screenshot', 'heron.png', 'image/png', 1, 'test', 'test', 1, 1)`),
      db.prepare(
        `INSERT INTO search_docs (doc_key, concept, concept_id, title, body, tags, updated_at)
         VALUES ('asset:a1', 'asset', 'a1', 'heron screenshot', '', '', 1)`,
      ),
    ]);
    expect(
      await search(env, {
        userId: "local",
        query: "heron",
        concepts: ["asset"],
      }),
    ).toEqual([
      expect.objectContaining({ docKey: "asset:a1", concept: "asset" }),
    ]);
    await integrityCheck();
  });

  it("enforces normalized bearer-token scopes", async () => {
    await db
      .prepare(
        `INSERT INTO bearer_tokens (
          token_id, user_id, label, token_digest, created_at, revoked_at
        ) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .bind("tok_1", "local", "CLI", "digest_1", 1, null)
      .run();
    await db
      .prepare(
        "INSERT INTO bearer_token_scopes (token_id, scope) VALUES (?, ?)",
      )
      .bind("tok_1", "search:read")
      .run();

    await expect(
      db
        .prepare(
          "INSERT INTO bearer_token_scopes (token_id, scope) VALUES (?, ?)",
        )
        .bind("tok_1", "not:a-scope")
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO bearer_token_scopes (token_id, scope) VALUES (?, ?)",
        )
        .bind("tok_1", "search:read")
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          "INSERT INTO bearer_token_scopes (token_id, scope) VALUES (?, ?)",
        )
        .bind("tok_missing", "search:read")
        .run(),
    ).rejects.toThrow();
    await expect(
      db
        .prepare(
          `INSERT INTO bearer_tokens (
            token_id, user_id, label, token_digest, created_at, revoked_at
          ) VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind("tok_2", "local", "Second CLI", "digest_1", 2, null)
        .run(),
    ).rejects.toThrow();
  });
});

describe("MCP scopes", () => {
  it("normalizes to the declared vocabulary order", () => {
    expect(
      normalizeMcpScopes([
        "skills:write",
        "search:read",
        "skills:write",
        "unknown:scope",
      ]),
    ).toEqual(["search:read", "skills:write"]);
  });
});

describe("the projection", () => {
  it("drops superseded tokens when a doc_key is upserted", async () => {
    await upsertProjection(db, {
      userId: "local",
      docKey: "todo:t1",
      concept: "todo",
      conceptId: "t1",
      project: "valise",
      title: "fix the flaky duckdb test",
      body: "the bm25 index is drifting",
      tags: "duckdb d1",
      updatedAt: 1,
    }).run();
    expect(await docKeys("duckdb")).toEqual(["todo:t1"]);

    await upsertProjection(db, {
      userId: "local",
      docKey: "todo:t1",
      concept: "todo",
      conceptId: "t1",
      project: "valise",
      title: "fix the flaky postgres test",
      body: "no longer about that engine",
      tags: "postgres",
      updatedAt: 2,
    }).run();

    expect(await docKeys("duckdb")).toEqual([]);
    expect(await docKeys("postgres")).toEqual(["todo:t1"]);

    const { results } = await db
      .prepare(
        "SELECT count(*) AS n FROM search_docs WHERE doc_key = 'todo:t1'",
      )
      .all<{ n: number }>();
    expect(results[0].n).toBe(1);

    await integrityCheck();
  });

  it("unpublishes when project() returns null", async () => {
    const live = {
      memoryId: "m1",
      userId: "local",
      memoryType: "user",
      title: "uv over pip",
      body: "always reach for uv when running python",
      tagsJson: JSON.stringify(["python"]),
      project: "valise",
      deletedAt: null as number | null,
      updatedAt: 1,
    };
    await projectionStatement(db, projectMemory(live), "memory:m1").run();
    expect(await docKeys("uv")).toEqual(["memory:m1"]);

    const archived = { ...live, deletedAt: 2 };
    expect(projectMemory(archived)).toBeNull();
    await projectionStatement(db, projectMemory(archived), "memory:m1").run();

    expect(await docKeys("uv")).toEqual([]);
    const { results } = await db
      .prepare("SELECT count(*) AS n FROM search_docs")
      .all<{ n: number }>();
    expect(results[0].n).toBe(0);

    await integrityCheck();
  });

  it("indexes the head skill version only", async () => {
    const head = projectSkill({
      userId: "local",
      skillId: "s1",
      name: "capture-this",
      tagsJson: JSON.stringify(["meta"]),
      project: "valise",
      deletedAt: null,
      disabledAt: null,
      updatedAt: 2,
      headBodyMd: "the second version talks about zeppelins",
    });
    await projectionStatement(db, head, "skill:s1").run();

    expect(await docKeys("zeppelins")).toEqual(["skill:s1"]);
    // A term that lived only in version 1 is not in the corpus at all.
    expect(await docKeys("dirigibles")).toEqual([]);

    await integrityCheck();
  });

  it("caps a body on a UTF-8 boundary", () => {
    const long = "é".repeat(MAX_BODY_BYTES);
    const capped = capBody(long);
    const bytes = new TextEncoder().encode(capped).byteLength;
    expect(bytes).toBeLessThanOrEqual(MAX_BODY_BYTES);
    expect(capped.endsWith("é")).toBe(true);
    expect(capped).not.toContain("\uFFFD");
  });
});

describe("console concept operations", () => {
  it("edits only todo content and publishes that replacement atomically", async () => {
    await db
      .prepare(
        `INSERT INTO todos (
          todo_id, title, body, project, tags_json, refs_json, state,
          lease_holder, lease_expires_at, fencing_token, blocked_on,
          source_agent, source_client, source_session,
          created_at, updated_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        "tdo_console",
        "Old title",
        "old constellation",
        "old-project",
        JSON.stringify(["old"]),
        JSON.stringify([{ kind: "file", value: "app/old/pulsar.ts" }]),
        "claimed",
        "agent-a",
        90,
        7,
        "waiting for review",
        "agent-a",
        "claude-code",
        "ses_1",
        1,
        1,
        null,
      )
      .run();

    const edited = await editTodoContent(env, "local", "tdo_console", {
      title: "New title",
      body: "new nebula",
      project: "new-project",
      tags: ["new"],
      refs: [{ kind: "file", value: "app/new/quasar.ts" }],
    });

    expect(edited).toMatchObject({
      id: "todo:tdo_console",
      title: "New title",
      body: "new nebula",
      project: "new-project",
      tags: ["new"],
      refs: [{ kind: "file", value: "app/new/quasar.ts" }],
      state: "claimed",
      leaseHolder: "agent-a",
      leaseExpiresAt: 90,
      fencingToken: 7,
      blockedOn: "waiting for review",
      // Provenance is content's neighbour, not content: an edit leaves it.
      sourceAgent: "agent-a",
      sourceClient: "claude-code",
      sourceSession: "ses_1",
    });
    expect(await listTodos(db, "local")).toHaveLength(1);
    expect(
      (await search(env, { userId: "local", query: "old constellation" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual([]);
    expect(
      (await search(env, { userId: "local", query: "new nebula" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual(["todo:tdo_console"]);
    // The pointers are searchable, and the replaced one is gone with the body.
    expect(
      (await search(env, { userId: "local", query: "app/new/quasar.ts" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual(["todo:tdo_console"]);
    expect(
      (await search(env, { userId: "local", query: "app/old/pulsar.ts" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual([]);

    await integrityCheck();
  });

  it("archives a memory idempotently and removes its projection", async () => {
    const saved = await saveMemory(
      env,
      {
        type: "reference",
        title: "Archive me",
        body: "vanishing quasar",
        tags: ["archive"],
        project: "valise",
      },
      { userId: "local", agent: "vitest", client: "test", session: null },
    );
    const id = saved.id.slice("memory:".length);

    expect(
      (await listMemories(db, "local")).map((memory) => memory.id),
    ).toEqual([saved.id]);
    expect(await archiveMemory(env, "local", id)).toBe(true);
    const archived = await db
      .prepare(
        "SELECT deleted_at, updated_at FROM memories WHERE memory_id = ?",
      )
      .bind(id)
      .first<{ deleted_at: number; updated_at: number }>();
    expect(archived?.deleted_at).not.toBeNull();

    expect(await archiveMemory(env, "local", id)).toBe(true);
    expect(
      await db
        .prepare(
          "SELECT deleted_at, updated_at FROM memories WHERE memory_id = ?",
        )
        .bind(id)
        .first<{ deleted_at: number; updated_at: number }>(),
    ).toEqual(archived);
    expect(await listMemories(db, "local")).toEqual([]);
    expect(await search(env, { userId: "local", query: "quasar" })).toEqual([]);

    await integrityCheck();
  });

  it("snapshots a memory before editing it and replaces the projection atomically", async () => {
    const saved = await saveMemory(
      env,
      {
        type: "reference",
        title: "Old memory",
        body: "old aurora",
        tags: ["old"],
        project: "valise",
      },
      { userId: "local", agent: "seed", client: "test", session: null },
    );
    const id = saved.id.slice("memory:".length);

    const edited = await editMemory(
      env,
      id,
      {
        type: "decision",
        title: "New memory",
        body: "new comet",
        tags: ["new"],
        project: "console",
      },
      { userId: "local", agent: "console", client: "web", session: null },
    );

    expect(edited).toMatchObject({
      id: saved.id,
      type: "decision",
      title: "New memory",
      body: "new comet",
      tags: ["new"],
      project: "console",
    });
    expect(
      await db
        .prepare(
          `SELECT revision, memory_type, title, body, tags_json, created_by
             FROM memory_revisions WHERE memory_id = ?`,
        )
        .bind(id)
        .first(),
    ).toMatchObject({
      revision: 1,
      memory_type: "reference",
      title: "Old memory",
      body: "old aurora",
      tags_json: JSON.stringify(["old"]),
      created_by: "console",
    });
    expect(await search(env, { userId: "local", query: "old aurora" })).toEqual(
      [],
    );
    expect(
      (await search(env, { userId: "local", query: "new comet" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual([saved.id]);

    await integrityCheck();
  });

  it("reads skill version history without mutating immutable version rows", async () => {
    await db
      .prepare(
        `INSERT INTO skills (
          skill_id, name, tags_json, visibility, head_version_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind("skl_history", "history-skill", "[]", "private", "skv_2", 1, 2)
      .run();
    for (const version of [1, 2]) {
      await db
        .prepare(
          `INSERT INTO skill_versions (
            version_id, skill_id, version, body_md, body_sha256, files_json,
            created_at, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          `skv_${version}`,
          "skl_history",
          version,
          `version ${version}`,
          `sha_${version}`,
          "[]",
          version,
          "console",
        )
        .run();
    }

    expect(await listSkillVersions(db, "local", "history-skill")).toEqual([
      {
        version: 2,
        body: "version 2",
        sha256: "sha_2",
        files: [],
        createdAt: 2,
        createdBy: "console",
        isHead: true,
      },
      {
        version: 1,
        body: "version 1",
        sha256: "sha_1",
        files: [],
        createdAt: 1,
        createdBy: "console",
        isHead: false,
      },
    ]);
    expect(
      await db
        .prepare("SELECT count(*) AS n FROM skill_versions WHERE skill_id = ?")
        .bind("skl_history")
        .first<{ n: number }>(),
    ).toEqual({ n: 2 });
  });
});

describe("console list search", () => {
  // D1 caps a LIKE pattern at 50 bytes, so a filter built as '%' || term || '%'
  // 500s at 49 characters. Test the boundary itself, with terms cut from text
  // the seed wrote, rather than a short representative string.
  it.each([48, 49, 200])(
    "finds a %i-character term in every list",
    async (length) => {
      await seed(env);
      const bodies = await db
        .prepare(
          `SELECT (SELECT body FROM memories) AS memory,
                  (SELECT body FROM todos) AS todo,
                  (SELECT body_md FROM skill_versions) AS skill`,
        )
        .first<{ memory: string; todo: string; skill: string }>();
      if (!bodies) throw new Error("seed wrote nothing");
      const term = (body: string) => body.slice(0, length).toUpperCase();

      const memories = await listMemories(db, "local", {
        query: term(bodies.memory),
      });
      const todos = await listTodos(db, "local", { query: term(bodies.todo) });
      const skills = await listSkills(db, "local", {
        query: term(bodies.skill),
      });
      expect([memories, todos, skills].map((rows) => rows.length)).toEqual([
        1, 1, 1,
      ]);

      const miss = "z".repeat(length);
      expect(await listMemories(db, "local", { query: miss })).toEqual([]);
      expect(await listTodos(db, "local", { query: miss })).toEqual([]);
      expect(await listSkills(db, "local", { query: miss })).toEqual([]);
    },
  );

  it("treats % and _ in a term as literal characters", async () => {
    await seed(env);
    expect(await listMemories(db, "local", { query: "%" })).toEqual([]);
    expect(await listTodos(db, "local", { query: "_" })).toEqual([]);
    expect(await listSkills(db, "local", { query: "%_%" })).toEqual([]);
  });
});

describe("search", () => {
  it("treats punctuation in a user query as literal text", async () => {
    await upsertProjection(db, {
      userId: "local",
      docKey: "memory:hyphen",
      concept: "memory",
      conceptId: "hyphen",
      project: "valise",
      title: "Console prototype",
      body: "console-prototype-marker",
      tags: "console",
      updatedAt: 1,
    }).run();

    await expect(
      search(env, { userId: "local", query: "console-prototype-marker" }),
    ).resolves.toMatchObject([{ docKey: "memory:hyphen" }]);

    await integrityCheck();
  });

  it("filters by a tag longer than D1's LIKE pattern limit", async () => {
    const tag = "t".repeat(60);
    await upsertProjection(db, {
      userId: "local",
      docKey: "memory:long-tag",
      concept: "memory",
      conceptId: "long-tag",
      project: "valise",
      title: "Long tag",
      body: "longtagmarker",
      tags: tag,
      updatedAt: 1,
    }).run();

    await expect(
      search(env, { userId: "local", query: "longtagmarker", tags: [tag] }),
    ).resolves.toMatchObject([{ docKey: "memory:long-tag" }]);
    await expect(
      search(env, {
        userId: "local",
        query: "longtagmarker",
        tags: [tag.slice(1)],
      }),
    ).resolves.toEqual([]);

    await integrityCheck();
  });

  it("ranks all three concepts in one corpus and filters by column", async () => {
    await seed(env);

    const all = await search(env, { userId: "local", query: "duckdb" });
    expect(new Set(all.map((hit) => hit.concept))).toEqual(
      new Set(["skill", "memory", "todo"]),
    );
    // BM25 in SQLite is negative, best first.
    expect(all.every((hit) => hit.score < 0)).toBe(true);
    expect([...all].sort((a, b) => a.score - b.score)).toEqual(all);
    expect(all[0].snippet).toContain("[");

    const memoriesOnly = await search(env, {
      userId: "local",
      query: "duckdb",
      concepts: ["memory"],
    });
    expect(memoriesOnly.map((hit) => hit.concept)).toEqual(["memory"]);

    const tagged = await search(env, {
      userId: "local",
      query: "duckdb",
      tags: ["tooling"],
    });
    expect(tagged.map((hit) => hit.concept)).toEqual(["memory"]);

    const otherProject = await search(env, {
      userId: "local",
      query: "duckdb",
      project: "not-valise",
    });
    expect(otherProject).toEqual([]);

    await integrityCheck();
  });

  it("answers a question-shaped query whose filler words no document holds", async () => {
    await seed(env);

    const hits = await search(env, {
      userId: "local",
      query: "how should I write a memory",
    });
    expect(hits[0]?.docKey).toBe("skill:skl_seed_capture_this");

    // A query every term of which matches stays exact: no partial matches pad it.
    expect(await docKeys("capture memory")).toEqual([
      "skill:skl_seed_capture_this",
    ]);
    expect(await docKeys("zzyzx")).toEqual([]);

    await integrityCheck();
  });
});

describe("reindex", () => {
  it("reproduces the index after the projection is truncated", async () => {
    await seed(env);
    const before = await search(env, { userId: "local", query: "duckdb" });
    const fingerprintBefore = await ftsFingerprint();

    await db.prepare("DELETE FROM search_docs").run();
    expect(await docKeys("duckdb")).toEqual([]);

    const report = await reindex(env);
    expect(report.published).toEqual({
      skill: 1,
      memory: 1,
      todo: 1,
      asset: 0,
      source: 0,
      transcript: 0,
    });
    expect(report.total).toBe(3);

    expect(await search(env, { userId: "local", query: "duckdb" })).toEqual(
      before,
    );
    expect(await ftsFingerprint()).toBe(fingerprintBefore);

    await integrityCheck();
  });

  it("prunes rows that no longer project and leaves rowids alone", async () => {
    await seed(env);
    const idsBefore = await rowIds();

    await db
      .prepare("UPDATE memories SET deleted_at = ? WHERE memory_id = ?")
      .bind(99, "mem_seed_duckdb_default")
      .run();

    const report = await reindex(env, ["memory"]);
    expect(report.published.memory).toBe(0);
    expect(report.unpublished.memory).toBe(1);

    const hits = await search(env, { userId: "local", query: "duckdb" });
    expect(hits.map((hit) => hit.concept).sort()).toEqual(["skill", "todo"]);

    const idsAfter = await rowIds();
    for (const [key, id] of Object.entries(idsAfter)) {
      expect(id).toBe(idsBefore[key]);
    }

    await integrityCheck();
  });
});

async function rowIds(): Promise<Record<string, number>> {
  const { results } = await db
    .prepare("SELECT doc_key, id FROM search_docs")
    .all<{ doc_key: string; id: number }>();
  return Object.fromEntries(results.map((r) => [r.doc_key, r.id]));
}
