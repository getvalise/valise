import { createMcpHandler } from "agents/mcp/server";
import {
  type McpPrincipal,
  mcpPrincipal,
  mcpProvenance,
} from "~/auth/principal";
import type { McpScope } from "~/auth/scopes";
import { serverInstructions } from "~/concepts/hook-config";
import type { Provenance } from "~/concepts/memories";
import { parseAssetUri } from "~/mcp/asset-tools";
import { parseAttachmentUri } from "~/mcp/attachment-resources";
import {
  claimTodoInput,
  commentTodoInput,
  completeTodoInput,
  createTodoInput,
  editHookInput,
  editMemoryInput,
  editSubjectInput,
  editTodoTagsInput,
  fetchInput,
  getAssetDownloadInput,
  getBriefInput,
  getSkillInput,
  listHooksInput,
  listMemoriesInput,
  listReadyInput,
  listSkillsInput,
  listSourcesInput,
  listSubjectsInput,
  listTodosInput,
  proposeHookInput,
  publishSkillInput,
  readSkillFileInput,
  saveMemoryInput,
  saveSourceInput,
  saveSubjectInput,
  searchInput,
  skillToolInput,
  updateAssetInput,
  updateTodoInput,
  uploadAssetInput,
} from "~/mcp/contracts";
import { type ObservedCall, observeCall } from "~/mcp/observe";
import { createServer, SKILL_TOOL_PREFIX } from "~/mcp/tools";
import {
  loopbackTenantStore,
  mcpTenantStore,
  type TenantStore,
} from "~/store/tenant.server";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

type McpEnv = {
  APP_ORIGIN: string;
  MCP_RESOURCE_URL: string;
  DB: D1Database;
  BUNDLES: R2Bucket;
  MCP_LIMITER?: RateLimit;
  TODO_COORDINATOR: DurableObjectNamespace<
    import("~/do/todo-coordinator").TodoCoordinator
  >;
};

type RpcEnvelope = {
  id?: string | number | null;
  method?: unknown;
  params?: {
    name?: unknown;
    arguments?: unknown;
    uri?: unknown;
    _meta?: unknown;
  };
};

/**
 * SEP-2817 puts an invocation reason in request `_meta` rather than in a tool
 * schema, which is where it belongs: an audit field in an argument list looks
 * like business input. The SEP is draft and nothing ships it yet, so this is
 * read first and finds nothing, and the `why` argument can be deleted rather
 * than migrated when it lands. ADR-0007.
 */
const SEP_2817_KEY = "io.modelcontextprotocol/aiInvocation";
const CLIENT_INFO_KEY = "io.modelcontextprotocol/clientInfo";

/** Longer than any session id, host, or version a client has reason to send. */
const HEADER_CAP = 200;

