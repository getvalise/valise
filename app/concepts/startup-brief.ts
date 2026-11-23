import { supersededMemorySql } from "~/search/memory-source";
import { queryTodos } from "./todo-query";

export const BRIEF_PROJECTS = 3;
export const BRIEF_TODOS = 5;
export const BRIEF_MEMORIES = 3;
export const MAX_TITLE_LENGTH = 160;
export const MAX_STARTUP_BRIEF_LENGTH = 7800;
export const BRIEF_WINDOW_SECONDS = 86_400;

type TodoPage = Awaited<ReturnType<typeof queryTodos>>;
type ProjectRow = {
  project: string;
  active_at: number;
  rollup_id: string | null;
};
type MemoryRow = {
  memory_id: string;
  title: string;
  project: string | null;
  updated_at: number;
  memory_type: string;
};

/**
 * Everything the brief reads, as the database returned it. Each list holds
 * one row past its limit, so selection can say whether more exist.
 */
export type BriefRows = {
  projects: ProjectRow[];
  /** `tags_json` of the rollup memories the selected projects name. */
  rollupTags: { memory_id: string; tags_json: string }[];
  memories: MemoryRow[];
  ready: TodoPage;
  claimed: TodoPage;
  blocked: TodoPage;
  completed: TodoPage;
};

export type BriefWindow = {
  now: number;
  since: number;
  project: string | null;
};

/** The window a brief covers: `since` defaults to the preceding 24 hours. */
export function briefWindow(
  input: { project?: string; since?: number },
  now: number,
): BriefWindow {
  return {
    now,
    since: input.since ?? now - BRIEF_WINDOW_SECONDS,
    project: input.project ?? null,
  };
}

/** The rollup memories worth reading facets for: the selected projects' only. */
export function selectedRollupIds(projects: ProjectRow[]): string[] {
  return projects
    .slice(0, BRIEF_PROJECTS)
    .flatMap((row) => (row.rollup_id ? [row.rollup_id] : []));
}

/** The I/O half: bounded reads, nothing chosen or formatted here. */
export async function loadBriefRows(
  db: D1Database,
  userId: string,
  window: BriefWindow,
): Promise<BriefRows> {
  const { now, since, project } = window;
  const todoProject = project ?? undefined;
  const [projects, memories, ready, claimed, blocked, completed] =
    await Promise.all([
      db
        .prepare(`WITH activity AS (
        SELECT project, updated_at AS at FROM todos WHERE user_id = ?1
        UNION ALL
        SELECT t.project, u.created_at FROM todo_updates u JOIN todos t USING(todo_id) WHERE t.user_id = ?1
        UNION ALL
        SELECT t.project, c.created_at FROM todo_comments c JOIN todos t USING(todo_id) WHERE t.user_id = ?1
        UNION ALL
        SELECT project, updated_at FROM memories WHERE user_id = ?1 AND deleted_at IS NULL
      ), recent AS (
        SELECT project, MAX(at) AS active_at FROM activity
         WHERE project IS NOT NULL AND (?2 IS NULL OR project = ?2)
         GROUP BY project ORDER BY active_at DESC, project LIMIT ?3
      )
      SELECT recent.*, (
        SELECT m.memory_id FROM memories m
         WHERE m.user_id = ?1 AND m.project = recent.project AND m.deleted_at IS NULL
           AND NOT ${supersededMemorySql("m")}
           AND EXISTS (SELECT 1 FROM json_each(m.tags_json) WHERE value = 'rollup')
         ORDER BY m.updated_at DESC, m.memory_id LIMIT 1
      ) AS rollup_id FROM recent ORDER BY active_at DESC, project`)
        .bind(userId, project, BRIEF_PROJECTS + 1)
        .all<ProjectRow>(),
      db
        .prepare(`SELECT memory_id, substr(COALESCE(title, body), 1, 500) AS title,
                       project, updated_at, memory_type
                  FROM memories m
                 WHERE user_id = ?1 AND deleted_at IS NULL AND updated_at >= ?2 AND updated_at <= ?3
                   AND (?4 IS NULL OR project = ?4)
                   AND NOT ${supersededMemorySql("m")}
                 ORDER BY updated_at DESC, memory_id LIMIT ?5`)
        .bind(userId, since, now, project, BRIEF_MEMORIES + 1)
        .all<MemoryRow>(),
      queryTodos(
        db,
        userId,
        { project: todoProject, state: "pending", limit: BRIEF_TODOS },
        now,
        { readyOnly: true, sampleBy: "activity" },
      ),
      queryTodos(
        db,
        userId,
        { project: todoProject, state: "claimed", limit: BRIEF_TODOS },
        now,
        { sampleBy: "activity" },
      ),
      queryTodos(
        db,
        userId,
        { project: todoProject, limit: BRIEF_TODOS },
        now,
        { effectiveBlockedOnly: true, sampleBy: "activity" },
      ),
      queryTodos(
        db,
        userId,
        {
          project: todoProject,
          state: "done",
          completed_since: since,
          limit: BRIEF_TODOS,
        },
        now,
        { sampleBy: "completion" },
      ),
    ]);
  // Facets only for the bounded selected projects, never every rollup.
  const { results: rollupTags } = await db
    .prepare(
      "SELECT memory_id, tags_json FROM memories WHERE user_id = ? AND memory_id IN (SELECT value FROM json_each(?))",
    )
    .bind(userId, JSON.stringify(selectedRollupIds(projects.results)))
    .all<{ memory_id: string; tags_json: string }>();
  return {
    projects: projects.results,
    rollupTags,
    memories: memories.results,
    ready,
    claimed,
    blocked,
    completed,
  };
}

