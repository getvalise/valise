import { getSkill, readFrontmatter, type StoredSkill } from "~/concepts/skills";
import { sha256Hex } from "~/r2/bundles";
import { capBody, docKey } from "~/search/project";
import { projectionStatement } from "~/search/write";
import captureThis from "../../skills/capture-this/SKILL.md?raw";

/**
 * The skills Valise ships, with the repo as their upstream. The Worker bundle
 * carries each SKILL.md body, so a deploy that changes one can publish it to
 * the store in a guarded batch: immutable version, head move, and search
 * projection. `source` is `builtin:<name>` and `source_hash` is the sha of
 * the last body the sync wrote, which is what tells an unedited head apart
 * from one the user published over.
 */

export type BuiltinSkill = {
  name: string;
  body: string;
  project?: string;
  tags?: string[];
};

export const BUILTIN_SKILLS: BuiltinSkill[] = [
  {
    name: "capture-this",
    body: captureThis,
    project: "valise",
    tags: ["meta", "memories"],
  },
];

export const BUILTIN_SWEEP_LIMIT = 5;
const LEASE_SECONDS = 120;
const RETRY_SECONDS = 300;

/** Bodies and metadata version themselves; bump policy when sync semantics change. */
export function builtinRelease(): Promise<string> {
  return sha256Hex(JSON.stringify({ policy: 1, skills: BUILTIN_SKILLS }));
}

export type BuiltinSyncOutcome =
  | "current" // head already matches the bundled body
  | "published" // a new version landed and moved the head
  | "adopted" // an unmanaged skill of the same name came under management
  | "held" // the head was edited past the last sync; nothing written
  | "error";

export type BuiltinSyncReport = {
  name: string;
  outcome: BuiltinSyncOutcome;
  detail?: string;
}[];

type SyncEnv = { DB: D1Database; BUNDLES: R2Bucket };

export type BuiltinProvisionResult = {
  status: "complete" | "current" | "deferred" | "failed";
  report: BuiltinSyncReport;
};

/** Completion is durable, and only the holder of the live lease can record it. */
export async function ensureBuiltinSkills(
  env: SyncEnv,
  userId: string,
): Promise<BuiltinProvisionResult> {
  const version = await builtinRelease();
  const token = crypto.randomUUID();
  const claimed = await env.DB.prepare(
    `INSERT INTO builtin_skill_sync
       (user_id, target_version, lease_token, lease_expires_at)
     SELECT user_id, ?, ?, unixepoch() + ? FROM users
      WHERE user_id = ? AND (role = 'owner' OR email_verified = 1)
     ON CONFLICT(user_id) DO UPDATE SET
       target_version = excluded.target_version, completed_version = NULL,
       lease_token = excluded.lease_token, lease_expires_at = excluded.lease_expires_at,
       retry_after = 0, last_error = NULL
     WHERE builtin_skill_sync.completed_version IS NOT excluded.target_version
       AND builtin_skill_sync.lease_expires_at <= unixepoch()
       AND (builtin_skill_sync.target_version != excluded.target_version
         OR builtin_skill_sync.retry_after <= unixepoch())`,
  )
    .bind(version, token, LEASE_SECONDS, userId)
    .run();
  if (!claimed.meta.changes) {
    const state = await env.DB.prepare(
      "SELECT completed_version FROM builtin_skill_sync WHERE user_id = ?",
    )
      .bind(userId)
      .first<{ completed_version: string | null }>();
    return {
      status: state?.completed_version === version ? "current" : "deferred",
      report: [],
    };
  }

  const report = await syncBuiltinSkills(env, userId, token);
  const failed = report.filter((entry) => entry.outcome === "error");
  const completed = await env.DB.prepare(
    `UPDATE builtin_skill_sync SET completed_version = ?, lease_token = NULL,
       lease_expires_at = 0, retry_after = ?, last_error = ?
     WHERE user_id = ? AND lease_token = ? AND target_version = ?
       AND lease_expires_at > unixepoch()`,
  )
    .bind(
      failed.length ? null : version,
      failed.length ? Math.floor(Date.now() / 1000) + RETRY_SECONDS : 0,
      failed.length ? JSON.stringify(failed.map((entry) => entry.name)) : null,
      userId,
      token,
      version,
    )
    .run();
  if (failed.length) {
    console.error({
      event: "builtin_provision_failed",
      userId,
      skills: failed.map((entry) => entry.name),
    });
  }
  return {
    status: failed.length
      ? "failed"
      : completed.meta.changes
        ? "complete"
        : "deferred",
    report,
  };
}

/** Signup is admitted independently of best-effort skill provisioning. */
export async function provisionBuiltinSkills(
  env: SyncEnv,
  userId: string,
): Promise<void> {
  try {
    await ensureBuiltinSkills(env, userId);
  } catch {
    // No passwords, verification tokens, bodies or raw database errors in logs.
    console.error({
      event: "builtin_provision_failed",
      userId,
      reason: "sync_failed",
    });
  }
}

