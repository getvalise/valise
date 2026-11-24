import {
  parseRunnableContent,
  type RunnableContent,
  type RunnableContentInput,
  type RunnableGates,
  relativePathError,
} from "~/concepts/hook-config";
import type { Provenance } from "~/concepts/memories";
import { nowSeconds, objectKey, sha256Hex } from "~/r2/objects";

/**
 * Runnable hook entries, ADR-0023. An agent proposes a version; the owner
 * approves it in the console with a passkey; the runner fetches only
 * approved versions. This module stores proposals and derives each
 * version's state from the append-only decisions. Approving, revoking and
 * the manifest live with their own routes.
 *
 * A version is keyed by `runnableVersionHash`: the SHA-256 of the canonical
 * JSON of the entry name, its content and its files' paths and hashes. An
 * approval names that hash, so what runs is exactly what the owner saw.
 */

export const MAX_HOOK_FILES = 20;
export const MAX_HOOK_FILE_BYTES = 64 * 1024;
export const MAX_HOOK_TOTAL_BYTES = 256 * 1024;
/** A proposal nobody decided on stops being pending after this. */
export const PROPOSAL_TTL_SECONDS = 7 * 24 * 60 * 60;
/**
 * A hook file no live version names is swept once untouched this long, so a
 * proposal whose files are stored but whose version write failed, or is in
 * flight, keeps them.
 */
export const HOOK_FILE_GRACE_SECONDS = 24 * 60 * 60;
/** Hook files swept per maintenance run; the rest wait a night. */
const HOOK_FILE_SWEEP_BATCH = 200;

export type HookFileInput = { path: string; content: string };
export type HookFile = {
  path: string;
  sha256: string;
  size: number;
  asset_id: string;
};

export type VersionState =
  | "pending"
  | "expired"
  | "approved"
  | "rejected"
  | "revoked"
  | "suspended";

export type RunnableVersion = {
  versionHash: string;
  content: RunnableContent;
  files: HookFile[];
  state: VersionState;
  /** The decision that set `state`, when one did. */
  decisionId: number | null;
  decidedAt: number | null;
  proposedAt: number;
  expiresAt: number;
  sourceAgent: string;
  sourceClient: string;
  sourceSession: string | null;
};

export type RunnableEntry = {
  runnableId: string;
  name: string;
  createdAt: number;
  disabled: boolean;
  /** The most recently approved version still approved; what runs. */
  running: RunnableVersion | null;
  /** The newest version awaiting the owner, if any. */
  pending: RunnableVersion | null;
};

/** JSON with every object's keys sorted, so equal content hashes equal. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export async function runnableVersionHash(
  content: RunnableContent,
  files: readonly { path: string; sha256: string }[],
): Promise<string> {
  const bound = {
    ...content,
    files: [...files]
      .map(({ path, sha256 }) => ({ path, sha256 }))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)),
  };
  return sha256Hex(
    new TextEncoder().encode(canonicalJson(bound)).buffer as ArrayBuffer,
  );
}

/** The file list's problems, or each file's bytes and hash, sorted by path. */
export async function parseHookFiles(
  files: readonly HookFileInput[],
): Promise<
  | { files: { path: string; bytes: Uint8Array; sha256: string }[] }
  | { error: string }
> {
  if (files.length > MAX_HOOK_FILES) {
    return { error: `at most ${MAX_HOOK_FILES} files` };
  }
  const seen = new Set<string>();
  const parsed: { path: string; bytes: Uint8Array; sha256: string }[] = [];
  let total = 0;
  for (const file of files) {
    const error = relativePathError(file.path, `file path "${file.path}"`);
    if (error) return { error };
    if (seen.has(file.path))
      return { error: `file "${file.path}" is listed twice` };
    seen.add(file.path);
    // Scripts are text. NUL is the mark of a binary file, and a lone
    // surrogate cannot be encoded as the bytes the agent meant.
    if (file.content.includes("\u0000") || !isWellFormed(file.content)) {
      return {
        error: `file "${file.path}" is not UTF-8 text; binary files are refused`,
      };
    }
    const bytes = new TextEncoder().encode(file.content);
    if (bytes.byteLength > MAX_HOOK_FILE_BYTES) {
      return {
        error: `file "${file.path}" is ${bytes.byteLength} bytes; the limit is ${MAX_HOOK_FILE_BYTES}`,
      };
    }
    total += bytes.byteLength;
    parsed.push({
      path: file.path,
      bytes,
      sha256: await sha256Hex(bytes.buffer as ArrayBuffer),
    });
  }
  if (total > MAX_HOOK_TOTAL_BYTES) {
    return {
      error: `files total ${total} bytes; the limit is ${MAX_HOOK_TOTAL_BYTES}`,
    };
  }
  parsed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { files: parsed };
}

