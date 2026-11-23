import { type McpScope, normalizeMcpScopes } from "./scopes";

/**
 * The capture extension's base grant. Consent for a Chrome extension client
 * grants these whatever it asked for, so a browser extension never holds the
 * full case.
 */
export const CHROME_EXTENSION_SCOPES = [
  "assets:read",
  "assets:write",
  "sources:write",
] as const satisfies readonly McpScope[];

/**
 * Scopes an extension gets only by asking for them. Extension 0.7.0 refuses a
 * grant other than the base three, so adding one here unasked would break it.
 */
export const CHROME_EXTENSION_OPTIONAL_SCOPES = [
  "todos:write",
] as const satisfies readonly McpScope[];

/**
 * The base scopes plus whichever optional ones were requested, in canonical
 * order. Anything else requested is ignored.
 */
export function chromeExtensionGrant(requested: Iterable<string>): McpScope[] {
  const asked = new Set(requested);
  return normalizeMcpScopes([
    ...CHROME_EXTENSION_SCOPES,
    ...CHROME_EXTENSION_OPTIONAL_SCOPES.filter((scope) => asked.has(scope)),
  ]);
}

const CHROMIUM_APP_REDIRECT = /^https:\/\/([a-p]{32})\.chromiumapp\.org\/$/;

/**
 * The extension id behind a `chrome.identity` redirect URI, or null. Chrome
 * delivers `https://<id>.chromiumapp.org/` only to the installed extension
 * with that id, so the redirect names the one extension that receives tokens.
 */
export function chromeExtensionId(redirectUri: string): string | null {
  return CHROMIUM_APP_REDIRECT.exec(redirectUri)?.[1] ?? null;
}
