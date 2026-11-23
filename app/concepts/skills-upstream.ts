import type { BundleFile } from "~/r2/bundles";
import type { Provenance } from "./memories";
import { inChunks, MAX_BOUND, publishSkill } from "./skills";
import {
  downloadGithubSkills,
  type GithubEnv,
  parseGithubSource,
} from "./skills-github";
import {
  downloadFromRegistry,
  isFailure,
  type RegistryEnv,
} from "./skills-registry";

/**
 * Has an imported skill changed upstream? `source_hash` is what the import
 * applied; this fetches what upstream holds now and stores its digest beside
 * it, so the console reads a column rather than a network call. ADR-0005.
 *
 * Upstream means the default branch for a `github:` source, and the current
 * download for a skills.sh one. Built-ins are not checked here: a deploy is
 * their upstream, and the sync already compares them.
 */

type UpstreamEnv = { DB: D1Database; BUNDLES: R2Bucket } & RegistryEnv &
  GithubEnv;

/** Who an auto-update publishes as; the user is the row's owner. */
const AUTO_UPDATE: Omit<Provenance, "userId"> = {
  agent: "auto-update",
  client: "worker",
  session: null,
};

/**
 * What one check did. `applied`: published the upstream bundle as the next
 * version. `held`: upstream moved, but the head was edited here, so nothing
 * replaced it.
 */
export type UpstreamReport = {
  errors: string[];
  applied: string[];
  held: string[];
};

export type UpstreamState = {
  /** Upstream's digest at the last check, or null before the first. */
  hash: string | null;
  /** What an update would import: a skills.sh id or a pinned `github:` source. */
  source: string | null;
  checkedAt: number | null;
  /** The last check found upstream past what was imported. */
  available: boolean;
  /** The head was published here after the import, so an update replaces it. */
  editedHere: boolean;
};

type Imported = {
  skill_id: string;
  user_id: string;
  name: string;
  source: string;
  source_hash: string | null;
  auto_update: number;
  edited: number;
};

const IMPORTED = `SELECT skill_id, user_id, name, source, source_hash, auto_update,
         source_version_id IS NOT NULL
           AND source_version_id <> head_version_id AS edited
    FROM skills
   WHERE deleted_at IS NULL AND source IS NOT NULL
     AND source NOT LIKE 'builtin:%'`;

/** One skill, on demand from its dialog. Applies it if it auto-updates. */
export async function checkUpstream(
  env: UpstreamEnv,
  userId: string,
  name: string,
): Promise<UpstreamReport> {
  const row = await env.DB.prepare(`${IMPORTED} AND user_id = ? AND name = ?`)
    .bind(userId, name)
    .first<Imported>();
  if (row === null) {
    return { errors: [`${name} was not imported.`], applied: [], held: [] };
  }
  return check(env, [row], null, false);
}

/**
 * Every imported skill, from the daily cron. One tarball per GitHub
 * repository and one download per skills.sh skill, whatever the count.
 * Skills that auto-update and were not edited here get the new version.
 */
export async function checkAllUpstream(
  env: UpstreamEnv,
): Promise<UpstreamReport> {
  const { results } = await env.DB.prepare(IMPORTED).all<Imported>();
  return check(env, results, null, false);
}

/**
 * The named skills, updated now whether they auto-update or not: the
 * console's Update. A skill edited here is still held, since Update on many
 * rows is not a review of each one's diff; its dialog is.
 */