function isWellFormed(text: string): boolean {
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      index++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

type VersionRow = {
  versionHash: string;
  runnableId: string;
  name: string;
  event: RunnableContent["event"];
  argvJson: string;
  gatesJson: string;
  outputsJson: string;
  timeoutSeconds: number;
  dailyCapMicrousd: number;
  maxRunsPerDay: number;
  filesJson: string;
  sourceAgent: string;
  sourceClient: string;
  sourceSession: string | null;
  proposedAt: number;
  expiresAt: number;
  decision: Exclude<VersionState, "pending" | "expired"> | null;
  decisionId: number | null;
  decidedAt: number | null;
};

/**
 * Each version with the decision that sets its state: the latest one made at
 * or after its current proposal. A decision on an earlier proposal of the
 * same content no longer counts.
 */
const SELECT_VERSION = `
SELECT v.version_hash AS versionHash, v.runnable_id AS runnableId, r.name,
       v.event, v.argv_json AS argvJson, v.gates_json AS gatesJson,
       v.outputs_json AS outputsJson, v.timeout_seconds AS timeoutSeconds,
       v.daily_cap_microusd AS dailyCapMicrousd, v.max_runs_per_day AS maxRunsPerDay,
       v.files_json AS filesJson, v.source_agent AS sourceAgent,
       v.source_client AS sourceClient, v.source_session AS sourceSession,
       v.proposed_at AS proposedAt, v.expires_at AS expiresAt,
       d.decision, d.decision_id AS decisionId, d.at AS decidedAt
  FROM hook_runnable_versions v
  JOIN hook_runnables r ON r.runnable_id = v.runnable_id AND r.user_id = v.user_id
  LEFT JOIN hook_runnable_decisions d ON d.decision_id = (
    SELECT MAX(decision_id) FROM hook_runnable_decisions
     WHERE user_id = v.user_id AND version_hash = v.version_hash
       AND at >= v.proposed_at)`;

function fromVersionRow(row: VersionRow, now: number): RunnableVersion {
  return {
    versionHash: row.versionHash,
    content: {
      name: row.name,
      event: row.event,
      argv: JSON.parse(row.argvJson) as string[],
      gates: JSON.parse(row.gatesJson) as RunnableGates,
      outputs: JSON.parse(row.outputsJson) as string[],
      timeout_seconds: row.timeoutSeconds,
      daily_cap_usd: row.dailyCapMicrousd / 1_000_000,
      max_runs_per_day: row.maxRunsPerDay,
    },
    files: JSON.parse(row.filesJson) as HookFile[],
    state: row.decision ?? (row.expiresAt > now ? "pending" : "expired"),
    decisionId: row.decisionId,
    decidedAt: row.decidedAt,
    proposedAt: row.proposedAt,
    expiresAt: row.expiresAt,
    sourceAgent: row.sourceAgent,
    sourceClient: row.sourceClient,
    sourceSession: row.sourceSession,
  };
}

/** One version of the owner's, in whatever state, or null. */
export async function readRunnableVersion(
  db: D1Database,
  userId: string,
  versionHash: string,
  now = nowSeconds(),
): Promise<RunnableVersion | null> {
  const row = await db
    .prepare(`${SELECT_VERSION} WHERE v.user_id = ? AND v.version_hash = ?`)
    .bind(userId, versionHash)
    .first<VersionRow>();
  return row === null ? null : fromVersionRow(row, now);
}

/**
 * Every runnable entry, by name, with what runs and what waits. Only live
 * versions are read (approved, or pending and unexpired), so the read stays
 * bounded however many proposals an entry has had.
 */
export async function listRunnables(
  db: D1Database,
  userId: string,
  now = nowSeconds(),
): Promise<RunnableEntry[]> {
  const [entries, versions] = await db.batch([
    db
      .prepare(
        `SELECT runnable_id AS runnableId, name, created_at AS createdAt,
                disabled_at AS disabledAt
           FROM hook_runnables WHERE user_id = ? ORDER BY name`,
      )
      .bind(userId),
    db
      .prepare(
        `${SELECT_VERSION}
          WHERE v.user_id = ?1
            AND (d.decision = 'approved' OR (d.decision IS NULL AND v.expires_at > ?2))`,
      )
      .bind(userId, now),
  ]);
  const live = (versions.results as VersionRow[]).map((row) => ({
    runnableId: row.runnableId,
    version: fromVersionRow(row, now),
  }));
  return (
    entries.results as {
      runnableId: string;
      name: string;
      createdAt: number;
      disabledAt: number | null;
    }[]
  ).map((entry) => {
    const own = live
      .filter((item) => item.runnableId === entry.runnableId)
      .map((item) => item.version);
    const running =
      own
        .filter((version) => version.state === "approved")
        .sort((a, b) => (b.decisionId ?? 0) - (a.decisionId ?? 0))[0] ?? null;
    const pending =
      own
        .filter((version) => version.state === "pending")
        .sort((a, b) => b.proposedAt - a.proposedAt)[0] ?? null;
    return {
      runnableId: entry.runnableId,
      name: entry.name,
      createdAt: entry.createdAt,
      disabled: entry.disabledAt !== null,
      running,
      pending,
    };
  });
}

/** Whether `name` is a runnable entry of this user's. */
export async function isRunnableName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 FROM hook_runnables WHERE user_id = ? AND name = ?")
    .bind(userId, name)
    .first();
  return row !== null;
}

