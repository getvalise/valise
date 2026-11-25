import {
  spendStatement,
  trimSpendStatement,
  UNATTRIBUTED_ACCOUNT,
} from "~/concepts/spend";
import { OWNER_USER_ID } from "~/concepts/users";
import { trimEmbeddingUsageStatement } from "~/search/embedding-budget";

/**
 * The call log and the auth log. ADR-0006.
 *
 * Recording never fails a request: every write is wrapped, and a database that
 * refuses the row leaves the caller's response untouched. Reading is the
 * workbench's logs tab, which is why the aggregates are shaped as the page
 * reads them rather than as a generic query builder.
 *
 * Timestamps here are Unix milliseconds, unlike the rest of the schema.
 */

import { clientName } from "./agent-names";

export const MCP_OUTCOMES = [
  "ok",
  "tool_error",
  "invalid_input",
  "insufficient_scope",
  "rate_limited",
  "unauthorized",
  /** The client could not speak the transport: bad Accept header, bad JSON. */
  "protocol_error",
] as const;

export type McpOutcome = (typeof MCP_OUTCOMES)[number];

export type McpTransport = "oauth" | "bearer" | "loopback";

/** 8KB of arguments is a long tool call and a short page. ADR-0006. */
const ARGS_CAP = 8192;

/** The log holds thirty days; the auth trail holds ninety. */
const CALL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const AUTH_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** Runnable hook run reports, ADR-0023. */
const HOOK_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;

export type McpCallRecord = {
  at: number;
  transport: McpTransport;
  userId: string | null;
  principal: string | null;
  agent: string | null;
  client: string | null;
  session: string | null;
  httpMethod: string;
  /** Effective `mcp-method` limiter dimension, including its fallback. */
  limiterMethod: string;
  /** Effective `mcp-name` limiter dimension, including its fallback. */
  limiterName: string;
  method: string;
  tool: string | null;
  requiredScope: string | null;
  args: unknown;
  /** What the agent says it is doing, if it said. ADR-0007. */
  intent: string | null;
  outcome: McpOutcome;
  errorCode: string | null;
  /** Why a failed call failed, as the response said it. Capped at 2KB. */
  errorMessage: string | null;
  status: number;
  durationMs: number;
  resultBytes: number | null;
  clientInfo: string | null;
  userAgent: string | null;
  sessionName: string | null;
  host: string | null;
  plugin: string | null;
  /** The item the call acted on, `todo:…`, `memory:…` or `skill:…`. */
  targetId: string | null;
  /** What `search`'s rerank stage did, as JSON. Null when it did not run. */
  rerank: string | null;
  searchResultIds?: readonly string[] | null;
};

export type AuthEventKind =
  | "console_login"
  | "console_login_failed"
  | "console_logout"
  | "oauth_grant"
  | "oauth_denied";

export type AuthEventRecord = {
  kind: AuthEventKind;
  userId?: string | null;
  subject?: string | null;
  detail?: string | null;
};

