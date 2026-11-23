import type { McpScope } from "~/auth/scopes";
import { MAX_RECALL_QUERY } from "~/search/recall";
import { bearerTenantStore, type TenantStore } from "~/store/tenant.server";

export const HOOK_CONFIG_PATH = "/config/hooks";
export const STARTUP_BRIEF_PATH = "/config/brief";
export const RECALL_PATH = "/config/recall";

type ConfigEnv = Parameters<typeof bearerTenantStore>[0];

/**
 * `GET /config/hooks`: the hook config document for the token's user, under
 * `config:read`. A plain endpoint rather than an MCP tool, because its only
 * caller is the hook script's background refresh, which holds a console-issued
 * bearer token and no MCP session. ADR-0004, 2026-10-17.
 */
export async function handleHookConfig(
  request: Request,
  env: ConfigEnv,
): Promise<Response> {
  const authorized = await authorizeConfigRead(request, env);
  if (authorized instanceof Response) return authorized;

  const { document, updatedAt } = await authorized.store.hooks.read();
  const headers = new Headers({
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  if (updatedAt !== null) {
    headers.set("last-modified", new Date(updatedAt * 1000).toUTCString());
  }
  return new Response(document, { status: 200, headers });
}

/**
 * `GET /config/brief`: the startup brief as plain text, under the same
 * `config:read` and fetched by the same background refresh. An empty body
 * means there is nothing to brief yet. The hook also calls it live at
 * `SessionStart` with `project` (from the working directory's git remote)
 * and `cwd`, and with `only=claimed` on resume and compaction, for the
 * claimed to-dos whose `worktree` ref holds `cwd`.
 */
export async function handleStartupBrief(
  request: Request,
  env: ConfigEnv,
): Promise<Response> {
  const authorized = await authorizeConfigRead(request, env);
  if (authorized instanceof Response) return authorized;

  const params = new URL(request.url).searchParams;
  const project = params.get("project")?.trim() || undefined;
  const cwd = params.get("cwd")?.trim() || undefined;
  const claimedOnly = params.get("only") === "claimed";
  if (
    (project && project.length > 200) ||
    (cwd && cwd.length > 1000) ||
    (claimedOnly && !cwd)
  ) {
    return new Response(JSON.stringify({ error: "invalid_request" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }

  return new Response(
    await authorized.store.startupBrief({ project, cwd, claimedOnly }),
    {
      status: 200,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        // A server that predates `only` answers the whole brief; the hook
        // injects claims only when this says they are what it got.
        ...(claimedOnly ? { "x-valise-brief": "claimed" } : {}),
      },
    },
  );
}

/**
 * `GET /config/recall?q=`: what the hook script injects after a failed
 * command, the memories, skills and to-dos that share most of the error's
 * words, as `{ hits }`. Under `search:read`, not `config:read`: it reads
 * whatever matches a caller-chosen query, which is search, so a token minted
 * with `config:read` alone still reads hook text and the brief and nothing
 * else, and the hook falls back to its plain line. ADR-0004, 2026-11-03.
 */
export async function handleRecall(
  request: Request,
  env: ConfigEnv,
): Promise<Response> {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  const authorized = await authorizeBearerStore(request, env, ["search:read"]);
  if (authorized instanceof Response) return authorized;
  const query = new URL(request.url).searchParams.get("q") ?? "";
  if (!query.trim() || query.length > MAX_RECALL_QUERY) {
    return new Response(JSON.stringify({ error: "invalid_query" }), {
      status: 400,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  }
  return new Response(
    JSON.stringify({ hits: await authorized.store.recall(query) }),
    {
      status: 200,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    },
  );
}

async function authorizeConfigRead(
  request: Request,
  env: ConfigEnv,
): Promise<{ store: TenantStore } | Response> {
  if (request.method !== "GET") {
    return new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  return authorizeBearerStore(request, env, ["config:read"]);
}

/**
 * A console-issued bearer token holding every scope named, for the plain
 * HTTP endpoints a script calls without an MCP session. The token's user is
 * the user; nothing in the request can name another.
 */
export async function authorizeBearer(
  request: Request,
  env: ConfigEnv,
  scopes: McpScope[],
): Promise<{ userId: string; tokenId: string } | Response> {
  const bound = await authorizeBearerStore(request, env, scopes);
  if (bound instanceof Response) return bound;
  return { userId: bound.provenance.userId, tokenId: bound.tokenId };
}

/**
 * The same check, answered with the token user's tenant store, so a handler
 * never holds an owner id. `door` labels writes made through the endpoint.
 */
export async function authorizeBearerStore(
  request: Request,
  env: ConfigEnv,
  scopes: McpScope[],
  door?: { agent: string; client: string },
) {
  const bound = await bearerTenantStore(env, request, scopes, door);
  if (!("refused" in bound)) return bound;
  if (bound.refused === "invalid_token")
    return challenge(401, 'Bearer error="invalid_token"', "invalid_token");
  return challenge(
    403,
    `Bearer error="insufficient_scope", scope="${bound.missing.join(" ")}"`,
    "insufficient_scope",
  );
}

function challenge(
  status: 401 | 403,
  wwwAuthenticate: string,
  error: string,
): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": wwwAuthenticate,
    },
  });
}
