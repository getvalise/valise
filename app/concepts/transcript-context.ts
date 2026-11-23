import { matchSubjects } from "./memory-subjects";
import {
  type FileTouch,
  filesTouched,
  GAP_SECONDS,
  HARNESS_SQL,
  itemMentions,
  skillsUsed,
  type ToolCount,
  toolLabel,
} from "./transcript-view";

/**
 * What the console shows beside a transcript's turns, read from D1 on
 * demand: counts, the prompts as an outline, and the Valise items the
 * session named, which is where its tags and subjects come from.
 *
 * Nothing here is stored. A transcript carries no tags of its own; its tags
 * are the tags of the to-dos and memories its tool calls named, and its
 * subjects are the subjects of those memories plus any subject whose name
 * its prompts use. docs/design/transcripts.md, "Where tags and subjects come
 * from".
 */

/** Bounds on every read, so a 20,000-turn session costs what a 500-turn one does. */
const OUTLINE_LIMIT = 300;
const MENTION_TURNS = 1000;
const FILE_TURNS = 3000;
const MENTION_IDS = 100;

export type TranscriptStats = {
  prompts: number;
  replies: number;
  toolCalls: number;
  errors: number;
  /** Wall-clock from first to last turn. */
  span: number | null;
  /** The same, with each idle stretch over `GAP_SECONDS` left out. */
  active: number | null;
  tools: ToolCount[];
};

export type OutlineEntry = {
  position: number;
  text: string;
  at: number | null;
};

export type LinkedTodo = {
  id: string;
  title: string;
  state: string;
  project: string | null;
  tags: string[];
  position: number;
};

export type LinkedMemory = {
  id: string;
  title: string;
  type: string;
  tags: string[];
  position: number;
};

export type LinkedSubject = {
  id: string;
  name: string;
  /** How the session reached it: a memory it named, the id itself, or its words. */
  via: "memory" | "mention" | "name";
};

export type TranscriptContext = {
  stats: TranscriptStats;
  outline: OutlineEntry[];
  todos: LinkedTodo[];
  memories: LinkedMemory[];
  subjects: LinkedSubject[];
  tags: { tag: string; count: number }[];
  files: FileTouch[];
  skills: string[];
};

export async function transcriptStats(
  db: D1Database,
  transcriptId: string,
): Promise<TranscriptStats> {
  const [kinds, timing] = await db.batch([
    db
      .prepare(
        `SELECT CASE WHEN kind = 'human' AND ${HARNESS_SQL} THEN 'event' ELSE kind END AS kind,
                tool_name AS toolName, COUNT(*) AS n
           FROM transcript_turns WHERE transcript_id = ? GROUP BY 1, tool_name`,
      )
      .bind(transcriptId),
    db
      .prepare(
        `SELECT MIN(at) AS first, MAX(at) AS last,
                SUM(CASE WHEN idle <= ? THEN idle ELSE 0 END) AS active
           FROM (SELECT at, at - LAG(at) OVER (ORDER BY position) AS idle
                   FROM transcript_turns WHERE transcript_id = ? AND at IS NOT NULL)`,
      )
      .bind(GAP_SECONDS, transcriptId),
  ]);
  const rows = kinds.results as {
    kind: string;
    toolName: string | null;
    n: number;
  }[];
  const time = (timing.results[0] ?? {}) as {
    first: number | null;
    last: number | null;
    active: number | null;
  };
  const sum = (kind: string) =>
    rows.filter((row) => row.kind === kind).reduce((s, row) => s + row.n, 0);
  const tools = new Map<string, number>();
  for (const row of rows) {
    if (row.kind !== "tool_call") continue;
    const tool = toolLabel(row.toolName);
    tools.set(tool, (tools.get(tool) ?? 0) + row.n);
  }
  return {
    prompts: sum("human"),
    replies: sum("assistant"),
    toolCalls: sum("tool_call"),
    errors: sum("tool_error") + sum("api_error"),
    span:
      time.first !== null && time.last !== null ? time.last - time.first : null,
    active: time.first !== null ? (time.active ?? 0) : null,
    tools: [...tools]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count || a.tool.localeCompare(b.tool)),
  };
}