export type ProposeRunnableInput = RunnableContentInput & {
  files?: readonly HookFileInput[];
};

export type ProposeOutcome = {
  /**
   * `proposed`: stored, or renewed after a rejection or expiry, and pending.
   * `pending`: this exact content was already waiting; nothing changed.
   * `running`: this exact content is what runs now; nothing changed.
   */
  outcome: "proposed" | "pending" | "running";
  version: RunnableVersion;
  /** What runs until the owner approves this, when something does. */
  running: RunnableVersion | null;
};

/**
 * Stores a pending version. It never runs, and never replaces what runs,
 * until the owner approves its hash. Files are stored as `purpose = 'hook'`
 * assets, one per distinct content per user, so a new version that changes
 * one script stores one file.
 */
export async function proposeRunnable(
  env: { DB: D1Database; BUNDLES: R2Bucket },
  input: ProposeRunnableInput,
  provenance: Provenance,
  now = nowSeconds(),
): Promise<ProposeOutcome | { error: string }> {
  const parsed = parseRunnableContent(input);
  if ("error" in parsed) return parsed;
  const read = await parseHookFiles(input.files ?? []);
  if ("error" in read) return read;
  const { content } = parsed;
  const { userId } = provenance;
  const versionHash = await runnableVersionHash(content, read.files);

  const entry = (await listRunnables(env.DB, userId, now)).find(
    (item) => item.name === content.name,
  );
  const running = entry?.running ?? null;
  if (running?.versionHash === versionHash) {
    return { outcome: "running", version: running, running };
  }
  const existing = await readRunnableVersion(env.DB, userId, versionHash, now);
  if (existing?.state === "pending") {
    return { outcome: "pending", version: existing, running };
  }

  const stored = await storeHookFiles(
    env,
    userId,
    content.name,
    read.files,
    provenance,
    now,
  );
  // A decision recorded in this same second would otherwise still count
  // against the renewed proposal.
  const proposedAt =
    existing?.decidedAt !== null && existing?.decidedAt !== undefined
      ? Math.max(now, existing.decidedAt + 1)
      : now;
  const runnableId = entry?.runnableId ?? `hkr_${crypto.randomUUID()}`;
  await env.DB.batch([
    ...stored.statements,
    env.DB.prepare(
      `INSERT INTO hook_runnables (runnable_id, user_id, name, created_at)
       VALUES (?, ?, ?, ?) ON CONFLICT(user_id, name) DO NOTHING`,
    ).bind(runnableId, userId, content.name, now),
    env.DB.prepare(
      `INSERT INTO hook_runnable_versions (
         user_id, version_hash, runnable_id, event, argv_json, gates_json,
         outputs_json, timeout_seconds, daily_cap_microusd, max_runs_per_day,
         files_json, source_agent, source_client, source_session,
         proposed_at, expires_at
       ) VALUES (?, ?, (SELECT runnable_id FROM hook_runnables WHERE user_id = ? AND name = ?),
                 ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(user_id, version_hash) DO UPDATE SET
         files_json = excluded.files_json,
         source_agent = excluded.source_agent,
         source_client = excluded.source_client,
         source_session = excluded.source_session,
         proposed_at = excluded.proposed_at,
         expires_at = excluded.expires_at`,
    ).bind(
      userId,
      versionHash,
      userId,
      content.name,
      content.event,
      JSON.stringify(content.argv),
      canonicalJson(content.gates),
      JSON.stringify(content.outputs),
      content.timeout_seconds,
      Math.round(content.daily_cap_usd * 1_000_000),
      content.max_runs_per_day,
      JSON.stringify(stored.files),
      provenance.agent,
      provenance.client,
      provenance.session,
      proposedAt,
      proposedAt + PROPOSAL_TTL_SECONDS,
    ),
  ]);
  const version = await readRunnableVersion(env.DB, userId, versionHash, now);
  if (version === null)
    throw new Error("A proposed hook version was not stored.");
  return { outcome: "proposed", version, running };
}

/**
 * Puts each file not already stored to R2 and returns the statements that
 * record it, with every file's asset id. R2 and D1 cannot commit together:
 * bytes whose rows never land are an orphan object the nightly sweep
 * removes after a day, as for any asset. A reused file's `updated_at` is
 * touched, so the hook-file sweep leaves it alone while this proposal lands.
 */