const toolRequirements = {
  search: { schema: searchInput, scope: "search:read" },
  fetch: { schema: fetchInput, scope: "search:read" },
  create_todo: { schema: createTodoInput, scope: "todos:write" },
  list_ready: { schema: listReadyInput, scope: "todos:read" },
  list_todos: { schema: listTodosInput, scope: "todos:read" },
  get_brief: { schema: getBriefInput, scope: "search:read" },
  claim_todo: { schema: claimTodoInput, scope: "todos:write" },
  update_todo: { schema: updateTodoInput, scope: "todos:write" },
  complete_todo: { schema: completeTodoInput, scope: "todos:write" },
  comment_todo: { schema: commentTodoInput, scope: "todos:write" },
  edit_todo_tags: { schema: editTodoTagsInput, scope: "todos:write" },
  save_memory: { schema: saveMemoryInput, scope: "memories:write" },
  edit_memory: { schema: editMemoryInput, scope: "memories:write" },
  list_memories: { schema: listMemoriesInput, scope: "memories:read" },
  list_subjects: { schema: listSubjectsInput, scope: "memories:read" },
  save_subject: { schema: saveSubjectInput, scope: "memories:write" },
  edit_subject: { schema: editSubjectInput, scope: "memories:write" },
  list_skills: { schema: listSkillsInput, scope: "skills:read" },
  get_skill: { schema: getSkillInput, scope: "skills:read" },
  read_skill_file: { schema: readSkillFileInput, scope: "skills:read" },
  publish_skill: { schema: publishSkillInput, scope: "skills:write" },
  list_hooks: { schema: listHooksInput, scope: "config:read" },
  edit_hook: { schema: editHookInput, scope: "config:write" },
  propose_hook: { schema: proposeHookInput, scope: "config:write" },
  upload_asset: { schema: uploadAssetInput, scope: "assets:write" },
  update_asset: { schema: updateAssetInput, scope: "assets:write" },
  get_asset_download: { schema: getAssetDownloadInput, scope: "assets:read" },
  save_source: { schema: saveSourceInput, scope: "sources:write" },
  list_sources: { schema: listSourcesInput, scope: "sources:read" },
} as const satisfies Record<
  string,
  {
    schema: {
      safeParse(value: unknown): { success: boolean; error?: unknown };
    };
    scope: McpScope;
  }
>;

/**
 * Every skill is also served as its own tool, `skill_{name}`, so its
 * requirement is derived from the prefix rather than listed one by one.
 */
type ToolRequirement = {
  schema: { safeParse(value: unknown): { success: boolean; error?: unknown } };
  scope: McpScope;
};

function toolRequirement(name: string): ToolRequirement | undefined {
  const named = toolRequirements[name as keyof typeof toolRequirements];
  if (named) return named;
  if (name.startsWith(SKILL_TOOL_PREFIX)) {
    return { schema: skillToolInput, scope: "skills:read" };
  }
  return undefined;
}

/** OAuthProvider calls this only after it validates a bearer token. */
export const mcpHandler = {
  async fetch(request: Request, env: McpEnv, ctx: ExecutionContext) {
    const startedAt = Date.now();
    const envelope = await requestEnvelope(request);
    const principal = mcpPrincipal(ctx);
    if (principal === null) {
      return observeCall(
        ctx,
        env,
        observed(startedAt, request, envelope, {
          transport: "oauth",
          userId: null,
          principal: null,
          agent: null,
          client: null,
          session: null,
        }),
        json({ error: "invalid bearer context" }, 401),
      );
    }

    const sessionHeaders = {
      session: headerValue(request, "x-valise-session"),
      sessionName: headerValue(request, "x-valise-session-name"),
    };
    const provenance = mcpProvenance(principal, sessionHeaders);
    const call = observed(startedAt, request, envelope, {
      transport: principal.kind,
      userId: principal.userId,
      principal:
        principal.kind === "bearer" ? principal.label : principal.clientId,
      agent: provenance.agent,
      client: provenance.client,
      session: provenance.session,
    });

    // Admission and tenant binding are one step: no admitted account, no store.
    const bound = await mcpTenantStore(env, ctx, sessionHeaders);
    if (bound === null) {
      return observeCall(
        ctx,
        env,
        call,
        json({ error: "account is not verified" }, 401),
      );
    }
    const limited = await rateLimit(request, env, principal, envelope);
    if (limited) return observeCall(ctx, env, call, limited);
    const failure = await preflightMcpRequest(request, env, principal);
    if (failure) return observeCall(ctx, env, call, failure);
    return observeCall(
      ctx,
      env,
      call,
      await dispatch(
        request,
        env,
        ctx,
        bound.provenance,
        principal,
        bound.store,
      ),
    );
  },
} satisfies ExportedHandler<McpEnv>;

