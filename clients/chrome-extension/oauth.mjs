import { CAPTURE_SCOPES, REQUESTED_SCOPES } from "./client.mjs";
import {
  forgetConnection,
  hasEndpointAccess,
  normalizeEndpoint,
  readConnection,
  requestEndpointAccess,
  storeConnection,
} from "./settings.mjs";

const CLIENT_NAME = "Valise capture";
const defaultFetch = (...args) => fetch(...args);

/**
 * Connect: register this extension with the endpoint's OAuth server, let the
 * signed-in owner approve it in a Chrome auth window, and keep the tokens in
 * local storage. Call it on the Connect gesture: the host permission request
 * comes first. `askAccess: false` is for a page the popup opened after it
 * asked on its own gesture; the grant must already be there.
 */
export async function connect(
  browser,
  endpoint,
  fetcher = defaultFetch,
  { askAccess = true } = {},
) {
  const normalized = normalizeEndpoint(endpoint);
  if (askAccess) await requestEndpointAccess(browser, normalized);
  else if (!(await hasEndpointAccess(browser, normalized)))
    throw new Error(
      "Chrome site access for Valise was not granted. Nothing was saved.",
    );
  const origin = new URL(normalized).origin;
  const redirectUri = browser.identity.getRedirectURL();

  // A fresh registration per Connect: a stored client id can outlive the
  // server's registration TTL and then fail inside the auth window.
  const registered = await send(
    fetcher,
    `${origin}/register`,
    JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: REQUESTED_SCOPES.join(" "),
    }),
    "application/json",
    "Valise refused to register this extension. Check the endpoint.",
  );
  const clientId = registered.client_id;
  if (typeof clientId !== "string" || !clientId)
    throw new Error("Valise returned no client id. Nothing was saved.");

  const verifier = randomString(32);
  const state = randomString(16);
  const authorize = new URL("/authorize", origin);
  authorize.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: REQUESTED_SCOPES.join(" "),
    resource: normalized,
    state,
    code_challenge: await challengeFor(verifier),
    code_challenge_method: "S256",
  }).toString();
  let returned;
  try {
    returned = new URL(
      await browser.identity.launchWebAuthFlow({
        url: authorize.href,
        interactive: true,
      }),
    );
  } catch {
    throw new Error(
      "The Valise sign-in window closed before approval. Nothing was saved.",
    );
  }
  if (returned.searchParams.get("state") !== state)
    throw new Error("Valise answered a different request. Nothing was saved.");
  const code = returned.searchParams.get("code");
  if (!code)
    throw new Error(
      returned.searchParams.get("error") === "access_denied"
        ? "Access was denied on the Valise consent page. Nothing was saved."
        : "Valise did not approve the extension. Nothing was saved.",
    );

  const tokens = await tokenRequest(
    fetcher,
    origin,
    {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: normalized,
    },
    "Valise did not issue a token. Nothing was saved.",
  );
  const granted = String(tokens.scope ?? "")
    .split(" ")
    .filter(Boolean);
  const connection = {
    endpoint: normalized,
    oauth: {
      clientId,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      scopes: granted,
    },
  };
  // The extension holds capture rights, and to-dos when granted. A server that
  // grants more is refused, so a full-case token never sits in this profile;
  // one that grants only capture, such as an older Valise, still connects.
  if (
    !CAPTURE_SCOPES.every((scope) => granted.includes(scope)) ||
    !granted.every((scope) => REQUESTED_SCOPES.includes(scope))
  ) {
    await revoke(connection, fetcher);
    throw new Error(
      `Valise granted ${granted.join(", ") || "no scopes"}; this extension accepts ${CAPTURE_SCOPES.join(", ")}, optionally with ${REQUESTED_SCOPES.filter((scope) => !CAPTURE_SCOPES.includes(scope)).join(", ")}. Nothing was saved.`,
    );
  }
  const previous = await readConnection(browser);
  if (previous?.oauth) await revoke(previous, fetcher);
  await storeConnection(browser, connection);
  return connection;
}

/**
 * Exchange the stored refresh token after a 401 and keep the rotated pair.
 * Returns the new access token. When Valise refuses the grant, the tokens are
 * dropped and the endpoint kept, so the popup leads with Connect again; the
 * thrown error carries `signedOut`.
 */
export async function refreshAccess(browser, fetcher = defaultFetch) {
  const connection = await readConnection(browser);
  if (!connection?.oauth)
    throw new Error("Valise rejected the token. Reconnect in Settings.");
  let tokens;
  try {
    tokens = await tokenRequest(
      fetcher,
      new URL(connection.endpoint).origin,
      {
        grant_type: "refresh_token",
        refresh_token: connection.oauth.refreshToken,
        client_id: connection.oauth.clientId,
        resource: connection.endpoint,
      },
      "Valise ended this extension's connection; it expired or was revoked in Connections. Connect again, then check Library before retrying.",
    );
  } catch (error) {
    // 400 invalid_grant or 401 invalid_client: the grant is gone for good.
    if (error.status === 400 || error.status === 401) {
      await storeConnection(browser, { endpoint: connection.endpoint });
      error.signedOut = true;
    }
    throw error;
  }
  await storeConnection(browser, {
    endpoint: connection.endpoint,
    oauth: {
      ...connection.oauth,
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token ?? connection.oauth.refreshToken,
    },
  });
  return tokens.access_token;
}

/**
 * Disconnect: revoke an OAuth grant on the server, then forget the local copy
 * and the endpoint grant. Returns whether nothing is left to revoke by hand.
 */
export async function disconnect(browser, fetcher = defaultFetch) {
  const connection = await readConnection(browser);
  const revoked = connection?.oauth ? await revoke(connection, fetcher) : false;
  await forgetConnection(browser);
  return revoked;
}

/**
 * RFC 7009 on the token endpoint. Revoking the refresh token ends the whole
 * grant, so its access tokens stop working too.
 */
export async function revoke(connection, fetcher = defaultFetch) {
  try {
    const response = await fetcher(
      `${new URL(connection.endpoint).origin}/token`,
      request(
        new URLSearchParams({
          token: connection.oauth.refreshToken,
          token_type_hint: "refresh_token",
          client_id: connection.oauth.clientId,
        }),
        "application/x-www-form-urlencoded",
      ),
    );
    return response.ok;
  } catch {
    return false;
  }
}

async function tokenRequest(fetcher, origin, params, failure) {
  const tokens = await send(
    fetcher,
    `${origin}/token`,
    new URLSearchParams(params),
    "application/x-www-form-urlencoded",
    failure,
  );
  if (
    typeof tokens.access_token !== "string" ||
    typeof tokens.refresh_token !== "string"
  )
    throw new Error(failure);
  return tokens;
}

async function send(fetcher, url, body, contentType, failure) {
  let response;
  try {
    response = await fetcher(url, request(body, contentType));
  } catch {
    throw new Error(
      `${failure} The endpoint could not be reached; check its site permission.`,
    );
  }
  // Do not display server bodies: they can reflect credentials.
  if (!response.ok)
    throw Object.assign(new Error(failure), { status: response.status });
  try {
    return await response.json();
  } catch {
    throw new Error(failure);
  }
}

function request(body, contentType) {
  return {
    method: "POST",
    credentials: "omit",
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.timeout(30_000),
    headers: { "content-type": contentType, accept: "application/json" },
    body,
  };
}

function randomString(bytes) {
  return base64Url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function challengeFor(verifier) {
  return base64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
  );
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