/**
 * One bounded page per minute. Advance before processing, so a failed tenant
 * or interrupted invocation cannot starve later ids. Expiring tenant leases
 * and the next traversal recover unfinished work. The CAS cursor prevents
 * overlapping ticks from taking the same page. No offset or full-user scan.
 */
export async function sweepBuiltinSkills(env: SyncEnv) {
  await env.DB.prepare(
    "INSERT OR IGNORE INTO builtin_skill_sweep (id, after_user_id) VALUES (1, '')",
  ).run();
  const cursor = await env.DB.prepare(
    "SELECT after_user_id FROM builtin_skill_sweep WHERE id = 1",
  ).first<{ after_user_id: string }>();
  const after = cursor?.after_user_id ?? "";
  const { results } = await env.DB.prepare(
    "SELECT user_id FROM users WHERE user_id > ? ORDER BY user_id LIMIT ?",
  )
    .bind(after, BUILTIN_SWEEP_LIMIT)
    .all<{ user_id: string }>();
  const advanced = await env.DB.prepare(
    "UPDATE builtin_skill_sweep SET after_user_id = ? WHERE id = 1 AND after_user_id = ?",
  )
    .bind(results.at(-1)?.user_id ?? "", after)
    .run();
  const report: { userId: string; status: BuiltinProvisionResult["status"] }[] =
    [];
  if (!advanced.meta.changes) return report;
  for (const { user_id: userId } of results) {
    try {
      const { status } = await ensureBuiltinSkills(env, userId);
      report.push({ userId, status });
    } catch {
      console.error({
        event: "builtin_provision_failed",
        userId,
        reason: "sync_failed",
      });
      report.push({ userId, status: "failed" });
    }
  }
  return report;
}