export async function transcriptContext(
  db: D1Database,
  userId: string,
  transcript: { transcriptId: string; title: string; cwd: string | null },
): Promise<TranscriptContext> {
  const id = transcript.transcriptId;
  const [outline, mentionTurns, fileTurns] = await db.batch([
    db
      .prepare(
        `SELECT position, substr(text, 1, 200) AS text, at FROM transcript_turns
          WHERE transcript_id = ? AND kind = 'human' AND NOT ${HARNESS_SQL}
          ORDER BY position LIMIT ?`,
      )
      .bind(id, OUTLINE_LIMIT),
    db
      .prepare(
        `SELECT position, substr(text, 1, 2000) AS text FROM transcript_turns
          WHERE transcript_id = ?
            AND (text LIKE '%todo:tdo\\_%' ESCAPE '\\' OR text LIKE '%memory:mem\\_%' ESCAPE '\\'
                 OR text LIKE '%subject:sub\\_%' ESCAPE '\\')
          ORDER BY position LIMIT ?`,
      )
      .bind(id, MENTION_TURNS),
    db
      .prepare(
        `SELECT kind, tool_name AS toolName, substr(text, 1, 400) AS text FROM transcript_turns
          WHERE transcript_id = ? AND kind = 'tool_call'
            AND (tool_name IN ('Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'Skill')
                 OR tool_name LIKE 'mcp\\_%skill\\_%' ESCAPE '\\' OR tool_name LIKE '%get\\_skill' ESCAPE '\\')
          ORDER BY position LIMIT ?`,
      )
      .bind(id, FILE_TURNS),
  ]);
  const outlineRows = outline.results as OutlineEntry[];
  const mentions = itemMentions(
    mentionTurns.results as { position: number; text: string }[],
  ).slice(0, MENTION_IDS);
  const toolRows = fileTurns.results as {
    kind: "tool_call";
    toolName: string;
    text: string;
  }[];
  const [stats, linked, matched] = await Promise.all([
    transcriptStats(db, id),
    resolveMentions(db, userId, mentions),
    matchSubjects(
      db,
      userId,
      [
        transcript.title,
        ...outlineRows.slice(0, 20).map((row) => row.text),
      ].join(" "),
      8,
    ),
  ]);
  const subjects = new Map<string, LinkedSubject>();
  for (const subject of linked.subjects) subjects.set(subject.id, subject);
  for (const subject of matched) {
    const key = subject.id.replace(/^subject:/, "");
    if (!subjects.has(key))
      subjects.set(key, { id: key, name: subject.name, via: "name" });
  }
  return {
    stats,
    outline: outlineRows,
    todos: linked.todos,
    memories: linked.memories,
    subjects: [...subjects.values()],
    tags: tagCounts([...linked.todos, ...linked.memories]),
    files: filesTouched(toolRows, transcript.cwd),
    skills: skillsUsed(toolRows),
  };
}

