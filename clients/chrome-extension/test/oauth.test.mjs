import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { REQUESTED_SCOPES, ValiseClient } from "../client.mjs";
import { connect, disconnect, refreshAccess } from "../oauth.mjs";
import { readConnection } from "../settings.mjs";

const ENDPOINT = "https://app.valise.run/mcp";
const EXTENSION_ID = "abcdefghijklmnopabcdefghijklmnop";
const REDIRECT = `https://${EXTENSION_ID}.chromiumapp.org/`;
const CAPTURE_SCOPES = "assets:write assets:read sources:write";
const GRANTED = "todos:write assets:read assets:write sources:write";

/** Chrome's extension APIs, stubbed: storage, permissions and identity. */
function browser({ granted = true, authorize } = {}) {
  const state = {};
  const events = [];
  const grants = new Set();
  return {
    events,
    grants,
    state,
    storage: {
      local: {
        setAccessLevel: async (value) =>
          assert.deepEqual(value, { accessLevel: "TRUSTED_CONTEXTS" }),
        get: async () => state,
        set: async (values) => Object.assign(state, values),
        remove: async (key) => {
          delete state[key];
        },
      },
      get sync() {
        assert.fail("Never use Chrome sync for authentication");
      },
    },
    permissions: {
      request: async ({ origins }) => {
        events.push(`permission ${origins.join(" ")}`);
        if (granted) grants.add(origins[0]);
        return granted;
      },
      contains: async ({ origins }) => origins.every((o) => grants.has(o)),
      remove: async ({ origins }) => {
        // Chrome refuses to remove a permission the manifest requires.
        if (origins.includes("https://app.valise.run/*"))
          throw new Error("You cannot remove required permissions.");
        for (const origin of origins) grants.delete(origin);
        return true;
      },
    },
    identity: {
      getRedirectURL: () => REDIRECT,
      launchWebAuthFlow: async ({ url, interactive }) => {
        assert.equal(interactive, true);
        events.push("auth window");
        return authorize(new URL(url));
      },
    },
  };
}

