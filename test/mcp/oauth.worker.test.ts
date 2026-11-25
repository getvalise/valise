import { env, SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { WHOLE_CASE_SCOPES } from "~/auth/scopes";
import {
  listOAuthConnections,
  revokeOAuthConnection,
} from "~/concepts/oauth-clients";
import { mintBearerToken, revokeBearerToken } from "~/concepts/tokens";
import { type OAuthEnv, oauthOptions } from "../../workers/oauth";

describe("OAuth provider", () => {
  it("enables Client ID Metadata Document resolution", () => {
    const options = oauthOptions(env, {
      fetch: async () => new Response(),
    } as ExportedHandler<OAuthEnv>);

    expect(options.clientIdMetadataDocumentEnabled).toBe(true);
  });

  it("registers a client, completes S256 PKCE, and grants every scope at one consent", async () => {
    const registered = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Valise OAuth test",
        redirect_uris: ["http://127.0.0.1:4567/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registered.status).toBe(201);
    const client = await registered.json<{ client_id: string }>();

    const verifier = "v".repeat(64);
    const plain = new URL("http://localhost/authorize");
    plain.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:4567/callback",
      scope: "search:read",
      resource: "http://localhost/mcp",
      code_challenge: verifier,
      code_challenge_method: "plain",
    }).toString();
    const plainResponse = await SELF.fetch(plain, { redirect: "manual" });
    expect(plainResponse.status).toBe(302);
    expect(plainResponse.headers.get("location")).toContain(
      "error=invalid_request",
    );

    const challenge = await pkceChallenge(verifier);
    const authorize = new URL("http://localhost/authorize");
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: "http://127.0.0.1:4567/callback",
      scope: "search:read",
      resource: "http://localhost/mcp",
      code_challenge: challenge,
      code_challenge_method: "S256",
      state: "test-state",
    }).toString();
    const consent = await SELF.fetch(authorize);
    expect(consent.status).toBe(200);
    const handle = /name="handle" value="([^"]+)"/.exec(
      await consent.text(),
    )?.[1];
    expect(handle).toBeTruthy();
    const cookie = consent.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const approved = await SELF.fetch("http://localhost/authorize", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        cookie: cookie ?? "",
      },
      body: new URLSearchParams({
        handle: handle ?? "",
        decision: "approve",
        password: "local-test-password-for-oauth",
      }),
      redirect: "manual",
    });
    expect(approved.status).toBe(302);
    expect(approved.headers.getSetCookie()).toEqual(
      expect.arrayContaining([expect.stringContaining("valise_session=ses_")]),
    );
    const redirected = new URL(approved.headers.get("location") ?? "");
    const code = redirected.searchParams.get("code");
    expect(code).toBeTruthy();

    const tokenResponse = await SELF.fetch("http://localhost/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: code ?? "",
        redirect_uri: "http://127.0.0.1:4567/callback",
        client_id: client.client_id,
        code_verifier: verifier,
        resource: "http://localhost/mcp",
      }),
    });
    expect(tokenResponse.status).toBe(200);
    const token = await tokenResponse.json<{
      access_token: string;
      refresh_token: string;
    }>();
    expect(token.refresh_token).toEqual(expect.any(String));

    const refreshedResponse = await SELF.fetch("http://localhost/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: token.refresh_token,
        client_id: client.client_id,
        resource: "http://localhost/mcp",
      }),
    });
    expect(refreshedResponse.status).toBe(200);
    const refreshed = await refreshedResponse.json<{
      access_token: string;
      refresh_token: string;
    }>();
    expect(refreshed.access_token).not.toBe(token.access_token);
    expect(refreshed.refresh_token).not.toBe(token.refresh_token);

    const search = await mcp("search", { query: "duckdb" }, token.access_token);
    expect(search.status, await search.text()).toBe(200);

    // One consent, every capability: a client that asked only for search:read
    // can still write without a second authorization round trip.
    const wrote = await mcp(
      "save_memory",
      {
        type: "fact",
        title: "Scope granted at consent",
        body: "Granted at consent",
        tags: ["scope"],
      },
      refreshed.access_token,
    );
    expect(wrote.status, await wrote.text()).toBe(200);
    const listedSkills = await mcp("list_skills", {}, refreshed.access_token);
    expect(listedSkills.status, await listedSkills.text()).toBe(200);

    await expect(listOAuthConnections(env, "local")).resolves.toMatchObject([
      {
        clientId: client.client_id,
        clientName: "Valise OAuth test",
        scopes: [...WHOLE_CASE_SCOPES].sort(),
      },
    ]);
    await expect(
      revokeOAuthConnection(env, "local", client.client_id),
    ).resolves.toBe(true);
    const revokedGrant = await mcp(
      "search",
      { query: "duckdb" },
      refreshed.access_token,
    );
    expect(revokedGrant.status).toBe(401);
  });

  it("refuses a registration callback outside the client allowlist", async () => {
    const response = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Untrusted callback",
        redirect_uris: ["https://example.com/callback"],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "invalid_redirect_uri",
    });
  });

  it("accepts ChatGPT's issuer-identified callback", async () => {
    const response = await SELF.fetch("http://localhost/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "ChatGPT callback test",
        redirect_uris: [
          "https://chatgpt.com/connector_platform_oauth_redirect",
        ],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(response.status, await response.text()).toBe(201);
  });

  it("accepts a Chrome extension callback only on its own", async () => {
    const register = (redirect_uris: string[]) =>
      SELF.fetch("http://localhost/register", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          client_name: "Valise capture",
          redirect_uris,
          token_endpoint_auth_method: "none",
        }),
      });
    expect((await register([EXTENSION_REDIRECT])).status).toBe(201);
    for (const refused of [
      // Shared with another callback, the grant could not be narrowed by it.
      [EXTENSION_REDIRECT, "http://127.0.0.1:4567/callback"],
      [`https://${"a".repeat(31)}.chromiumapp.org/`],
      [`https://${"q".repeat(32)}.chromiumapp.org/`],
      [`https://${"A".repeat(32)}.chromiumapp.org/`],
      [`https://${EXTENSION_ID}.chromiumapp.org/callback`],
      [`https://${EXTENSION_ID}.chromiumapp.org/?next=x`],
      [`http://${EXTENSION_ID}.chromiumapp.org/`],
      [`https://${EXTENSION_ID}.chromiumapp.org.example.com/`],
    ]) {
      const response = await register(refused);
      expect(response.status, refused.join(" ")).toBe(400);
      // The provider refuses plain http itself, before Valise's allowlist.
      expect((await response.json<{ error: string }>()).error).toMatch(
        /^invalid_(redirect_uri|client_metadata)$/,
      );
    }
  });

  // Extension 0.7.0 asks for these four and refuses any grant but the three
  // capture scopes, so this is its compatibility with the current server.
  it("grants a Chrome extension only the capture scopes, for its own Origin, until revoked", async () => {
    const connect = () =>
      connectExtension(
        "assets:write assets:read sources:write memories:write",
        ["assets:read", "assets:write", "sources:write"],
      );

    const first = await connect();
    await expect(listOAuthConnections(env, "local")).resolves.toMatchObject([
      {
        clientId: first.clientId,
        clientName: "Valise capture",
        redirectUris: [EXTENSION_REDIRECT],
        scopes: ["assets:read", "assets:write", "sources:write"],
      },
    ]);
    const capture = { id: "asset:ast_00000000-0000-0000-0000-000000000001" };
    const own = await mcp(
      "get_asset_download",
      capture,
      first.access_token,
      EXTENSION_ORIGIN,
    );
    expect(own.status, await own.text()).toBe(200);
    // Another extension's Origin does not borrow this grant.
    const other = await mcp(
      "get_asset_download",
      capture,
      first.access_token,
      `chrome-extension://${"b".repeat(32)}`,
    );
    expect(other.status).toBe(403);
    const search = await mcp("search", { query: "x" }, first.access_token);
    expect(search.status).toBe(403);
    expect(search.headers.get("www-authenticate")).toContain("search:read");
    const memory = await mcp(
      "save_memory",
      {
        type: "fact",
        title: "Outside the capture grant",
        body: "Refused",
        tags: ["scope"],
      },
      first.access_token,
      EXTENSION_ORIGIN,
    );
    expect(memory.status).toBe(403);

    // Revoked from Connections.
    await expect(
      revokeOAuthConnection(env, "local", first.clientId),
    ).resolves.toBe(true);
    expect(
      (
        await mcp(
          "get_asset_download",
          capture,
          first.access_token,
          EXTENSION_ORIGIN,
        )
      ).status,
    ).toBe(401);

    // Revoked by the extension's Disconnect: RFC 7009 on the token endpoint.
    const second = await connect();
    const revoked = await SELF.fetch("http://localhost/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: EXTENSION_ORIGIN,
      },
      body: new URLSearchParams({
        token: second.refresh_token,
        token_type_hint: "refresh_token",
        client_id: second.clientId,
      }),
    });
    expect(revoked.status).toBe(200);
    expect(
      (
        await mcp(
          "get_asset_download",
          capture,
          second.access_token,
          EXTENSION_ORIGIN,
        )
      ).status,
    ).toBe(401);
    await expect(listOAuthConnections(env, "local")).resolves.toEqual([]);
  });

  it("grants a Chrome extension todos:write only when it asks for it", async () => {
    const connected = await connectExtension(
      "assets:write assets:read sources:write todos:write memories:write",
      ["todos:write", "assets:read", "assets:write", "sources:write"],
    );
    const created = await mcp(
      "create_todo",
      {
        title: "Read this page",
        project: "valise",
        refs: [{ kind: "url", value: "https://example.org/x" }],
      },
      connected.access_token,
      EXTENSION_ORIGIN,
    );
    const raw = await created.text();
    expect(created.status, raw).toBe(200);
    const payload =
      raw
        .split("\n")
        .find((line) => line.startsWith("data:"))
        ?.slice(5)
        .trim() ?? raw;
    expect(JSON.parse(payload).result.structuredContent.id).toMatch(
      /^todo:tdo_/,
    );
    const memory = await mcp(
      "save_memory",
      {
        type: "fact",
        title: "Outside the extension grant",
        body: "Refused",
        tags: ["scope"],
      },
      connected.access_token,
      EXTENSION_ORIGIN,
    );
    expect(memory.status).toBe(403);
  });

  it("grants exactly the scopes a client names beyond search:read, and the whole case to one that names search:read alone", async () => {
    // A writer that asks for one capability holds that and nothing else.
    const narrow = await connectLoopback("transcripts:write", [
      "transcripts:write",
    ]);
    expect(narrow.page).toContain(
      "This client asked for part of the case. It can do these things and nothing else:",
    );
    expect(narrow.page).toContain(
      "Send session transcripts from this machine.",
    );
    const denied = await mcp(
      "search",
      { query: "duckdb" },
      narrow.access_token,
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain("search:read");
    await expect(listOAuthConnections(env, "local")).resolves.toContainEqual(
      expect.objectContaining({
        clientId: narrow.clientId,
        scopes: ["transcripts:write"],
      }),
    );

    // Naming search:read beside another scope is still naming scopes.
    const two = await connectLoopback("todos:read search:read", [
      "search:read",
      "todos:read",
    ]);
    const searched = await mcp("search", { query: "duckdb" }, two.access_token);
    expect(searched.status, await searched.text()).toBe(200);
    const listed = await mcp("list_skills", {}, two.access_token);
    expect(listed.status).toBe(403);

    // A connector's minimum, or a request naming nothing the vocabulary
    // knows, keeps the one-consent grant of ADR-0004 V1-7.
    const whole = await connectLoopback("search:read openid", [
      ...WHOLE_CASE_SCOPES,
    ]);
    expect(whole.page).toContain(
      "One approval covers the whole case. This client will not ask again:",
    );
    const wrote = await mcp("list_skills", {}, whole.access_token);
    expect(wrote.status, await wrote.text()).toBe(200);
  });

  it("accepts a scoped long-lived token and rejects it after revocation", async () => {
    const tokenEnv = {
      DB: env.DB,
      TOKEN_PEPPER: "local-test-token-pepper",
    };
    const minted = await mintBearerToken(tokenEnv, {
      userId: "local",
      label: "Codex local prototype",
      scopes: ["search:read"],
    });

    const searched = await mcp("search", { query: "duckdb" }, minted.token);
    expect(searched.status, await searched.text()).toBe(200);

    const denied = await mcp(
      "save_memory",
      {
        type: "fact",
        title: "Should be denied",
        body: "Not allowed",
        tags: ["scope"],
      },
      minted.token,
    );
    expect(denied.status).toBe(403);
    expect(denied.headers.get("www-authenticate")).toContain("memories:write");

    await expect(
      revokeBearerToken(tokenEnv, {
        userId: "local",
        tokenId: minted.record.tokenId,
      }),
    ).resolves.toEqual({ revoked: true });
    const revoked = await mcp("search", { query: "duckdb" }, minted.token);
    expect(revoked.status).toBe(401);
    expect(revoked.headers.get("www-authenticate")).toContain("invalid_token");
  });
});

