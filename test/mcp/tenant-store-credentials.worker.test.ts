import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { consoleContext } from "~/console/context.server";
import { createSessionCookie } from "~/lib/auth.server";
import { loader as accountLoader } from "~/routes/account";
import {
  action as connectionsAction,
  loader as connectionsLoader,
} from "~/routes/connections";
import { requireCredentialStore } from "~/store/credentials.server";

const settings = {
  ...env,
  SESSION_SECRET: "tenant-store-credentials-secret",
  TOKEN_PEPPER: "local-test-token-pepper",
};
const OWNER = "local";
const OTHER = "usr_credentials_other";

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, email, display_name, role, created_at, email_verified)
     VALUES (?, 'member@example.test', 'Member', 'member', unixepoch(), 1)`,
  )
    .bind(OTHER)
    .run();
});

afterEach(async () => {
  for (const table of [
    "bearer_token_scopes",
    "bearer_token_grants",
    "bearer_tokens",
    "mcp_calls",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

async function requestFor(
  userId: string,
  path: string,
  init: RequestInit = {},
) {
  // Routing hints in the URL and headers must not choose whose credentials.
  const url = `https://valise.test${path}?userId=${OWNER}`;
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, {
    ...init,
    headers: {
      cookie,
      "x-valise-user": OWNER,
      origin: "https://valise.test",
      ...(init.headers ?? {}),
    },
  });
}

function args(request: Request) {
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  return {
    context,
    request,
    url: new URL(request.url),
    params: {},
    pattern: new URL(request.url).pathname,
  };
}

const credentials = async (userId: string) =>
  requireCredentialStore(settings, await requestFor(userId, "/connections"));

describe("browser credential store", () => {
  it("lists, mints and revokes only the session's own bearer tokens", async () => {
    const owner = await credentials(OWNER);
    const member = await credentials(OTHER);
    const minted = await owner.mintBearer({
      label: "owner-script",
      scopes: ["config:read"],
    });
    if (minted === null) throw new Error("fixture pepper missing");
    await member.mintBearer({
      label: "member-script",
      scopes: ["search:read"],
    });

    expect((await member.bearerTokens()).map((t) => t.label)).toEqual([
      "member-script",
    ]);
    expect(await member.revokeBearer(minted.record.tokenId)).toEqual({
      revoked: false,
    });
    expect(
      (await owner.bearerTokens()).find((t) => t.label === "owner-script")
        ?.revokedAt,
    ).toBeNull();

    const page = await connectionsLoader(
      args(await requestFor(OTHER, "/connections")),
    );
    expect(page.tokens.map((t) => t.label)).toEqual(["member-script"]);
    await connectionsAction(
      args(
        await requestFor(OTHER, "/connections", {
          method: "POST",
          body: new URLSearchParams({
            intent: "revoke",
            id: minted.record.tokenId,
          }),
        }),
      ),
    );
    expect(
      (await owner.bearerTokens()).find((t) => t.label === "owner-script")
        ?.revokedAt,
    ).toBeNull();
  });

  it("shows the session's own account record", async () => {
    const page = await accountLoader(args(await requestFor(OTHER, "/account")));
    expect(page).toEqual({
      email: "member@example.test",
      owner: false,
      hasPassword: false,
      // The member's own first-run checklist, not the owner's.
      onboarding: expect.objectContaining({
        dismissedAt: null,
        connected: false,
        firstSkill: false,
      }),
    });
  });
});
