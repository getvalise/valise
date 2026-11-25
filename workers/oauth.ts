import {
  type ClientRegistrationCallbackOptions,
  getOAuthApi,
  OAuthProvider,
  type OAuthProviderOptions,
} from "@cloudflare/workers-oauth-provider";
import { chromeExtensionId } from "~/auth/chrome-extension";
import { bearerTokenProps } from "~/auth/principal";
import { MCP_SCOPES, type McpScope } from "~/auth/scopes";
import { resolveBearerToken } from "~/concepts/tokens";
import {
  HOOKS_MANIFEST_PATH,
  HOOKS_RUNS_PATH,
  handleHooks,
  isHooksPath,
} from "./hooks";
import { mcpHandler } from "./mcp";
import { handleTranscripts, TRANSCRIPTS_PATH } from "./transcripts";

export { MCP_SCOPES, type McpScope } from "~/auth/scopes";

export type OAuthEnv = {
  APP_ORIGIN: string;
  MCP_RESOURCE_URL: string;
  OAUTH_KV: KVNamespace;
  DB: D1Database;
  BUNDLES: R2Bucket;
  TOKEN_PEPPER?: string;
  TODO_COORDINATOR: DurableObjectNamespace<
    import("~/do/todo-coordinator").TodoCoordinator
  >;
};

const protectedResourceMetadataPath = "/.well-known/oauth-protected-resource";

export function isOAuthProviderPath(pathname: string, env: OAuthEnv): boolean {
  return (
    pathname === new URL(env.MCP_RESOURCE_URL).pathname ||
    pathname === TRANSCRIPTS_PATH ||
    isHooksPath(pathname) ||
    pathname === "/authorize" ||
    pathname === "/token" ||
    pathname === "/register" ||
    pathname === protectedResourceMetadataPath ||
    pathname.startsWith(`${protectedResourceMetadataPath}/`) ||
    pathname === "/.well-known/oauth-authorization-server"
  );
}

export function validateMcpClientRegistration({
  clientMetadata,
}: ClientRegistrationCallbackOptions) {
  const redirects = clientMetadata.redirect_uris;
  if (
    !Array.isArray(redirects) ||
    redirects.length === 0 ||
    !redirects.every(supportedRedirectUri) ||
    // A chromiumapp.org callback identifies one extension, and consent narrows
    // its grant on that basis, so it cannot share a client with other callbacks.
    (redirects.length > 1 && redirects.some(isChromeExtensionRedirect))
  ) {
    return {
      code: "invalid_redirect_uri",
      description: "This MCP client redirect URI is not supported.",
    };
  }
}

export function oauthOptions(
  env: OAuthEnv,
  defaultHandler: ExportedHandler<OAuthEnv>,
): OAuthProviderOptions<OAuthEnv> {
  return {
    // Every route takes the same tokens: the provider validates a bearer
    // against the one configured resource, then hands the request on.
    apiRoute: [
      new URL(env.MCP_RESOURCE_URL).pathname,
      TRANSCRIPTS_PATH,
      HOOKS_MANIFEST_PATH,
      HOOKS_RUNS_PATH,
    ],
    apiHandler: {
      fetch(request: Request, env: OAuthEnv, ctx: ExecutionContext) {
        const { pathname } = new URL(request.url);
        if (pathname === TRANSCRIPTS_PATH)
          return handleTranscripts(request, env, ctx);
        if (isHooksPath(pathname)) return handleHooks(request, env, ctx);
        return mcpHandler.fetch(request, env, ctx);
      },
    },
    defaultHandler,
    authorizeEndpoint: "/authorize",
    tokenEndpoint: "/token",
    clientRegistrationEndpoint: "/register",
    clientIdMetadataDocumentEnabled: true,
    scopesSupported: [...MCP_SCOPES],
    requiredScopes: ["search:read"],
    disallowPublicClientRegistration: false,
    clientRegistrationCallback: validateMcpClientRegistration,
    accessTokenTTL: 60 * 60,
    refreshTokenTTL: 30 * 24 * 60 * 60,
    clientRegistrationTTL: 90 * 24 * 60 * 60,
    resourceMetadata: {
      resource: env.MCP_RESOURCE_URL,
      authorization_servers: [new URL(env.APP_ORIGIN).origin],
      bearer_methods_supported: ["header"],
      resource_name: "Valise",
    },
    resolveExternalToken: async ({ env: resolverEnv, token }) => {
      const pepper = resolverEnv.TOKEN_PEPPER;
      if (!pepper) return null;
      const record = await resolveBearerToken(
        { DB: resolverEnv.DB, TOKEN_PEPPER: pepper },
        token,
      );
      if (record === null) return null;
      return {
        audience: resolverEnv.MCP_RESOURCE_URL,
        props: bearerTokenProps(record),
      };
    },
    onError({ status, code }) {
      console.info(JSON.stringify({ event: "mcp_oauth_error", status, code }));
    },
  };
}

export function createOAuthProvider(
  env: OAuthEnv,
  defaultHandler: ExportedHandler<OAuthEnv>,
): OAuthProvider<OAuthEnv> {
  return new OAuthProvider(oauthOptions(env, defaultHandler));
}

/**
 * The console uses only the provider's administrative helper methods. Its
 * fallback is unreachable for those methods, but keeps their configuration
 * identical to the HTTP provider.
 */
const managementFallback: ExportedHandler<OAuthEnv> = {
  fetch: async () => new Response("Not found", { status: 404 }),
};

export function oauthManagementApi(env: OAuthEnv) {
  return getOAuthApi(oauthOptions(env, managementFallback), env);
}

function supportedRedirectUri(value: unknown): boolean {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (isChromeExtensionRedirect(value)) return true;
  if (url.href === "https://claude.ai/api/mcp/auth_callback") return true;
  if (url.href === "https://chatgpt.com/connector_platform_oauth_redirect") {
    return true;
  }
  if (url.href.startsWith("https://chatgpt.com/connector/oauth/")) return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost") &&
    Boolean(url.port)
  );
}

function isChromeExtensionRedirect(value: unknown): boolean {
  return typeof value === "string" && chromeExtensionId(value) !== null;
}
