import { z } from "zod";
import { digest, sameDigest } from "~/concepts/assets";
import { listRunnables, readRunnableVersion } from "~/concepts/hook-runnables";
import { nowSeconds } from "~/r2/objects";

/**
 * What a machine fetches to run the owner's approved hooks, and what it sends
 * back after each run. ADR-0023, "Delivery" and "Cost and caps". Both are
 * read and written under `hooks:exec`, which never proposes or approves.
 *
 * The manifest lists only enabled entries with an approved version. Each file
 * comes with a URL signed for that one hook file and ten minutes, under its
 * own signature domain: an ordinary asset download URL cannot fetch a hook
 * file, and a hook-file URL cannot fetch anything else.
 */

/** How long a hook file URL in the manifest stays valid. */
export const HOOK_FILE_TTL_SECONDS = 10 * 60;
/** The longest `result` line a run report keeps, in bytes. */
export const MAX_RUN_RESULT_BYTES = 2048;

export type ManifestFile = {
  path: string;
  sha256: string;
  size: number;
  url: string;
  expires_at: number;
};

export type ManifestEntry = {
  name: string;
  version_hash: string;
  event: "SessionStart" | "Stop" | "SessionEnd";
  argv: string[];
  gates: Record<string, unknown>;
  outputs: string[];
  timeout_seconds: number;
  daily_cap_usd: number;
  max_runs_per_day: number;
  /** Reported across every machine since 00:00 UTC, as of this read. */
  today: { cost_usd: number; runs: number };
  files: ManifestFile[];
};

export type HookManifest = {
  generated_at: number;
  entries: ManifestEntry[];
};

type ManifestEnv = { DB: D1Database; TOKEN_PEPPER?: string };

function startOfUtcDay(now: number): number {
  return now - (now % 86_400);
}

export async function readHookManifest(
  env: ManifestEnv,
  userId: string,
  origin: string,
  now = nowSeconds(),
): Promise<HookManifest> {
  const pepper = env.TOKEN_PEPPER;
  if (!pepper) throw new Error("TOKEN_PEPPER is required to sign hook files.");
  const running = (await listRunnables(env.DB, userId, now)).filter(
    (entry) => !entry.disabled && entry.running !== null,
  );
  const { results: usage } = running.length
    ? await env.DB.prepare(
        `SELECT runnable_id AS runnableId, COUNT(*) AS runs,
                COALESCE(SUM(cost_microusd), 0) AS costMicrousd
           FROM hook_runs
          WHERE user_id = ? AND started_at >= ?
          GROUP BY runnable_id`,
      )
        .bind(userId, startOfUtcDay(now))
        .all<{ runnableId: string; runs: number; costMicrousd: number }>()
    : { results: [] };
  const today = new Map(usage.map((row) => [row.runnableId, row]));
  const expiresAt = now + HOOK_FILE_TTL_SECONDS;
  const entries: ManifestEntry[] = [];
  for (const entry of running) {
    const version = entry.running;
    if (version === null) continue;
    const files: ManifestFile[] = [];
    for (const file of version.files) {
      files.push({
        path: file.path,
        sha256: file.sha256,
        size: file.size,
        url: await hookFileUrl(pepper, file.asset_id, origin, expiresAt),
        expires_at: expiresAt,
      });
    }
    const used = today.get(entry.runnableId);
    entries.push({
      name: entry.name,
      version_hash: version.versionHash,
      event: version.content.event,
      argv: version.content.argv,
      gates: version.content.gates,
      outputs: version.content.outputs,
      timeout_seconds: version.content.timeout_seconds,
      daily_cap_usd: version.content.daily_cap_usd,
      max_runs_per_day: version.content.max_runs_per_day,
      today: {
        cost_usd: (used?.costMicrousd ?? 0) / 1_000_000,
        runs: used?.runs ?? 0,
      },
      files,
    });
  }
  return { generated_at: now, entries };
}

async function hookFileUrl(
  pepper: string,
  assetId: string,
  origin: string,
  expiresAt: number,
): Promise<string> {
  const url = new URL(`/hook-files/${assetId}`, origin);
  url.searchParams.set("expires", String(expiresAt));
  url.searchParams.set(
    "signature",
    await digest(pepper, `hook-file:${assetId}:${expiresAt}`),
  );
  return url.href;
}

export const HOOK_FILE_PATH = /^\/hook-files\/(ast_[0-9a-f-]{36})$/;

/**
 * `GET /hook-files/{id}`: the bytes of one hook file, for a URL the manifest
 * signed. Only `purpose = 'hook'` assets answer here, and they answer nowhere
 * else (ADR-0023, "Hook files as assets").
 */
