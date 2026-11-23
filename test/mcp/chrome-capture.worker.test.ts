import { env, SELF } from "cloudflare:test";
import { afterEach, expect, it } from "vitest";
import { listAssets } from "~/concepts/assets";
import { listSources } from "~/concepts/sources";
import { mintBearerToken, revokeBearerToken } from "~/concepts/tokens";
import { createSessionCookie } from "~/lib/auth.server";
import { ValiseClient } from "../../clients/chrome-extension/client.mjs";
import { oauthManagementApi } from "../../workers/oauth";

const CHROME_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const MISSING_ASSET = "asset:ast_00000000-0000-0000-0000-000000000001";

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

it("the extension's real upload/save sequence publishes tagged original + source to the Library's queries and safe download paths", async () => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    {
      userId: "local",
      label: "Chrome capture",
      scopes: ["assets:write", "assets:read", "sources:write"],
    },
  );
  const client = new ValiseClient(
    { endpoint: "http://localhost/mcp", token: minted.token },
    // workerd does not implement redirect:error. Keep redirects unfollowed in this adapter.
    (input, init) =>
      SELF.fetch(
        new Request(input, {
          ...init,
          redirect: "manual",
          headers: { ...init?.headers, host: "localhost" },
        }),
      ),
  );
  const html =
    "<!doctype html><html><head><title>Chrome wren snapshot</title></head><body><h1>Wren ☀</h1><script>window.stolen=true</script></body></html>";
  const saved = await client.saveArchive(
    {
      html,
      title: "Chrome wren snapshot",
      url: "https://example.org/wren",
      capturedAt: "2026-10-23T12:00:00Z",
      resources: [],
      skipped: 0,
    },
    { tags: ["capture", "birds"], project: "coast" },
  );
  const [assets, sources] = await Promise.all([
    listAssets(env.DB, "local", false),
    listSources(env.DB, "local", false),
  ]);
  expect(assets).toHaveLength(1);
  expect(sources).toHaveLength(1);
  expect(assets[0]).toMatchObject({
    state: "ready",
    title: "Chrome wren snapshot",
    contentType: "text/html",
    project: "coast",
    tags: ["capture", "birds"],
    expiresAt: null,
  });
  expect(sources[0]).toMatchObject({
    kind: "document",
    title: "Chrome wren snapshot",
    url: "https://example.org/wren",
    project: "coast",
    tags: ["capture", "birds"],
  });
  expect(sources[0].assets[0].assetId).toBe(assets[0].assetId);
  expect(saved.libraryUrl).toBe("http://localhost/library");
  const projected = await env.DB.prepare(
    "SELECT concept FROM search_docs WHERE concept IN ('asset','source')",
  ).all();
  expect(projected.results).toHaveLength(2);
  const download = await client.tool("get_asset_download", {
    id: saved.assetId,
  });
  const response = await SELF.fetch(download.url);
  expect(new TextDecoder().decode(await response.arrayBuffer())).toBe(html);
  expect(response.headers.get("content-disposition")).toMatch(/^attachment;/);
  expect(response.headers.get("content-type")).toBe("application/octet-stream");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-security-policy")).toBe(
    "default-src 'none'; sandbox",
  );
  await revokeBearerToken(
    { DB: env.DB },
    { userId: "local", tokenId: minted.record.tokenId },
  );
  await expect(
    client.tool("get_asset_download", { id: saved.assetId }),
  ).rejects.toThrow("rejected the token");
});

it("accepts the scoped bearer from a valid Chrome extension Origin without weakening Host checks", async () => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    {
      userId: "local",
      label: "Chrome origin acceptance",
      scopes: ["assets:write", "assets:read", "sources:write"],
    },
  );
  const client = new ValiseClient(
    { endpoint: "http://localhost/mcp", token: minted.token },
    (input, init) =>
      SELF.fetch(
        new Request(input, {
          ...init,
          redirect: "manual",
          headers: {
            ...init?.headers,
            host: "localhost",
            origin: CHROME_ORIGIN,
          },
        }),
      ),
  );
  const saved = await client.saveArchive(
    {
      html: "<p>Chrome origin snapshot</p>",
      title: "Chrome origin",
      url: "https://example.org/origin",
      capturedAt: "2026-10-23T12:00:00Z",
      resources: [],
      skipped: 0,
    },
    { tags: ["chrome"] },
  );
  expect(saved.sourceId).toMatch(/^source:/);
  const wrongHost = new ValiseClient(
    { endpoint: "http://localhost/mcp", token: minted.token },
    (input, init) =>
      SELF.fetch(
        new Request(input, {
          ...init,
          redirect: "manual",
          headers: {
            ...init?.headers,
            host: "unrelated.example.org",
            origin: CHROME_ORIGIN,
          },
        }),
      ),
  );
  await expect(
    wrongHost.tool("get_asset_download", { id: saved.assetId }),
  ).rejects.toThrow("denied this request");
  const rejected = await readMissingAsset(minted.token, CHROME_ORIGIN, {
    host: "unrelated.example.org",
  });
  expect(rejected.status).toBe(403);
  expect(await rejected.text()).toContain("Invalid Host");
});

