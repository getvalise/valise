import { mcpPrincipal, mcpProvenance } from "~/auth/principal";
import { runReportInput } from "~/concepts/hook-manifest";
import { type ObservedCall, observeCall } from "~/mcp/observe";
import { mcpTenantStore } from "~/store/tenant.server";

/**
 * The runner's two calls, ADR-0023 "Delivery": `GET /mcp/hooks/manifest`
 * answers the approved, enabled entries with signed file URLs, and
 * `POST /mcp/hooks/runs` takes one run report. Both sit behind the OAuth
 * provider beside `/mcp`, as `/mcp/transcripts` does, so a CLI grant or a
 * console-minted bearer opens them, and both need `hooks:exec`. Plain JSON,
 * not MCP: the caller is the runner, not a model, so neither is a tool.
 *
 * Unlike `/mcp/transcripts`, each call is recorded in `mcp_calls` through
 * `observeCall`, as method `hooks/manifest` or `hooks/runs`, so a machine
 * fetching approved code shows in the logs tab beside the agent that
 * proposed it.
 */

export const HOOKS_MANIFEST_PATH = "/mcp/hooks/manifest";
export const HOOKS_RUNS_PATH = "/mcp/hooks/runs";

/** A report is a few hundred bytes; 2 KiB of result plus room. */
const MAX_REPORT_BYTES = 16 * 1024;

type HooksEnv = Parameters<typeof mcpTenantStore>[0] & {
  APP_ORIGIN: string;
};

export function isHooksPath(pathname: string): boolean {
  return pathname === HOOKS_MANIFEST_PATH || pathname === HOOKS_RUNS_PATH;
}

export async function handleHooks(
  request: Request,
  env: HooksEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const startedAt = Date.now();
  const url = new URL(request.url);
  const manifest = url.pathname === HOOKS_MANIFEST_PATH;
  const method = manifest ? "hooks/manifest" : "hooks/runs";
  const principal = mcpPrincipal(ctx);
  const sessionHeaders = {
    session: header(request, "x-valise-session"),
    sessionName: header(request, "x-valise-session-name"),
  };
  const provenance = principal
    ? mcpProvenance(principal, sessionHeaders)
    : null;
  const call: ObservedCall = {
    startedAt,
    transport: principal?.kind ?? "oauth",
    userId: principal?.userId ?? null,
    principal: principal
      ? principal.kind === "bearer"
        ? principal.label
        : principal.clientId
      : null,
    agent: provenance?.agent ?? null,
    client: provenance?.client ?? null,
    session: provenance?.session ?? null,
    httpMethod: request.method,
    limiterMethod: method,
    limiterName: method,
    streamProbe: false,
    method,
    tool: null,
    requiredScope: "hooks:exec",
    args: {},
    intent: null,
    clientInfo: null,
    userAgent: header(request, "user-agent"),
    sessionName: sessionHeaders.sessionName,
    host: header(request, "x-valise-host"),
    plugin: header(request, "x-valise-plugin"),
  };
  const respond = (response: Response) => observeCall(ctx, env, call, response);

  const allowed = manifest ? "GET" : "POST";
  if (request.method !== allowed)
    return respond(
      answer(405, { error: "method_not_allowed" }, { allow: allowed }),
    );
  if (principal === null) return respond(invalidToken());
  if (!principal.scopes.includes("hooks:exec"))
    return respond(
      answer(
        403,
        { error: "insufficient_scope", scope: "hooks:exec" },
        {
          "www-authenticate":
            'Bearer error="insufficient_scope", scope="hooks:exec"',
        },
      ),
    );
  const bound = await mcpTenantStore(env, ctx, sessionHeaders);
  if (bound === null) return respond(invalidToken());
  const { runnables } = bound.store.hooks;

  if (manifest)
    return respond(answer(200, await runnables.manifest(env.APP_ORIGIN)));

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_REPORT_BYTES)
    return respond(answer(413, { error: "too_large" }));
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > MAX_REPORT_BYTES)
      return respond(answer(413, { error: "too_large" }));
    body = JSON.parse(raw);
  } catch {
    return respond(answer(400, { error: "invalid_json" }));
  }
  const parsed = runReportInput.safeParse(body);
  if (!parsed.success)
    return respond(
      answer(400, {
        error: "invalid_report",
        message: parsed.error.issues
          .map((issue) => `${issue.path.join(".") || "body"}: ${issue.message}`)
          .join("; "),
      }),
    );
  call.args = {
    name: parsed.data.name,
    version_hash: parsed.data.version_hash,
    outcome: parsed.data.outcome,
  };
  const recorded = await runnables.recordRun(parsed.data);
  if (!recorded.ok)
    return respond(
      answer(recorded.status, {
        error: recorded.status === 404 ? "not_found" : "invalid_report",
        message: recorded.message,
      }),
    );
  return respond(
    answer(200, { recorded: recorded.recorded, suspended: recorded.suspended }),
  );
}

function invalidToken(): Response {
  return answer(
    401,
    { error: "invalid_token" },
    { "www-authenticate": 'Bearer error="invalid_token"' },
  );
}

function header(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim();
  return value ? value.slice(0, 200) : null;
}

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