/** Explicit tenant repair/dev entrypoint; never enumerates users. */
export async function syncBuiltinSkills(
  env: SyncEnv,
  userId: string,
  leaseToken: string | null = null,
): Promise<BuiltinSyncReport> {
  const report: BuiltinSyncReport = [];
  for (const builtin of BUILTIN_SKILLS) {
    try {
      report.push(await syncOne(env, userId, builtin, leaseToken));
    } catch (error) {
      // A stale head/lease, transient storage error, or the legacy global-name
      // index stays retryable. Never substitute another tenant's copy.
      report.push({
        name: builtin.name,
        outcome: "error",
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }
  await retireUnbundled(env, userId);
  return report;
}

/**
 * A skill Valise no longer bundles stays with the person who has it, as an
 * ordinary skill: no `builtin:` source, so it can be deleted, and no upstream
 * for a later sync to follow. Versions and body are untouched.
 */
async function retireUnbundled(env: SyncEnv, userId: string): Promise<void> {
  const bundled = BUILTIN_SKILLS.map((skill) => `builtin:${skill.name}`);
  await env.DB.prepare(
    `UPDATE skills SET source = NULL, source_hash = NULL, updated_at = unixepoch()
      WHERE user_id = ? AND substr(source, 1, 8) = 'builtin:'
        AND source NOT IN (${bundled.map(() => "?").join(", ")})`,
  )
    .bind(userId, ...bundled)
    .run();
}

async function syncOne(
  env: SyncEnv,
  userId: string,
  builtin: BuiltinSkill,
  leaseToken: string | null,
): Promise<BuiltinSyncReport[number]> {
  if (readFrontmatter(builtin.body).name !== builtin.name) {
    throw new Error("invalid bundled skill or mismatched name");
  }
  const source = `builtin:${builtin.name}`;
  const bundledSha = await sha256Hex(builtin.body);
  const current = await getSkill(
    env.DB,
    userId,
    builtin.name,
    undefined,
    "deleted",
  );

  // Existing authored/imported/deleted content belongs to the user. Even an
  // identical body must not steal a registry source or discard attached files.
  if (
    current &&
    (current.deleted ||
      current.files.length > 0 ||
      (current.source !== source &&
        (current.source !== null || current.sha256 !== bundledSha)))
  ) {
    return {
      name: builtin.name,
      outcome: "held",
      detail: "name or bundle owned by user",
    };
  }

  if (current !== null && current.sha256 === bundledSha) {
    if (current.source === source && current.sourceHash === bundledSha) {
      return { name: builtin.name, outcome: "current" };
    }
    // Same body, missing attribution: mark it managed without a new version.
    const adopted = await env.DB.prepare(
      `UPDATE skills SET source = ?, source_hash = ?, source_version_id = head_version_id
       WHERE skill_id = ? AND user_id = ? AND ${unchangedHead} AND ${liveLease}`,
    )
      .bind(
        source,
        bundledSha,
        current.skillId,
        userId,
        current.version,
        current.source,
        current.sourceHash,
        leaseToken,
        userId,
        leaseToken,
      )
      .run();
    if (!adopted.meta.changes)
      throw new Error("head changed or lease expired; retry");
    return { name: builtin.name, outcome: "adopted" };
  }

  // A managed skill whose head is not what the sync last wrote was edited
  // here. Hold the update and let the console show the divergence; clobbering
  // a user's head because a deploy happened is the one wrong move.
  if (
    current !== null &&
    current.source === source &&
    current.sourceHash !== current.sha256
  ) {
    return {
      name: builtin.name,
      outcome: "held",
      detail: "head edited past the last sync",
    };
  }

  await publishBuiltin(
    env.DB,
    userId,
    builtin,
    bundledSha,
    current,
    leaseToken,
  );
  return {
    name: builtin.name,
    outcome: "published",
  };
}

const unchangedHead = `deleted_at IS NULL
  AND head_version_id = (SELECT version_id FROM skill_versions WHERE skill_id = skills.skill_id AND version = ?)
  AND source IS ? AND source_hash IS ?`;
const liveLease = `(? IS NULL OR EXISTS (SELECT 1 FROM builtin_skill_sync
  WHERE user_id = ? AND lease_token = ? AND lease_expires_at > unixepoch()))`;

/** Conditional version insert is the CAS. The head and projection only move if
 * that insert succeeded, in the same batch. Concurrent edits/toggles survive. */
async function publishBuiltin(
  db: D1Database,
  userId: string,
  builtin: BuiltinSkill,
  sha: string,
  current: StoredSkill | null,
  token: string | null,
) {
  const skillId = current?.skillId ?? `skl_${crypto.randomUUID()}`;
  const versionId = `skv_${crypto.randomUUID()}`;
  const now = Math.floor(Date.now() / 1000);
  const statements: D1PreparedStatement[] = [];
  if (!current) {
    statements.push(
      db
        .prepare(
          `INSERT INTO skills (skill_id, user_id, name, project, tags_json, visibility, created_at, updated_at)
       SELECT ?, ?, ?, ?, ?, 'private', ?, ?
       WHERE NOT EXISTS (SELECT 1 FROM skills WHERE user_id = ? AND name = ?) AND ${liveLease}`,
        )
        .bind(
          skillId,
          userId,
          builtin.name,
          builtin.project ?? null,
          JSON.stringify(builtin.tags ?? []),
          now,
          now,
          userId,
          builtin.name,
          token,
          userId,
          token,
        ),
    );
  }
  statements.push(
    db
      .prepare(
        `INSERT INTO skill_versions (version_id, skill_id, version, body_md, body_sha256, files_json, created_at, created_by)
     SELECT ?, skill_id, (SELECT COALESCE(MAX(version), 0) + 1 FROM skill_versions WHERE skill_id = skills.skill_id),
       ?, ?, '[]', ?, 'builtin-sync' FROM skills WHERE skill_id = ? AND user_id = ?
        AND ${current ? `${unchangedHead} AND ${liveLease}` : "head_version_id IS NULL"}`,
      )
      .bind(
        versionId,
        builtin.body,
        sha,
        now,
        skillId,
        userId,
        ...(current
          ? [
              current.version,
              current.source,
              current.sourceHash,
              token,
              userId,
              token,
            ]
          : []),
      ),
  );
  const insertIndex = statements.length - 1;
  statements.push(
    db
      .prepare(`UPDATE skills SET head_version_id = ?, source = ?, source_hash = ?,
        source_version_id = ?, updated_at = ? WHERE skill_id = ? AND user_id = ?
        AND EXISTS (SELECT 1 FROM skill_versions WHERE version_id = ?)`)
      .bind(
        versionId,
        `builtin:${builtin.name}`,
        sha,
        versionId,
        now,
        skillId,
        userId,
        versionId,
      ),
    projectionStatement(
      db,
      {
        selectSql: `SELECT ?, s.user_id, 'skill', s.skill_id, s.project, s.name, ?,
          (SELECT COALESCE(group_concat(value, ' '), '') FROM json_each(s.tags_json) WHERE type = 'text'), s.updated_at
        FROM skills s
        WHERE s.skill_id = ? AND s.user_id = ? AND s.head_version_id = ?
          AND s.deleted_at IS NULL AND s.disabled_at IS NULL`,
        bindings: [
          docKey("skill", skillId),
          capBody(builtin.body),
          skillId,
          userId,
          versionId,
        ],
      },
      docKey("skill", skillId),
    ),
  );
  const result = await db.batch(statements);
  if (!result[insertIndex].meta.changes)
    throw new Error("head changed or lease expired; retry");
}