/** A rollup's `covers_up_to:` facet, tolerant of a malformed tag list. */
export function coversUpTo(tagsJson: string): string | null {
  let tags: unknown;
  try {
    tags = JSON.parse(tagsJson);
  } catch {
    return null;
  }
  if (!Array.isArray(tags)) return null;
  const tag = tags.find(
    (item): item is string =>
      typeof item === "string" && item.startsWith("covers_up_to:"),
  );
  return tag ? tag.slice("covers_up_to:".length) : null;
}

/**
 * The pure half: bound each section, mark what was omitted, and cut long
 * text. Same rows and window in, same brief out; no clock, no database.
 */
export function selectBrief(rows: BriefRows, window: BriefWindow) {
  const covers = new Map(
    rows.rollupTags.map((row) => [row.memory_id, coversUpTo(row.tags_json)]),
  );
  const section = (page: TodoPage) => ({
    limit: BRIEF_TODOS,
    has_more: page.has_more,
    // This is a sample, not a page: continuation is an explicit list_todos call.
    items: page.todos.map(({ tags: _tags, refs: _refs, ...todo }) => ({
      ...todo,
      title: cut(todo.title),
      blocked_on: todo.blocked_on === null ? null : cut(todo.blocked_on),
      status: todo.status === null ? null : cut(todo.status),
      last_update_summary:
        todo.last_update_summary === null
          ? null
          : cut(todo.last_update_summary),
    })),
  });
  return {
    generated_at: window.now,
    project: window.project,
    window: { since: window.since, until: window.now },
    note: "Bounded orientation, not a complete store or lease authority. Fetch ids before acting; list_todos paginates stored states, list_ready selects work to claim. Blocked includes stored blocked tasks and pending work waiting on manual reasons or unfinished dependencies; state and blocked_on are unchanged. State mirrors the coordinator asynchronously.",
    projects: {
      limit: BRIEF_PROJECTS,
      has_more: rows.projects.length > BRIEF_PROJECTS,
      items: rows.projects.slice(0, BRIEF_PROJECTS).map((row) => ({
        project: row.project,
        active_at: row.active_at,
        rollup_id: row.rollup_id ? `memory:${row.rollup_id}` : null,
        covers_up_to: row.rollup_id
          ? (covers.get(row.rollup_id) ?? null)
          : null,
      })),
    },
    ready: section(rows.ready),
    claimed: section(rows.claimed),
    blocked: section(rows.blocked),
    completed: section(rows.completed),
    changed_memories: {
      limit: BRIEF_MEMORIES,
      has_more: rows.memories.length > BRIEF_MEMORIES,
      items: rows.memories
        .slice(0, BRIEF_MEMORIES)
        .map(({ memory_id, title, memory_type, ...row }) => ({
          id: `memory:${memory_id}`,
          title: cut(title),
          type: memory_type,
          ...row,
        })),
    },
  };
}

export type ProjectBrief = ReturnType<typeof selectBrief>;

/** One bounded read model for hook text, MCP and console callers. */
export async function readProjectBrief(
  db: D1Database,
  userId: string,
  input: { project?: string; since?: number } = {},
  now = Math.floor(Date.now() / 1000),
): Promise<ProjectBrief> {
  const window = briefWindow(input, now);
  return selectBrief(await loadBriefRows(db, userId, window), window);
}

export const BRIEF_WORKTREE_CLAIMS = 3;

export type StartupBriefInput = {
  /** The project the session's working directory maps to, if any. */
  project?: string;
  /** The session's working directory, matched against `worktree` refs. */
  cwd?: string;
  /** Only this worktree's claims: what resume and compaction re-inject. */
  claimedOnly?: boolean;
};

/** Whether a `worktree` ref names `cwd` or a directory holding it. */
export function worktreeHolds(ref: string, cwd: string): boolean {
  const root = ref.replace(/\/+$/, "");
  return root !== "" && (cwd === root || cwd.startsWith(`${root}/`));
}

/**
 * Claimed to-dos with a `worktree` ref holding `cwd`, most active first. The
 * claimed set is small, so it is read whole and filtered here, which keeps
 * the ref match in one place rather than in SQL over `refs_json`.
 */
export async function worktreeClaims(
  db: D1Database,
  userId: string,
  cwd: string,
  now: number,
) {
  const claimed = await queryTodos(
    db,
    userId,
    { state: "claimed", limit: 100 },
    now,
    { sampleBy: "activity" },
  );
  return claimed.todos
    .filter((todo) =>
      todo.refs.some(
        (ref) => ref.kind === "worktree" && worktreeHolds(ref.value, cwd),
      ),
    )
    .slice(0, BRIEF_WORKTREE_CLAIMS);
}

