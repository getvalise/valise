import {
  docKey,
  projectMemory,
  projectSkill,
  projectTodo,
} from "~/search/project";
import { projectionStatement } from "~/search/write";
import captureThisSkill from "../../skills/capture-this/SKILL.md?raw";

/**
 * One skill, one memory, and one to-do sharing a term, so cross-concept ranking
 * is observable from the first commit. Each write pairs its authoritative
 * statements with its projection statement in one `db.batch`, which is the
 * contract every concept module in V1-2 and after follows.
 *
 * Seeding is idempotent: rerunning it overwrites the same three ids.
 */

const SKILL_ID = "skl_seed_capture_this";
const MEMORY_ID = "mem_seed_duckdb_default";
const TODO_ID = "tdo_seed_rank_calibration";
const PROJECT = "valise";
const AUTHOR = "dev-seed";

/**
 * The skill Valise ships, read from the file rather than copied into this
 * module. A copy drifts, and the eval caught exactly that: the copy's
 * description read like `save_memory`'s, so a model picked the skill for a
 * turn that wanted the tool.
 */
const SKILL_BODY = captureThisSkill;

const MEMORY_BODY = `The team queries its DuckDB warehouse through the warehouse's MCP or CLI
rather than ad hoc Python scripts. Prefer those paths when a question is answerable by
running a query.`;

/**
 * The checklist is part of the seed because subtasks are Markdown in the
 * body, not a table: a fresh console should show one that ticks.
 */
const TODO_BODY = `Cross-concept BM25 weights are taste, not calibration. Once
real DuckDB-flavoured content lands, read a few rankings and decide whether
skills need a query-time boost over to-dos.

- [x] Seed a corpus with the same term in all three concepts
- [ ] Read ten rankings and write down which one is wrong
- [ ] Try a per-concept boost and re-read the same ten

**Done when** a weight change ships with the rankings that justify it, or the
idea is written off in an ADR.`;

/** Where the work is, so a claimant does not have to ask. */
const TODO_REFS = [
  { kind: "repo", value: "getvalise/valise" },
  { kind: "file", value: "app/search/query.ts" },
  { kind: "doc", value: "docs/adr/0001-data-model.md" },
];

export type SeedReport = {
  seeded: { skill: string; memory: string; todo: string };
  at: number;
};