it.each([
  "chrome-extension://localhost",
  "chrome-extension://127.0.0.1",
  "chrome-extension://" + "A".repeat(32),
  "chrome-extension://" + "q".repeat(32),
  "chrome-extension://" + "a".repeat(31),
  "chrome-extension://" + "a".repeat(33),
  `${CHROME_ORIGIN}/`,
  `${CHROME_ORIGIN}/path`,
  `${CHROME_ORIGIN}:443`,
  `${CHROME_ORIGIN}?query=1`,
  `${CHROME_ORIGIN}#fragment`,
  `chrome-extension://user@${"a".repeat(32)}`,
  `${CHROME_ORIGIN}, ${CHROME_ORIGIN}`,
  `https://${"a".repeat(32)}`,
  "moz-extension://localhost",
  "null",
])("rejects invalid or impersonated extension Origin %s", async (origin) => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    {
      userId: "local",
      label: "Invalid Chrome origin",
      scopes: ["assets:read"],
    },
  );
  const response = await readMissingAsset(minted.token, origin);
  expect(response.status).toBe(403);
});

it("requires bearer authentication, not a missing/invalid/revoked token or browser cookie", async () => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId: "local", label: "Revoked Chrome", scopes: ["assets:read"] },
  );
  await revokeBearerToken(
    { DB: env.DB },
    { userId: "local", tokenId: minted.record.tokenId },
  );
  for (const token of [undefined, "invalid-token", minted.token]) {
    expect((await readMissingAsset(token, CHROME_ORIGIN)).status).toBe(401);
  }
  const cookie = await createSessionCookie(
    { DB: env.DB, SESSION_SECRET: "local-test-session-secret" },
    new Request("http://localhost/login"),
    "local",
  );
  expect(
    (
      await readMissingAsset(undefined, CHROME_ORIGIN, {
        cookie: cookie.split(";")[0],
      })
    ).status,
  ).toBe(401);
});

it("does not grant extension access to loopback x-valise headers, even with a valid bearer", async () => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId: "local", label: "Spoofed loopback", scopes: ["assets:read"] },
  );
  for (const token of [undefined, minted.token]) {
    const response = await readMissingAsset(token, CHROME_ORIGIN, {
      "x-valise-agent": "spoofed",
      "x-valise-client": "chrome",
    });
    expect(response.status).toBe(403);
    expect(await response.text()).toContain("Origin is not allowed");
  }
});

it("does not extend the Origin exception to OAuth grants not consented to that extension", async () => {
  // Issue a real OAuth grant through the provider's administrative helper,
  // then exchange its S256 authorization code through the actual /token route.
  const api = oauthManagementApi({
    ...env,
    APP_ORIGIN: "http://localhost",
    MCP_RESOURCE_URL: "http://localhost/mcp",
  });
  const redirectUri = "http://127.0.0.1:4567/callback";
  const client = await api.createClient({
    clientName: "Chrome origin OAuth denial",
    redirectUris: [redirectUri],
    tokenEndpointAuthMethod: "none",
  });
  try {
    const verifier = "v".repeat(64);
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    const challenge = btoa(String.fromCharCode(...digest))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
    const { redirectTo } = await api.completeAuthorization({
      request: {
        responseType: "code",
        clientId: client.clientId,
        redirectUri,
        scope: ["assets:read"],
        state: "test",
        resource: "http://localhost/mcp",
        codeChallenge: challenge,
        codeChallengeMethod: "S256",
      },
      userId: "local",
      metadata: {},
      scope: ["assets:read"],
      props: { userId: "local" },
    });
    const response = await SELF.fetch("http://localhost/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: new URL(redirectTo).searchParams.get("code") ?? "",
        client_id: client.clientId,
        redirect_uri: redirectUri,
        code_verifier: verifier,
        resource: "http://localhost/mcp",
      }),
    });
    expect(response.status, await response.clone().text()).toBe(200);
    const token = await response.json<{ access_token: string }>();
    expect((await readMissingAsset(token.access_token)).status).toBe(200);
    expect(
      (await readMissingAsset(token.access_token, CHROME_ORIGIN)).status,
    ).toBe(403);
  } finally {
    await api.deleteClient(client.clientId);
  }
});