export async function recordMcpCall(
  env: { DB: D1Database },
  record: McpCallRecord,
): Promise<void> {
  const serialized = serializeArgs(record.args);
  try {
    const insert = env.DB.prepare(
      `INSERT INTO mcp_calls (
          call_id, at, transport, user_id, principal, agent, client, session, http_method,
          limiter_method, limiter_name, method, tool, required_scope, args_json, args_bytes, intent,
          outcome, error_code, error_message, status, duration_ms,
          result_bytes, client_info, user_agent, session_name, host, plugin,
          target_id, rerank_json, search_result_ids_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                  ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      `cal_${crypto.randomUUID()}`,
      record.at,
      record.transport,
      record.userId,
      record.principal,
      record.agent,
      record.client,
      record.session,
      record.httpMethod,
      record.limiterMethod,
      record.limiterName,
      record.method,
      record.tool,
      record.requiredScope,
      serialized.text,
      serialized.bytes,
      record.intent,
      record.outcome,
      record.errorCode,
      record.errorMessage,
      record.status,
      record.durationMs,
      record.resultBytes,
      record.clientInfo,
      record.userAgent,
      record.sessionName,
      record.host,
      record.plugin,
      record.targetId,
      record.rerank,
      record.searchResultIds ? JSON.stringify(record.searchResultIds) : null,
    );
    // The request-load proxy on the spend view, counted with the row so the
    // view never scans mcp_calls. docs/design/spend.md.
    await env.DB.batch([
      insert,
      spendStatement(
        env.DB,
        record.userId ?? UNATTRIBUTED_ACCOUNT,
        "mcp_requests",
        { units: 1, microusd: 0 },
      ),
    ]);
  } catch (error) {
    console.error("mcp_calls insert failed", error);
  }
}

export async function recordAuthEvent(
  env: { DB: D1Database },
  request: Request,
  record: AuthEventRecord,
): Promise<void> {
  try {
    await env.DB.prepare(
      `INSERT INTO auth_events (
          event_id, at, kind, user_id, subject, detail, ip, user_agent
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        `aev_${crypto.randomUUID()}`,
        Date.now(),
        record.kind,
        record.userId ?? null,
        record.subject ?? null,
        record.detail ?? null,
        request.headers.get("cf-connecting-ip"),
        request.headers.get("user-agent")?.slice(0, 300) ?? null,
      )
      .run();
  } catch (error) {
    console.error("auth_events insert failed", error);
  }
}

/** The nightly cron's whole job. Returns what it removed, for the log line. */
export async function trimActivity(
  env: { DB: D1Database },
  now = Date.now(),
): Promise<{
  calls: number;
  authEvents: number;
  sessions: number;
  embeddingUsage: number;
  hookRuns: number;
}> {
  const [calls, authEvents, sessions, embeddingUsage, _spend, hookRuns] =
    await env.DB.batch<unknown>([
      env.DB.prepare("DELETE FROM mcp_calls WHERE at < ?").bind(
        now - CALL_RETENTION_MS,
      ),
      env.DB.prepare("DELETE FROM auth_events WHERE at < ?").bind(
        now - AUTH_RETENTION_MS,
      ),
      env.DB.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(
        Math.floor(now / 1000),
      ),
      trimEmbeddingUsageStatement(env.DB),
      trimSpendStatement(env.DB),
      env.DB.prepare("DELETE FROM hook_runs WHERE started_at < ?").bind(
        Math.floor((now - HOOK_RUN_RETENTION_MS) / 1000),
      ),
    ]);
  return {
    calls: calls.meta.changes ?? 0,
    authEvents: authEvents.meta.changes ?? 0,
    sessions: sessions.meta.changes ?? 0,
    embeddingUsage: embeddingUsage.meta.changes ?? 0,
    hookRuns: hookRuns.meta.changes ?? 0,
  };
}

// --- reading ----------------------------------------------------------------

/**
 * The columns a click in the logs pane can filter on, keyed by the query
 * parameter that carries each. Columns only: a field inside `args_json` is
 * reachable through `target`, which is the one payload field worth a filter.
 */
export const CALL_FIELDS = {
  agent: "agent",
  principal: "principal",
  transport: "transport",
  session: "session",
  name: "session_name",
  host: "host",
  plugin: "plugin",
  target: "target_id",
  info: "client_info",
  ua: "user_agent",
} as const;

export type CallField = keyof typeof CALL_FIELDS;

export const CALL_FIELD_NAMES = Object.keys(CALL_FIELDS) as CallField[];

export type ActivityFilters = {
  /** Hours back from now. The page offers 24, 168, and 720. */
  windowHours: number;
  tool: string | null;
  client: string | null;
  outcome: McpOutcome | null;
  /** One exact value per column, ANDed with each other and the rest. */
  fields: Partial<Record<CallField, string>>;
  /** Only calls that did not come back `ok`. */
  errorsOnly: boolean;
  /** Only calls that said why. ADR-0007. */
  intentOnly: boolean;
  /** Include the listings and discovery a client sends on every connect. */
  handshakes: boolean;
};

export type CallRow = {
  callId: string;
  at: number;
  transport: McpTransport;
  principal: string | null;
  agent: string | null;
  client: string | null;
  session: string | null;
  /** Null when the request predates HTTP method recording. */
  httpMethod: string | null;
  /** Null on rows written before limiter dimensions were recorded. */
  limiterMethod: string | null;
  /** Null on rows written before limiter dimensions were recorded. */
  limiterName: string | null;
  method: string;
  tool: string | null;
  requiredScope: string | null;
  argsJson: string | null;
  argsBytes: number | null;
  intent: string | null;
  outcome: McpOutcome;
  errorCode: string | null;
  /** Why a failed call failed, as the response said it. Capped at 2KB. */
  errorMessage: string | null;
  status: number;
  durationMs: number;
  resultBytes: number | null;
  clientInfo: string | null;
  userAgent: string | null;
  sessionName: string | null;
  host: string | null;
  plugin: string | null;
  /** The item the call acted on. Null when it acted on none. */
  targetId: string | null;
  /** `search`'s rerank stage as JSON, `RerankOutcome`. Null when none ran. */
  rerankJson: string | null;
};

export type ToolUsageRow = {
  tool: string;
  calls: number;
  errors: number;
  avgMs: number;
  slowestMs: number;
  avgArgsBytes: number;
};

export type ClientUsageRow = {
  client: string;
  agent: string;
  transport: McpTransport;
  calls: number;
  errors: number;
  lastSeen: number;
};

export type AuthEventRow = {
  eventId: string;
  at: number;
  kind: AuthEventKind;
  userId: string | null;
  subject: string | null;
  detail: string | null;
  ip: string | null;
  userAgent: string | null;
};

export type Activity = {
  filters: ActivityFilters;
  since: number;
  totals: { calls: number; errors: number; clients: number; tools: number };
  outcomes: { outcome: McpOutcome; calls: number }[];
  logins: AuthEventRow[];
  /** Every tool and client seen in the window, for the filter selects. */
  knownTools: string[];
  knownClients: string[];
};

const RECENT_CALL_LIMIT = 120;
const RECENT_LOGIN_LIMIT = 25;

export function parseActivityFilters(url: URL): ActivityFilters {
  const outcome = url.searchParams.get("outcome");
  return {
    windowHours: windowHours(url.searchParams.get("window")),
    tool: trimmed(url.searchParams.get("tool")),
    client: trimmed(url.searchParams.get("client")),
    outcome: isOutcome(outcome) ? outcome : null,
    fields: Object.fromEntries(
      CALL_FIELD_NAMES.flatMap((field) => {
        const value = trimmed(url.searchParams.get(field));
        return value ? [[field, value]] : [];
      }),
    ),
    errorsOnly: url.searchParams.get("errors") === "1",
    intentOnly: url.searchParams.get("intent") === "1",
    handshakes: url.searchParams.get("handshakes") === "1",
  };
}

/** Calls newest first. The runs view groups these; a test reads them flat. */
export async function readCalls(
  env: { DB: D1Database },
  userId: string,
  filters: ActivityFilters,
): Promise<CallRow[]> {
  const since = Date.now() - filters.windowHours * 60 * 60 * 1000;
  const { clause, bindings } = callPredicate(userId, filters, since);
  const { results } = await env.DB.prepare(
    `SELECT ${CALL_COLUMNS} FROM mcp_calls
      WHERE ${clause}
      ORDER BY at DESC LIMIT ${RECENT_CALL_LIMIT}`,
  )
    .bind(...bindings)
    .all<CallRow>();
  return results;
}

/**
 * One call by id, whatever the filters say. A link to a call has to open it
 * after the window has moved past it or the filters have changed.
 */
export async function readCall(
  env: { DB: D1Database },
  userId: string,
  callId: string,
): Promise<CallRow | null> {
  return env.DB.prepare(
    `SELECT ${CALL_COLUMNS} FROM mcp_calls WHERE call_id = ? AND user_id = ?`,
  )
    .bind(callId, userId)
    .first<CallRow>();
}

/** Every column of `mcp_calls`, under the names `CallRow` reads them by. */
const CALL_COLUMNS = `call_id AS callId, at, transport, principal, agent,
  client, session, http_method AS httpMethod,
  limiter_method AS limiterMethod, limiter_name AS limiterName,
  method, tool, required_scope AS requiredScope,
  args_json AS argsJson, args_bytes AS argsBytes, intent, outcome,
  error_code AS errorCode, error_message AS errorMessage, status,
  duration_ms AS durationMs, result_bytes AS resultBytes,
  client_info AS clientInfo, user_agent AS userAgent,
  session_name AS sessionName, host, plugin, target_id AS targetId,
  rerank_json AS rerankJson`;

export async function readActivity(
  env: { DB: D1Database },
  userId: string,
  filters: ActivityFilters,
): Promise<Activity> {
  const since = Date.now() - filters.windowHours * 60 * 60 * 1000;
  const { clause, bindings } = callPredicate(userId, filters, since);

  const [totals, outcomes, logins, known] = await env.DB.batch<
    Record<string, never>
  >([
    env.DB.prepare(
      `SELECT COUNT(*) AS calls,
              SUM(CASE WHEN outcome <> 'ok' THEN 1 ELSE 0 END) AS errors,
              COUNT(DISTINCT client) AS clients,
              COUNT(DISTINCT tool) AS tools
         FROM mcp_calls WHERE ${clause}`,
    ).bind(...bindings),
    env.DB.prepare(
      `SELECT outcome, COUNT(*) AS calls FROM mcp_calls
        WHERE ${clause} GROUP BY outcome ORDER BY calls DESC`,
    ).bind(...bindings),
    // A refused sign-in has no user. The owner is the one who acts on it,
    // so it shows on the owner's tab only; a member would see a stranger's
    // email and nothing of theirs. ADR-0016.
    env.DB.prepare(
      `SELECT event_id AS eventId, at, kind, user_id AS userId, subject,
              detail, ip, user_agent AS userAgent
         FROM auth_events WHERE user_id = ? OR (user_id IS NULL AND ? = ?)
        ORDER BY at DESC LIMIT ${RECENT_LOGIN_LIMIT}`,
    ).bind(userId, userId, OWNER_USER_ID),
    env.DB.prepare(
      `SELECT DISTINCT tool, client FROM mcp_calls WHERE user_id = ? AND at >= ?`,
    ).bind(userId, since),
  ]);

  const totalsRow = rows<{
    calls: number;
    errors: number | null;
    clients: number;
    tools: number;
  }>(totals)[0];

  const knownRows = rows<{ tool: string | null; client: string | null }>(known);

  return {
    filters,
    since,
    totals: {
      calls: totalsRow?.calls ?? 0,
      errors: totalsRow?.errors ?? 0,
      clients: totalsRow?.clients ?? 0,
      tools: totalsRow?.tools ?? 0,
    },
    outcomes: rows<{ outcome: McpOutcome; calls: number }>(outcomes),
    logins: rows<AuthEventRow>(logins),
    knownTools: distinct(knownRows.map((row) => row.tool)),
    knownClients: distinct(knownRows.map((row) => row.client)),
  };
}

/**
 * What a client sends on every connect and every reconnect, before and between
 * any work: discovery, listings, notifications. On production it is most of
 * the table, and left in it buries the tool calls and glues a session's quiet
 * stretches into one run. A handshake that failed is not chatter and stays.
 * `initialize` stays too, because it names the caller.
 */
const HANDSHAKE = `(outcome = 'ok' AND (method IN ('server/discover', 'tools/list',
  'resources/list', 'resources/templates/list', 'prompts/list', 'ping')
  OR method LIKE 'notifications/%'
  OR (http_method = 'GET' AND method = 'GET' AND status = 405)))`;

/** Only the observer's confirmed optional stream refusal is stored as ok/405. */
export function isStreamProbe(call: CallRow): boolean {
  return (
    call.httpMethod === "GET" &&
    call.method === "GET" &&
    call.status === 405 &&
    call.outcome === "ok"
  );
}

function callPredicate(
  userId: string,
  filters: ActivityFilters,
  since: number,
): { clause: string; bindings: unknown[] } {
  // A call refused before any principal was verified has no user. The
  // owner sees those, as with refused sign-ins; a member sees only theirs.
  const parts = ["(user_id = ? OR (user_id IS NULL AND ? = ?))", "at >= ?"];
  const bindings: unknown[] = [userId, userId, OWNER_USER_ID, since];
  if (filters.tool) {
    parts.push("tool = ?");
    bindings.push(filters.tool);
  }
  if (filters.client) {
    parts.push("client = ?");
    bindings.push(filters.client);
  }
  for (const field of CALL_FIELD_NAMES) {
    const value = filters.fields[field];
    if (!value) continue;
    // The column comes from the fixed map above, never from the URL.
    parts.push(`${CALL_FIELDS[field]} = ?`);
    bindings.push(value);
  }
  if (filters.outcome) {
    parts.push("outcome = ?");
    bindings.push(filters.outcome);
  } else if (filters.errorsOnly) {
    parts.push("outcome <> 'ok'");
  }
  if (filters.intentOnly) parts.push("intent IS NOT NULL");
  if (!filters.handshakes) parts.push(`NOT ${HANDSHAKE}`);
  return { clause: parts.join(" AND "), bindings };
}

function serializeArgs(args: unknown): { text: string | null; bytes: number } {
  if (args === undefined || args === null) return { text: null, bytes: 0 };
  let text: string;
  try {
    text = JSON.stringify(args) ?? "";
  } catch {
    return { text: null, bytes: 0 };
  }
  return {
    bytes: text.length,
    text: text.length > ARGS_CAP ? text.slice(0, ARGS_CAP) : text,
  };
}

function rows<T>(result: D1Result<unknown>): T[] {
  return (result.results ?? []) as T[];
}

function distinct(values: (string | null)[]): string[] {
  return [
    ...new Set(values.filter((value): value is string => !!value)),
  ].sort();
}

function windowHours(value: string | null): number {
  const hours = Number(value);
  return hours === 168 || hours === 720 ? hours : 24;
}

function isOutcome(value: string | null): value is McpOutcome {
  return (MCP_OUTCOMES as readonly string[]).includes(value ?? "");
}

function trimmed(value: string | null): string | null {
  return value?.trim() ? value.trim() : null;
}

/* ---------------------------------------------------------------- runs --- */

/**
 * A run is consecutive calls from one agent and client with no idle gap longer
 * than this. It is a heuristic standing in for a user turn, which Valise
 * cannot see: SEP-2817's `turnId` is the field designed to carry one and no
 * client sends it, and `session` holds a bearer token id rather than a
 * conversation. ADR-0006.
 */
const RUN_GAP_MS = 10 * 60 * 1000;

/** How many runs the page shows. The calls of exactly these runs are read. */
const RUN_LIMIT = 25;

export const RUN_SORTS = ["recent", "longest", "errors"] as const;
export type RunSort = (typeof RUN_SORTS)[number];

export function isRunSort(value: string | null): value is RunSort {
  return RUN_SORTS.includes(value as RunSort);
}

export type Run = {
  /** Stable for one read, not across reads. A React key and nothing else. */
  runId: string;
  agent: string | null;
  client: string | null;
  /** The plugin's session id, null for a client without the plugin. */
  session: string | null;
  sessionName: string | null;
  host: string | null;
  plugin: string | null;
  transport: McpTransport;
  startedAt: number;
  /** The run's latest call, which is what "newest" means for a live run. */
  lastAt: number;
  /** First call to last call. What a person would call the duration. */
  spanMs: number;
  /** Summed per-call server time. Excludes everything the model spent. */
  serverMs: number;
  calls: CallRow[];
  tools: number;
  errors: number;
  /**
   * Who ran it, in the name they call themselves. An OAuth client's `agent` is
   * its registration URL, so the console would otherwise head every production
   * row with `https://claude.ai/oauth/claude-code-client-metadata`.
   */
  caller: string;
  /** The first reason any call in the run gave. ADR-0007. */
  intent: string | null;
  /** A tool failed, then the same tool answered later in this run. */
  recovered: boolean;
  /** One tool was called twice with byte-identical arguments. */
  repeated: boolean;
};

type RunCallRow = CallRow & { runNo: number };

/**
 * The calls of the top runs, rather than the top calls grouped afterwards.
 * Capping on calls and grouping after it leaves the oldest run cut in half,
 * and half a run reports a wrong duration and a wrong error count.
 */
export async function readRuns(
  env: { DB: D1Database },
  userId: string,
  filters: ActivityFilters,
  sort: RunSort,
): Promise<Run[]> {
  const since = Date.now() - filters.windowHours * 60 * 60 * 1000;
  const { clause, bindings } = callPredicate(userId, filters, since);
  const order: Record<RunSort, string> = {
    recent: "last DESC",
    longest: "span DESC",
    errors: "errors DESC, started DESC",
  };

  const { results } = await env.DB.prepare(
    `WITH windowed AS (
       SELECT ${CALL_COLUMNS} FROM mcp_calls WHERE ${clause}
     ),
     marked AS (
       SELECT *,
              CASE WHEN at - LAG(at) OVER caller > ? THEN 1 ELSE 0 END AS breaks
         FROM windowed
       WINDOW caller AS (PARTITION BY agent, client, session ORDER BY at)
     ),
     numbered AS (
       SELECT *,
              SUM(breaks) OVER (PARTITION BY agent, client, session ORDER BY at
                ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) AS runNo
         FROM marked
     ),
     runs AS (
       SELECT agent, client, session, runNo,
              MIN(at) AS started,
              MAX(at) AS last,
              MAX(at) - MIN(at) AS span,
              SUM(CASE WHEN outcome <> 'ok' THEN 1 ELSE 0 END) AS errors
         FROM numbered
        GROUP BY agent, client, session, runNo
        ORDER BY ${order[sort]}
        LIMIT ${RUN_LIMIT}
     )
     SELECT n.*
       FROM numbered n
       JOIN runs r
         ON n.agent IS r.agent AND n.client IS r.client
        AND n.session IS r.session AND n.runNo = r.runNo
      ORDER BY n.at ASC`,
  )
    .bind(...bindings, RUN_GAP_MS)
    .all<RunCallRow>();

  return groupRuns(results, sort);
}

/**
 * Both badges are derived from the calls rather than asserted by anything. A
 * model's account of its own run is not evidence; a failure followed by a
 * success on the same tool is.
 */
export function groupRuns(rows: RunCallRow[], sort: RunSort): Run[] {
  const byRun = new Map<string, Run>();
  for (const row of rows) {
    const runId = JSON.stringify([
      row.agent,
      row.client,
      row.session,
      row.runNo,
    ]);
    const run = byRun.get(runId);
    if (run === undefined) {
      byRun.set(runId, {
        runId,
        agent: row.agent,
        client: row.client,
        session: row.session,
        sessionName: row.sessionName,
        host: row.host,
        plugin: row.plugin,
        transport: row.transport,
        startedAt: row.at,
        lastAt: row.at,
        spanMs: 0,
        serverMs: row.durationMs,
        calls: [row],
        tools: 0,
        errors: row.outcome === "ok" ? 0 : 1,
        caller: "",
        intent: row.intent,
        recovered: false,
        repeated: false,
      });
      continue;
    }
    run.calls.push(row);
    run.serverMs += row.durationMs;
    run.lastAt = row.at;
    run.spanMs = row.at - run.startedAt;
    if (row.outcome !== "ok") run.errors += 1;
    run.intent ??= row.intent;
    run.sessionName ??= row.sessionName;
    run.host ??= row.host;
    run.plugin ??= row.plugin;
  }

  for (const run of byRun.values()) {
    run.caller = callerName(run.calls, run.agent);
    run.tools = new Set(
      run.calls
        .map((call) => call.tool)
        .filter((tool): tool is string => tool !== null),
    ).size;
    run.recovered = recovered(run.calls);
    run.repeated = repeated(run.calls);
  }

  const runs = [...byRun.values()];
  if (sort === "longest") runs.sort((a, b) => b.spanMs - a.spanMs);
  else if (sort === "errors") {
    runs.sort((a, b) => b.errors - a.errors || b.startedAt - a.startedAt);
  } else runs.sort((a, b) => b.lastAt - a.lastAt);
  return runs;
}

/**
 * The name a caller gives for itself, best first.
 *
 * `clientInfo` is the only name a client states rather than one derived from
 * how it authenticated. Every row carries it now; rows from before that carry
 * it only on an `initialize`. Failing both, an OAuth `agent` is a registration
 * URL, and the last path segment of one is the readable part.
 */
function callerName(calls: CallRow[], agent: string | null): string {
  const stated = calls.find((call) => call.clientInfo !== null)?.clientInfo;
  if (stated) return stated;
  for (const call of calls) {
    if (call.method !== "initialize" || call.argsJson === null) continue;
    const info = clientInfo(call.argsJson);
    if (info !== null) return info;
  }
  return clientName(agent);
}

function clientInfo(argsJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(argsJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const info = (parsed as { clientInfo?: unknown }).clientInfo;
  if (typeof info !== "object" || info === null) return null;
  const { name, version } = info as { name?: unknown; version?: unknown };
  if (typeof name !== "string" || name.trim() === "") return null;
  return typeof version === "string" ? `${name} ${version}` : name;
}

/** A tool that failed and then answered, which is the repair loop working. */
function recovered(calls: CallRow[]): boolean {
  const failed = new Set<string>();
  for (const call of calls) {
    if (call.tool === null) continue;
    if (call.outcome === "ok") {
      if (failed.has(call.tool)) return true;
    } else {
      failed.add(call.tool);
    }
  }
  return false;
}

/** The same question asked twice. Cheap to spot and worth seeing. */
function repeated(calls: CallRow[]): boolean {
  const seen = new Set<string>();
  for (const call of calls) {
    if (call.tool === null || call.argsJson === null) continue;
    const key = JSON.stringify([call.tool, call.argsJson]);
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

/* ------------------------------------------------------------ sessions --- */

/** The connections page shows what used each connection in the last week. */
const SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export type ClientSession = {
  transport: McpTransport;
  /** Joins to a connection: an OAuth client id or a bearer token label. */
  principal: string | null;
  /** The plugin's session id, or the bearer token id; null without either. */
  session: string | null;
  sessionName: string | null;
  host: string | null;
  clientInfo: string | null;
  userAgent: string | null;
  plugin: string | null;
  lastSeen: number;
  toolCalls: number;
};

/**
 * One row per session that called in the window, newest first. A client
 * without the plugin sends no session, so its calls group by its user agent,
 * which carries the version, and by `clientInfo` only when it sends no user
 * agent either. Codex names itself on `initialize` and never again, so
 * `clientInfo` is the latest one the group sent rather than the latest
 * call's. Every other descriptive column is read from the session's latest
 * call: SQLite takes bare columns from the row that `MAX(at)` picked.
 * Aggregate named calls once and join by session, rather than sorting the
 * weekly call set again for every group. The shared CTE excludes payloads.
 */
export async function readClientSessions(
  env: { DB: D1Database },
  userId: string,
  now = Date.now(),
): Promise<ClientSession[]> {
  const { results } = await env.DB.prepare(
    `WITH recent AS (
        SELECT transport, principal, session, session_name, host, client_info,
               user_agent, plugin, at, method,
               COALESCE(session, user_agent, client_info) AS grouping
          FROM mcp_calls
         WHERE user_id = ? AND at >= ?
      ),
      named AS (
        SELECT transport, principal, grouping, client_info, MAX(at) AS named_at
          FROM recent WHERE client_info IS NOT NULL
         GROUP BY transport, principal, grouping
      ),
      sessions AS (
        SELECT transport, principal, grouping, session, session_name, host,
               user_agent, plugin, MAX(at) AS lastSeen,
               SUM(CASE WHEN method = 'tools/call' THEN 1 ELSE 0 END) AS toolCalls
          FROM recent GROUP BY transport, principal, grouping
      )
      SELECT s.transport, s.principal, s.session, s.session_name AS sessionName,
             s.host, named.client_info AS clientInfo,
             s.user_agent AS userAgent, s.plugin, s.lastSeen, s.toolCalls
        FROM sessions s LEFT JOIN named
          ON named.transport = s.transport AND named.principal IS s.principal
         AND named.grouping IS s.grouping
       ORDER BY s.lastSeen DESC`,
  )
    .bind(userId, now - SESSION_WINDOW_MS)
    .all<ClientSession>();
  return results;
}

/**
 * Whether this session already completed a to-do, read from the call log, so
 * the server-side capture nudge goes out once per session.
 */
export async function completedTodoInSession(
  db: D1Database,
  userId: string,
  session: string,
): Promise<boolean> {
  const row = await db
    .prepare(
      `SELECT 1 FROM mcp_calls
        WHERE tool = 'complete_todo' AND outcome = 'ok'
          AND session = ? AND user_id = ?
        LIMIT 1`,
    )
    .bind(session, userId)
    .first();
  return row !== null;
}