const LOOPBACK_REDIRECT = "http://127.0.0.1:4567/callback";

/** One consent for a client on this computer, asking for `scope`. */
async function connectLoopback(
  scope: string,
  granted: string[],
): Promise<{ clientId: string; access_token: string; page: string }> {
  const registered = await SELF.fetch("http://localhost/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "Valise loopback test",
      redirect_uris: [LOOPBACK_REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const client = await registered.json<{ client_id: string }>();
  const verifier = "l".repeat(64);
  const authorize = new URL("http://localhost/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: LOOPBACK_REDIRECT,
    scope,
    resource: "http://localhost/mcp",
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state: "loopback-state",
  }).toString();
  const consent = await SELF.fetch(authorize);
  expect(consent.status).toBe(200);
  const page = await consent.text();
  expect(
    [...page.matchAll(/<li><code>([^<]+)<\/code>/g)].map((m) => m[1]),
  ).toEqual(granted);
  const approved = await SELF.fetch("http://localhost/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: consent.headers.get("set-cookie")?.split(";")[0] ?? "",
    },
    body: new URLSearchParams({
      handle: /name="handle" value="([^"]+)"/.exec(page)?.[1] ?? "",
      decision: "approve",
      password: "local-test-password-for-oauth",
    }),
    redirect: "manual",
  });
  expect(approved.status).toBe(302);
  const redirected = new URL(approved.headers.get("location") ?? "");
  const tokenResponse = await SELF.fetch("http://localhost/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: redirected.searchParams.get("code") ?? "",
      redirect_uri: LOOPBACK_REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: "http://localhost/mcp",
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const token = await tokenResponse.json<{
    access_token: string;
    scope: string;
  }>();
  expect(token.scope.split(" ").sort()).toEqual([...granted].sort());
  return { clientId: client.client_id, access_token: token.access_token, page };
}