async function storeHookFiles(
  env: { DB: D1Database; BUNDLES: R2Bucket },
  userId: string,
  name: string,
  files: { path: string; bytes: Uint8Array; sha256: string }[],
  provenance: Provenance,
  now: number,
): Promise<{ files: HookFile[]; statements: D1PreparedStatement[] }> {
  const hashes = [...new Set(files.map((file) => file.sha256))];
  const { results } = hashes.length
    ? await env.DB.prepare(
        `SELECT o.sha256, MIN(a.asset_id) AS assetId FROM assets a
           JOIN objects o ON o.object_id = a.object_id AND o.user_id = a.user_id
          WHERE a.user_id = ? AND a.purpose = 'hook' AND a.state = 'ready'
            AND o.sha256 IN (SELECT value FROM json_each(?))
          GROUP BY o.sha256`,
      )
        .bind(userId, JSON.stringify(hashes))
        .all<{ sha256: string; assetId: string }>()
    : { results: [] };
  const known = new Map(results.map((row) => [row.sha256, row.assetId]));
  const statements: D1PreparedStatement[] = [];
  if (known.size) {
    statements.push(
      env.DB.prepare(
        `UPDATE assets SET updated_at = ? WHERE user_id = ? AND purpose = 'hook'
            AND asset_id IN (SELECT value FROM json_each(?))`,
      ).bind(now, userId, JSON.stringify([...known.values()])),
    );
  }
  const stored: HookFile[] = [];
  for (const file of files) {
    let assetId = known.get(file.sha256);
    if (assetId === undefined) {
      assetId = `ast_${crypto.randomUUID()}`;
      const objectId = `obj_${crypto.randomUUID()}`;
      const r2Key = objectKey(userId, objectId);
      const fileName = file.path.split("/").pop() ?? file.path;
      await env.BUNDLES.put(r2Key, file.bytes, {
        httpMetadata: { contentType: "text/plain; charset=utf-8" },
        customMetadata: { sha256: file.sha256 },
      });
      statements.push(
        env.DB.prepare(
          `INSERT INTO objects (
             object_id, user_id, r2_key, name, content_type, size, sha256, created_at
           ) VALUES (?, ?, ?, ?, 'text/plain; charset=utf-8', ?, ?, ?)`,
        ).bind(
          objectId,
          userId,
          r2Key,
          fileName,
          file.bytes.byteLength,
          file.sha256,
          now,
        ),
        // No projection statement: a hook file is never searchable.
        env.DB.prepare(
          `INSERT INTO assets (
             asset_id, user_id, state, object_id, title, file_name, content_type,
             declared_size, declared_sha256, source_agent, source_client,
             source_session, purpose, created_at, updated_at, finalized_at
           ) VALUES (?, ?, 'ready', ?, ?, ?, 'text/plain; charset=utf-8', ?, ?, ?, ?, ?, 'hook', ?, ?, ?)`,
        ).bind(
          assetId,
          userId,
          objectId,
          `${name}/${file.path}`,
          fileName,
          file.bytes.byteLength,
          file.sha256,
          provenance.agent,
          provenance.client,
          provenance.session,
          now,
          now,
          now,
        ),
      );
      known.set(file.sha256, assetId);
    }
    stored.push({
      path: file.path,
      sha256: file.sha256,
      size: file.bytes.byteLength,
      asset_id: assetId,
    });
  }
  return { files: stored, statements };
}

/**
 * Hook files no live version names: not referenced by any version that was
 * ever approved, or that is pending and unexpired, and untouched for a day.
 * The nightly sweep in `cleanupLibrary` purges them.
 */
export async function unreferencedHookFiles(
  db: D1Database,
  now = nowSeconds(),
): Promise<{ assetId: string; userId: string; objectId: string | null }[]> {
  const { results } = await db
    .prepare(
      `SELECT a.asset_id AS assetId, a.user_id AS userId, a.object_id AS objectId
         FROM assets a
        WHERE a.purpose = 'hook' AND a.updated_at <= ?1
          AND NOT EXISTS (
            SELECT 1 FROM hook_runnable_versions v, json_each(v.files_json) f
             WHERE v.user_id = a.user_id
               AND json_extract(f.value, '$.asset_id') = a.asset_id
               AND (v.expires_at > ?2 OR EXISTS (
                 SELECT 1 FROM hook_runnable_decisions d
                  WHERE d.user_id = v.user_id AND d.version_hash = v.version_hash
                    AND d.decision = 'approved')))
        LIMIT ?3`,
    )
    .bind(now - HOOK_FILE_GRACE_SECONDS, now, HOOK_FILE_SWEEP_BATCH)
    .all<{ assetId: string; userId: string; objectId: string | null }>();
  return results;
}
