import {
  type McpOutcome,
  type McpTransport,
  recordMcpCall,
} from "~/concepts/activity";

/**
 * One row per MCP request, from the one place every transport passes through.
 * ADR-0006.
 *
 * The outcome is read from the response rather than guessed at the call site,
 * because a tool error and a preflight rejection both answer 200 with an
 * `isError` result and only the body tells them apart. The body is read from a
 * clone inside `waitUntil`, so the caller's response is untouched and the row
 * costs no latency. A failed insert is logged and swallowed; observability
 * never fails a call.
 */

/**
 * The `_meta` key `search` reports its rerank stage under: backend, whether
 * the order is the reranker's, its latency, and why it fell back if it did.
 */
export const RERANK_META = "valise/rerank";

export type ObservedCall = {
  startedAt: number;
  transport: McpTransport;
  userId: string | null;
  /** OAuth client id, bearer token label, or the dev agent header. */
  principal: string | null;
  agent: string | null;
  client: string | null;
  session: string | null;
  httpMethod: string;
  limiterMethod: string;
  limiterName: string;
  /** Authenticated, bodyless GET offering SSE, without session/resume headers. */
  streamProbe: boolean;
  method: string;
  tool: string | null;
  requiredScope: string | null;
  args: unknown;
  /** What the agent says it is doing, if it said. ADR-0007. */
  intent: string | null;
  clientInfo: string | null;
  userAgent: string | null;
  sessionName: string | null;
  host: string | null;
  plugin: string | null;
};

export function observeCall(
  ctx: ExecutionContext,
  env: { DB: D1Database },
  call: ObservedCall,
  response: Response,
): Response {
  const inspected = response.clone();
  ctx.waitUntil(
    (async () => {
      const {
        outcome,
        errorCode,
        errorMessage,
        bytes,
        resultId,
        rerank,
        searchResultIds,
      } = await classify(response.status, inspected, call.streamProbe);
      await recordMcpCall(env, {
        at: call.startedAt,
        transport: call.transport,
        userId: call.userId,
        principal: call.principal,
        agent: call.agent,
        client: call.client,
        session: call.session,
        httpMethod: call.httpMethod,
        limiterMethod: call.limiterMethod,
        limiterName: call.limiterName,
        method: call.method,
        tool: call.tool,
        requiredScope: call.requiredScope,
        args: call.args,
        intent: call.intent,
        outcome,
        errorCode,
        errorMessage,
        status: response.status,
        durationMs: Date.now() - call.startedAt,
        resultBytes: bytes,
        clientInfo: call.clientInfo,
        userAgent: call.userAgent,
        sessionName: call.sessionName,
        host: call.host,
        plugin: call.plugin,
        targetId: targetId(call.tool, call.args, resultId),
        rerank,
        searchResultIds:
          call.tool === "search" && outcome === "ok" ? searchResultIds : null,
      });
    })(),
  );
  return response;
}

/** Tools whose `id` argument names the item they act on. */
const ID_ARGUMENT = new Set([
  "fetch",
  "edit_memory",
  "edit_subject",
  "claim_todo",
  "update_todo",
  "complete_todo",
  "comment_todo",
  "edit_todo_tags",
]);

/** Tools that answer with the id of the item they created or resolved. */
const ID_RESULT = new Set([
  "create_todo",
  "save_memory",
  "save_subject",
  "publish_skill",
  "get_skill",
]);

/**
 * The item a call acted on, read from named fields per tool rather than from
 * any string that looks like an id, so a body or a query that quotes an id is
 * never mistaken for the call's target.
 */
export function targetId(
  tool: string | null,
  args: unknown,
  resultId: string | null,
): string | null {
  if (tool === null) return null;
  if (ID_ARGUMENT.has(tool)) {
    const id =
      args && typeof args === "object"
        ? (args as Record<string, unknown>).id
        : null;
    return typeof id === "string" && id ? id.slice(0, 200) : null;
  }
  if (ID_RESULT.has(tool)) return resultId;
  return null;
}

type Classified = {
  outcome: McpOutcome;
  errorCode: string | null;
  errorMessage: string | null;
  bytes: number | null;
  /** `structuredContent.id` on a result that has one. */
  resultId: string | null;
  /** The rerank stage a `search` reports in `_meta`, as JSON. */
  rerank: string | null;
  searchResultIds?: string[];
};

