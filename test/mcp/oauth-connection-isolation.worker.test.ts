import {
  createExecutionContext,
  env,
  waitOnExecutionContext,
} from "cloudflare:test";
import type { ClientInfo } from "@cloudflare/workers-oauth-provider";
import { beforeAll, describe, expect, it } from "vitest";
import {
  listOAuthConnections,
  revokeOAuthConnection,
} from "~/concepts/oauth-clients";
import { createSessionCookie, getUser } from "~/lib/auth.server";
import {
  createOAuthProvider,
  type OAuthEnv,
  oauthManagementApi,
} from "../../workers/oauth";

const CALLER = "usr_oauth_disconnect_caller";
const OTHER = "usr_oauth_disconnect_other";
const REDIRECT = "http://127.0.0.1:4567/callback";
const SESSION_SECRET = "oauth-isolation-test-session-secret";
const settings = {
  ...env,
  APP_ORIGIN: "https://valise.test",
  MCP_RESOURCE_URL: "https://valise.test/mcp",
};
const api = oauthManagementApi(settings);
const provider = createOAuthProvider(settings, {
  fetch: async () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<OAuthEnv>);

beforeAll(async () => {
  // Already admitted users: the test exercises disconnect, not signup.
  await env.DB.batch(
    [CALLER, OTHER].map((userId) =>
      env.DB.prepare(
        `INSERT INTO users (user_id, email, display_name, role, plan, created_at, email_verified)
         VALUES (?, ?, ?, 'member', 'free', ?, 1)`,
      ).bind(userId, `${userId}@example.com`, userId, 1_800_000_000),
    ),
  );
});

async function client(name: string) {
  return api.createClient({
    clientName: name,
    redirectUris: [REDIRECT],
    tokenEndpointAuthMethod: "none",
  });
}

async function send(request: Request) {
  const ctx = createExecutionContext();
  const response = await provider.fetch(request, settings, ctx);
  const body = await response.text();
  await waitOnExecutionContext(ctx);
  return { response, body };
}

function tokenRequest(fields: Record<string, string>) {
  return new Request(`${settings.APP_ORIGIN}/token`, {
    method: "POST",
    body: new URLSearchParams({
      ...fields,
      resource: settings.MCP_RESOURCE_URL,
    }),
  });
}

async function grant(userId: string, registered: ClientInfo) {
  const verifier = crypto.randomUUID().replaceAll("-", "").repeat(2);
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const challenge = btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  const authorize = new URL(`${settings.APP_ORIGIN}/authorize`);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: registered.clientId,
    redirect_uri: REDIRECT,
    scope: "search:read",
    resource: settings.MCP_RESOURCE_URL,
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();
  const request = await api.parseAuthRequest(new Request(authorize));
  const { redirectTo } = await api.completeAuthorization({
    request,
    userId,
    metadata: {},
    scope: ["search:read"],
    props: { userId },
    // Exercise disconnecting every session of this user's connection.
    revokeExistingGrants: false,
  });
  const code = new URL(redirectTo).searchParams.get("code");
  expect(code).toBeTruthy();
  const result = await send(
    tokenRequest({
      grant_type: "authorization_code",
      code: code ?? "",
      redirect_uri: REDIRECT,
      client_id: registered.clientId,
      code_verifier: verifier,
    }),
  );
  expect(result.response.status, result.body).toBe(200);
  return JSON.parse(result.body) as {
    access_token: string;
    refresh_token: string;
  };
}

async function ping(token: string, status = 200) {
  const result = await send(
    new Request(settings.MCP_RESOURCE_URL, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        host: new URL(settings.APP_ORIGIN).host,
        "mcp-protocol-version": "2025-11-25",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    }),
  );
  expect(result.response.status, result.body).toBe(status);
}

async function records(prefix: string) {
  const page = await env.OAUTH_KV.list({ prefix });
  expect(page.list_complete).toBe(true);
  return Promise.all(
    page.keys.map(async ({ name }) => [name, await env.OAUTH_KV.get(name)]),
  );
}

describe("OAuth connection revocation isolation", () => {
  it("revokes all caller grants, not the shared registration or another user's tokens", async () => {
    const shared = await client("Shared OAuth client");
    const unrelated = await client("Another OAuth client");
    const first = await grant(CALLER, shared);
    const second = await grant(CALLER, shared);
    const other = await grant(OTHER, shared);
    const separate = await grant(CALLER, unrelated);
    const sessionEnv = { DB: env.DB, SESSION_SECRET };
    const cookie = await createSessionCookie(
      sessionEnv,
      new Request(settings.APP_ORIGIN),
      CALLER,
    );
    const browser = new Request(settings.APP_ORIGIN, { headers: { cookie } });
    const registration = await api.lookupClient(shared.clientId);
    const otherGrants = await records(`grant:${OTHER}:`);
    const otherTokens = await records(`token:${OTHER}:`);
    expect(otherGrants).toHaveLength(1);
    expect(otherTokens).toHaveLength(1);
    expect((await api.listUserGrants(CALLER)).items).toHaveLength(3);
    for (const token of [first, second, other, separate]) {
      await ping(token.access_token);
    }

    expect(await revokeOAuthConnection(settings, CALLER, shared.clientId)).toBe(
      true,
    );

    expect(await api.lookupClient(shared.clientId)).toEqual(registration);
    expect(await records(`grant:${OTHER}:`)).toEqual(otherGrants);
    expect(await records(`token:${OTHER}:`)).toEqual(otherTokens);
    expect(await listOAuthConnections(settings, CALLER)).toMatchObject([
      { clientId: unrelated.clientId },
    ]);
    expect(await listOAuthConnections(settings, OTHER)).toMatchObject([
      { clientId: shared.clientId },
    ]);
    await ping(first.access_token, 401);
    await ping(second.access_token, 401);
    await ping(other.access_token);
    await ping(separate.access_token);
    expect(await getUser(sessionEnv, browser)).toEqual({ userId: CALLER });
    const revokedRefresh = await send(
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: first.refresh_token,
        client_id: shared.clientId,
      }),
    );
    expect(revokedRefresh.response.status, revokedRefresh.body).toBe(400);
    const otherRefresh = await send(
      tokenRequest({
        grant_type: "refresh_token",
        refresh_token: other.refresh_token,
        client_id: shared.clientId,
      }),
    );
    expect(otherRefresh.response.status, otherRefresh.body).toBe(200);
    expect(await revokeOAuthConnection(settings, CALLER, shared.clientId)).toBe(
      false,
    );
  });

  it("cannot disconnect a client when only the other user has a grant", async () => {
    const shared = await client("Other user's OAuth client");
    const other = await grant(OTHER, shared);
    const registration = await api.lookupClient(shared.clientId);
    const otherGrants = await records(`grant:${OTHER}:`);
    const otherTokens = await records(`token:${OTHER}:`);

    expect(await revokeOAuthConnection(settings, CALLER, shared.clientId)).toBe(
      false,
    );

    expect(await api.lookupClient(shared.clientId)).toEqual(registration);
    expect(await records(`grant:${OTHER}:`)).toEqual(otherGrants);
    expect(await records(`token:${OTHER}:`)).toEqual(otherTokens);
    await ping(other.access_token);
  });
});
