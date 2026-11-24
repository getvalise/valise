import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { listAssets, readAssetRow, visibleAssetIds } from "~/concepts/assets";
import {
  canonicalJson,
  listRunnables,
  PROPOSAL_TTL_SECONDS,
  proposeRunnable,
  runnableVersionHash,
} from "~/concepts/hook-runnables";
import { cleanupLibrary } from "~/concepts/library";
import { nowSeconds } from "~/r2/objects";
import { callMcp } from "./fixture-worker";

// ADR-0023: agents propose runnable hooks; nothing runs until the owner
// approves a version's hash.

const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};

const HANDOFF = {
  name: "handoff",
  event: "Stop",
  argv: ["sh", "./handoff.sh"],
  files: [{ path: "handoff.sh", content: "#!/bin/sh\necho handoff\n" }],
  gates: { min_context_tokens: 120000, git_repo_only: true },
  outputs: ["HANDOFF.md"],
};

afterEach(async () => {
  for (const table of [
    "hook_runnable_decisions",
    "hook_runnable_versions",
    "hook_runnables",
    "hook_configs",
    "assets",
    "objects",
  ]) {
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  }
});

async function tool(name: string, args: Record<string, unknown>) {
  const { response, raw, value } = await callMcp("tools/call", {
    name,
    arguments: args,
  });
  expect(response.status, raw).toBe(200);
  return value.result;
}

async function decide(
  versionHash: string,
  decision: "approved" | "rejected" | "revoked" | "suspended",
  at = nowSeconds(),
) {
  // The approval route is the console's (todo:tdo_a98f12e2); the rows are
  // what it will write.
  await env.DB.prepare(
    `INSERT INTO hook_runnable_decisions (user_id, version_hash, decision, credential_id, at)
     VALUES ('local', ?, ?, 'cred-test', ?)`,
  )
    .bind(versionHash, decision, at)
    .run();
}

function hookAssetIds(files: unknown): string[] {
  return (files as { asset_id: string }[]).map((file) => file.asset_id);
}

