export const DEFAULT_ENDPOINT = "https://app.valise.run/mcp";
const KEY = "valiseConnection";

export function normalizeEndpoint(value) {
  const url = new URL(value.trim());
  const loopback = ["localhost", "127.0.0.1"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/mcp"
  )
    throw new Error(
      "Use an HTTPS /mcp endpoint without credentials, query or fragment (HTTP is allowed on localhost only).",
    );
  return url.href;
}

export function endpointPermission(endpoint) {
  const url = new URL(normalizeEndpoint(endpoint));
  // Chrome match patterns are host-scoped and cannot restrict by TCP port.
  return `${url.protocol}//${url.hostname}/*`;
}

/**
 * The stored connection: `{ endpoint, token }` for a pasted console token, or
 * `{ endpoint, oauth: { clientId, accessToken, refreshToken, scopes } }` after
 * Connect. `scopes` is what Valise granted; a connection from 0.7.0 has none.
 */
export async function readConnection(browser) {
  await browser.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
  return (await browser.storage.local.get(KEY))[KEY] ?? null;
}

/** Whether a stored connection still carries a credential. */
export function hasCredential(connection) {
  return Boolean(connection?.oauth || connection?.token);
}

/** The endpoint Connect signs in to: the last one used, or app.valise.run. */
export function connectEndpoint(connection) {
  return connection?.endpoint ?? DEFAULT_ENDPOINT;
}

export async function hasEndpointAccess(browser, endpoint) {
  return browser.permissions.contains({
    origins: [endpointPermission(endpoint)],
  });
}

/**
 * Ask for the endpoint host. Chrome requires this to be the first await on
 * the Connect or Save gesture, before any network call. The default host is
 * in the manifest's `host_permissions`, so for it Chrome answers at once.
 * Call it only from Settings: the prompt for any other host takes focus, and
 * a popup that loses focus closes with its script.
 */
export async function requestEndpointAccess(browser, endpoint) {
  const granted = await browser.permissions.request({
    origins: [endpointPermission(endpoint)],
  });
  if (!granted)
    throw new Error(
      "Valise endpoint permission was not granted. Nothing was saved.",
    );
}

/**
 * Replace the stored connection, dropping the old host grant if it moved.
 * Returns the replaced connection so an OAuth grant can be revoked.
 */
export async function storeConnection(browser, connection) {
  const old = await readConnection(browser);
  await browser.storage.local.set({ [KEY]: connection });
  if (
    old &&
    endpointPermission(old.endpoint) !== endpointPermission(connection.endpoint)
  )
    await releaseEndpointAccess(browser, old.endpoint);
  return old;
}

export async function saveConnection(browser, endpoint, token) {
  const normalized = normalizeEndpoint(endpoint);
  const bearer = token.trim();
  if (!bearer || /\s/.test(bearer))
    throw new Error(
      "Paste the console bearer token, without the Bearer prefix.",
    );
  await requestEndpointAccess(browser, normalized);
  return storeConnection(browser, { endpoint: normalized, token: bearer });
}

export async function forgetConnection(browser) {
  const old = await readConnection(browser);
  await browser.storage.local.remove(KEY);
  if (old) await releaseEndpointAccess(browser, old.endpoint);
}

/**
 * Drop a self-hosted endpoint's runtime grant. The default host is a required
 * permission, which Chrome refuses to remove, so it stays.
 */
async function releaseEndpointAccess(browser, endpoint) {
  const origin = endpointPermission(endpoint);
  if (origin === endpointPermission(DEFAULT_ENDPOINT)) return;
  await browser.permissions.remove({ origins: [origin] });
}