function tagCounts(items: readonly { tags: string[] }[]) {
  const counts = new Map<string, number>();
  for (const item of items)
    for (const tag of item.tags) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  return [...counts]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

function parseTags(json: string | null): string[] {
  try {
    const value = JSON.parse(json ?? "[]");
    return Array.isArray(value)
      ? value.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

/** Look up the named ids, scoped to the reader; an id from another account resolves to nothing. */
async function resolveMentions(
  db: D1Database,
  userId: string,
  mentions: readonly { id: string; position: number }[],
) {
  const at = new Map(mentions.map((m) => [m.id, m.position]));
  const of = (prefix: string) =>
    mentions
      .filter((m) => m.id.startsWith(prefix))
      .map((m) => m.id.slice(prefix.length));
  const todoIds = of("todo:");
  const memoryIds = of("memory:");
  const subjectIds = of("subject:");
  const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
  const empty = { results: [] as unknown[] };
  const [todos, memories, memorySubjects, namedSubjects] = await Promise.all([
    todoIds.length
      ? db
          .prepare(
            `SELECT todo_id AS id, title, state, project, tags_json AS tags FROM todos
              WHERE user_id = ? AND todo_id IN (${marks(todoIds.length)})`,
          )
          .bind(userId, ...todoIds)
          .all()
      : empty,
    memoryIds.length
      ? db
          .prepare(
            `SELECT memory_id AS id, COALESCE(title, substr(body, 1, 120)) AS title,
                    memory_type AS type, tags_json AS tags FROM memories
              WHERE user_id = ? AND deleted_at IS NULL AND memory_id IN (${marks(memoryIds.length)})`,
          )
          .bind(userId, ...memoryIds)
          .all()
      : empty,
    memoryIds.length
      ? db
          .prepare(
            `SELECT DISTINCT s.subject_id AS id, s.name FROM memory_subject_members sm
               JOIN memory_subjects s ON s.subject_id = sm.subject_id
              WHERE s.user_id = ? AND s.deleted_at IS NULL AND sm.removed_at IS NULL
                AND sm.confirmed_at IS NOT NULL AND sm.memory_id IN (${marks(memoryIds.length)})
              ORDER BY s.name`,
          )
          .bind(userId, ...memoryIds)
          .all()
      : empty,
    subjectIds.length
      ? db
          .prepare(
            `SELECT subject_id AS id, name FROM memory_subjects
              WHERE user_id = ? AND deleted_at IS NULL AND subject_id IN (${marks(subjectIds.length)})`,
          )
          .bind(userId, ...subjectIds)
          .all()
      : empty,
  ]);
  const order = <T extends { position: number }>(rows: T[]) =>
    rows.sort((a, b) => a.position - b.position);
  return {
    todos: order(
      (
        todos.results as {
          id: string;
          title: string;
          state: string;
          project: string | null;
          tags: string;
        }[]
      ).map((row) => ({
        ...row,
        tags: parseTags(row.tags),
        position: at.get(`todo:${row.id}`) ?? 0,
      })),
    ),
    memories: order(
      (
        memories.results as {
          id: string;
          title: string;
          type: string;
          tags: string;
        }[]
      ).map((row) => ({
        ...row,
        tags: parseTags(row.tags),
        position: at.get(`memory:${row.id}`) ?? 0,
      })),
    ),
    subjects: [
      ...(namedSubjects.results as { id: string; name: string }[]).map(
        (row) => ({ ...row, via: "mention" as const }),
      ),
      ...(memorySubjects.results as { id: string; name: string }[]).map(
        (row) => ({ ...row, via: "memory" as const }),
      ),
    ].filter(
      (row, index, all) => all.findIndex((one) => one.id === row.id) === index,
    ),
  };
}

export type SessionSummary = {
  prompts: number;
  toolCalls: number;
  errors: number;
  tags: string[];
};

/**
 * One line of numbers and tags per listed session, in two reads for the
 * whole page: counts by kind, and the turns that name a to-do or memory.
 */
export async function sessionSummaries(
  db: D1Database,
  userId: string,
  transcriptIds: readonly string[],
): Promise<Record<string, SessionSummary>> {
  const out: Record<string, SessionSummary> = {};
  if (transcriptIds.length === 0) return out;
  const marks = transcriptIds.map(() => "?").join(",");
  const [counts, mentionTurns] = await db.batch([
    db
      .prepare(
        `SELECT transcript_id AS id,
                SUM(kind = 'human' AND NOT ${HARNESS_SQL}) AS prompts, SUM(kind = 'tool_call') AS toolCalls,
                SUM(kind IN ('tool_error', 'api_error')) AS errors
           FROM transcript_turns WHERE transcript_id IN (${marks}) GROUP BY transcript_id`,
      )
      .bind(...transcriptIds),
    db
      .prepare(
        `SELECT transcript_id AS id, position, substr(text, 1, 2000) AS text FROM transcript_turns
          WHERE transcript_id IN (${marks})
            AND (text LIKE '%todo:tdo\\_%' ESCAPE '\\' OR text LIKE '%memory:mem\\_%' ESCAPE '\\')
          LIMIT 3000`,
      )
      .bind(...transcriptIds),
  ]);
  for (const row of counts.results as (SessionSummary & { id: string })[]) {
    out[row.id] = {
      prompts: row.prompts ?? 0,
      toolCalls: row.toolCalls ?? 0,
      errors: row.errors ?? 0,
      tags: [],
    };
  }
  const bySession = new Map<string, string[]>();
  const allIds = new Set<string>();
  const rows = mentionTurns.results as {
    id: string;
    position: number;
    text: string;
  }[];
  for (const id of transcriptIds) {
    const ids = itemMentions(rows.filter((row) => row.id === id)).map(
      (m) => m.id,
    );
    bySession.set(id, ids);
    for (const one of ids) allIds.add(one);
  }
  const ids = [...allIds].slice(0, 400);
  const todoIds = ids
    .filter((id) => id.startsWith("todo:"))
    .map((id) => id.slice(5));
  const memoryIds = ids
    .filter((id) => id.startsWith("memory:"))
    .map((id) => id.slice(7));
  const tagsOf = new Map<string, string[]>();
  const [todos, memories] = await Promise.all([
    todoIds.length
      ? db
          .prepare(
            `SELECT 'todo:' || todo_id AS id, tags_json AS tags FROM todos
              WHERE user_id = ? AND todo_id IN (${todoIds.map(() => "?").join(",")})`,
          )
          .bind(userId, ...todoIds)
          .all<{ id: string; tags: string }>()
      : { results: [] },
    memoryIds.length
      ? db
          .prepare(
            `SELECT 'memory:' || memory_id AS id, tags_json AS tags FROM memories
              WHERE user_id = ? AND deleted_at IS NULL
                AND memory_id IN (${memoryIds.map(() => "?").join(",")})`,
          )
          .bind(userId, ...memoryIds)
          .all<{ id: string; tags: string }>()
      : { results: [] },
  ]);
  for (const row of [...todos.results, ...memories.results])
    tagsOf.set(row.id, parseTags(row.tags));
  for (const [id, mentioned] of bySession) {
    const summary = out[id];
    if (!summary) continue;
    summary.tags = tagCounts(
      mentioned.map((one) => ({ tags: tagsOf.get(one) ?? [] })),
    ).map((one) => one.tag);
  }
  return out;
}

/**
 * Sessions whose turns named a to-do or memory carrying `tag`, or a
 * memory in `subjectId`. A LIKE per named id, so the id list is capped.
 */
export async function transcriptIdsLinkedTo(
  db: D1Database,
  userId: string,
  filter: { tags?: readonly string[]; subjectId?: string },
): Promise<string[]> {
  /*
   * Several tags narrow like the other lists' tag filters: a session has to
   * have reached an item under every one, so each tag is its own set and the
   * sets intersect.
   */
  const sets: string[][] = [];
  for (const tag of filter.tags ?? [])
    sets.push(await idsNaming(db, userId, { tag }));
  if (filter.subjectId)
    sets.push(await idsNaming(db, userId, { subjectId: filter.subjectId }));
  if (sets.length === 0) return [];
  const [first, ...rest] = sets;
  return first.filter((id) => rest.every((set) => set.includes(id)));
}

/**
 * The tags a session can reach: those on the account's to-dos and live
 * memories, the two kinds a turn names by id. Most used first.
 */
export async function transcriptTagOptions(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `SELECT tag.value AS value FROM (
         SELECT tags_json FROM todos WHERE user_id = ?1
         UNION ALL SELECT tags_json FROM memories WHERE user_id = ?1 AND deleted_at IS NULL
       ) AS record, json_each(record.tags_json) AS tag
       WHERE tag.value <> '' GROUP BY tag.value ORDER BY COUNT(*) DESC, tag.value LIMIT 200`,
    )
    .bind(userId)
    .all<{ value: string }>();
  return results.map((row) => row.value);
}

async function idsNaming(
  db: D1Database,
  userId: string,
  filter: { tag?: string; subjectId?: string },
): Promise<string[]> {
  const items: string[] = [];
  if (filter.tag) {
    const { results } = await db
      .prepare(
        `SELECT 'todo:' || todo_id AS id FROM todos
          WHERE user_id = ?1 AND EXISTS (SELECT 1 FROM json_each(todos.tags_json) WHERE value = ?2)
         UNION ALL
         SELECT 'memory:' || memory_id FROM memories
          WHERE user_id = ?1 AND deleted_at IS NULL
            AND EXISTS (SELECT 1 FROM json_each(memories.tags_json) WHERE value = ?2)
         LIMIT ${MENTION_IDS}`,
      )
      .bind(userId, filter.tag)
      .all<{ id: string }>();
    items.push(...results.map((row) => row.id));
  }
  if (filter.subjectId) {
    const { results } = await db
      .prepare(
        `SELECT 'memory:' || sm.memory_id AS id FROM memory_subject_members sm
           JOIN memory_subjects s ON s.subject_id = sm.subject_id
          WHERE s.user_id = ? AND s.subject_id = ? AND sm.removed_at IS NULL
            AND sm.confirmed_at IS NOT NULL
          LIMIT ${MENTION_IDS}`,
      )
      .bind(userId, filter.subjectId)
      .all<{ id: string }>();
    items.push(...results.map((row) => row.id), `subject:${filter.subjectId}`);
  }
  if (items.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT DISTINCT t.transcript_id AS id FROM transcript_turns t
         JOIN transcripts s ON s.transcript_id = t.transcript_id AND s.user_id = ?
        WHERE ${items.map(() => "instr(t.text, ?) > 0").join(" OR ")}
        LIMIT 500`,
    )
    .bind(userId, ...items)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}