const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}`;
const EXTENSION_REDIRECT = `https://${EXTENSION_ID}.chromiumapp.org/`;

async function connectExtension(
  scope: string,
  granted: string[],
): Promise<{
  clientId: string;
  access_token: string;
  refresh_token: string;
  scope: string;
}> {
  const registered = await SELF.fetch("http://localhost/register", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: EXTENSION_ORIGIN,
    },
    body: JSON.stringify({
      client_name: "Valise capture",
      redirect_uris: [EXTENSION_REDIRECT],
      token_endpoint_auth_method: "none",
    }),
  });
  expect(registered.status).toBe(201);
  const client = await registered.json<{ client_id: string }>();
  const verifier = "e".repeat(64);
  const authorize = new URL("http://localhost/authorize");
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: EXTENSION_REDIRECT,
    scope,
    resource: "http://localhost/mcp",
    code_challenge: await pkceChallenge(verifier),
    code_challenge_method: "S256",
    state: "extension-state",
  }).toString();
  const consent = await SELF.fetch(authorize);
  expect(consent.status).toBe(200);
  const page = await consent.text();
  expect(page).toContain(
    "Allow the Chrome extension Valise capture to save captures?",
  );
  expect(page).toContain(`<code>${EXTENSION_ID}</code>`);
  expect(
    [...page.matchAll(/<li><code>([^<]+)<\/code>/g)].map((m) => m[1]),
  ).toEqual(granted);
  const approved = await SELF.fetch("http://localhost/authorize", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      cookie: consent.headers.get("set-cookie")?.split(";")[0] ?? "",
    },
    body: new URLSearchParams({
      handle: /name="handle" value="([^"]+)"/.exec(page)?.[1] ?? "",
      decision: "approve",
      password: "local-test-password-for-oauth",
    }),
    redirect: "manual",
  });
  expect(approved.status).toBe(302);
  const redirected = new URL(approved.headers.get("location") ?? "");
  expect(`${redirected.origin}/`).toBe(EXTENSION_REDIRECT);
  expect(redirected.searchParams.get("state")).toBe("extension-state");
  const tokenResponse = await SELF.fetch("http://localhost/token", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      origin: EXTENSION_ORIGIN,
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: redirected.searchParams.get("code") ?? "",
      redirect_uri: EXTENSION_REDIRECT,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: "http://localhost/mcp",
    }),
  });
  expect(tokenResponse.status).toBe(200);
  const token = await tokenResponse.json<{
    access_token: string;
    refresh_token: string;
    scope: string;
  }>();
  expect(token.scope.split(" ").sort()).toEqual([...granted].sort());
  return { clientId: client.client_id, ...token };
}

function mcp(
  name: string,
  args: Record<string, unknown>,
  accessToken: string,
  origin?: string,
): Promise<Response> {
  return SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json",
      host: "localhost",
      "mcp-protocol-version": "2025-11-25",
      ...(origin ? { origin } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
}

async function pkceChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(verifier),
  );
  return bytesToBase64Url(new Uint8Array(digest));
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
