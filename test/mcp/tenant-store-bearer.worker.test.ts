import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { McpScope } from "~/auth/scopes";
import { mintBearerToken } from "~/concepts/tokens";
import { requireBrowserStore } from "~/store/tenant.server";
import { handleCapture } from "../../workers/capture";
import { handleHookConfig, handleStartupBrief } from "../../workers/config";
import { handleLibrary } from "../../workers/library";

const PEPPER = "local-test-token-pepper";
const settings = {
  ...env,
  TOKEN_PEPPER: PEPPER,
  SESSION_SECRET: "tenant-store-bearer-secret",
};
const OWNER = "local";
const OTHER = "usr_bearer_other";
const MINE = "ast_00000000-0000-4000-8000-0000000000c1";

beforeEach(async () => {
  await env.BUNDLES.put(`u/${OWNER}/objects/obj_c1`, "owner bytes");
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO users (user_id, display_name, created_at, email_verified)
       VALUES (?, ?, unixepoch(), 1)`,
    ).bind(OTHER, OTHER),
    env.DB.prepare(
      `INSERT INTO objects (object_id, user_id, r2_key, name, content_type, size, sha256, created_at)
       VALUES ('obj_c1', ?, ?, 'notes.txt', 'text/plain', 11, 'fixture-sha', 1)`,
    ).bind(OWNER, `u/${OWNER}/objects/obj_c1`),
    env.DB.prepare(
      `INSERT INTO assets (asset_id, user_id, state, object_id, title, file_name, content_type,
         declared_size, tags_json, source_agent, source_client, created_at, updated_at, finalized_at)
       VALUES (?, ?, 'ready', 'obj_c1', 'Owner notes', 'notes.txt', 'text/plain', 11, '[]',
         'fixture', 'test', 1, 1, 1)`,
    ).bind(MINE, OWNER),
  ]);
});

afterEach(async () => {
  for (const table of [
    "bearer_token_scopes",
    "bearer_token_grants",
    "bearer_tokens",
    "hook_configs",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "assets",
    "objects",
    "memories",
    "search_docs",
    "vector_pending",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
  const objects = await env.BUNDLES.list();
  if (objects.objects.length)
    await env.BUNDLES.delete(objects.objects.map((object) => object.key));
});

async function token(userId: string, scopes: McpScope[]) {
  const { token } = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: PEPPER },
    { userId, label: `script-${userId}`, scopes },
  );
  return token;
}

function request(path: string, token: string, init: RequestInit = {}) {
  return new Request(`https://valise.test${path}?userId=${OWNER}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      // A forged loopback identity header must not choose the tenant.
      "x-valise-user": OWNER,
      ...(init.headers ?? {}),
    },
  });
}

async function ownerStore() {
  const url = "https://valise.test/";
  const { createSessionCookie } = await import("~/lib/auth.server");
  const cookie = await createSessionCookie(settings, new Request(url), OWNER);
  return (
    await requireBrowserStore(
      settings,
      new Request(url, { headers: { cookie } }),
    )
  ).store;
}

describe("bearer HTTP endpoints on the tenant store", () => {
  it("serves hook config and the startup brief for the token's tenant only", async () => {
    const owner = await ownerStore();
    const { document } = await owner.hooks.read();
    await owner.hooks.write(`${document}\n# owner edit`);
    await owner.memories.save({
      type: "fact",
      title: "Owner-only brief item",
      body: "Evidence.",
      tags: ["brief"],
    });
    const member = await token(OTHER, ["config:read"]);

    const hooks = await handleHookConfig(
      request("/config/hooks", member),
      settings,
    );
    expect(hooks.status).toBe(200);
    expect(await hooks.text()).not.toContain("# owner edit");
    const brief = await handleStartupBrief(
      request("/config/brief", member),
      settings,
    );
    expect(brief.status).toBe(200);
    expect(await brief.text()).not.toContain("Owner-only brief item");
  });

  it("exports and serves only the token's own library", async () => {
    const member = await token(OTHER, ["assets:read", "sources:read"]);
    const exported = await handleLibrary(
      request("/library/export", member),
      settings,
      new URL("https://valise.test/library/export"),
    );
    expect(exported?.status).toBe(200);
    expect(JSON.stringify(await exported?.json())).not.toContain(MINE);

    const path = `/library/export/files/${MINE}`;
    const stolen = await handleLibrary(
      request(path, member),
      settings,
      new URL(`https://valise.test${path}`),
    );
    expect(stolen?.status).toBe(404);
    const own = await handleLibrary(
      request(path, await token(OWNER, ["assets:read"])),
      settings,
      new URL(`https://valise.test${path}`),
    );
    expect(await own?.text()).toBe("owner bytes");
  });

  it("captures a bookmark under the token's tenant, labelled as the Shortcut", async () => {
    const member = await token(OTHER, ["sources:write"]);
    const response = await handleCapture(
      request("/capture", member, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ url: "https://example.test/shared" }),
      }),
      settings,
    );
    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(
        "SELECT user_id, source_agent, source_client FROM sources",
      ).all(),
    ).toMatchObject({
      results: [
        {
          user_id: OTHER,
          source_agent: "ios-shortcut",
          source_client: "capture",
        },
      ],
    });
  });

  it("refuses a token without the scope and a revoked or unknown token", async () => {
    const readOnly = await token(OTHER, ["assets:read"]);
    const refused = await handleCapture(
      request("/capture", readOnly, {
        method: "POST",
        body: JSON.stringify({ url: "https://example.test/x" }),
      }),
      settings,
    );
    expect(refused.status).toBe(403);
    const unknown = await handleHookConfig(
      request("/config/hooks", "vls_not-a-real-token"),
      settings,
    );
    expect(unknown.status).toBe(401);
  });
});