describe("propose_hook", () => {
  it("stores a pending version keyed by the hash of its content and files", async () => {
    const result = await tool("propose_hook", HANDOFF);
    expect(result.isError).toBeFalsy();
    const out = result.structuredContent as Record<string, unknown>;
    expect(out).toMatchObject({
      name: "handoff",
      state: "pending",
      running_version_hash: null,
      files: [{ path: "handoff.sh", size: 23 }],
    });
    expect(out.message).toContain("Nothing runs until they approve it");

    const [entry] = await listRunnables(env.DB, "local");
    expect(entry.running).toBeNull();
    expect(entry.pending?.versionHash).toBe(out.version_hash);
    expect(entry.pending?.content).toEqual({
      name: "handoff",
      event: "Stop",
      argv: ["sh", "./handoff.sh"],
      gates: { min_context_tokens: 120000, git_repo_only: true },
      outputs: ["HANDOFF.md"],
      timeout_seconds: 600,
      daily_cap_usd: 0.5,
      max_runs_per_day: 20,
    });
    expect(entry.pending?.expiresAt).toBe(
      (entry.pending?.proposedAt ?? 0) + PROPOSAL_TTL_SECONDS,
    );
    expect(out.version_hash).toBe(
      await runnableVersionHash(entry.pending!.content, entry.pending!.files),
    );
  });

  it("hashes the same content the same way whatever the key order or defaults sent", async () => {
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe(
      '{"a":[{"c":3,"d":2}],"b":1}',
    );
    const first = await proposeRunnable(env, HANDOFF, provenance);
    const second = await proposeRunnable(
      env,
      {
        outputs: ["HANDOFF.md"],
        gates: {
          git_repo_only: true,
          changed_since_last_run: false,
          min_context_tokens: 120000,
        },
        files: HANDOFF.files,
        argv: HANDOFF.argv,
        event: "Stop",
        name: "handoff",
        timeout_seconds: 600,
        daily_cap_usd: 0.5,
      },
      provenance,
    );
    if ("error" in first || "error" in second) throw new Error("refused");
    expect(second.version.versionHash).toBe(first.version.versionHash);
    expect(second.outcome).toBe("pending");
  });

  it("keeps the approved version running while a changed one waits", async () => {
    const v1 = await proposeRunnable(env, HANDOFF, provenance);
    if ("error" in v1) throw new Error(v1.error);
    await decide(v1.version.versionHash, "approved");

    const changed = await tool("propose_hook", {
      ...HANDOFF,
      files: [{ path: "handoff.sh", content: "#!/bin/sh\necho v2\n" }],
    });
    const out = changed.structuredContent as Record<string, unknown>;
    expect(out.state).toBe("pending");
    expect(out.running_version_hash).toBe(v1.version.versionHash);
    expect(out.message).toContain("keeps running until then");

    const [entry] = await listRunnables(env.DB, "local");
    expect(entry.running?.versionHash).toBe(v1.version.versionHash);
    expect(entry.pending?.versionHash).toBe(out.version_hash);

    // Proposing what already runs changes nothing.
    const again = await tool("propose_hook", HANDOFF);
    expect(again.structuredContent).toMatchObject({
      state: "approved",
      version_hash: v1.version.versionHash,
      expires_at: null,
    });
  });

  it("runs the newest approval that still reads approved, and a revoked one stops", async () => {
    const v1 = await proposeRunnable(env, HANDOFF, provenance);
    const v2 = await proposeRunnable(
      env,
      { ...HANDOFF, argv: ["sh", "./handoff.sh", "--quiet"] },
      provenance,
    );
    if ("error" in v1 || "error" in v2) throw new Error("refused");
    await decide(v1.version.versionHash, "approved");
    await decide(v2.version.versionHash, "approved");
    expect((await listRunnables(env.DB, "local"))[0].running?.versionHash).toBe(
      v2.version.versionHash,
    );
    await decide(v2.version.versionHash, "revoked");
    expect((await listRunnables(env.DB, "local"))[0].running?.versionHash).toBe(
      v1.version.versionHash,
    );
    await decide(v1.version.versionHash, "suspended");
    expect((await listRunnables(env.DB, "local"))[0].running).toBeNull();
  });

  it("makes a rejected or expired version pending again when the same content is proposed", async () => {
    const now = nowSeconds();
    const first = await proposeRunnable(env, HANDOFF, provenance, now);
    if ("error" in first) throw new Error(first.error);
    await decide(first.version.versionHash, "rejected", now);
    expect((await listRunnables(env.DB, "local", now))[0].pending).toBeNull();

    const again = await proposeRunnable(env, HANDOFF, provenance, now);
    if ("error" in again) throw new Error(again.error);
    expect(again.outcome).toBe("proposed");
    expect(again.version.state).toBe("pending");
    // The rejection fell in the same second; the renewed proposal is after it.
    expect(again.version.proposedAt).toBe(now + 1);

    const later = now + PROPOSAL_TTL_SECONDS + 10;
    expect((await listRunnables(env.DB, "local", later))[0].pending).toBeNull();
  });

  it("stores each distinct file once, as a hook asset nothing can find or fetch", async () => {
    const v1 = await proposeRunnable(env, HANDOFF, provenance);
    const v2 = await proposeRunnable(
      env,
      { ...HANDOFF, argv: ["sh", "./handoff.sh", "--quiet"] },
      provenance,
    );
    if ("error" in v1 || "error" in v2) throw new Error("refused");
    const [assetId] = hookAssetIds(v1.version.files);
    expect(hookAssetIds(v2.version.files)).toEqual([assetId]);

    const row = await env.DB.prepare(
      "SELECT purpose, expires_at, title FROM assets WHERE asset_id = ?",
    )
      .bind(assetId)
      .first();
    expect(row).toEqual({
      purpose: "hook",
      expires_at: null,
      title: "handoff/handoff.sh",
    });

    expect(await readAssetRow(env.DB, "local", assetId)).toBeNull();
    expect(await listAssets(env.DB, "local", false)).toEqual([]);
    expect([...(await visibleAssetIds(env.DB, "local", [assetId]))]).toEqual(
      [],
    );
    const projected = await env.DB.prepare(
      "SELECT COUNT(*) AS n FROM search_docs WHERE concept_id = ?",
    )
      .bind(assetId)
      .first<{ n: number }>();
    expect(projected?.n).toBe(0);

    const fetched = await tool("fetch", { id: `asset:${assetId}` });
    expect(fetched.isError).toBe(true);
    const download = await tool("get_asset_download", {
      id: `asset:${assetId}`,
    });
    expect(download.isError).toBe(true);
  });

  it("refuses binary files, oversized files, unsafe paths and a text entry's id", async () => {
    const cases: [Record<string, unknown>, string][] = [
      [
        { ...HANDOFF, files: [{ path: "a.bin", content: "ELF\u0000\u0001" }] },
        "binary files are refused",
      ],
      [
        { ...HANDOFF, files: [{ path: "big.sh", content: "é".repeat(40000) }] },
        "the limit is 65536",
      ],
      [
        { ...HANDOFF, files: [{ path: "../x.sh", content: "x" }] },
        "must not contain empty",
      ],
      [{ ...HANDOFF, outputs: ["/etc/passwd"] }, "relative to the repo root"],
      [{ ...HANDOFF, name: "capture-nudge" }, "is a text entry's id"],
      [{ ...HANDOFF, name: "custom-0" }, "is a text entry's id"],
      [
        { ...HANDOFF, event: "SessionStart", gates: { every_turns: 10 } },
        "every_turns is only valid",
      ],
      [
        { ...HANDOFF, timeout_seconds: 3600 },
        "timeout_seconds must be an integer from 1 to 1800",
      ],
    ];
    for (const [args, message] of cases) {
      const result = await tool("propose_hook", args);
      expect(result.isError, message).toBe(true);
      expect(JSON.stringify(result.content), message).toContain(message);
    }
    const stored = await env.DB.prepare(
      "SELECT (SELECT COUNT(*) FROM hook_runnable_versions) + (SELECT COUNT(*) FROM assets) AS n",
    ).first<{ n: number }>();
    expect(stored?.n).toBe(0);
  });
});

