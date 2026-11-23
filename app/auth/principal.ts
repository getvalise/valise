import { isMcpScope, type McpScope, normalizeMcpScopes } from "~/auth/scopes";
import type { Provenance } from "~/concepts/memories";
import type { BearerTokenRecord } from "~/concepts/tokens";

export type McpPrincipal =
  | {
      kind: "oauth";
      userId: string;
      clientId: string;
      scopes: readonly McpScope[];
      /** Set only on a grant consented through a chromiumapp.org redirect. */
      chromeExtensionId: string | null;
    }
  | {
      kind: "bearer";
      userId: string;
      tokenId: string;
      label: string;
      scopes: readonly McpScope[];
    };

type ValiseBearerProps = {
  kind: "valise_bearer";
  userId: string;
  tokenId: string;
  label: string;
  scopes: readonly McpScope[];
};

export function bearerTokenProps(record: BearerTokenRecord): ValiseBearerProps {
  return {
    kind: "valise_bearer",
    userId: record.userId,
    tokenId: record.tokenId,
    label: record.label,
    scopes: record.scopes,
  };
}

export function mcpPrincipal(ctx: ExecutionContext): McpPrincipal | null {
  const auth = recordOf(Reflect.get(ctx, "auth"));
  const props = recordOf(ctx.props);
  if (auth === null || props === null) return null;

  const bearer = bearerPrincipal(auth, props);
  if (bearer !== null) return bearer;

  const scopes = canonicalScopes(Reflect.get(auth, "scope"), true);
  const userId = stringField(props, "userId");
  if (scopes === null || userId === null) return null;
  return {
    kind: "oauth",
    userId,
    clientId: stringField(auth, "clientId") ?? "oauth-client",
    scopes,
    chromeExtensionId: stringField(props, "chromeExtensionId"),
  };
}

export function principalProvenance(principal: McpPrincipal): Provenance {
  if (principal.kind === "bearer") {
    return {
      userId: principal.userId,
      agent: principal.label,
      client: "bearer",
      session: principal.tokenId,
    };
  }
  return {
    userId: principal.userId,
    agent: principal.clientId,
    client: "oauth",
    session: null,
  };
}

/**
 * What an MCP request writes as: the principal's identity, plus the plugin's
 * session headers. OAuth carries no session, and every Claude Code on a machine
 * shares one grant, so the plugin's header is the only thing that tells two
 * apart. The session name is a label for people, stored beside the client id
 * rather than in place of it: leases still key on `agent`. ADR-0004.
 */
export function mcpProvenance(
  principal: McpPrincipal,
  headers: { session: string | null; sessionName: string | null },
): Provenance {
  const granted = principalProvenance(principal);
  return {
    ...granted,
    session: granted.session ?? headers.session,
    sessionName: headers.sessionName,
  };
}

function bearerPrincipal(
  auth: Record<string, unknown>,
  props: Record<string, unknown>,
): McpPrincipal | null {
  if (Reflect.get(props, "kind") !== "valise_bearer") return null;
  const providerScopes = Reflect.get(auth, "scope");
  if (!Array.isArray(providerScopes) || providerScopes.length !== 0)
    return null;
  const scopes = canonicalScopes(Reflect.get(props, "scopes"));
  const userId = stringField(props, "userId");
  const tokenId = stringField(props, "tokenId");
  const label = stringField(props, "label");
  if (
    scopes === null ||
    userId === null ||
    tokenId === null ||
    label === null
  ) {
    return null;
  }
  return { kind: "bearer", userId, tokenId, label, scopes };
}

function canonicalScopes(
  value: unknown,
  allowEmpty = false,
): McpScope[] | null {
  if (
    !Array.isArray(value) ||
    (!allowEmpty && !value.length) ||
    !value.every(isMcpScope)
  ) {
    return null;
  }
  const scopes = normalizeMcpScopes(value);
  if (scopes.length !== value.length) return null;
  return scopes;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = Reflect.get(record, key);
  return typeof value === "string" && value.trim() ? value : null;
}