export async function serveHookFile(
  env: ManifestEnv & { BUNDLES: R2Bucket },
  assetId: string,
  url: URL,
  now = nowSeconds(),
): Promise<Response> {
  const pepper = env.TOKEN_PEPPER;
  const expires = Number(url.searchParams.get("expires"));
  const signature = url.searchParams.get("signature") ?? "";
  if (
    !pepper ||
    !Number.isInteger(expires) ||
    expires <= now ||
    expires > now + HOOK_FILE_TTL_SECONDS ||
    !sameDigest(
      signature,
      await digest(pepper, `hook-file:${assetId}:${expires}`),
    )
  ) {
    return plainError(
      403,
      "invalid_signature",
      "Fetch the hook manifest again for fresh file URLs.",
    );
  }
  const row = await env.DB.prepare(
    `SELECT o.r2_key AS r2Key, o.sha256
       FROM assets a
       JOIN objects o ON o.object_id = a.object_id AND o.user_id = a.user_id
      WHERE a.asset_id = ? AND a.purpose = 'hook' AND a.state = 'ready'`,
  )
    .bind(assetId)
    .first<{ r2Key: string; sha256: string }>();
  if (row === null) return plainError(404, "not_found");
  const object = await env.BUNDLES.get(row.r2Key);
  if (object === null) return plainError(404, "not_found");
  return new Response(object.body, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "x-valise-sha256": row.sha256,
    },
  });
}

function plainError(status: number, error: string, message?: string) {
  return Response.json(
    { error, ...(message ? { message } : {}) },
    { status, headers: { "cache-control": "no-store" } },
  );
}

/** A run report as `POST /mcp/hooks/runs` takes it. */
export const runReportInput = z.object({
  run_id: z
    .string()
    .regex(/^[A-Za-z0-9_-]{8,100}$/, "run_id: 8 to 100 of A-Z a-z 0-9 _ -"),
  name: z.string().min(1).max(100),
  version_hash: z.string().regex(/^[0-9a-f]{64}$/),
  machine: z.string().trim().min(1).max(200),
  session: z.string().max(200).nullish(),
  repo: z.string().max(500).nullish(),
  started_at: z.number().int().min(0),
  duration_ms: z
    .number()
    .int()
    .min(0)
    .max(4 * 60 * 60 * 1000),
  outcome: z.enum(["ok", "failed", "timeout", "violation"]),
  cost_usd: z.number().min(0).max(1000).nullish(),
  result: z.string().nullish(),
});

export type RunReport = z.infer<typeof runReportInput>;

export type RecordedRun =
  | { ok: true; recorded: boolean; suspended: boolean }
  | { ok: false; status: 404 | 400; message: string };

/**
 * Stores one report, once per `run_id`. A `violation` (a tracked file the run
 * changed) records a `suspended` decision on the version when it is the one
 * approved, so it stops running on every machine until the owner approves it
 * again; the report is the runner's word, and suspending only ever removes
 * what may run.
 */
export async function recordHookRun(
  db: D1Database,
  userId: string,
  report: RunReport,
  now = nowSeconds(),
): Promise<RecordedRun> {
  if (report.started_at > now + 300 || report.started_at < now - 7 * 86_400)
    return {
      ok: false,
      status: 400,
      message: "started_at is more than a week old or in the future.",
    };
  const version = await readRunnableVersion(
    db,
    userId,
    report.version_hash,
    now,
  );
  if (version === null || version.content.name !== report.name)
    return {
      ok: false,
      status: 404,
      message: `No version ${report.version_hash} of hook "${report.name}".`,
    };
  const runnable = await db
    .prepare(
      "SELECT runnable_id AS runnableId FROM hook_runnables WHERE user_id = ? AND name = ?",
    )
    .bind(userId, report.name)
    .first<{ runnableId: string }>();
  if (runnable === null)
    return {
      ok: false,
      status: 404,
      message: `No hook "${report.name}".`,
    };
  const suspend =
    report.outcome === "violation" && version.state === "approved";
  const statements = [
    db
      .prepare(
        `INSERT INTO hook_runs (
           user_id, run_id, runnable_id, version_hash, machine, session, repo,
           started_at, duration_ms, outcome, cost_microusd, result, received_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, run_id) DO NOTHING`,
      )
      .bind(
        userId,
        report.run_id,
        runnable.runnableId,
        report.version_hash,
        report.machine,
        report.session ?? null,
        report.repo ?? null,
        report.started_at,
        report.duration_ms,
        report.outcome,
        report.cost_usd == null
          ? null
          : Math.round(report.cost_usd * 1_000_000),
        report.result == null ? null : truncateUtf8(report.result),
        now,
      ),
  ];
  if (suspend)
    statements.push(
      db
        .prepare(
          `INSERT INTO hook_runnable_decisions (user_id, version_hash, decision, credential_id, at, reason)
           SELECT ?, ?, 'suspended', NULL, ?, ?
            WHERE changes() > 0`,
        )
        .bind(
          userId,
          report.version_hash,
          now,
          `Run ${report.run_id} on ${report.machine} changed a tracked file.`,
        ),
    );
  const [inserted, suspended] = await db.batch(statements);
  return {
    ok: true,
    recorded: (inserted.meta.changes ?? 0) > 0,
    suspended: suspended !== undefined && (suspended.meta.changes ?? 0) > 0,
  };
}

/** At most `MAX_RUN_RESULT_BYTES` of UTF-8, never splitting a character. */
function truncateUtf8(text: string): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= MAX_RUN_RESULT_BYTES) return text;
  return new TextDecoder()
    .decode(bytes.subarray(0, MAX_RUN_RESULT_BYTES))
    .replace(/�$/, "");
}