export async function updateSkills(
  env: UpstreamEnv,
  names: string[],
  provenance: Provenance,
): Promise<UpstreamReport> {
  const rows = await inChunks(names, async (chunk) => {
    const { results } = await env.DB.prepare(
      `${IMPORTED} AND user_id = ? AND name IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(provenance.userId, ...chunk)
      .all<Imported>();
    return new Map(results.map((row) => [row.name, row]));
  });
  return check(env, [...rows.values()], provenance, true);
}

type Fetched = {
  hash: string;
  source: string;
  body: string;
  files: BundleFile[];
};

/** A null provenance is the cron: each row publishes as its own owner. */
async function check(
  env: UpstreamEnv,
  rows: Imported[],
  provenance: Provenance | null,
  force: boolean,
): Promise<UpstreamReport> {
  const errors: string[] = [];
  const found: { row: Imported; got: Fetched }[] = [];

  const repos = new Map<string, { row: Imported; path: string }[]>();
  for (const row of rows) {
    const pinned = parseGithubSource(row.source);
    if (pinned === null) {
      const got = await downloadFromRegistry(env, row.source);
      if (isFailure(got)) errors.push(`${row.name}: ${got.errors.join(" ")}`);
      else found.push({ row, got: { ...got, source: got.id } });
      continue;
    }
    const key = `${pinned.owner}/${pinned.repo}`;
    repos.set(key, [...(repos.get(key) ?? []), { row, path: pinned.path }]);
  }

  for (const [key, skills] of repos) {
    const [owner, repo] = key.split("/");
    const read = await downloadGithubSkills(
      env,
      owner,
      repo,
      "HEAD",
      skills.map((skill) => skill.path),
    );
    for (const { row, path } of skills) {
      const got = "errors" in read ? read : read.get(path);
      if (got === undefined || "errors" in got) {
        errors.push(`${row.name}: ${got?.errors.join(" ") ?? "not found"}`);
      } else {
        found.push({ row, got });
      }
    }
  }

  const now = Math.floor(Date.now() / 1000);
  if (found.length > 0) {
    await env.DB.batch(
      found.map(({ row, got }) =>
        env.DB.prepare(
          `UPDATE skills
              SET upstream_hash = ?, upstream_source = ?, upstream_checked_at = ?
            WHERE skill_id = ?`,
        ).bind(got.hash, got.source, now, row.skill_id),
      ),
    );
  }

  // Applying is an ordinary import publish, so it gets an immutable version,
  // the projection write, and `source_version_id` moved to the new head.
  const applied: string[] = [];
  const held: string[] = [];
  for (const { row, got } of found) {
    if (got.hash === row.source_hash) continue;
    if (!force && row.auto_update !== 1) continue;
    if (row.edited === 1) {
      held.push(row.name);
      continue;
    }
    const published = await publishSkill(
      env,
      { body: got.body, files: got.files },
      provenance ?? { ...AUTO_UPDATE, userId: row.user_id },
      { source: got.source, sourceHash: got.hash },
    );
    if ("errors" in published) {
      errors.push(`${row.name}: ${published.errors.join(" ")}`);
    } else {
      applied.push(row.name);
    }
  }
  return { errors, applied, held };
}

/** The stored state for the console, one row per name. No network. */
export async function readUpstream(
  db: D1Database,
  userId: string,
  names: string[],
): Promise<Map<string, UpstreamState>> {
  if (names.length > MAX_BOUND)
    return inChunks(names, (chunk) => readUpstream(db, userId, chunk));
  const out = new Map<string, UpstreamState>();
  if (names.length === 0) return out;
  const { results } = await db
    .prepare(
      `SELECT name, source_hash, upstream_hash, upstream_source,
              upstream_checked_at,
              source_version_id IS NOT NULL
                AND source_version_id <> head_version_id AS edited
         FROM skills
        WHERE user_id = ? AND name IN (${names.map(() => "?").join(", ")})
          AND source IS NOT NULL AND source NOT LIKE 'builtin:%'`,
    )
    .bind(userId, ...names)
    .all<{
      name: string;
      source_hash: string | null;
      upstream_hash: string | null;
      upstream_source: string | null;
      upstream_checked_at: number | null;
      edited: number;
    }>();
  for (const row of results) {
    out.set(row.name, {
      hash: row.upstream_hash,
      source: row.upstream_source,
      checkedAt: row.upstream_checked_at,
      available:
        row.upstream_hash !== null && row.upstream_hash !== row.source_hash,
      editedHere: row.edited === 1,
    });
  }
  return out;
}
