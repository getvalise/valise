import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { consentGrant, type McpScope } from "~/auth/scopes";
import { trimActivity } from "~/concepts/activity";
import { proposeRunnable } from "~/concepts/hook-runnables";
import { mintBearerToken } from "~/concepts/tokens";
import { nowSeconds, sha256Hex } from "~/r2/objects";

/**
 * ADR-0023 delivery: `hooks:exec`, `GET /mcp/hooks/manifest`,
 * `POST /mcp/hooks/runs` and the signed `/hook-files/{id}` route, through the
 * Worker's own OAuth provider with console-minted bearer tokens.
 */

const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};
const SCRIPT = "#!/bin/sh\necho handoff > .git/HANDOFF.md\n";
const HANDOFF = {
  name: "handoff",
  event: "Stop" as const,
  argv: ["sh", "./handoff.sh"],
  files: [{ path: "handoff.sh", content: SCRIPT }],
  gates: { every_turns: 10 },
  outputs: [".git/HANDOFF.md"],
};

afterEach(async () => {
  for (const table of [
    "hook_runs",
    "hook_runnable_decisions",
    "hook_runnable_versions",
    "hook_runnables",
    "assets",
    "objects",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

async function propose(input: Record<string, unknown> = HANDOFF) {
  const proposed = await proposeRunnable(
    env,
    input as Parameters<typeof proposeRunnable>[1],
    provenance,
  );
  if (!("version" in proposed) || !proposed.version)
    throw new Error(JSON.stringify(proposed));
  return proposed.version.versionHash;
}

async function decide(
  versionHash: string,
  decision: "approved" | "rejected" | "revoked" | "suspended",
) {
  // What the console's approval route will write (todo:tdo_a98f12e2).
  await env.DB.prepare(
    `INSERT INTO hook_runnable_decisions (user_id, version_hash, decision, credential_id, at)
     VALUES ('local', ?, ?, 'cred-test', ?)`,
  )
    .bind(versionHash, decision, nowSeconds())
    .run();
}

async function bearer(scopes: McpScope[]): Promise<string> {
  const minted = await mintBearerToken(
    { DB: env.DB, TOKEN_PEPPER: "local-test-token-pepper" },
    { userId: "local", label: `runner-${crypto.randomUUID()}`, scopes },
  );
  return minted.token;
}

async function request(
  path: string,
  token: string,
  init: { method?: string; body?: unknown } = {},
) {
  const response = await SELF.fetch(
    new Request(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers: {
        authorization: `Bearer ${token}`,
        host: "localhost",
        "content-type": "application/json",
        "x-valise-session": "session-a",
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    }),
  );
  return { response, body: (await response.json()) as Record<string, any> };
}

function report(versionHash: string, extra: Record<string, unknown> = {}) {
  return {
    run_id: `run_${crypto.randomUUID()}`,
    name: "handoff",
    version_hash: versionHash,
    machine: "mbp",
    session: "session-a",
    repo: "getvalise/valise",
    started_at: nowSeconds() - 30,
    duration_ms: 12_000,
    outcome: "ok",
    cost_usd: 0.0042,
    result: "HANDOFF.md written",
    ...extra,
  };
}

describe("hooks:exec", () => {
  it("is never part of the whole-case grant, only of a request that names it", () => {
    expect(consentGrant(["search:read"])).not.toContain("hooks:exec");
    expect(consentGrant(["search:read"])).toContain("transcripts:write");
    expect(consentGrant(["search:read", "hooks:exec"])).toEqual([
      "search:read",
      "hooks:exec",
    ]);
  });

  it("is required for the manifest and for run reports", async () => {
    const token = await bearer(["search:read", "config:write"]);
    const manifest = await request("/mcp/hooks/manifest", token);
    expect(manifest.response.status).toBe(403);
    expect(manifest.body).toMatchObject({
      error: "insufficient_scope",
      scope: "hooks:exec",
    });
    const runs = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: {},
    });
    expect(runs.response.status).toBe(403);
  });

  it("refuses a request with no token", async () => {
    const response = await SELF.fetch(
      new Request("http://localhost/mcp/hooks/manifest", {
        headers: { host: "localhost" },
      }),
    );
    expect(response.status).toBe(401);
  });
});

describe("GET /mcp/hooks/manifest", () => {
  it("lists only approved, enabled entries, with signed file URLs", async () => {
    const approved = await propose();
    await decide(approved, "approved");
    // A pending proposal of another entry never appears.
    await propose({ ...HANDOFF, name: "pending-only" });
    // A newer pending version of the approved entry does not replace it.
    await propose({ ...HANDOFF, argv: ["sh", "./handoff.sh", "--new"] });

    const token = await bearer(["hooks:exec"]);
    const { response, body } = await request("/mcp/hooks/manifest", token);
    expect(response.status).toBe(200);
    expect(body.entries).toHaveLength(1);
    const [entry] = body.entries;
    expect(entry).toMatchObject({
      name: "handoff",
      version_hash: approved,
      event: "Stop",
      argv: ["sh", "./handoff.sh"],
      gates: { every_turns: 10 },
      outputs: [".git/HANDOFF.md"],
      timeout_seconds: 600,
      daily_cap_usd: 0.5,
      max_runs_per_day: 20,
      today: { cost_usd: 0, runs: 0 },
    });
    const [file] = entry.files;
    expect(file).toMatchObject({
      path: "handoff.sh",
      sha256: await sha256Hex(
        new TextEncoder().encode(SCRIPT).buffer as ArrayBuffer,
      ),
      size: new TextEncoder().encode(SCRIPT).byteLength,
    });
    expect(file.expires_at - body.generated_at).toBe(600);

    // The signed URL needs no token and returns the exact bytes.
    const url = new URL(file.url);
    const download = await SELF.fetch(
      new Request(`http://localhost${url.pathname}${url.search}`),
    );
    expect(download.status).toBe(200);
    expect(await download.text()).toBe(SCRIPT);

    // A tampered signature is refused.
    url.searchParams.set("signature", "x".repeat(43));
    const tampered = await SELF.fetch(
      new Request(`http://localhost${url.pathname}${url.search}`),
    );
    expect(tampered.status).toBe(403);
  });

  it("leaves out a disabled entry and a revoked version", async () => {
    const handoff = await propose();
    await decide(handoff, "approved");
    const other = await propose({ ...HANDOFF, name: "other" });
    await decide(other, "approved");
    await decide(other, "revoked");
    await env.DB.prepare(
      "UPDATE hook_runnables SET disabled_at = ? WHERE name = 'handoff'",
    )
      .bind(nowSeconds())
      .run();
    const { body } = await request(
      "/mcp/hooks/manifest",
      await bearer(["hooks:exec"]),
    );
    expect(body.entries).toEqual([]);
  });

  it("records the call in mcp_calls", async () => {
    await request("/mcp/hooks/manifest", await bearer(["hooks:exec"]));
    await expect
      .poll(async () =>
        env.DB.prepare(
          "SELECT method, required_scope AS scope, outcome FROM mcp_calls",
        ).all(),
      )
      .toMatchObject({
        results: [
          { method: "hooks/manifest", scope: "hooks:exec", outcome: "ok" },
        ],
      });
  });
});

describe("hook file URLs", () => {
  it("serve only hook files, and an asset download URL never serves one", async () => {
    const approved = await propose();
    await decide(approved, "approved");
    const { body } = await request(
      "/mcp/hooks/manifest",
      await bearer(["hooks:exec"]),
    );
    const hookAssetId = new URL(body.entries[0].files[0].url).pathname.split(
      "/",
    )[2];
    // The ordinary download route reads assets with purpose IS NULL.
    const expires = nowSeconds() + 60;
    const asDownload = await SELF.fetch(
      new Request(
        `http://localhost/downloads/${hookAssetId}?expires=${expires}&signature=${"a".repeat(43)}`,
      ),
    );
    expect(asDownload.status).toBe(403);
  });
});

describe("POST /mcp/hooks/runs", () => {
  it("records a run once per run_id and counts it in the manifest", async () => {
    const approved = await propose();
    await decide(approved, "approved");
    const token = await bearer(["hooks:exec"]);
    const sent = report(approved);
    const first = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: sent,
    });
    expect(first.response.status).toBe(200);
    expect(first.body).toEqual({ recorded: true, suspended: false });
    const again = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: sent,
    });
    expect(again.body).toEqual({ recorded: false, suspended: false });
    await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: report(approved, { cost_usd: null, outcome: "failed" }),
    });

    const { body } = await request("/mcp/hooks/manifest", token);
    expect(body.entries[0].today).toEqual({ cost_usd: 0.0042, runs: 2 });
  });

  it("suspends the approved version on a tracked-file violation, once", async () => {
    const approved = await propose();
    await decide(approved, "approved");
    const token = await bearer(["hooks:exec"]);
    const violation = report(approved, { outcome: "violation" });
    const first = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: violation,
    });
    expect(first.body).toEqual({ recorded: true, suspended: true });
    const resent = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: violation,
    });
    expect(resent.body).toEqual({ recorded: false, suspended: false });
    const decisions = await env.DB.prepare(
      "SELECT decision, reason FROM hook_runnable_decisions WHERE decision = 'suspended'",
    ).all<{ decision: string; reason: string }>();
    expect(decisions.results).toHaveLength(1);
    expect(decisions.results[0].reason).toContain("changed a tracked file");

    const { body } = await request("/mcp/hooks/manifest", token);
    expect(body.entries).toEqual([]);
  });

  it("refuses a report for a version that is not the named hook's", async () => {
    const approved = await propose();
    const other = await propose({ ...HANDOFF, name: "other" });
    const token = await bearer(["hooks:exec"]);
    const wrongName = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: report(other),
    });
    expect(wrongName.response.status).toBe(404);
    const unknown = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: report("0".repeat(64)),
    });
    expect(unknown.response.status).toBe(404);
    const malformed = await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: { ...report(approved), outcome: "great" },
    });
    expect(malformed.response.status).toBe(400);
    expect(malformed.body.message).toContain("outcome");
    expect(
      (await env.DB.prepare("SELECT COUNT(*) AS n FROM hook_runs").first())?.n,
    ).toBe(0);
  });

  it("keeps a long result to 2 KiB and trims reports after 90 days", async () => {
    const approved = await propose();
    const token = await bearer(["hooks:exec"]);
    await request("/mcp/hooks/runs", token, {
      method: "POST",
      body: report(approved, { result: "é".repeat(2000) }),
    });
    const row = await env.DB.prepare("SELECT result FROM hook_runs").first<{
      result: string;
    }>();
    expect(new TextEncoder().encode(row?.result).byteLength).toBe(2048);

    await env.DB.prepare("UPDATE hook_runs SET started_at = ?")
      .bind(nowSeconds() - 91 * 86_400)
      .run();
    const removed = await trimActivity(env);
    expect(removed.hookRuns).toBe(1);
  });
});