function readMissingAsset(
  token?: string,
  origin?: string,
  headers: Record<string, string> = {},
) {
  return SELF.fetch("http://localhost/mcp", {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      host: "localhost",
      "mcp-protocol-version": "2025-11-25",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(origin ? { origin } : {}),
      ...headers,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name: "get_asset_download", arguments: { id: MISSING_ASSET } },
    }),
  });
}

it("refuses an unrelated web Origin even with the correct scoped bearer", async () => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    {
      userId: "local",
      label: "Untrusted origin",
      scopes: ["assets:write", "assets:read", "sources:write"],
    },
  );
  const client = new ValiseClient(
    { endpoint: "http://localhost/mcp", token: minted.token },
    (input, init) =>
      SELF.fetch(
        new Request(input, {
          ...init,
          redirect: "manual",
          headers: {
            ...init?.headers,
            host: "localhost",
            origin: "https://unrelated.example.org",
          },
        }),
      ),
  );
  await expect(
    client.saveArchive(
      {
        html: "<p>Wren</p>",
        title: "Wren",
        url: "https://example.org/wren",
        capturedAt: "2026-10-23T12:00:00Z",
        resources: [],
        skipped: 0,
      },
      {},
    ),
  ).rejects.toThrow("denied this request");
  expect(await listAssets(env.DB, "local", false)).toHaveLength(0);
});

it("a valid token without asset-write is denied before any bytes or source are stored", async () => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId: "local", label: "Read only", scopes: ["assets:read"] },
  );
  const client = new ValiseClient(
    { endpoint: "http://localhost/mcp", token: minted.token },
    (input, init) =>
      SELF.fetch(
        new Request(input, {
          ...init,
          redirect: "manual",
          headers: {
            ...init?.headers,
            host: "localhost",
            origin: CHROME_ORIGIN,
          },
        }),
      ),
  );
  await expect(
    client.saveArchive(
      {
        html: "<p>Wren</p>",
        title: "Wren",
        url: "https://example.org/wren",
        capturedAt: "2026-10-23T12:00:00Z",
        resources: [],
        skipped: 0,
      },
      {},
    ),
  ).rejects.toThrow("token needs");
  expect(await listAssets(env.DB, "local", false)).toHaveLength(0);
  expect(await listSources(env.DB, "local", false)).toHaveLength(0);
});

it("the extension's archive save puts the page's stylesheet in the HTML's folder and the popup's check finds the source", async () => {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    {
      userId: "local",
      label: "Chrome archive folder",
      scopes: ["assets:write", "assets:read", "sources:write"],
    },
  );
  const client = new ValiseClient(
    { endpoint: "http://localhost/mcp", token: minted.token },
    (input, init) =>
      SELF.fetch(
        new Request(input, {
          ...init,
          redirect: "manual",
          headers: { ...init?.headers, host: "localhost" },
        }),
      ),
  );
  expect(await client.checkSaved("https://example.org/styled")).toMatchObject({
    saved: [],
  });
  const saved = await client.saveArchive(
    {
      html: '<!doctype html><html><head><link rel="stylesheet" href="page.css"></head><body><h1 class="title">Styled</h1></body></html>',
      title: "Styled page",
      url: "https://example.org/styled",
      capturedAt: "2026-10-31T12:00:00Z",
      resources: [
        {
          name: "page.css",
          contentType: "text/css",
          base64: btoa(".title{color:red}"),
        },
      ],
      skipped: 1,
    },
    {},
  );
  expect(saved).toMatchObject({ stored: 1, missed: 1 });
  const members = await env.DB.prepare(
    `SELECT a.file_name AS name FROM asset_folder_files m JOIN assets a USING(asset_id)
      WHERE m.folder_id = ? ORDER BY a.file_name`,
  )
    .bind(saved.assetId.slice("asset:".length))
    .all<{ name: string }>();
  expect(members.results.map((row) => row.name)).toContain("page.css");
  expect(members.results).toHaveLength(2);
  const { saved: found } = await client.checkSaved(
    "https://example.org/styled",
  );
  expect(found).toMatchObject([
    { id: saved.sourceId, kind: "document", archive_asset_id: saved.assetId },
  ]);
});
