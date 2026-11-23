/**
 * What changed in one tenant: to-dos created, claimed, progressed, blocked,
 * released, completed and commented on, memories saved and edited, skills
 * published, sources saved and files uploaded. Each row is a write that
 * already happened, read from the authoritative tables, never from the MCP
 * call log: a hundred calls that changed nothing are not activity. ADR-0006,
 * amendment of 2026-10-29.
 */

export type TrailConcept = "todo" | "memory" | "skill" | "source" | "file";

export type TrailEvent = {
  id: string;
  concept: TrailConcept;
  /** created, claim, progress, blocked, release, complete, comment, saved, edited, published, uploaded */
  action: string;
  itemId: string;
  title: string;
  project: string | null;
  agent: string | null;
  session: string | null;
  detail: string | null;
  at: number;
};

export type TrailWindow = {
  since: number;
  until: number;
  day: string | null;
  project: string | null;
};

/** The newest rows one page shows; the summary still counts the whole window. */
export const TRAIL_LIMIT = 300;
export const TRAIL_DAYS = 7;

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The window a URL asks for: one UTC day with `day=YYYY-MM-DD`, otherwise
 * the last seven days ending now. `project` narrows to one project.
 */
export function trailWindow(url: URL, now = Date.now()): TrailWindow {
  const project = url.searchParams.get("project")?.trim() || null;
  const day = url.searchParams.get("day")?.trim() ?? "";
  if (DAY_PATTERN.test(day)) {
    const start = Date.parse(`${day}T00:00:00Z`);
    if (Number.isFinite(start))
      return {
        since: start / 1000,
        until: start / 1000 + 86_400,
        day,
        project,
      };
  }
  const until = Math.floor(now / 1000) + 1;
  return { since: until - TRAIL_DAYS * 86_400, until, day: null, project };
}

/**
 * Every write in the window, one arm per table. D1 refuses a compound SELECT
 * this long, so each arm runs as its own statement in one batch, already
 * newest first and capped, and the page merges them. Each arm filters by
 * owner first, so no other tenant's row is read.
 */
const ARMS = [
  `SELECT 'todo' AS concept, 'created' AS action, t.todo_id AS item_id,
          t.title AS title, t.project AS project, t.source_agent AS agent,
          t.source_session_name AS session, NULL AS detail,
          t.created_at AS at, 'new_' || t.todo_id AS id
     FROM todos t
    WHERE t.user_id = ?1 AND t.created_at >= ?2 AND t.created_at < ?3`,
  `SELECT 'todo' AS concept, u.kind AS action, t.todo_id AS item_id,
          t.title AS title, t.project AS project, u.author AS agent,
          u.session_name AS session, u.summary AS detail,
          u.created_at AS at, u.update_id AS id
     FROM todo_updates u JOIN todos t ON t.todo_id = u.todo_id
    WHERE t.user_id = ?1 AND u.created_at >= ?2 AND u.created_at < ?3`,
  `SELECT 'todo' AS concept, 'comment' AS action, t.todo_id AS item_id,
          t.title AS title, t.project AS project, c.author AS agent,
          NULL AS session, c.summary AS detail, c.created_at AS at,
          c.comment_id AS id
     FROM todo_comments c JOIN todos t ON t.todo_id = c.todo_id
    WHERE t.user_id = ?1 AND c.created_at >= ?2 AND c.created_at < ?3`,
  `SELECT 'memory' AS concept, 'saved' AS action, m.memory_id AS item_id,
          m.title AS title, m.project AS project, m.source_agent AS agent,
          m.source_session_name AS session, NULL AS detail,
          m.created_at AS at, 'new_' || m.memory_id AS id
     FROM memories m
    WHERE m.user_id = ?1 AND m.created_at >= ?2 AND m.created_at < ?3`,
  // A revision row keeps the state an edit replaced, written at the edit by
  // the editor, so it dates the edit; the title shown is the current one.
  `SELECT 'memory' AS concept, 'edited' AS action, m.memory_id AS item_id,
          m.title AS title, m.project AS project, r.created_by AS agent,
          NULL AS session, NULL AS detail, r.created_at AS at,
          r.revision_id AS id
     FROM memory_revisions r JOIN memories m ON m.memory_id = r.memory_id
    WHERE m.user_id = ?1 AND r.created_at >= ?2 AND r.created_at < ?3`,
  `SELECT 'skill' AS concept, 'published' AS action, s.name AS item_id,
          s.name AS title, s.project AS project, v.created_by AS agent,
          NULL AS session, 'version ' || v.version AS detail,
          v.created_at AS at, v.version_id AS id
     FROM skill_versions v JOIN skills s ON s.skill_id = v.skill_id
    WHERE s.user_id = ?1 AND v.created_at >= ?2 AND v.created_at < ?3`,
  `SELECT 'source' AS concept, 'saved' AS action, s.source_id AS item_id,
          s.title AS title, s.project AS project, s.source_agent AS agent,
          NULL AS session, s.url AS detail, s.created_at AS at,
          'new_' || s.source_id AS id
     FROM sources s
    WHERE s.user_id = ?1 AND s.created_at >= ?2 AND s.created_at < ?3`,
  `SELECT 'file' AS concept, 'uploaded' AS action, a.asset_id AS item_id,
          COALESCE(a.title, a.file_name) AS title, a.project AS project,
          a.source_agent AS agent, NULL AS session, a.file_name AS detail,
          a.finalized_at AS at, 'new_' || a.asset_id AS id
     FROM assets a
    WHERE a.user_id = ?1 AND a.finalized_at >= ?2 AND a.finalized_at < ?3`,
];