/** The loopback-only surface used by local tests and the probe script. */
export async function handleMcp(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext,
): Promise<Response> {
  const url = new URL(request.url);
  if (!LOOPBACK.has(url.hostname)) {
    return json({ error: "OAuth is required outside local development." }, 401);
  }
  const provenance = readDevProvenance(request);
  if (provenance === null) {
    return json(
      {
        error:
          "Local MCP requests require x-valise-agent and x-valise-client headers.",
      },
      401,
    );
  }
  const startedAt = Date.now();
  const envelope = await requestEnvelope(request);
  const call = observed(startedAt, request, envelope, {
    transport: "loopback",
    userId: provenance.userId,
    principal: provenance.agent,
    agent: provenance.agent,
    client: provenance.client,
    session: provenance.session,
  });
  const failure = await validateToolInput(request);
  if (failure) return observeCall(ctx, env, call, failure);
  return observeCall(
    ctx,
    env,
    call,
    await dispatch(
      request,
      env,
      ctx,
      provenance,
      null,
      loopbackTenantStore(env, provenance),
    ),
  );
}

/**
 * The half of a log row that comes from the envelope rather than the caller.
 * A request with no JSON-RPC body still gets a row, named by its HTTP method,
 * because a client that opens the endpoint and sends nothing useful is exactly
 * the thing the logs tab exists to show.
 *
 * A non-tool method records its whole `params`, not just a resource uri. That
 * is how `initialize`'s `clientInfo` reaches the log, which is the difference
 * between a row that says `claude-code 2.x` and one that says `oauth`.
 */
function observed(
  startedAt: number,
  request: Request,
  envelope: RpcEnvelope | null,
  who: Pick<
    ObservedCall,
    "transport" | "userId" | "principal" | "agent" | "client" | "session"
  >,
): ObservedCall {
  const method =
    typeof envelope?.method === "string" ? envelope.method : request.method;
  const tool =
    method === "tools/call" && typeof envelope?.params?.name === "string"
      ? envelope.params.name
      : null;
  return {
    ...who,
    startedAt,
    httpMethod: request.method,
    streamProbe:
      who.userId !== null &&
      request.method === "GET" &&
      request.body === null &&
      !request.headers.has("last-event-id") &&
      !request.headers.has("mcp-session-id") &&
      acceptsEventStream(request),
    limiterMethod: limiterMethod(request, envelope),
    limiterName: limiterDimension(request, "mcp-name", "unclassified"),
    method,
    tool,
    requiredScope: envelope ? (requiredScope(envelope) ?? null) : null,
    args: tool ? (envelope?.params?.arguments ?? {}) : nonToolParams(envelope),
    intent: callIntent(envelope),
    clientInfo: clientInfo(envelope),
    userAgent: headerValue(request, "user-agent"),
    sessionName: headerValue(request, "x-valise-session-name"),
    host: headerValue(request, "x-valise-host"),
    plugin: headerValue(request, "x-valise-plugin"),
  };
}

/** An explicit event-stream offer, not a wildcard or a q=0 exclusion. */
function acceptsEventStream(request: Request): boolean {
  return (request.headers.get("accept") ?? "").split(",").some((range) => {
    const [type, ...parameters] = range.split(";");
    if (type.trim().toLowerCase() !== "text/event-stream") return false;
    const quality = parameters.find((value) => /^\s*q\s*=/i.test(value));
    if (quality === undefined) return true;
    const weight = Number(quality.split("=")[1]);
    return weight > 0 && weight <= 1;
  });
}

/**
 * `name version` from the `clientInfo` a client sends: in `_meta` on every
 * request under the stateless protocol, in `params` on a legacy `initialize`.
 */
function clientInfo(envelope: RpcEnvelope | null): string | null {
  const params = envelope?.params as Record<string, unknown> | undefined;
  const meta = params?._meta;
  const info =
    (meta !== null && typeof meta === "object"
      ? (meta as Record<string, unknown>)[CLIENT_INFO_KEY]
      : undefined) ?? params?.clientInfo;
  if (info === null || typeof info !== "object") return null;
  const { name, version } = info as { name?: unknown; version?: unknown };
  if (typeof name !== "string" || name.trim() === "") return null;
  const named = typeof version === "string" ? `${name} ${version}` : name;
  return named.slice(0, HEADER_CAP);
}

