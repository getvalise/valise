import type { Provenance } from "~/concepts/memories";
import { nowSeconds } from "~/r2/objects";
import { projectTranscript } from "~/search/project";
import { projectionStatement } from "~/search/write";
import { harnessEvent, isHarnessText } from "./transcript-view";

export {
  TRANSCRIPT_PAGE_TURNS,
  transcriptTurnPath,
  transcriptTurnRef,
} from "./transcript-ref";

/**
 * Transcripts: the distilled conversation of one agent session, sent by the
 * Valise CLI as it happens or imported from a local store. One row per
 * session, one per turn. A turn is a human message, an assistant text, the
 * assistant's thinking, text the client put in front of the model that
 * nobody typed (`system`: the system prompt, instruction files, hook
 * context, reminders), a tool call with a one-line argument summary, a tool
 * error with its text, or an API error the writer saw. Successful tool
 * results, tool definitions and raw request bodies never arrive. ADR-0022
 * (thinking and system: amendments of 2026-11-08).
 *
 * Writes are idempotent and keyed on the turn list: a writer says which
 * position its turns start at, the server checks the overlap against the
 * hashes it holds, appends what is new, and answers a conflict with its own
 * hash list when the two histories disagree, so the writer can resend from
 * the longest common prefix.
 */

export const TURN_KINDS = [
  "human",
  "assistant",
  "thinking",
  "system",
  "tool_call",
  "tool_error",
  "api_error",
] as const;
export type TurnKind = (typeof TURN_KINDS)[number];

/** One turn's text, after the writer's own distillation. */
export const MAX_TURN_BYTES = 64 * 1024;
/** Turns per write, so one request stays well under the Worker body cap. */
export const MAX_TURNS_PER_WRITE = 500;
/** Turns per session; a longer one is a sign the writer is not distilling. */
export const MAX_TURNS_PER_TRANSCRIPT = 20_000;
/** Characters of the first human turn that name the session in lists. */
export const TITLE_LENGTH = 120;

const NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export type TurnInput = {
  kind: TurnKind;
  text: string;
  toolName?: string | null;
  /** Unix seconds, as the writer saw the turn; null when it did not say. */
  at?: number | null;
};

export type AppendTranscript = {
  /** The program that held the conversation: `claude-code`, `codex`, `opencode`. */
  client: string;
  /** The machine, as the writer names it; part of the session's identity. */
  device: string;
  /** The client's own id for the session, such as a Claude Code uuid. */
  sessionId: string;
  cwd?: string | null;
  gitBranch?: string | null;
  project?: string | null;
  model?: string | null;
  /** The position of `turns[0]`: what the writer believes the server holds. */
  from: number;
  /**
   * The writer's history differs from the held one at `from`: drop the held
   * turns from there and keep the writer's. A distiller that learns to keep
   * more (thinking, system text) inserts turns mid-history, which appending
   * alone can never accept.
   */
  replace?: boolean;
  turns: TurnInput[];
};

export type Transcript = {
  transcriptId: string;
  userId: string;
  client: string;
  device: string;
  sessionId: string;
  cwd: string | null;
  gitBranch: string | null;
  project: string | null;
  model: string | null;
  title: string;
  turnCount: number;
  chainHash: string;
  firstAt: number | null;
  lastAt: number | null;
  sourceAgent: string;
  sourceClient: string;
  createdAt: number;
  updatedAt: number;
};

export type TranscriptTurn = {
  position: number;
  kind: TurnKind;
  text: string;
  /** The tool of a tool turn; where a `system` turn's text came from. */
  toolName: string | null;
  at: number | null;
  hash: string;
};

/** What the server holds for a session, for a writer to resume from. */
export type TranscriptState = {
  transcriptId: string;
  turnCount: number;
  chainHash: string;
  hashes: string[];
};

export type AppendResult =
  | { ok: true; transcript: Transcript; appended: number }
  | { ok: false; conflict: TranscriptState | null };

export class TranscriptRefused extends Error {}

export function transcriptRef(transcriptId: string): string {
  return `transcript:${transcriptId}`;
}

export function transcriptIdOf(id: string): string | null {
  const match = /^transcript:(trn_[\w-]+)$/.exec(id);
  return match ? match[1] : null;
}