export async function seed(env: { DB: D1Database }): Promise<SeedReport> {
  const db = env.DB;
  const now = Math.floor(Date.now() / 1000);

  const skillTags = JSON.stringify(["meta", "duckdb"]);
  const memoryTags = JSON.stringify(["duckdb", "tooling"]);
  const todoTags = JSON.stringify(["search", "duckdb"]);
  const todoRefs = JSON.stringify(TODO_REFS);

  /**
   * The name's unique index outranks the fixed id: if any row already owns
   * `capture-this` — the built-in sync lever creates one under a random id —
   * the seed layers onto that row instead of colliding with it.
   */
  const owner = await db
    .prepare("SELECT skill_id FROM skills WHERE name = 'capture-this'")
    .first<{ skill_id: string }>();
  const skillId = owner?.skill_id ?? SKILL_ID;

  /**
   * The version id is derived from the body, so editing `SKILL.md` and
   * reseeding appends a version and moves the head instead of leaving the
   * first one in place. Versions stay append-only, per ADR-0001.
   */
  const skillSha = await sha256(SKILL_BODY);
  const skillVersionId = `skv_seed_capture_this_${skillSha.slice(0, 12)}`;
  const existing = await db
    .prepare(
      `SELECT version FROM skill_versions WHERE skill_id = ? AND version_id = ?`,
    )
    .bind(skillId, skillVersionId)
    .first<{ version: number }>();
  const highest = await db
    .prepare(
      `SELECT COALESCE(MAX(version), 0) AS version FROM skill_versions WHERE skill_id = ?`,
    )
    .bind(skillId)
    .first<{ version: number }>();
  const skillVersion = existing?.version ?? (highest?.version ?? 0) + 1;

  await db.batch([
    db
      .prepare(
        `INSERT INTO skills (skill_id, name, project, tags_json, visibility, head_version_id, created_at, updated_at)
         VALUES (?, 'capture-this', ?, ?, 'private', ?, ?, ?)
         ON CONFLICT(skill_id) DO UPDATE SET
           tags_json = excluded.tags_json,
           head_version_id = excluded.head_version_id,
           updated_at = excluded.updated_at,
           disabled_at = NULL,
           deleted_at = NULL`,
      )
      .bind(skillId, PROJECT, skillTags, skillVersionId, now, now),
    db
      .prepare(
        `INSERT INTO skill_versions (version_id, skill_id, version, body_md, body_sha256, files_json, created_at, created_by)
         VALUES (?, ?, ?, ?, ?, '[]', ?, ?)
         ON CONFLICT(version_id) DO NOTHING`,
      )
      .bind(
        skillVersionId,
        skillId,
        skillVersion,
        SKILL_BODY,
        skillSha,
        now,
        AUTHOR,
      ),
    projectionStatement(
      db,
      projectSkill({
        skillId,
        userId: "local",
        name: "capture-this",
        tagsJson: skillTags,
        project: PROJECT,
        deletedAt: null,
        disabledAt: null,
        updatedAt: now,
        headBodyMd: SKILL_BODY,
      }),
      docKey("skill", skillId),
    ),
  ]);

  await db.batch([
    db
      .prepare(
        `INSERT INTO memories (memory_id, memory_type, title, body, tags_json, project, source_agent, source_client, source_session, created_at, updated_at)
         VALUES (?, 'preference', 'Query the warehouse through its MCP, not ad hoc scripts', ?, ?, ?, ?, 'dev', NULL, ?, ?)
         ON CONFLICT(memory_id) DO UPDATE SET
           body = excluded.body,
           tags_json = excluded.tags_json,
           updated_at = excluded.updated_at`,
      )
      .bind(MEMORY_ID, MEMORY_BODY, memoryTags, PROJECT, AUTHOR, now, now),
    projectionStatement(
      db,
      projectMemory({
        memoryId: MEMORY_ID,
        userId: "local",
        memoryType: "preference",
        title: "Query the warehouse through its MCP, not ad hoc scripts",
        body: MEMORY_BODY,
        tagsJson: memoryTags,
        project: PROJECT,
        deletedAt: null,
        updatedAt: now,
      }),
      docKey("memory", MEMORY_ID),
    ),
  ]);

  await db.batch([
    db
      .prepare(
        `INSERT INTO todos (todo_id, title, body, project, tags_json, refs_json, state, source_agent, source_client, created_at, updated_at)
         VALUES (?, 'Calibrate cross-concept BM25 weights', ?, ?, ?, ?, 'pending', ?, 'dev', ?, ?)
         ON CONFLICT(todo_id) DO UPDATE SET
           body = excluded.body,
           tags_json = excluded.tags_json,
           refs_json = excluded.refs_json,
           updated_at = excluded.updated_at`,
      )
      .bind(TODO_ID, TODO_BODY, PROJECT, todoTags, todoRefs, AUTHOR, now, now),
    projectionStatement(
      db,
      projectTodo({
        todoId: TODO_ID,
        userId: "local",
        title: "Calibrate cross-concept BM25 weights",
        body: TODO_BODY,
        tagsJson: todoTags,
        refsJson: todoRefs,
        project: PROJECT,
        updatedAt: now,
      }),
      docKey("todo", TODO_ID),
    ),
  ]);

  return {
    seeded: { skill: skillId, memory: MEMORY_ID, todo: TODO_ID },
    at: now,
  };
}

export type SeedMemory = {
  id: string;
  type: string;
  title: string;
  body: string;
  tags: string[];
  project: string | null;
  updatedAt: number;
};

/** Memories per `db.batch`, two statements each. */
const MEMORY_BATCH = 50;

/**
 * A memory store of any size for the retrieval-at-scale measurements, built
 * by `evals/retrieval/corpus.ts`. Each memory pairs its row with its
 * projection in the same batch, like every other write, and an id seeded
 * twice overwrites itself, so a larger store seeded over a smaller one is
 * the larger store.
 */
export async function seedMemories(
  env: { DB: D1Database },
  memories: SeedMemory[],
): Promise<{ seeded: number }> {
  const db = env.DB;
  for (let start = 0; start < memories.length; start += MEMORY_BATCH) {
    await db.batch(
      memories.slice(start, start + MEMORY_BATCH).flatMap((memory) => {
        const tagsJson = JSON.stringify(memory.tags);
        return [
          db
            .prepare(
              `INSERT INTO memories (memory_id, memory_type, title, body, tags_json, project, source_agent, source_client, source_session, created_at, updated_at)
               VALUES (?, ?, ?, ?, ?, ?, 'retrieval-corpus', 'dev', NULL, ?, ?)
               ON CONFLICT(memory_id) DO UPDATE SET
                 memory_type = excluded.memory_type,
                 title = excluded.title,
                 body = excluded.body,
                 tags_json = excluded.tags_json,
                 project = excluded.project,
                 deleted_at = NULL,
                 updated_at = excluded.updated_at`,
            )
            .bind(
              memory.id,
              memory.type,
              memory.title,
              memory.body,
              tagsJson,
              memory.project,
              memory.updatedAt,
              memory.updatedAt,
            ),
          projectionStatement(
            db,
            projectMemory({
              memoryId: memory.id,
              userId: "local",
              memoryType: memory.type,
              title: memory.title,
              body: memory.body,
              tagsJson,
              project: memory.project,
              deletedAt: null,
              updatedAt: memory.updatedAt,
            }),
            docKey("memory", memory.id),
          ),
        ];
      }),
    );
  }
  return { seeded: memories.length };
}

async function sha256(input: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(input),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
