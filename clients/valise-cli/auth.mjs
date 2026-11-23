import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import http from "node:http";
import { readConfig, writeConfig } from "./config.mjs";

/**
 * One OAuth sign-in per machine, the way an MCP client does it: register a
 * public client with a loopback redirect, send the person to the consent
 * page, catch the code on 127.0.0.1, exchange it with PKCE. The grant asks
 * for `search:read transcripts:write transcripts:read` and the consent page
 * grants exactly that (ADR-0022), so the refresh token on this machine can
 * send and read transcripts and nothing else.
 */

/**
 * This machine has no sign-in, or Valise refused the one it has. Only a new
 * `valise login` fixes it; any other error from the token endpoint does not.
 */
export class SignInNeeded extends Error {
  constructor(reason) {
    super(`${reason}; run \`valise login\`.`);
    this.reason = reason;
  }
}

export const CLI_SCOPES = "search:read transcripts:write transcripts:read";
const CLIENT_NAME = "Valise CLI";

export async function login({ origin, openBrowser = open } = {}) {
  const config = readConfig();
  if (origin) config.origin = origin;
  const base = config.origin.replace(/\/+$/, "");
  const { server, port } = await listen();
  const redirectUri = `http://127.0.0.1:${port}/callback`;
  try {
    const client = await registerClient(base, redirectUri);
    const verifier = base64url(randomBytes(32));
    const state = base64url(randomBytes(16));
    const authorize = new URL(`${base}/authorize`);
    authorize.search = new URLSearchParams({
      response_type: "code",
      client_id: client.client_id,
      redirect_uri: redirectUri,
      scope: CLI_SCOPES,
      resource: `${base}/mcp`,
      code_challenge: base64url(createHash("sha256").update(verifier).digest()),
      code_challenge_method: "S256",
      state,
    }).toString();
    process.stderr.write(
      `Open this page to allow the Valise CLI on ${config.device}:\n${authorize.href}\n`,
    );
    openBrowser(authorize.href);
    const code = await waitForCode(server, state);
    const token = await exchange(base, {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: client.client_id,
      code_verifier: verifier,
      resource: `${base}/mcp`,
    });
    config.auth = {
      client_id: client.client_id,
      redirect_uri: redirectUri,
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
      scope: token.scope ?? CLI_SCOPES,
    };
    const file = writeConfig(config);
    return { file, scope: config.auth.scope, device: config.device };
  } finally {
    server.close();
  }
}

export function logout() {
  const config = readConfig();
  config.auth = null;
  return writeConfig(config);
}

/** A live access token, refreshed when within a minute of expiry. */
export async function accessToken(config = readConfig()) {
  const auth = config.auth;
  if (!auth?.refresh_token) throw new SignInNeeded("Not signed in");
  if (auth.access_token && auth.expires_at - Date.now() > 60_000) {
    return auth.access_token;
  }
  const base = config.origin.replace(/\/+$/, "");
  const token = await exchange(base, {
    grant_type: "refresh_token",
    refresh_token: auth.refresh_token,
    client_id: auth.client_id,
    resource: `${base}/mcp`,
  });
  config.auth = {
    ...auth,
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? auth.refresh_token,
    expires_at: Date.now() + (token.expires_in ?? 3600) * 1000,
    scope: token.scope ?? auth.scope,
  };
  writeConfig(config);
  return config.auth.access_token;
}

async function registerClient(base, redirectUri) {
  const response = await fetch(`${base}/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
    }),
  });
  if (!response.ok) {
    throw new Error(
      `${base}/register answered ${response.status}: ${await response.text()}`,
    );
  }
  return response.json();
}

async function exchange(base, form) {
  const response = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(form),
  }).catch((error) => {
    throw new Error(
      `Cannot reach ${base} (${error.cause?.code ?? error.message}). Check the connection and try again.`,
    );
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reason = body.error ?? response.status;
    if (reason === "invalid_client" || reason === "invalid_grant") {
      throw new SignInNeeded(
        `Valise no longer accepts this machine's sign-in (${reason})`,
      );
    }
    throw new Error(
      `${base}/token answered ${response.status}: ${JSON.stringify(body)}`,
    );
  }
  return body;
}

function listen() {
  return new Promise((resolve, reject) => {
    const server = http.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () =>
      resolve({ server, port: server.address().port }),
    );
  });
}

function waitForCode(server, state) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("No authorization within 10 minutes.")),
      600_000,
    );
    server.on("request", (req, res) => {
      const url = new URL(req.url, "http://127.0.0.1");
      if (url.pathname !== "/callback") {
        res.writeHead(404).end();
        return;
      }
      const error = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      if (url.searchParams.get("state") !== state || !code) {
        res
          .writeHead(400, { "content-type": "text/plain" })
          .end(`Sign-in failed: ${error ?? "no code"}.`);
        clearTimeout(timer);
        reject(
          new Error(
            `Consent did not return a code${error ? ` (${error})` : ""}.`,
          ),
        );
        return;
      }
      res
        .writeHead(200, { "content-type": "text/plain" })
        .end("Valise CLI is signed in. You can close this tab.");
      clearTimeout(timer);
      resolve(code);
    });
  });
}

function open(url) {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "start"
        : "xdg-open";
  try {
    spawn(command, [url], {
      stdio: "ignore",
      detached: true,
      shell: process.platform === "win32",
    }).unref();
  } catch {
    // The URL is already printed; the person can open it by hand.
  }
}

function base64url(buffer) {
  return Buffer.from(buffer)
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