describe("list_hooks and edit_hook", () => {
  it("lists runnable entries beside the text entries", async () => {
    const v1 = await proposeRunnable(env, HANDOFF, provenance);
    if ("error" in v1) throw new Error(v1.error);
    await decide(v1.version.versionHash, "approved");
    const pending = await proposeRunnable(
      env,
      { ...HANDOFF, outputs: [".git/valise/handoff.md"] },
      provenance,
    );
    if ("error" in pending) throw new Error(pending.error);

    const listed = (await tool("list_hooks", {})).structuredContent as {
      entries: unknown[];
      runnable: unknown[];
    };
    expect(listed.entries.length).toBeGreaterThan(0);
    expect(listed.runnable).toEqual([
      {
        name: "handoff",
        enabled: true,
        approved: {
          version_hash: v1.version.versionHash,
          event: "Stop",
          proposed_at: v1.version.proposedAt,
        },
        pending: {
          version_hash: pending.version.versionHash,
          event: "Stop",
          proposed_at: pending.version.proposedAt,
          expires_at: pending.version.expiresAt,
        },
      },
    ]);
  });

  it("refuses to edit a runnable entry and points at propose_hook", async () => {
    await proposeRunnable(env, HANDOFF, provenance);
    const result = await tool("edit_hook", {
      action: "change",
      id: "handoff",
      text: "run something else",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("propose_hook");
  });
});

describe("hook file sweep", () => {
  it("removes files no live version names, and keeps approved and pending ones", async () => {
    const now = nowSeconds();
    const approved = await proposeRunnable(env, HANDOFF, provenance, now);
    const lapsed = await proposeRunnable(
      env,
      {
        ...HANDOFF,
        name: "lapsed",
        files: [{ path: "old.sh", content: "echo old\n" }],
      },
      provenance,
      now,
    );
    const waiting = await proposeRunnable(
      env,
      {
        ...HANDOFF,
        name: "waiting",
        files: [{ path: "new.sh", content: "echo new\n" }],
      },
      provenance,
      now,
    );
    if ("error" in approved || "error" in lapsed || "error" in waiting)
      throw new Error("refused");
    await decide(approved.version.versionHash, "approved", now);

    const assetEnv = {
      DB: env.DB,
      BUNDLES: env.BUNDLES,
      TOKEN_PEPPER: "pepper",
    };
    // A day on, nothing has expired yet: every file is still named.
    expect((await cleanupLibrary(assetEnv, now + 2 * 86400)).hookFiles).toBe(0);

    // Past the proposal's life: the lapsed and waiting files go, the approved one stays.
    const report = await cleanupLibrary(
      assetEnv,
      now + PROPOSAL_TTL_SECONDS + 86400,
    );
    expect(report).toMatchObject({ hookFiles: 2, errors: [] });
    const left = await env.DB.prepare(
      "SELECT asset_id FROM assets WHERE purpose = 'hook'",
    ).all<{ asset_id: string }>();
    expect(left.results.map((row) => row.asset_id)).toEqual(
      hookAssetIds(approved.version.files),
    );
  });
});