/** The OAuth endpoints and /mcp, answering as the Worker does. */
function valise({ scope = GRANTED, refreshStatus = 200 } = {}) {
  const log = [];
  const live = new Set();
  let issued = 0;
  let challenge;
  const issue = () => {
    issued++;
    const pair = { access: `access-${issued}`, refresh: `refresh-${issued}` };
    live.add(pair.access);
    live.add(pair.refresh);
    return pair;
  };
  const json = (body, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  const fetcher = async (url, init) => {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    const path = new URL(url).pathname;
    if (path === "/register") {
      const body = JSON.parse(init.body);
      log.push({ path, body });
      assert.deepEqual(body.redirect_uris, [REDIRECT]);
      assert.equal(body.token_endpoint_auth_method, "none");
      const registered = log.filter((entry) => entry.path === path).length;
      return json({ client_id: `client-${registered}` }, 201);
    }
    if (path === "/token") {
      const body = Object.fromEntries(new URLSearchParams(init.body));
      log.push({ path, body });
      if (!body.grant_type) {
        // RFC 7009: revoking the refresh token ends the grant.
        const n = body.token.split("-")[1];
        live.delete(`refresh-${n}`);
        live.delete(`access-${n}`);
        return new Response("", { status: 200 });
      }
      if (body.grant_type === "authorization_code") {
        assert.equal(body.code, "the-code");
        assert.equal(body.redirect_uri, REDIRECT);
        assert.equal(body.resource, ENDPOINT);
        assert.equal(
          createHash("sha256").update(body.code_verifier).digest("base64url"),
          challenge,
        );
        const pair = issue();
        return json({
          access_token: pair.access,
          refresh_token: pair.refresh,
          scope,
        });
      }
      assert.equal(body.grant_type, "refresh_token");
      if (refreshStatus !== 200 || !live.has(body.refresh_token))
        return json({ error: "invalid_grant" }, 400);
      live.delete(body.refresh_token);
      const pair = issue();
      return json({
        access_token: pair.access,
        refresh_token: pair.refresh,
        scope,
      });
    }
    assert.equal(url, ENDPOINT);
    const token = init.headers.authorization.slice("Bearer ".length);
    log.push({ path, token });
    if (!live.has(token)) return new Response("expired", { status: 401 });
    const { id } = JSON.parse(init.body);
    return json({
      jsonrpc: "2.0",
      id,
      result: { structuredContent: { ok: true } },
    });
  };
  const approve = (url) => {
    assert.equal(url.origin, "https://app.valise.run");
    assert.equal(url.pathname, "/authorize");
    assert.equal(url.searchParams.get("redirect_uri"), REDIRECT);
    assert.equal(url.searchParams.get("scope"), REQUESTED_SCOPES.join(" "));
    assert.equal(url.searchParams.get("code_challenge_method"), "S256");
    challenge = url.searchParams.get("code_challenge");
    const back = new URL(REDIRECT);
    back.searchParams.set("code", "the-code");
    back.searchParams.set("state", url.searchParams.get("state"));
    return back.href;
  };
  return { fetcher, approve, log, live };
}

test("Connect asks for the host first, registers, runs PKCE and stores tokens locally", async () => {
  const server = valise();
  const chrome = browser({ authorize: server.approve });
  const connection = await connect(chrome, ENDPOINT, async (url, init) => {
    chrome.events.push(`fetch ${new URL(url).pathname}`);
    return server.fetcher(url, init);
  });
  assert.deepEqual(chrome.events, [
    "permission https://app.valise.run/*",
    "fetch /register",
    "auth window",
    "fetch /token",
  ]);
  assert.equal(server.log[0].body.client_name, "Valise capture");
  assert.equal(
    server.log[0].body.scope,
    "assets:write assets:read sources:write todos:write",
  );
  assert.deepEqual(await readConnection(chrome), {
    endpoint: ENDPOINT,
    oauth: {
      clientId: "client-1",
      accessToken: "access-1",
      refreshToken: "refresh-1",
      scopes: ["todos:write", "assets:read", "assets:write", "sources:write"],
    },
  });
  assert.deepEqual(connection, await readConnection(chrome));
  assert.deepEqual([...chrome.grants], ["https://app.valise.run/*"]);
});

test("Connect saves nothing when the host, the window or the answer is refused", async () => {
  const server = valise();
  const cases = [
    [browser({ granted: false }), /permission was not granted/],
    [
      browser({
        authorize: async () => {
          throw new Error("The user did not approve access.");
        },
      }),
      /window closed before approval/,
    ],
    [
      browser({
        authorize: (url) => {
          server.approve(url);
          return `${REDIRECT}?code=the-code&state=forged`;
        },
      }),
      /different request/,
    ],
    [
      browser({
        authorize: (url) =>
          `${REDIRECT}?error=access_denied&state=${url.searchParams.get("state")}`,
      }),
      /Access was denied/,
    ],
  ];
  for (const [chrome, message] of cases) {
    await assert.rejects(connect(chrome, ENDPOINT, server.fetcher), message);
    assert.equal(await readConnection(chrome), null);
  }
});

test("Connect accepts a capture-only grant from a Valise without to-dos", async () => {
  const server = valise({ scope: CAPTURE_SCOPES });
  const chrome = browser({ authorize: server.approve });
  await connect(chrome, ENDPOINT, server.fetcher);
  assert.deepEqual((await readConnection(chrome)).oauth.scopes, [
    "assets:write",
    "assets:read",
    "sources:write",
  ]);
  assert.equal(server.live.has("refresh-1"), true);
});

test("Connect refuses and revokes a grant wider than it asked for, or short of capture", async () => {
  for (const scope of [
    `${GRANTED} memories:write`,
    "assets:write assets:read todos:write",
  ]) {
    const server = valise({ scope });
    const chrome = browser({ authorize: server.approve });
    await assert.rejects(connect(chrome, ENDPOINT, server.fetcher), (error) => {
      assert.match(
        error.message,
        new RegExp(`^Valise granted ${scope.split(" ").join(", ")};`),
      );
      assert.match(
        error.message,
        /accepts assets:write, assets:read, sources:write, optionally with todos:write\. Nothing was saved\.$/,
      );
      return true;
    });
    assert.equal(await readConnection(chrome), null);
    assert.equal(server.live.has("refresh-1"), false);
  }
});

test("a 401 refreshes once, retries, and keeps the rotated tokens", async () => {
  const server = valise();
  const chrome = browser({ authorize: server.approve });
  await connect(chrome, ENDPOINT, server.fetcher);
  server.live.delete("access-1"); // the hour-long access token expired
  const client = new ValiseClient(
    await readConnection(chrome),
    server.fetcher,
    () => refreshAccess(chrome, server.fetcher),
  );
  assert.deepEqual(await client.tool("save_source", {}), { ok: true });
  assert.deepEqual(
    server.log.filter((entry) => entry.path === "/mcp").map((e) => e.token),
    ["access-1", "access-2"],
  );
  assert.deepEqual((await readConnection(chrome)).oauth, {
    clientId: "client-1",
    accessToken: "access-2",
    refreshToken: "refresh-2",
    scopes: ["todos:write", "assets:read", "assets:write", "sources:write"],
  });
});

test("a revoked connection asks to reconnect instead of looping", async () => {
  const server = valise({ refreshStatus: 400 });
  const chrome = browser({ authorize: server.approve });
  await connect(chrome, ENDPOINT, server.fetcher);
  server.live.delete("access-1");
  const client = new ValiseClient(
    await readConnection(chrome),
    server.fetcher,
    () => refreshAccess(chrome, server.fetcher),
  );
  await assert.rejects(client.tool("save_source", {}), (error) => {
    assert.match(error.message, /expired or was revoked in Connections/);
    assert.equal(error.signedOut, true);
    return true;
  });
  assert.equal(server.log.filter((entry) => entry.path === "/mcp").length, 1);
  // The tokens are gone and the endpoint stays, so the popup offers Connect.
  assert.deepEqual(await readConnection(chrome), { endpoint: ENDPOINT });
});

test("a refresh that cannot reach Valise keeps the tokens", async () => {
  const server = valise();
  const chrome = browser({ authorize: server.approve });
  await connect(chrome, ENDPOINT, server.fetcher);
  const stored = await readConnection(chrome);
  await assert.rejects(
    refreshAccess(chrome, async () => {
      throw new TypeError("Failed to fetch");
    }),
    (error) => !error.signedOut,
  );
  assert.deepEqual(await readConnection(chrome), stored);
});

test("Connect opened by the popup uses the grant the popup asked for", async () => {
  const server = valise();
  const denied = browser({ authorize: server.approve });
  await assert.rejects(
    connect(denied, ENDPOINT, server.fetcher, { askAccess: false }),
    /site access for Valise was not granted/,
  );
  assert.deepEqual(denied.events, []);
  const chrome = browser({ authorize: server.approve });
  chrome.grants.add("https://app.valise.run/*");
  await connect(chrome, ENDPOINT, server.fetcher, { askAccess: false });
  assert.deepEqual(chrome.events, ["auth window"]);
  assert.equal((await readConnection(chrome)).oauth.accessToken, "access-1");
});

test("Disconnect revokes the grant in Valise, then forgets it here", async () => {
  const server = valise();
  const chrome = browser({ authorize: server.approve });
  await connect(chrome, ENDPOINT, server.fetcher);
  assert.equal(await disconnect(chrome, server.fetcher), true);
  const revocation = server.log.at(-1);
  assert.deepEqual(revocation.body, {
    token: "refresh-1",
    token_type_hint: "refresh_token",
    client_id: "client-1",
  });
  assert.equal(server.live.has("access-1"), false);
  assert.equal(await readConnection(chrome), null);
  // app.valise.run is a manifest permission, so Disconnect leaves it.
  assert.deepEqual([...chrome.grants], ["https://app.valise.run/*"]);
});

test("Disconnect from a self-hosted endpoint drops its site access", async () => {
  const chrome = browser();
  chrome.state.valiseConnection = {
    endpoint: "https://valise.example.com/mcp",
    token: "pasted",
  };
  chrome.grants.add("https://valise.example.com/*");
  assert.equal(await disconnect(chrome, valise().fetcher), false);
  assert.equal(await readConnection(chrome), null);
  assert.equal(chrome.grants.size, 0);
});

test("reconnecting revokes the previous grant", async () => {
  const server = valise();
  const chrome = browser({ authorize: server.approve });
  await connect(chrome, ENDPOINT, server.fetcher);
  await connect(chrome, ENDPOINT, server.fetcher);
  assert.equal(server.live.has("refresh-1"), false);
  assert.equal(server.live.has("refresh-2"), true);
  assert.equal((await readConnection(chrome)).oauth.clientId, "client-2");
});
