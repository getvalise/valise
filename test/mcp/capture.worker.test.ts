import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { McpScope } from "~/auth/scopes";
import { readSourceArticle } from "~/concepts/source-articles";
import { enrichSource } from "~/concepts/source-enrichment";
import { PASTE_EXTRACTOR } from "~/concepts/source-paste";
import { readSource, sourceIdOf } from "~/concepts/sources";
import { mintBearerToken, revokeBearerToken } from "~/concepts/tokens";
import { handleCapture } from "../../workers/capture";

/**
 * `POST /capture`, the iPhone Shortcut's save, through the Worker's own
 * routing on a real D1. Whether Shortcuts sends this request is
 * docs/operations/ios-capture.md and unverified on a device.
 */

const PEPPER = "local-test-token-pepper";
const words = (count: number) =>
  Array.from({ length: count }, (_, at) => `hedgerow${at}`).join(" ");

afterEach(async () => {
  for (const table of [
    "search_docs",
    "source_articles",
    "source_enrichments",
    "source_revision_assets",
    "source_revisions",
    "sources",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
});

async function mint(scopes: McpScope[] = ["sources:write"]) {
  return mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: PEPPER },
    { userId: "local", label: "iPhone Shortcut", scopes },
  );
}

function capture(body: unknown, bearer?: string, init: RequestInit = {}) {
  return SELF.fetch("http://localhost/capture", {
    method: "POST",
    ...init,
    headers: {
      "content-type": "application/json",
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...init.headers,
    },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const url = () => `https://example.org/gated/${crypto.randomUUID()}`;

describe("POST /capture", () => {
  it("saves the article the Shortcut sent, so Valise never fetches the page", async () => {
    const { token } = await mint();
    const response = await capture(
      { url: url(), title: "Gated hedgerows", text: words(300), tags: "a, b" },
      token,
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      title: "Gated hedgerows",
      article: true,
      words: 300,
      message: 'Saved "Gated hedgerows" with the article, 300 words.',
      link: expect.stringMatching(
        /^http:\/\/localhost\/library\/read\/src_[0-9a-f-]{36}$/,
      ),
    });
    const sourceId = sourceIdOf(String(body.id)) ?? "";
    expect(await readSource(env.DB, "local", sourceId)).toMatchObject({
      kind: "bookmark",
      tags: ["a", "b"],
    });
    expect(await readSourceArticle(env.DB, "local", sourceId)).toMatchObject({
      extractor: PASTE_EXTRACTOR,
      wordCount: 300,
    });

    const fetcher = vi.fn(async () => new Response("", { status: 500 }));
    const ai = {
      run: vi.fn(async () => ({ response: "{}" })),
    } as unknown as Pick<Ai, "run">;
    await enrichSource(
      { DB: env.DB, AI: ai },
      "local",
      sourceId,
      fetcher,
    ).catch(() => null);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("cuts page HTML like a fetched page", async () => {
    const { token } = await mint();
    const response = await capture(
      {
        url: url(),
        text: `<html><head><title>Hedgerows</title></head><body><nav>Subscribe</nav><article>${words(160)}</article></body></html>`,
      },
      token,
    );
    expect(await response.json()).toMatchObject({
      title: "Hedgerows",
      article: true,
      words: 160,
    });
  });

  it("saves a link with no article and leaves the page to Valise's fetch", async () => {
    const { token } = await mint();
    const page = url();
    const response = await capture({ url: page }, token);
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ article: false, words: 0 });
    expect(body.title).toMatch(/^example\.org\/gated\//);
    const sourceId = sourceIdOf(String(body.id)) ?? "";
    expect(await readSourceArticle(env.DB, "local", sourceId)).toBeNull();

    const fetcher = vi.fn(async () => new Response("", { status: 500 }));
    const ai = {
      run: vi.fn(async () => ({ response: "{}" })),
    } as unknown as Pick<Ai, "run">;
    await enrichSource(
      { DB: env.DB, AI: ai },
      "local",
      sourceId,
      fetcher,
    ).catch(() => null);
    expect(fetcher).toHaveBeenCalled();
  });

  it("revises the bookmark when the same URL is saved again", async () => {
    const { token } = await mint();
    const page = url();
    const first = (await (await capture({ url: page }, token)).json()) as {
      id: string;
    };
    const second = (await (
      await capture({ url: page, text: words(200) }, token)
    ).json()) as { id: string; article: boolean };
    expect(second).toMatchObject({ id: first.id, article: true });
  });

  it("refuses a missing, unknown or revoked token, and says so", async () => {
    expect((await capture({ url: url() })).status).toBe(401);
    expect(
      (await capture({ url: url() }, `vls_${"x".repeat(43)}`)).status,
    ).toBe(401);
    const { token, record } = await mint();
    await revokeBearerToken(env, { userId: "local", tokenId: record.tokenId });
    const revoked = await capture({ url: url() }, token);
    expect(revoked.status).toBe(401);
    expect(await revoked.json()).toMatchObject({
      error: "invalid_token",
      message: expect.stringContaining("Create a new one on Connections"),
    });
  });

  it("needs sources:write, and the capture token reaches nothing else", async () => {
    const { token: reader } = await mint(["sources:read"]);
    expect((await capture({ url: url() }, reader)).status).toBe(403);
    const { token } = await mint();
    const exported = await SELF.fetch("http://localhost/library/export", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(exported.status).toBe(403);
    const mcp = await SELF.fetch("http://localhost/mcp", {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(mcp.status).toBe(403);
  });

  it("refuses what is not a savable JSON capture", async () => {
    const { token } = await mint();
    const get = await SELF.fetch("http://localhost/capture");
    expect(get.status).toBe(405);
    expect(get.headers.get("allow")).toBe("POST");
    expect((await capture("url=x", token)).status).toBe(400);
    expect((await capture({ url: "javascript:alert(1)" }, token)).status).toBe(
      400,
    );
    const large = await capture(
      { url: url(), text: "a".repeat(3 * 1024 * 1024 + 70_000) },
      token,
    );
    expect(large.status).toBe(413);
  });

  it("rate-limits per token", async () => {
    const { token, record } = await mint();
    const keys: string[] = [];
    const limiter = {
      limit: vi.fn(async ({ key }: { key: string }) => {
        keys.push(key);
        return { success: false };
      }),
    } as unknown as RateLimit;
    const response = await handleCapture(
      new Request("https://valise.test/capture", {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
        body: JSON.stringify({ url: url() }),
      }),
      { ...env, TOKEN_PEPPER: PEPPER, CAPTURE_LIMITER: limiter },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("60");
    expect(keys).toEqual([record.tokenId]);
    expect(
      (
        await env.DB.prepare("SELECT COUNT(*) AS n FROM sources").first<{
          n: number;
        }>()
      )?.n,
    ).toBe(0);
  });

  it("is held by the deployed binding after 20 saves a minute", async () => {
    const { token } = await mint();
    const statuses: number[] = [];
    // An empty body answers 400 after admission, so no source is written.
    for (let at = 0; at < 21; at++)
      statuses.push((await capture("", token)).status);
    expect(statuses.slice(0, 20).every((status) => status === 400)).toBe(true);
    expect(statuses[20]).toBe(429);
  });
});