/** The worktree's claims as hook text; "" when it holds none. */
export function renderWorktreeClaims(
  claims: Awaited<ReturnType<typeof worktreeClaims>>,
  cwd: string,
): string {
  if (!claims.length) return "";
  const lines = [
    `Claimed in this worktree (${cut(cwd)}); fetch the to-do for its fencing token and history before continuing:`,
  ];
  for (const todo of claims) {
    lines.push(
      `- ${todo.id} ${cut(todo.title)}${todo.project ? ` · ${cut(todo.project)}` : ""}${todo.lease_expires_at ? ` · lease until ${todo.lease_expires_at}` : ""}`,
    );
    if (todo.status)
      lines.push(`  status ${todo.status_at}: ${cut(todo.status)}`);
    else if (todo.last_update_summary)
      lines.push(
        `  last update ${todo.last_update_at}: ${cut(todo.last_update_summary)}`,
      );
  }
  return lines.join("\n");
}

/**
 * The hook's session brief. With a project, that project's brief, or the
 * unscoped one when the project has nothing to brief (a remote whose name no
 * project uses); with a `cwd`, the claims of that worktree first.
 */
export async function readStartupBrief(
  db: D1Database,
  userId: string,
  now = Date.now(),
  input: StartupBriefInput = {},
): Promise<string> {
  const seconds = Math.floor(now / 1000);
  const claims = input.cwd
    ? renderWorktreeClaims(
        await worktreeClaims(db, userId, input.cwd, seconds),
        input.cwd,
      )
    : "";
  if (input.claimedOnly) return claims;
  let brief = input.project
    ? renderStartupBrief(
        await readProjectBrief(db, userId, { project: input.project }, seconds),
      )
    : "";
  if (!brief)
    brief = renderStartupBrief(await readProjectBrief(db, userId, {}, seconds));
  const text = [claims, brief].filter(Boolean).join("\n\n");
  return text.length <= MAX_STARTUP_BRIEF_LENGTH
    ? text
    : text.slice(0, text.lastIndexOf("\n", MAX_STARTUP_BRIEF_LENGTH - 1));
}

/** The brief as hook text; each to-do's status follows its line. */
export function renderStartupBrief(brief: ProjectBrief): string {
  if (
    !brief.projects.items.length &&
    !brief.changed_memories.items.length &&
    ![brief.ready, brief.claimed, brief.blocked, brief.completed].some(
      (part) => part.items.length,
    )
  )
    return "";
  const lines = [
    "Recent work, for orientation only; fetch before relying on any of it.",
    `Generated ${brief.generated_at}; completion and memory window ${brief.window.since}–${brief.window.until} (Unix seconds).`,
    brief.note,
  ];
  lines.push(
    `Projects worked on last (up to ${brief.projects.limit}${brief.projects.has_more ? "; more omitted" : ""}): ${brief.projects.items
      .map(
        (row) =>
          `${cut(row.project)}${row.rollup_id ? ` (overview ${row.rollup_id}${row.covers_up_to ? `, covers up to ${row.covers_up_to}` : ""})` : ""}`,
      )
      .join(", ")}.`,
  );
  for (const [label, part] of [
    ["Ready", brief.ready],
    ["Claimed", brief.claimed],
    ["Blocked", brief.blocked],
    ["Completed", brief.completed],
  ] as const) {
    lines.push(
      `${label} (up to ${part.limit}${part.has_more ? "; more omitted, use list_todos" : ""}):`,
    );
    for (const todo of part.items) {
      lines.push(
        `- ${todo.id} [${todo.state}] ${todo.title}${todo.project ? ` · ${cut(todo.project)}` : ""}${todo.blocked_on ? ` · blocker: ${todo.blocked_on}` : ""}`,
      );
      if (todo.status) lines.push(`  status ${todo.status_at}: ${todo.status}`);
      else if (todo.last_update_summary)
        lines.push(
          `  last update ${todo.last_update_at}, ${todo.last_update_kind}: ${todo.last_update_summary}`,
        );
    }
  }
  lines.push(
    `Changed memories (up to ${brief.changed_memories.limit}${brief.changed_memories.has_more ? "; more omitted" : ""}):`,
    ...brief.changed_memories.items.map((row) => `- ${row.id} ${row.title}`),
  );
  const text = lines.join("\n");
  if (text.length <= MAX_STARTUP_BRIEF_LENGTH) return text;
  const note =
    "\nAdditional items omitted to bound hook context; use get_brief for structured bounds and list_todos for task pages.";
  return (
    text.slice(
      0,
      text.lastIndexOf("\n", MAX_STARTUP_BRIEF_LENGTH - note.length),
    ) + note
  );
}

function cut(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= MAX_TITLE_LENGTH
    ? line
    : `${line.slice(0, MAX_TITLE_LENGTH - 1).trimEnd()}…`;
}