function headerValue(request: Request, name: string): string | null {
  const value = request.headers.get(name)?.trim();
  return value ? value.slice(0, HEADER_CAP) : null;
}

/** The dimensions used by the rate-limit key, with bounded client input. */
function limiterDimension(
  request: Request,
  header: string,
  fallback: string,
): string {
  return headerValue(request, header) ?? fallback;
}

/**
 * The JSON-RPC methods a header-less call is bucketed by. Only these: an
 * unknown method stays in `rpc`, so a client cannot open buckets by naming
 * methods. The header, when sent, still wins, as before.
 */
const LIMITER_METHODS = new Set([
  "initialize",
  "ping",
  "server/discover",
  "tools/list",
  "tools/call",
  "resources/list",
  "resources/read",
  "resources/templates/list",
  "prompts/list",
  "prompts/get",
  "notifications/initialized",
  "notifications/cancelled",
]);

/**
 * The method half of the rate-limit key. Without an `mcp-method` header every
 * call fell into one `rpc` bucket per user, so a client polling
 * `resources/list` got its own `initialize` and `tools/list` refused: OpenCode
 * 2.1 subagents lost their Valise tools that way between 2026-10-21 and 10-30.
 * docs/operations/mcp-catalog-refresh.md.
 */
function limiterMethod(request: Request, envelope: RpcEnvelope | null) {
  const method = envelope?.method;
  return limiterDimension(
    request,
    "mcp-method",
    typeof method === "string" && LIMITER_METHODS.has(method) ? method : "rpc",
  );
}

/** An empty `params` reads as no arguments, the way `tools/list` always did. */
function nonToolParams(envelope: RpcEnvelope | null): unknown {
  const params = envelope?.params;
  if (params === undefined || params === null) return null;
  return Object.keys(params).length === 0 ? null : params;
}

/**
 * The reason the agent gives, from `_meta` first and the `why` argument
 * second. Both are model-asserted, so the row records a thing the model said
 * rather than the reason it called, and nothing reads it but a person.
 */
function callIntent(envelope: RpcEnvelope | null): string | null {
  const meta = envelope?.params?._meta;
  if (meta !== null && typeof meta === "object") {
    const invocation = (meta as Record<string, unknown>)[SEP_2817_KEY];
    const reason =
      invocation !== null && typeof invocation === "object"
        ? (invocation as { invocationReason?: { text?: unknown } })
            .invocationReason?.text
        : undefined;
    if (typeof reason === "string" && reason.trim() !== "") {
      return reason.trim();
    }
  }
  const args = envelope?.params?.arguments;
  if (args === null || typeof args !== "object") return null;
  const why = (args as Record<string, unknown>).why;
  return typeof why === "string" && why.trim() !== "" ? why.trim() : null;
}

async function rateLimit(
  request: Request,
  env: McpEnv,
  principal: McpPrincipal,
  envelope: RpcEnvelope | null,
): Promise<Response | undefined> {
  if (!env.MCP_LIMITER) return undefined;
  const method = limiterMethod(request, envelope);
  const name = limiterDimension(request, "mcp-name", "unclassified");
  const outcome = await env.MCP_LIMITER.limit({
    key: `${principal.userId}:${method}:${name}`,
  });
  if (outcome.success) return undefined;

  // Admission is an HTTP failure, not a tool result: initialize and catalog
  // calls have no tool result schema, and a null result id breaks clients.
  // Notifications, client responses and GET probes must not receive an
  // unsolicited JSON-RPC response. The binding exposes no reset timestamp;
  // wait a full configured window rather than claiming an exact reset time.
  const retryAfterSeconds = 60;
  const hasRequestId =
    typeof envelope?.method === "string" &&
    (typeof envelope.id === "string" || typeof envelope.id === "number");
  return new Response(
    hasRequestId
      ? JSON.stringify({
          jsonrpc: "2.0",
          id: envelope.id,
          error: {
            code: -32000,
            message: "Too many requests. Retry in one minute.",
            data: { code: "rate_limited", retryAfterSeconds },
          },
        })
      : null,
    {
      status: 429,
      headers: {
        ...(hasRequestId ? { "content-type": "application/json" } : {}),
        "retry-after": String(retryAfterSeconds),
        "cache-control": "no-store",
      },
    },
  );
}

