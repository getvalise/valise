import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { SHIPPED_HOOKS } from "~/concepts/hook-config";
import {
  listBearerTokens,
  mintBearerToken,
  resolveBearerToken,
} from "~/concepts/tokens";
import { callMcp } from "./fixture-worker";

const tokenEnv = { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" };

afterEach(async () => {
  for (const table of [
    "hook_configs",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function tokenWith(...scopes: string[]): Promise<string> {
  const minted = await mintBearerToken(tokenEnv, {
    userId: "local",
    label: `hook ${scopes.join(" ")}`,
    scopes,
  });
  return minted.token;
}

function getConfig(token?: string, method = "GET"): Promise<Response> {
  const headers = new Headers({ host: "localhost" });
  if (token) headers.set("authorization", `Bearer ${token}`);
  return SELF.fetch(
    new Request("http://localhost/config/hooks", { method, headers }),
  );
}

describe("config:read", () => {
  it("is stored beside the seven scopes bearer_token_scopes' CHECK allows", async () => {
    const minted = await mintBearerToken(tokenEnv, {
      userId: "local",
      label: "Laptop hooks",
      scopes: ["config:read", "search:read"],
    });
    expect(minted.record.scopes).toEqual(["search:read", "config:read"]);

    const grants = await env.DB.prepare(
      "SELECT scope FROM bearer_token_grants WHERE token_id = ?",
    )
      .bind(minted.record.tokenId)
      .all<{ scope: string }>();
    expect(grants.results).toEqual([{ scope: "config:read" }]);

    await expect(resolveBearerToken(tokenEnv, minted.token)).resolves.toEqual(
      minted.record,
    );
    await expect(listBearerTokens(tokenEnv, "local")).resolves.toEqual([
      minted.record,
    ]);
  });

  it("refuses a token holding a grant outside the vocabulary", async () => {
    const minted = await mintBearerToken(tokenEnv, {
      userId: "local",
      label: "Tampered",
      scopes: ["config:read"],
    });
    await env.DB.prepare(
      "INSERT INTO bearer_token_grants (token_id, scope) VALUES (?, ?)",
    )
      .bind(minted.record.tokenId, "config:delete")
      .run();
    await expect(
      resolveBearerToken(tokenEnv, minted.token),
    ).resolves.toBeNull();
  });
});

describe("GET /config/hooks", () => {
  it("answers 401 without a valid bearer token", async () => {
    const missing = await getConfig();
    expect(missing.status).toBe(401);
    expect(missing.headers.get("www-authenticate")).toContain("invalid_token");

    const unknown = await getConfig(`vls_${"a".repeat(43)}`);
    expect(unknown.status).toBe(401);
  });

  it("answers 403 to a token without config:read", async () => {
    const response = await getConfig(await tokenWith("search:read"));
    expect(response.status).toBe(403);
    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer error="insufficient_scope", scope="config:read"',
    );
  });

  it("serves the shipped defaults until a document is stored", async () => {
    const response = await getConfig(await tokenWith("config:read"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe("{}");
  });

  it("serves the stored document byte for byte", async () => {
    const document = JSON.stringify({
      "capture-nudge": { every_turns: 20 },
      custom: [{ event: "SessionStart", text: "Tag with priority:today." }],
    });
    await env.DB.prepare(
      "INSERT INTO hook_configs (user_id, document, updated_at) VALUES (?, ?, ?)",
    )
      .bind("local", document, 1792270000)
      .run();

    const response = await getConfig(await tokenWith("config:read"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(document);
    expect(response.headers.get("last-modified")).toBe(
      new Date(1792270000 * 1000).toUTCString(),
    );
  });

  it("answers 405 to anything but GET", async () => {
    const response = await getConfig(await tokenWith("config:read"), "PUT");
    expect(response.status).toBe(405);
  });
});

describe("list_hooks and edit_hook", () => {
  it("adds, changes, and removes a custom entry, and the hook endpoint serves it", async () => {
    const listed = await tool("list_hooks", {});
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toMatchObject({
      entries: [
        { id: "capture-nudge", shipped: true, event: "Stop" },
        { id: "recall-reminder", shipped: true, event: "SessionStart" },
        {
          id: "recall-on-error",
          shipped: true,
          event: "PostToolUseFailure",
        },
      ],
      updated_at: null,
    });

    const added = await tool("edit_hook", {
      action: "add",
      event: "Stop",
      text: "Write British spelling.",
      every_turns: 5,
    });
    expect(added.isError, JSON.stringify(added)).not.toBe(true);
    expect(added.structuredContent?.entries).toContainEqual({
      id: "custom-0",
      label: "Custom",
      shipped: false,
      event: "Stop",
      text: "Write British spelling.",
      enabled: true,
      every_turns: 5,
      default_text: null,
    });

    const disabled = await tool("edit_hook", {
      action: "change",
      id: "recall-reminder",
      enabled: false,
      every_turns: 1,
    });
    expect(disabled.isError, JSON.stringify(disabled)).not.toBe(true);
    const served = await getConfig(await tokenWith("config:read"));
    expect(JSON.parse(await served.text())).toEqual({
      "recall-reminder": { enabled: false },
      custom: [
        { event: "Stop", text: "Write British spelling.", every_turns: 5 },
      ],
    });

    const removed = await tool("edit_hook", {
      action: "remove",
      id: "custom-0",
    });
    expect(removed.structuredContent?.entries).toHaveLength(3);
  });

  it("refuses to remove a shipped entry, and writes nothing", async () => {
    const refused = await tool("edit_hook", {
      action: "remove",
      id: "capture-nudge",
    });
    expect(refused).toMatchObject({
      isError: true,
      content: [{ text: "A shipped entry can only be off." }],
    });
    const row = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM hook_configs",
    ).first<{ n: number }>();
    expect(row?.n).toBe(0);
  });

  it("names the missing field when an add has no text", async () => {
    const response = await callMcp("tools/call", {
      name: "edit_hook",
      arguments: { action: "add", event: "Stop" },
    });
    expect(response.value.result).toMatchObject({
      isError: true,
      content: [
        { text: "Invalid input for edit_hook. Missing or invalid: text." },
      ],
    });
  });
});

describe("server instructions", () => {
  const initializeParams = {
    protocolVersion: "2025-11-25",
    capabilities: {},
    clientInfo: { name: "vitest", version: "1" },
  };

  async function instructions(
    method: "initialize" | "server/discover",
    headers: Record<string, string> = {},
  ): Promise<string | undefined> {
    const params =
      method === "initialize"
        ? initializeParams
        : {
            _meta: {
              "io.modelcontextprotocol/protocolVersion": "2026-07-28",
              "io.modelcontextprotocol/clientCapabilities": {},
              "io.modelcontextprotocol/clientInfo": {
                name: "vitest",
                version: "1",
              },
            },
          };
    const { response, raw, value } = await callMcp(
      method,
      params,
      "vitest",
      undefined,
      method === "server/discover"
        ? {
            "mcp-protocol-version": "2026-07-28",
            "mcp-method": "server/discover",
            ...headers,
          }
        : headers,
    );
    expect(response.status, raw).toBe(200);
    return value.result.instructions as string | undefined;
  }

  it("gives a client without the plugin every enabled entry, hook-only events as standing rules", async () => {
    for (const method of ["initialize", "server/discover"] as const) {
      const text = await instructions(method);
      expect(text, method).toContain(
        SHIPPED_HOOKS["recall-reminder"].defaults.text,
      );
      expect(text, method).toContain(
        `Whenever a shell command fails:\n${SHIPPED_HOOKS["recall-on-error"].defaults.text}`,
      );
      expect(text, method).toContain(
        `Before you end a turn:\n${SHIPPED_HOOKS["capture-nudge"].defaults.text}`,
      );
    }
  });

  it("gives a plugin client the SessionStart text only, since its hooks mark the other moments", async () => {
    const text = await instructions("initialize", {
      "x-valise-plugin": "valise/0.8.0",
    });
    expect(text).toBe(SHIPPED_HOOKS["recall-reminder"].defaults.text);
  });

  it("follows the next edit: a custom SessionStart entry joins, a disabled one leaves", async () => {
    await tool("edit_hook", {
      action: "add",
      event: "SessionStart",
      text: "Also check the backlog.",
    });
    await tool("edit_hook", {
      action: "change",
      id: "recall-reminder",
      enabled: false,
    });
    const text = await instructions("initialize", {
      "x-valise-plugin": "valise/0.8.0",
    });
    expect(text).toBe("Also check the backlog.");

    await tool("edit_hook", {
      action: "change",
      id: "custom-0",
      enabled: false,
    });
    expect(
      await instructions("initialize", { "x-valise-plugin": "valise/0.8.0" }),
    ).toBeUndefined();
  });
});

async function tool(name: string, args: Record<string, unknown>) {
  const { response, raw, value } = await callMcp("tools/call", {
    name,
    arguments: args,
  });
  expect(response.status, raw).toBe(200);
  return value.result;
}
