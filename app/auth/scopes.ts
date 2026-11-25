export const MCP_SCOPES = [
  "search:read",
  "todos:read",
  "todos:write",
  "memories:read",
  "memories:write",
  "skills:read",
  "skills:write",
  "config:read",
  "config:write",
  "assets:read",
  "assets:write",
  "sources:read",
  "sources:write",
  "transcripts:read",
  "transcripts:write",
  "hooks:exec",
] as const;

export type McpScope = (typeof MCP_SCOPES)[number];

const knownScopes = new Set<string>(MCP_SCOPES);

export function isMcpScope(value: unknown): value is McpScope {
  return typeof value === "string" && knownScopes.has(value);
}

/** Returns the valid subset once, in the vocabulary's canonical order. */
export function normalizeMcpScopes(scopes: Iterable<string>): McpScope[] {
  const requested = new Set(scopes);
  return MCP_SCOPES.filter((scope) => requested.has(scope));
}

/**
 * Scopes a client holds only by naming them, never through the whole-case
 * grant: `hooks:exec` reads the approved hooks a machine runs (ADR-0023), so
 * a connector that asked for `search:read` alone must not get it.
 */
export const NAMED_ONLY_SCOPES: readonly McpScope[] = ["hooks:exec"];

/** What consent grants a client that names nothing beyond `search:read`. */
export const WHOLE_CASE_SCOPES: readonly McpScope[] = MCP_SCOPES.filter(
  (scope) => !NAMED_ONLY_SCOPES.includes(scope),
);

/** The scope the resource metadata requires, and the one connectors ask for. */
export const REQUIRED_SCOPE = "search:read" satisfies McpScope;

/**
 * What consent grants a client other than a Chrome extension. A request that
 * names nothing from the vocabulary beyond `search:read` is a connector's
 * minimum: claude.ai asks for `search:read` and then calls everything, which
 * is why consent grants the whole case (ADR-0004, V1-7). A request that names
 * more means it and gets exactly what it named (ADR-0022), so a Valise CLI
 * asking for `transcripts:write` holds that and nothing else. The whole case
 * leaves out `NAMED_ONLY_SCOPES` (ADR-0023).
 */
export function consentGrant(requested: Iterable<string>): McpScope[] {
  const named = normalizeMcpScopes(requested);
  return named.some((scope) => scope !== REQUIRED_SCOPE)
    ? named
    : [...WHOLE_CASE_SCOPES];
}