async function classify(
  status: number,
  response: Response,
  streamProbe: boolean,
): Promise<Classified> {
  let raw = "";
  try {
    raw = await response.text();
  } catch {
    return {
      outcome: httpOutcome(status),
      errorCode: null,
      errorMessage: null,
      bytes: null,
      resultId: null,
      rerank: null,
    };
  }
  const bytes = raw.length;
  const payload = rpcPayload(raw);
  const result =
    payload && typeof payload === "object" && "result" in payload
      ? (payload.result as Record<string, unknown> | null)
      : null;

  // `rpcError` puts its code on `result.error`; the MCP SDK sets only `isError`.
  // Both put the reason in `result.content[].text`.
  const code = result && typeof result.error === "string" ? result.error : null;
  if (result && code !== null) {
    return {
      outcome: errorOutcome(code, status),
      errorCode: code,
      errorMessage: contentText(result) ?? stringField(result, "message"),
      bytes,
      resultId: null,
      rerank: null,
    };
  }
  if (result?.isError === true) {
    return {
      outcome: "tool_error",
      errorCode: null,
      errorMessage: contentText(result),
      bytes,
      resultId: null,
      rerank: null,
    };
  }
  // A JSON-RPC error answers `{ error: { code, message } }` with no result.
  const rpcError =
    payload && typeof payload.error === "object" && payload.error !== null
      ? (payload.error as Record<string, unknown>)
      : null;
  // Streamable HTTP permits 405 when the optional GET event stream is not
  // offered. Only accept the stateless SDK's exact refusal on a fresh probe;
  // POST errors, resumption failures, and other GET failures remain errors.
  if (
    streamProbe &&
    status === 405 &&
    rpcError?.code === -32000 &&
    rpcError.message === "Method not allowed."
  ) {
    return {
      outcome: "ok",
      errorCode: null,
      errorMessage: null,
      bytes,
      resultId: null,
      rerank: null,
    };
  }
  if (rpcError || status >= 400) {
    return {
      outcome: status >= 400 ? httpOutcome(status) : "protocol_error",
      errorCode: status === 429 ? "rate_limited" : null,
      errorMessage: rpcError
        ? stringField(rpcError, "message")
        : capped(raw.trim() || null),
      bytes,
      resultId: null,
      rerank: null,
    };
  }
  const structured =
    result && typeof result.structuredContent === "object"
      ? (result.structuredContent as Record<string, unknown> | null)
      : null;
  const id = structured?.id;
  const meta =
    result && typeof result._meta === "object"
      ? (result._meta as Record<string, unknown> | null)
      : null;
  const rerank = meta?.[RERANK_META];
  return {
    outcome: "ok",
    errorCode: null,
    errorMessage: null,
    bytes,
    resultId: typeof id === "string" && id ? id.slice(0, 200) : null,
    searchResultIds: deliveredSearchIds(structured?.results),
    rerank:
      rerank && typeof rerank === "object" ? JSON.stringify(rerank) : null,
  };
}

function deliveredSearchIds(results: unknown): string[] {
  if (!Array.isArray(results)) return [];
  return [
    ...new Set(
      results.slice(0, 10).flatMap((hit: unknown) => {
        if (typeof hit !== "object" || hit === null || !("id" in hit))
          return [];
        return typeof hit.id === "string" &&
          /^(memory|skill|todo):[^:\s]+$/.test(hit.id) &&
          hit.id.length <= 200
          ? [hit.id]
          : [];
      }),
    ),
  ];
}

/** 2KB says why a call failed; a longer body is a payload, not a reason. */
const MESSAGE_CAP = 2048;

function contentText(result: Record<string, unknown>): string | null {
  if (!Array.isArray(result.content)) return null;
  const text = result.content
    .map((part) =>
      part && typeof part === "object" && typeof part.text === "string"
        ? part.text
        : "",
    )
    .filter(Boolean)
    .join("\n");
  return capped(text || null);
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  return typeof value === "string" ? capped(value || null) : null;
}

function capped(text: string | null): string | null {
  return text && text.length > MESSAGE_CAP ? text.slice(0, MESSAGE_CAP) : text;
}

/** Both framings the handler answers in: bare JSON, or one SSE `data:` line. */
function rpcPayload(raw: string): Record<string, unknown> | null {
  const line = raw.startsWith("data:")
    ? raw
    : raw.split("\n").find((candidate) => candidate.startsWith("data:"));
  const text = line ? line.slice("data:".length).trim() : raw;
  try {
    const parsed = JSON.parse(text) as unknown;
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function errorOutcome(code: string, status: number): McpOutcome {
  if (code === "rate_limited") return "rate_limited";
  if (code === "insufficient_scope") return "insufficient_scope";
  if (code === "invalid_input") return "invalid_input";
  return httpOutcome(status);
}

/**
 * A 4xx from the transport is not a tool error. A client that sends the wrong
 * Accept header or unparseable JSON never reaches a tool, and calling that a
 * tool error buries the one thing the row is good for.
 */
function httpOutcome(status: number): McpOutcome {
  if (status === 401) return "unauthorized";
  if (status === 403) return "insufficient_scope";
  if (status === 429) return "rate_limited";
  if (status >= 400) return "protocol_error";
  return "ok";
}