async function dispatch(
  request: Request,
  env: McpEnv,
  ctx: ExecutionContext,
  provenance: Provenance,
  principal: McpPrincipal | null,
  store: TenantStore,
): Promise<Response> {
  const url = new URL(request.url);
  const envelope = await requestEnvelope(request);
  const origin = request.headers.get("origin");
  // After scope preflight, Chrome's serialized extension origin is admitted
  // for a console bearer, or for an OAuth grant consented to that same
  // extension id. Loopback headers and other OAuth grants never opt in. Match
  // the entire raw value, not just its hostname.
  const chromeOrigin =
    (principal?.kind === "bearer" &&
      /^chrome-extension:\/\/[a-p]{32}$/.test(origin ?? "")) ||
    (principal?.kind === "oauth" &&
      principal.chromeExtensionId !== null &&
      origin === `chrome-extension://${principal.chromeExtensionId}`);
  // The SDK's Origin validator compares hostnames only. Without this guard,
  // e.g. chrome-extension://localhost could borrow an allowed web hostname.
  if (origin && !/^https?:\/\//.test(origin) && !chromeOrigin) {
    return json({ error: "Origin is not allowed." }, 403);
  }
  const caller = {
    hooks: headerValue(request, "x-valise-plugin") !== null,
    origin: url.origin,
    method: typeof envelope?.method === "string" ? envelope.method : undefined,
  };
  // Only the handshake carries instructions, so only it reads the document.
  const instructions =
    envelope?.method === "initialize" || envelope?.method === "server/discover"
      ? serverInstructions((await store.hooks.read()).document, caller)
      : null;
  const handler = createMcpHandler(
    () => createServer(env, provenance, caller, store, instructions),
    {
      route: "/mcp",
      allowedHostnames: [url.hostname],
      // Skip only the SDK's hostname-only Origin check for this already
      // authenticated, exactly matched request. Host/DNS-rebinding validation
      // above it still runs, and no CORS policy or hostname list is widened.
      allowedOriginHostnames: chromeOrigin ? "*" : [url.hostname],
    },
  );
  return addToolSecuritySchemes(envelope, await handler(request, env, ctx));
}

/**
 * The installed MCP SDK does not yet expose the protocol's top-level tool
 * `securitySchemes` field. ChatGPT uses that field to decide which tools need
 * OAuth, so add the standards-compliant declaration at the HTTP boundary.
 */