/**
 * Timestamps are whole seconds and most ids are random. Within one second,
 * rows keep their author together, so two agents working at once do not
 * splinter into alternating blocks, and a to-do created, claimed and
 * completed in that second keeps its lifecycle order.
 */
const STEP: Record<string, number> = {
  created: 0,
  saved: 0,
  uploaded: 0,
  claim: 1,
  published: 1,
  progress: 2,
  comment: 2,
  edited: 2,
  blocked: 3,
  release: 4,
  complete: 5,
};

type Row = {
  concept: TrailConcept;
  action: string;
  item_id: string;
  title: string | null;
  project: string | null;
  agent: string | null;
  session: string | null;
  detail: string | null;
  at: number;
  id: string;
};

export type TrailCount = { concept: TrailConcept; action: string; n: number };

export async function readTrail(
  db: D1Database,
  userId: string,
  window: TrailWindow,
): Promise<{ events: TrailEvent[]; counts: TrailCount[]; truncated: boolean }> {
  const bind = [userId, window.since, window.until, window.project] as const;
  const results = await db.batch(
    ARMS.flatMap((arm) => [
      db
        .prepare(
          `SELECT * FROM (${arm}) WHERE ?4 IS NULL OR project = ?4
            ORDER BY at DESC, id DESC LIMIT ?5`,
        )
        .bind(...bind, TRAIL_LIMIT + 1),
      db
        .prepare(
          `SELECT concept, action, COUNT(*) AS n FROM (${arm})
            WHERE ?4 IS NULL OR project = ?4 GROUP BY concept, action`,
        )
        .bind(...bind),
    ]),
  );
  const rows = results
    .filter((_, index) => index % 2 === 0)
    .flatMap((result) => (result.results ?? []) as Row[])
    .sort(
      (a, b) =>
        b.at - a.at ||
        (a.agent ?? "").localeCompare(b.agent ?? "") ||
        (a.session ?? "").localeCompare(b.session ?? "") ||
        (STEP[b.action] ?? 0) - (STEP[a.action] ?? 0) ||
        (a.id < b.id ? 1 : a.id > b.id ? -1 : 0),
    );
  const counts = results
    .filter((_, index) => index % 2 === 1)
    .flatMap((result) => (result.results ?? []) as TrailCount[]);
  return {
    events: rows.slice(0, TRAIL_LIMIT).map((row) => ({
      id: row.id,
      concept: row.concept,
      action: row.action,
      itemId: row.item_id,
      title: row.title ?? "(untitled)",
      project: row.project,
      agent: row.agent,
      session: row.session,
      detail: row.detail,
      at: row.at,
    })),
    counts,
    truncated: rows.length > TRAIL_LIMIT,
  };
}

/**
 * Consecutive events by the same author and session, so a session that
 * touched twelve to-dos reads as one block rather than twelve rows with the
 * same byline. Never across a UTC day.
 */
export type TrailRun = {
  day: string;
  agent: string | null;
  session: string | null;
  events: TrailEvent[];
};

export function groupTrail(events: TrailEvent[]): TrailRun[] {
  const runs: TrailRun[] = [];
  for (const event of events) {
    const day = new Date(event.at * 1000).toISOString().slice(0, 10);
    const last = runs.at(-1);
    if (
      last &&
      last.day === day &&
      last.agent === event.agent &&
      last.session === event.session
    )
      last.events.push(event);
    else
      runs.push({
        day,
        agent: event.agent,
        session: event.session,
        events: [event],
      });
  }
  return runs;
}

/** Where a person goes to see the item itself. */
export function trailHref(event: TrailEvent): string {
  switch (event.concept) {
    case "todo":
      return `/todos?open=${encodeURIComponent(`todo:${event.itemId}`)}`;
    case "memory":
      return `/memories?open=${encodeURIComponent(`memory:${event.itemId}`)}`;
    case "skill":
      return `/skills?open=${encodeURIComponent(event.itemId)}`;
    default:
      return `/library?q=${encodeURIComponent(event.title)}`;
  }
}

const VERBS: Record<string, string> = {
  created: "created",
  claim: "claimed",
  progress: "posted progress on",
  blocked: "blocked",
  release: "released",
  complete: "completed",
  comment: "commented on",
  saved: "saved",
  edited: "edited",
  published: "published",
  uploaded: "uploaded",
};

export function trailVerb(event: Pick<TrailEvent, "action">): string {
  return VERBS[event.action] ?? event.action;
}

/**
 * The outcomes line: what got done, in the person's words. Claims, releases
 * and progress posts are steps toward an outcome, so they stay in the list
 * and out of this line.
 */
const OUTCOMES: [TrailConcept, string, string, string][] = [
  ["todo", "complete", "to-do completed", "to-dos completed"],
  ["todo", "created", "to-do created", "to-dos created"],
  ["todo", "blocked", "to-do blocked", "to-dos blocked"],
  ["memory", "saved", "memory saved", "memories saved"],
  ["memory", "edited", "memory edit", "memory edits"],
  ["skill", "published", "skill version published", "skill versions published"],
  ["source", "saved", "source saved", "sources saved"],
  ["file", "uploaded", "file uploaded", "files uploaded"],
];

export function trailOutcomes(counts: TrailCount[]): string[] {
  return OUTCOMES.flatMap(([concept, action, one, many]) => {
    const n =
      counts.find(
        (count) => count.concept === concept && count.action === action,
      )?.n ?? 0;
    return n === 0 ? [] : [`${n} ${n === 1 ? one : many}`];
  });
}

/** `12:41–12:48`, or one time when both fall in the same UTC minute. */
export function timeRange(first: number, last: number): string {
  const time = (seconds: number) =>
    new Date(seconds * 1000).toISOString().slice(11, 16);
  return time(first) === time(last)
    ? time(first)
    : `${time(first)}–${time(last)}`;
}