/**
 * Turns as `fetch` returns them: one line each, led by the position a link
 * names and the time, so a reader can cite a line or ask for the next page.
 * A message a client wrote as a user turn (a task notification, a slash
 * command, hook feedback) reads as an event, not as the person.
 */
export function transcriptLines(
  turns: readonly TranscriptTurn[],
  focus: number | null = null,
): string {
  return turns
    .map((turn) => {
      const time =
        turn.at === null
          ? ""
          : ` ${new Date(turn.at * 1000).toISOString().slice(11, 16)}`;
      const mark = turn.position === focus ? "→ " : "";
      return `${mark}[t-${turn.position}${time}] ${turnLine(turn)}`;
    })
    .join("\n");
}

type TranscriptEnv = { DB: D1Database; BUNDLES: R2Bucket };

/**
 * Append a writer's turns to its session, creating the session on the first
 * write. Pairs every row with its projection in one batch (ADR-0001), then
 * rewrites the session's JSON lines mirror in R2 for DuckDB readers.
 */
export async function appendTranscript(
  env: TranscriptEnv,
  input: AppendTranscript,
  provenance: Provenance,
): Promise<AppendResult> {
  const db = env.DB;
  const valid = validate(input);
  const hashes = await Promise.all(valid.turns.map(turnHash));
  const now = nowSeconds();
  const head = await readTranscriptBySession(
    db,
    provenance.userId,
    valid.client,
    valid.device,
    valid.sessionId,
  );
  let held = head?.turnCount ?? 0;
  if (valid.from > held) {
    return {
      ok: false,
      conflict: head === null ? null : await transcriptState(db, head),
    };
  }
  // The overlap must match what is held, hash for hash; a resend after a
  // lost answer then adds nothing, and a diverged history is refused.
  const overlap = held - valid.from;
  let diverged = false;
  if (overlap > 0) {
    const heldHashes = await readHashes(
      db,
      head?.transcriptId ?? "",
      valid.from,
      held,
    );
    const agrees =
      heldHashes.length === overlap &&
      heldHashes.every((hash, index) => hash === hashes[index]);
    diverged = !agrees;
    if (diverged && !valid.replace) {
      return {
        ok: false,
        conflict: head === null ? null : await transcriptState(db, head),
      };
    }
  }
  // Replacing: what is held from `from` on goes, and the writer's turns
  // follow the kept prefix. The guard below still names the count read
  // here, so a writer that raced this one loses rather than interleaves.
  const guard = held;
  const truncate = diverged && head !== null;
  if (truncate) held = valid.from;
  const kept = truncate ? valid.from : held;
  const fresh = valid.turns.slice(truncate ? 0 : held - valid.from);
  const freshHashes = hashes.slice(truncate ? 0 : held - valid.from);
  if (held + fresh.length > MAX_TURNS_PER_TRANSCRIPT) {
    throw new TranscriptRefused(
      `A transcript holds at most ${MAX_TURNS_PER_TRANSCRIPT} turns.`,
    );
  }
  const transcriptId = head?.transcriptId ?? `trn_${crypto.randomUUID()}`;
  const earlier = (
    head === null ? [] : await readTranscriptTurns(db, transcriptId)
  ).slice(0, kept);
  let chain = "";
  if (truncate) {
    for (const turn of earlier) chain = await chainHash(chain, turn.hash);
  } else chain = head?.chainHash ?? "";
  for (const hash of freshHashes) chain = await chainHash(chain, hash);
  // A task notification or a slash command is not what the session is about.
  const isPrompt = (turn: { kind: string; text: string }) =>
    turn.kind === "human" && !isHarnessText(turn.text);
  const firstHuman = (truncate ? [...earlier, ...fresh] : fresh).find(isPrompt);
  const title =
    (truncate ? "" : head?.title) ||
    (firstHuman ? titleOf(firstHuman.text) : "");
  const times = (truncate ? [...earlier, ...fresh] : fresh)
    .map((turn) => turn.at)
    .filter((at): at is number => at !== null && at !== undefined);
  const firstAt =
    (truncate ? null : head?.firstAt) ??
    (times.length ? Math.min(...times) : null);
  const lastAt = times.length
    ? Math.max(truncate ? 0 : (head?.lastAt ?? 0), ...times)
    : (head?.lastAt ?? null);
  const row: Transcript = {
    transcriptId,
    userId: provenance.userId,
    client: valid.client,
    device: valid.device,
    sessionId: valid.sessionId,
    cwd: valid.cwd ?? head?.cwd ?? null,
    gitBranch: valid.gitBranch ?? head?.gitBranch ?? null,
    project: valid.project ?? head?.project ?? null,
    model: valid.model ?? head?.model ?? null,
    title,
    turnCount: held + fresh.length,
    chainHash: chain,
    firstAt,
    lastAt,
    sourceAgent: head?.sourceAgent ?? provenance.agent,
    sourceClient: head?.sourceClient ?? provenance.client,
    createdAt: head?.createdAt ?? now,
    updatedAt: now,
  };
  const all: TranscriptTurn[] = [
    ...earlier,
    ...fresh.map((turn, index) => ({
      position: held + index,
      kind: turn.kind,
      text: turn.text,
      toolName: turn.toolName ?? null,
      at: turn.at ?? null,
      hash: freshHashes[index],
    })),
  ];
  const statements = [
    // First, while the count still says what this writer read: a raced
    // writer's turns are never deleted.
    ...(truncate
      ? [
          db
            .prepare(
              `DELETE FROM transcript_turns WHERE transcript_id = ? AND position >= ?
                 AND (SELECT turn_count FROM transcripts WHERE transcript_id = ?) = ?`,
            )
            .bind(transcriptId, kept, transcriptId, guard),
        ]
      : []),
    db
      .prepare(
        `INSERT INTO transcripts (
           transcript_id, user_id, client, device, session_id, cwd, git_branch,
           project, model, title, turn_count, chain_hash, first_at, last_at,
           source_agent, source_client, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(transcript_id) DO UPDATE SET
           cwd = excluded.cwd, git_branch = excluded.git_branch,
           project = excluded.project, model = excluded.model,
           title = excluded.title, turn_count = excluded.turn_count,
           chain_hash = excluded.chain_hash, first_at = excluded.first_at,
           last_at = excluded.last_at, updated_at = excluded.updated_at
         WHERE transcripts.turn_count = ?`,
      )
      .bind(
        row.transcriptId,
        row.userId,
        row.client,
        row.device,
        row.sessionId,
        row.cwd,
        row.gitBranch,
        row.project,
        row.model,
        row.title,
        row.turnCount,
        row.chainHash,
        row.firstAt,
        row.lastAt,
        row.sourceAgent,
        row.sourceClient,
        row.createdAt,
        row.updatedAt,
        guard,
      ),
    ...all.slice(earlier.length).map((turn) =>
      db
        .prepare(
          `INSERT INTO transcript_turns (transcript_id, position, kind, text, tool_name, at, hash)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          transcriptId,
          turn.position,
          turn.kind,
          turn.text,
          turn.toolName,
          turn.at,
          turn.hash,
        ),
    ),
    projectionStatement(
      db,
      projectTranscript(row, all),
      transcriptRef(transcriptId),
    ),
  ];
  if (fresh.length > 0 || truncate) {
    try {
      await db.batch(statements);
    } catch (error) {
      // Two writers for one session raced; the loser sees the winner's state.
      const current = await readTranscript(db, provenance.userId, transcriptId);
      if (current !== null && current.turnCount !== guard) {
        return { ok: false, conflict: await transcriptState(db, current) };
      }
      throw error;
    }
    await env.BUNDLES.put(mirrorKey(row), mirrorLines(row, all), {
      httpMetadata: { contentType: "application/x-ndjson" },
    });
  }
  return { ok: true, transcript: row, appended: fresh.length };
}

export async function readTranscript(
  db: D1Database,
  userId: string,
  transcriptId: string,
): Promise<Transcript | null> {
  return (
    (await db
      .prepare(`${SELECT_SQL} WHERE user_id = ? AND transcript_id = ?`)
      .bind(userId, transcriptId)
      .first<Transcript>()) ?? null
  );
}

export async function readTranscriptBySession(
  db: D1Database,
  userId: string,
  client: string,
  device: string,
  sessionId: string,
): Promise<Transcript | null> {
  return (
    (await db
      .prepare(
        `${SELECT_SQL} WHERE user_id = ? AND client = ? AND device = ? AND session_id = ?`,
      )
      .bind(userId, client, device, sessionId)
      .first<Transcript>()) ?? null
  );
}

export async function readTranscriptTurns(
  db: D1Database,
  transcriptId: string,
): Promise<TranscriptTurn[]> {
  const { results } = await db
    .prepare(
      `SELECT position, kind, text, tool_name AS toolName, at, hash
         FROM transcript_turns WHERE transcript_id = ? ORDER BY position`,
    )
    .bind(transcriptId)
    .all<TranscriptTurn>();
  return results;
}

/** What the console's session list narrows by. Every field is optional. */
export type TranscriptFilter = {
  query?: string;
  client?: string;
  device?: string;
  project?: string;
  /** Only sessions with a failed tool or API call. */
  errors?: boolean;
  /** Only these sessions, already narrowed by a tag or subject. */
  ids?: readonly string[];
  /**
   * Only sessions active in `[from, to)`, unix seconds: one whose first turn
   * is before `to` and whose last turn is at or after `from`.
   */
  from?: number;
  to?: number;
};

/** Which end of a session orders the list: when it started, or its latest turn. */
export type TranscriptSort = "first" | "last";

const SORT_KEY: Record<TranscriptSort, string> = {
  first: "COALESCE(first_at, updated_at)",
  last: "COALESCE(last_at, updated_at)",
};

function filterSql(userId: string, filter: TranscriptFilter) {
  const where = ["user_id = ?"];
  const bindings: unknown[] = [userId];
  if (filter.query) {
    where.push("title LIKE ? ESCAPE '\\'");
    bindings.push(`%${filter.query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`);
  }
  for (const key of ["client", "device", "project"] as const) {
    if (filter[key]) {
      where.push(`${key} = ?`);
      bindings.push(filter[key]);
    }
  }
  if (filter.errors) {
    where.push(
      `EXISTS (SELECT 1 FROM transcript_turns t WHERE t.transcript_id = transcripts.transcript_id
         AND t.kind IN ('tool_error', 'api_error'))`,
    );
  }
  if (filter.ids) {
    where.push(
      filter.ids.length
        ? `transcript_id IN (${filter.ids.map(() => "?").join(",")})`
        : "0",
    );
    bindings.push(...filter.ids);
  }
  if (filter.to !== undefined) {
    where.push(`${SORT_KEY.first} < ?`);
    bindings.push(filter.to);
  }
  if (filter.from !== undefined) {
    where.push(`COALESCE(last_at, first_at, updated_at) >= ?`);
    bindings.push(filter.from);
  }
  return { sql: where.join(" AND "), bindings };
}

/** Bounded console reading; every query is scoped by the signed-in user. */
export async function listTranscripts(
  db: D1Database,
  userId: string,
  offset: number,
  limit = 30,
  filter: TranscriptFilter = {},
  sort: TranscriptSort = "first",
): Promise<Transcript[]> {
  const { sql, bindings } = filterSql(userId, filter);
  const { results } = await db
    .prepare(
      `${SELECT_SQL} WHERE ${sql} ORDER BY ${SORT_KEY[sort]} DESC, transcript_id DESC LIMIT ? OFFSET ?`,
    )
    .bind(...bindings, limit, offset)
    .all<Transcript>();
  return results;
}

/** How many sessions the filter matches, for the list's progress line. */
export async function countTranscripts(
  db: D1Database,
  userId: string,
  filter: TranscriptFilter = {},
): Promise<number> {
  const { sql, bindings } = filterSql(userId, filter);
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM transcripts WHERE ${sql}`)
    .bind(...bindings)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export type TranscriptFacets = Record<
  "client" | "device" | "project",
  { value: string; count: number }[]
>;

/** Each column's values on this account, with how many sessions hold them. */
export async function transcriptFacets(
  db: D1Database,
  userId: string,
): Promise<TranscriptFacets> {
  const { results } = await db
    .prepare(
      `SELECT 'client' AS facet, client AS value, COUNT(*) AS count FROM transcripts WHERE user_id = ?1 GROUP BY client
       UNION ALL
       SELECT 'device', device, COUNT(*) FROM transcripts WHERE user_id = ?1 GROUP BY device
       UNION ALL
       SELECT 'project', project, COUNT(*) FROM transcripts WHERE user_id = ?1 AND project IS NOT NULL GROUP BY project
       ORDER BY 3 DESC, 2 LIMIT 300`,
    )
    .bind(userId)
    .all<{ facet: keyof TranscriptFacets; value: string; count: number }>();
  const facets: TranscriptFacets = { client: [], device: [], project: [] };
  for (const row of results)
    facets[row.facet].push({ value: row.value, count: row.count });
  return facets;
}

export async function readTranscriptTurnPage(
  db: D1Database,
  userId: string,
  transcriptId: string,
  offset: number,
  limit = 100,
): Promise<TranscriptTurn[] | null> {
  if ((await readTranscript(db, userId, transcriptId)) === null) return null;
  const { results } = await db
    .prepare(
      `SELECT position, kind, text, tool_name AS toolName, at, hash
       FROM transcript_turns WHERE transcript_id = ? ORDER BY position LIMIT ? OFFSET ?`,
    )
    .bind(transcriptId, limit, offset)
    .all<TranscriptTurn>();
  return results;
}

export async function transcriptState(
  db: D1Database,
  transcript: Transcript,
): Promise<TranscriptState> {
  return {
    transcriptId: transcript.transcriptId,
    turnCount: transcript.turnCount,
    chainHash: transcript.chainHash,
    hashes: await readHashes(
      db,
      transcript.transcriptId,
      0,
      transcript.turnCount,
    ),
  };
}

/** The session's turns as JSON lines, after a header line, for DuckDB. */
export function mirrorLines(
  transcript: Transcript,
  turns: readonly TranscriptTurn[],
): string {
  const header = {
    type: "transcript",
    transcript_id: transcript.transcriptId,
    client: transcript.client,
    device: transcript.device,
    session_id: transcript.sessionId,
    cwd: transcript.cwd,
    git_branch: transcript.gitBranch,
    project: transcript.project,
    model: transcript.model,
    title: transcript.title,
    turn_count: transcript.turnCount,
    first_at: transcript.firstAt,
    last_at: transcript.lastAt,
  };
  return [
    JSON.stringify(header),
    ...turns.map((turn) =>
      JSON.stringify({
        type: "turn",
        position: turn.position,
        kind: turn.kind,
        tool_name: turn.toolName,
        text: turn.text,
        at: turn.at,
        hash: turn.hash,
      }),
    ),
  ].join("\n");
}

export function mirrorKey(
  transcript: Pick<Transcript, "userId" | "client" | "device" | "sessionId">,
): string {
  return `transcripts/${transcript.userId}/${transcript.client}/${transcript.device}/${transcript.sessionId}.jsonl`;
}

/** Every turn, one line each, without positions: the whole session as text. */
export function transcriptText(turns: readonly TranscriptTurn[]): string {
  return turns.map(turnLine).join("\n");
}

function turnLine(turn: TranscriptTurn): string {
  switch (turn.kind) {
    case "human": {
      const event = harnessEvent(turn.text);
      if (event?.hidden) return "Event: (instructions to the model)";
      if (event)
        return `Event: ${event.label}${event.code ? ` ${event.code}` : ""}`;
      return `Human: ${turn.text}`;
    }
    case "assistant":
      return `Assistant: ${turn.text}`;
    case "thinking":
      return `Thinking: ${turn.text}`;
    case "system":
      return `System ${turn.toolName ?? "context"}: ${systemGist(turn.text)}`;
    case "tool_call":
      return `Tool ${turn.toolName ?? "?"}: ${turn.text}`;
    case "tool_error":
      return `Tool ${turn.toolName ?? "?"} failed: ${turn.text}`;
    case "api_error":
      return `API error: ${turn.text}`;
  }
}

/** Characters of a `system` turn a reader sees in `fetch`. */
export const SYSTEM_GIST_LENGTH = 300;

/*
 * A session carries tens of kilobytes of system prompt and instruction
 * files, the same in every session of a project. A reader of one session
 * gets where each came from and how it opens; the console and the R2 mirror
 * keep the whole text.
 */
function systemGist(text: string): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length > SYSTEM_GIST_LENGTH
    ? `${line.slice(0, SYSTEM_GIST_LENGTH)}… (${text.length} characters)`
    : line;
}

const SELECT_SQL = `SELECT transcript_id AS transcriptId, user_id AS userId, client, device,
  session_id AS sessionId, cwd, git_branch AS gitBranch, project, model, title,
  turn_count AS turnCount, chain_hash AS chainHash, first_at AS firstAt,
  last_at AS lastAt, source_agent AS sourceAgent, source_client AS sourceClient,
  created_at AS createdAt, updated_at AS updatedAt FROM transcripts`;

async function readHashes(
  db: D1Database,
  transcriptId: string,
  from: number,
  to: number,
): Promise<string[]> {
  if (to <= from) return [];
  const { results } = await db
    .prepare(
      `SELECT hash FROM transcript_turns
        WHERE transcript_id = ? AND position >= ? AND position < ?
        ORDER BY position`,
    )
    .bind(transcriptId, from, to)
    .all<{ hash: string }>();
  return results.map((row) => row.hash);
}

function titleOf(text: string): string {
  const line = text.trim().split("\n")[0].trim();
  return line.length > TITLE_LENGTH
    ? `${line.slice(0, TITLE_LENGTH - 1)}…`
    : line;
}

/** The turn's identity: its kind, tool and text, so a resend hashes the same. */
export async function turnHash(turn: TurnInput): Promise<string> {
  return sha256(JSON.stringify([turn.kind, turn.toolName ?? "", turn.text]));
}

async function chainHash(previous: string, hash: string): Promise<string> {
  return sha256(`${previous}\n${hash}`);
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

type Valid = Omit<AppendTranscript, "turns"> & { turns: TurnInput[] };

function validate(input: AppendTranscript): Valid {
  const client = text(input.client, "client", 64);
  const device = text(input.device, "device", 200);
  const sessionId = text(input.sessionId, "session_id", 200);
  if (!NAME.test(client)) {
    throw new TranscriptRefused(
      "client is a short lowercase name such as claude-code, codex or opencode.",
    );
  }
  if (!Number.isInteger(input.from) || input.from < 0) {
    throw new TranscriptRefused("from is the position of the first turn sent.");
  }
  if (!Array.isArray(input.turns) || input.turns.length === 0) {
    throw new TranscriptRefused("turns holds at least one turn.");
  }
  if (input.turns.length > MAX_TURNS_PER_WRITE) {
    throw new TranscriptRefused(
      `Send at most ${MAX_TURNS_PER_WRITE} turns per request.`,
    );
  }
  const encoder = new TextEncoder();
  const turns = input.turns.map((turn, index) => {
    if (!TURN_KINDS.includes(turn?.kind)) {
      throw new TranscriptRefused(
        `turns[${index}].kind is one of ${TURN_KINDS.join(", ")}.`,
      );
    }
    if (typeof turn.text !== "string") {
      throw new TranscriptRefused(`turns[${index}].text is a string.`);
    }
    if (encoder.encode(turn.text).byteLength > MAX_TURN_BYTES) {
      throw new TranscriptRefused(
        `turns[${index}].text is over ${MAX_TURN_BYTES} bytes; distil it.`,
      );
    }
    const toolName =
      turn.toolName === undefined || turn.toolName === null
        ? null
        : text(turn.toolName, `turns[${index}].tool_name`, 200);
    if (
      (turn.kind === "tool_call" || turn.kind === "tool_error") &&
      !toolName
    ) {
      throw new TranscriptRefused(
        `turns[${index}].tool_name names the tool of a ${turn.kind} turn.`,
      );
    }
    const at =
      turn.at === undefined || turn.at === null
        ? null
        : Number.isInteger(turn.at) && turn.at > 0
          ? turn.at
          : (() => {
              throw new TranscriptRefused(
                `turns[${index}].at is Unix seconds.`,
              );
            })();
    return { kind: turn.kind, text: turn.text, toolName, at };
  });
  return {
    client,
    device,
    sessionId,
    cwd: optional(input.cwd, "cwd", 1000),
    gitBranch: optional(input.gitBranch, "git_branch", 200),
    project: optional(input.project, "project", 200),
    model: optional(input.model, "model", 100),
    from: input.from,
    replace: input.replace === true,
    turns,
  };
}

function text(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new TranscriptRefused(`${field} is required.`);
  }
  if (value.length > max) {
    throw new TranscriptRefused(`${field} is at most ${max} characters.`);
  }
  return value.trim();
}

function optional(
  value: unknown,
  field: string,
  max: number,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  return text(value, field, max);
}