async function addToolSecuritySchemes(
  envelope: RpcEnvelope | null,
  response: Response,
): Promise<Response> {
  if (
    envelope?.method !== "tools/list" ||
    !response.headers
      .get("content-type")
      ?.match(/application\/json|text\/event-stream/)
  ) {
    return response;
  }

  try {
    const raw = await response.clone().text();
    const eventStream = response.headers
      .get("content-type")
      ?.includes("text/event-stream");
    const lines = eventStream ? raw.split("\n") : undefined;
    const dataLine = lines?.findIndex((line) => line.startsWith("data:"));
    const payload =
      lines && dataLine !== undefined && dataLine >= 0
        ? lines[dataLine].slice("data:".length).trim()
        : raw;
    const body = JSON.parse(payload) as {
      result?: { tools?: unknown };
    };
    if (!Array.isArray(body.result?.tools)) return response;
    const tools = body.result.tools.map((tool) => {
      if (typeof tool !== "object" || tool === null || !("name" in tool)) {
        return tool;
      }
      const name = tool.name;
      if (typeof name !== "string") return tool;
      const scope = toolRequirement(name)?.scope;
      if (scope === undefined) return tool;
      return {
        ...tool,
        securitySchemes: [{ type: "oauth2", scopes: [scope] }],
      };
    });
    const serialized = JSON.stringify({
      ...body,
      result: { ...body.result, tools },
    });
    if (lines && dataLine !== undefined && dataLine >= 0) {
      lines[dataLine] = `data: ${serialized}`;
    }
    return new Response(lines ? lines.join("\n") : serialized, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch {
    return response;
  }
}

async function preflightMcpRequest(
  request: Request,
  env: McpEnv,
  principal: McpPrincipal,
): Promise<Response | undefined> {
  const invalid = await validateToolInput(request);
  if (invalid) return invalid;
  const envelope = await requestEnvelope(request);
  if (envelope === null) return undefined;
  const required = [
    requiredScope(envelope),
    ...linkedAssetScopes(envelope),
  ].find((scope) => scope !== undefined && !principal.scopes.includes(scope));
  if (required === undefined) return undefined;
  const challenge = oauthChallenge(env, [required], "insufficient_scope");
  const response = rpcError(
    envelope.id,
    `This operation requires ${required}.`,
    "insufficient_scope",
    challenge,
  );
  response.headers.set("www-authenticate", challenge);
  return new Response(response.body, {
    status: 403,
    headers: response.headers,
  });
}

async function validateToolInput(
  request: Request,
): Promise<Response | undefined> {
  const envelope = await requestEnvelope(request);
  // Scope and input checks read one envelope. The SDK still dispatches a JSON
  // array element by element, so a batch would reach tools unchecked. The
  // protocol dropped batching in 2025-06-18, and no client has sent one.
  if (Array.isArray(envelope)) {
    return plainError("JSON-RPC batches are not supported.", 400);
  }
  if (envelope === null || envelope.method !== "tools/call") return undefined;
  const name =
    typeof envelope.params?.name === "string" ? envelope.params.name : "";
  const requirement = toolRequirement(name);
  if (!requirement) return undefined;
  const parsed = requirement.schema.safeParse(envelope.params?.arguments ?? {});
  if (parsed.success) return undefined;
  const fields = invalidFields(parsed.error);
  const suffix = fields.length
    ? ` Missing or invalid: ${fields.join(", ")}.`
    : "";
  return rpcError(
    envelope.id,
    `Invalid input for ${name}.${suffix}`,
    "invalid_input",
  );
}

async function requestEnvelope(request: Request): Promise<RpcEnvelope | null> {
  if (
    request.method !== "POST" ||
    !request.headers.get("content-type")?.includes("application/json")
  ) {
    return null;
  }
  try {
    return (await request.clone().json()) as RpcEnvelope;
  } catch {
    return null;
  }
}

function requiredScope(envelope: RpcEnvelope): McpScope | undefined {
  if (
    envelope.method === "resources/read" &&
    typeof envelope.params?.uri === "string"
  ) {
    const attachment = parseAttachmentUri(envelope.params.uri);
    if (attachment !== null)
      return attachment.target.concept === "todo"
        ? "todos:read"
        : "memories:read";
    // Bytes, so not search:read, which reads text and metadata only.
    if (parseAssetUri(envelope.params.uri) !== null) return "assets:read";
  }
  if (envelope.method === "tools/call") {
    const name =
      typeof envelope.params?.name === "string" ? envelope.params.name : "";
    return toolRequirement(name)?.scope;
  }
  if (
    envelope.method === "resources/read" ||
    envelope.method === "resources/list" ||
    envelope.method === "resources/templates/list" ||
    envelope.method === "prompts/list" ||
    envelope.method === "prompts/get" ||
    envelope.method === "skills/list" ||
    envelope.method === "skills/get"
  ) {
    return "skills:read";
  }
  return undefined;
}

/**
 * The one operation that needs more scopes: `save_source` linking assets
 * also needs `assets:read`, so a token that cannot download a file cannot
 * cite it either, and fetching a bookmark's images into new assets needs
 * `assets:write`. ADR-0015 amends ADR-0004's one-scope-per-tool rule here.
 * A missing extra scope answers the same challenge as a missing first.
 */
function linkedAssetScopes(envelope: RpcEnvelope): McpScope[] {
  if (
    envelope.method !== "tools/call" ||
    envelope.params?.name !== "save_source"
  ) {
    return [];
  }
  const args = envelope.params.arguments;
  const { asset_ids: linked, images } =
    args !== null && typeof args === "object"
      ? (args as { asset_ids?: unknown; images?: unknown })
      : {};
  return [
    ...(Array.isArray(linked) && linked.length > 0
      ? (["assets:read"] as const)
      : []),
    ...(Array.isArray(images) && images.length > 0
      ? (["assets:write"] as const)
      : []),
  ];
}

/**
 * Loopback only. `x-valise-user` picks the user the call acts as, so a test
 * can prove one user's rows are invisible to another; absent, the owner.
 */
function readDevProvenance(request: Request): Provenance | null {
  const agent = request.headers.get("x-valise-agent")?.trim();
  const client = request.headers.get("x-valise-client")?.trim();
  const session = headerValue(request, "x-valise-session");
  const userId = request.headers.get("x-valise-user")?.trim() || "local";
  if (!agent || !client) return null;
  const sessionName = headerValue(request, "x-valise-session-name");
  return { userId, agent, client, session, sessionName };
}

function oauthChallenge(
  env: Pick<McpEnv, "APP_ORIGIN" | "MCP_RESOURCE_URL">,
  scopes: McpScope[],
  error?: string,
): string {
  const resourcePath = new URL(env.MCP_RESOURCE_URL).pathname;
  const metadata = new URL(
    `/.well-known/oauth-protected-resource${resourcePath}`,
    env.APP_ORIGIN,
  );
  const parameters = [
    `resource_metadata="${metadata}"`,
    `scope="${scopes.join(" ")}"`,
  ];
  if (error) parameters.push(`error="${error}"`);
  return `Bearer ${parameters.join(", ")}`;
}

function rpcError(
  id: RpcEnvelope["id"],
  message: string,
  code: string,
  challenge?: string,
): Response {
  // A result needs the id it answers: `id: null` beside a result matches no
  // JSON-RPC message shape, and the client throws `invalid_union` instead of
  // showing the reason. A request without an id gets an HTTP failure instead.
  if (typeof id !== "string" && typeof id !== "number") {
    return plainError(message, 400);
  }
  return new Response(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      result: {
        // Preflight returns before the SDK can shape the result. Required by
        // modern clients and accepted as an extension by legacy clients.
        resultType: "complete",
        content: [{ type: "text", text: message }],
        isError: true,
        _meta: challenge ? { "mcp/www_authenticate": challenge } : undefined,
        error: code,
      },
    }),
    { headers: { "content-type": "application/json" } },
  );
}

function invalidFields(error: unknown): string[] {
  if (typeof error !== "object" || error === null || !("issues" in error)) {
    return [];
  }
  const issues = error.issues;
  if (!Array.isArray(issues)) return [];
  return [
    ...new Set(
      issues.flatMap((issue) => {
        if (typeof issue !== "object" || issue === null || !("path" in issue)) {
          return [];
        }
        const path = issue.path;
        return Array.isArray(path) && typeof path[0] === "string"
          ? [path[0]]
          : [];
      }),
    ),
  ];
}

function plainError(message: string, status: number): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
