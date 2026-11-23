import { mcpPrincipal } from "~/auth/principal";
import { TranscriptRefused } from "~/concepts/transcripts";
import { mcpTenantStore } from "~/store/tenant.server";

/**
 * `POST /mcp/transcripts`: the Valise CLI appends a session's distilled turns;
 * `GET /mcp/transcripts?client=&device=&session=`: what the server holds for a
 * session, so a writer can resume. Both sit behind the OAuth provider with
 * `/mcp`, so the CLI's grant and a console-minted bearer token both open
 * them; the grant needs `transcripts:write` to append and `transcripts:read`
 * to look. Plain JSON, not MCP: the writer is a program, not a model, and
 * ADR-0003 adds no tool without a user intent. ADR-0022.
 */

export const TRANSCRIPTS_PATH = "/mcp/transcripts";

/** A write with 500 turns of 64 KiB each is far larger than any session. */
const MAX_BODY_BYTES = 8 * 1024 * 1024;

type TranscriptsEnv = Parameters<typeof mcpTenantStore>[0];

export async function handleTranscripts(
  request: Request,
  env: TranscriptsEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  if (request.method !== "POST" && request.method !== "GET") {
    return answer(405, { error: "method_not_allowed" }, { allow: "GET, POST" });
  }
  const principal = mcpPrincipal(ctx);
  if (principal === null) {
    return answer(
      401,
      { error: "invalid_token" },
      { "www-authenticate": 'Bearer error="invalid_token"' },
    );
  }
  const scope =
    request.method === "POST" ? "transcripts:write" : "transcripts:read";
  if (!principal.scopes.includes(scope)) {
    return answer(
      403,
      { error: "insufficient_scope", scope },
      {
        "www-authenticate": `Bearer error="insufficient_scope", scope="${scope}"`,
      },
    );
  }
  const bound = await mcpTenantStore(env, ctx);
  if (bound === null) {
    return answer(
      401,
      { error: "invalid_token" },
      { "www-authenticate": 'Bearer error="invalid_token"' },
    );
  }
  const { transcripts } = bound.store;

  if (request.method === "GET") {
    const url = new URL(request.url);
    const client = url.searchParams.get("client") ?? "";
    const device = url.searchParams.get("device") ?? "";
    const session = url.searchParams.get("session") ?? "";
    if (!client || !device || !session) {
      return answer(400, {
        error: "invalid_request",
        message: "client, device and session name the session.",
      });
    }
    const state = await transcripts.state(client, device, session);
    if (state === null) return answer(404, { error: "not_found" });
    return answer(200, stateJson(state));
  }

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY_BYTES) return answer(413, { error: "too_large" });
  let body: Record<string, unknown>;
  try {
    const raw = await request.text();
    if (raw.length > MAX_BODY_BYTES) return answer(413, { error: "too_large" });
    body = JSON.parse(raw);
  } catch {
    return answer(400, { error: "invalid_json" });
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return answer(400, { error: "invalid_json" });
  }
  const turns = Array.isArray(body.turns) ? body.turns : [];
  try {
    const result = await transcripts.append({
      client: String(body.client ?? ""),
      device: String(body.device ?? ""),
      sessionId: String(body.session_id ?? ""),
      cwd: optionalString(body.cwd),
      gitBranch: optionalString(body.git_branch),
      project: optionalString(body.project),
      model: optionalString(body.model),
      from: typeof body.from === "number" ? body.from : Number.NaN,
      replace: body.replace === true,
      turns: turns.map((turn: Record<string, unknown>) => ({
        kind: turn?.kind as never,
        text: turn?.text as never,
        toolName: optionalString(turn?.tool_name),
        at: typeof turn?.at === "number" ? turn.at : null,
      })),
    });
    if (!result.ok) {
      return answer(409, {
        error: "conflict",
        message:
          result.conflict === null
            ? "This session has no turns yet; send from 0."
            : "The turns sent do not continue what is held; resend from the longest common prefix of hashes.",
        ...(result.conflict === null
          ? { turn_count: 0, chain_hash: "", hashes: [] }
          : stateJson(result.conflict)),
      });
    }
    return answer(200, {
      transcript_id: result.transcript.transcriptId,
      id: `transcript:${result.transcript.transcriptId}`,
      turn_count: result.transcript.turnCount,
      chain_hash: result.transcript.chainHash,
      appended: result.appended,
    });
  } catch (error) {
    if (error instanceof TranscriptRefused) {
      return answer(400, {
        error: "invalid_transcript",
        message: error.message,
      });
    }
    throw error;
  }
}

function stateJson(state: {
  transcriptId: string;
  turnCount: number;
  chainHash: string;
  hashes: string[];
}) {
  return {
    transcript_id: state.transcriptId,
    turn_count: state.turnCount,
    chain_hash: state.chainHash,
    hashes: state.hashes,
  };
}

function optionalString(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return typeof value === "string" ? value : String(value);
}

function answer(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...headers,
    },
  });
}
