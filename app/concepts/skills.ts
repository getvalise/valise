import { isCollection, isMap, isScalar, parseDocument } from "yaml";
import type { Provenance } from "~/concepts/memories";
import {
  type BundleFile,
  type BundleManifestEntry,
  sha256Hex,
  writeBundle,
} from "~/r2/bundles";
import { docKey, MAX_BODY_BYTES, projectSkill } from "~/search/project";
import { type ProjectionSelect, projectionStatement } from "~/search/write";
import { type DiffLine, diffLines } from "./line-diff";
import { everyTagSql, type ListFilters, tagsParam } from "./list-filters";
import type { ListWindow } from "./pagination";

type SkillEnv = { DB: D1Database; BUNDLES: R2Bucket };

/** A version to publish: from publish_skill, an import, or a console edit, whose files may be bytes. */
export type SkillDraft = {
  body: string;
  project?: string;
  tags?: string[];
  files: BundleFile[];
};

/** Decoded scalars; structured metadata stays YAML. SEP-2640 carries the map. */
export type SkillFrontmatter = Record<string, string>;

/**
 * The frontmatter alone, for something not yet published. A registry preview
 * has to show what a skill claims to be before it is written, including when
 * it claims nothing, so this returns an empty map rather than an error.
 */
export function readFrontmatter(body: string): SkillFrontmatter {
  const parsed = parseSkill(body);
  return Array.isArray(parsed) ? {} : parsed.frontmatter;
}

export type ListedSkill = {
  name: string;
  description: string;
  version: number;
  project: string | null;
  tags: string[];
  frontmatter: SkillFrontmatter;
  /**
   * `owner/repo/skill` when imported from the registry, `builtin:<name>` when
   * the repo itself is the upstream, null when written here.
   */
  source: string | null;
  /** The upstream digest last applied, builtin or registry. Null when authored. */
  sourceHash: string | null;
  /** Off: every agent door closed, the console row still visible. */
  disabled: boolean;
  /** Deleted: gone from every door and from the console's default list. */
  deleted: boolean;
  /** Publishes upstream's newer bundle on the next check, unless edited here. */
  autoUpdate: boolean;
};

/**
 * How far a read reaches. Agents see enabled skills; the console also sees
 * disabled ones it can switch back on; a publish sees deleted ones too, so
 * it brings a name back instead of colliding with it.
 */
export type SkillReach = "enabled" | "disabled" | "deleted";

const REACH: Record<SkillReach, number> = {
  enabled: 0,
  disabled: 1,
  deleted: 2,
};

export type StoredSkill = ListedSkill & {
  skillId: string;
  id: string;
  body: string;
  /** Byte length of `body`, which is what a SEP-2640 manifest reports. */
  size: number;
  files: BundleManifestEntry[];
  sha256: string;
  createdAt: number;
};

export type SkillVersionHistory = {
  version: number;
  body: string;
  sha256: string;
  files: BundleManifestEntry[];
  createdAt: number;
  createdBy: string;
  isHead: boolean;
};

/** Where an imported skill came from. Absent when it was written here. */
export type SkillOrigin = { source: string; sourceHash: string };

export async function publishSkill(
  env: SkillEnv,
  input: SkillDraft,
  provenance: Provenance,
  origin?: SkillOrigin,
): Promise<StoredSkill | { errors: string[] }> {
  return publishVersion(env, input, provenance, origin, null);
}

/** What the editor shows before it publishes: the head it edits and the diff. */
export type SkillEditReview = {
  name: string;
  body: string;
  /** The version a publish would write, or the head when nothing changed. */
  version: number;
  unchanged: boolean;
  diff: DiffLine[];
};

/**
 * Checks an edited SKILL.md against the head it replaces, without writing.
 * The name is the skill's identity, so an edit that changes it is refused
 * here rather than published as a second skill.
 */
export async function reviewSkillEdit(
  db: D1Database,
  userId: string,
  name: string,
  submitted: string,
): Promise<SkillEditReview | { errors: string[] }> {
  const head = await getSkill(db, userId, name, undefined, "disabled");
  if (head === null) return { errors: [`No skill is named ${name}.`] };
  // A textarea submits CRLF whatever it was given, so an untouched edit of
  // an LF body would otherwise publish a new version that differs only there.
  const body = head.body.includes("\r\n")
    ? submitted
    : submitted.replaceAll("\r\n", "\n");
  const parsed = parseSkill(body);
  if (Array.isArray(parsed)) return { errors: parsed };
  if (parsed.name !== name) {
    return {
      errors: [
        `The name is the skill's identity, so an edit keeps name: ${name}.`,
      ],
    };
  }
  const unchanged = (await sha256Hex(body)) === head.sha256;
  return {
    name,
    body,
    version: unchanged
      ? head.version
      : (await highestVersion(db, head.skillId)) + 1,
    unchanged,
    diff: diffLines(head.body, body),
  };
}

/**
 * What adding a SKILL.md would do, before anything is written: whether it
 * parses, and when the name is taken, the version it would become and the
 * diff against that skill's head. Every Add skill source ends here.
 */
export type SkillAddPreview = {
  body: string;
  frontmatter: SkillFrontmatter;
  errors: string[];
  existing: {
    version: number;
    unchanged: boolean;
    diff: DiffLine[];
    source: string | null;
    /** Publishing brings a deleted skill back, unchanged or not. */
    deleted: boolean;
  } | null;
};

export async function previewSkillAdd(
  db: D1Database,
  userId: string,
  body: string,
): Promise<SkillAddPreview> {
  const parsed = parseSkill(body);
  if (Array.isArray(parsed)) {
    return {
      body,
      frontmatter: readFrontmatter(body),
      errors: parsed,
      existing: null,
    };
  }
  const head = await getSkill(db, userId, parsed.name, undefined, "deleted");
  if (head === null) {
    return {
      body,
      frontmatter: parsed.frontmatter,
      errors: [],
      existing: null,
    };
  }
  const unchanged = (await sha256Hex(body)) === head.sha256;
  return {
    body,
    frontmatter: parsed.frontmatter,
    errors: [],
    existing: {
      version: unchanged
        ? head.version
        : (await highestVersion(db, head.skillId)) + 1,
      unchanged,
      diff: diffLines(head.body, body),
      source: head.source,
      deleted: head.deleted,
    },
  };
}

/**
 * Publishes an edited SKILL.md as the next version of `name`. The bundle is
 * carried over by manifest: R2 objects are written once and never replaced,
 * so version N+1 can point at the keys version N wrote rather than copying
 * them. Project, tags and `source` stay as they are, so an imported or
 * built-in skill keeps its attribution and the local edit shows as a head
 * that no longer matches `source_hash`.
 */
export async function editSkill(
  env: SkillEnv,
  name: string,
  body: string,
  provenance: Provenance,
): Promise<StoredSkill | { errors: string[] }> {
  const head = await getSkill(
    env.DB,
    provenance.userId,
    name,
    undefined,
    "disabled",
  );
  if (head === null) return { errors: [`No skill is named ${name}.`] };
  const review = await reviewSkillEdit(env.DB, provenance.userId, name, body);
  if ("errors" in review) return review;
  return publishVersion(
    env,
    { body: review.body, files: [] },
    provenance,
    undefined,
    head.files,
  );
}

async function publishVersion(
  env: SkillEnv,
  input: SkillDraft,
  provenance: Provenance,
  origin: SkillOrigin | undefined,
  /** Manifest entries kept as they are, for an edit that leaves the bundle. */
  carried: BundleManifestEntry[] | null,
): Promise<StoredSkill | { errors: string[] }> {
  const parsed = parseSkill(input.body);
  if (Array.isArray(parsed)) return { errors: parsed };

  const bodySha256 = await sha256Hex(input.body);
  const current = await findSkillByName(env.DB, provenance.userId, parsed.name);
  if (
    current !== null &&
    current.bodySha256 === bodySha256 &&
    (await sameBundle(current.skill.files, input.files))
  ) {
    // Re-adding a deleted skill word for word restores the head it had.
    if (current.skill.deleted) {
      await changeSkills(
        env,
        provenance.userId,
        [current.skill.name],
        "restore",
      );
    }
    // Same content under a new upstream digest: re-attribute the head
    // rather than write a version identical to it.
    if (origin && origin.sourceHash !== current.skill.sourceHash) {
      await env.DB.prepare(
        `UPDATE skills
            SET source = ?, source_hash = ?, source_version_id = head_version_id
          WHERE skill_id = ? AND user_id = ?`,
      )
        .bind(
          origin.source,
          origin.sourceHash,
          current.skill.skillId,
          provenance.userId,
        )
        .run();
      return { ...current.skill, ...origin, deleted: false };
    }
    return { ...current.skill, deleted: false };
  }

  const now = Math.floor(Date.now() / 1000);
  const skillId = current?.skill.skillId ?? `skl_${crypto.randomUUID()}`;
  const version = (await highestVersion(env.DB, skillId)) + 1;
  const versionId = `skv_${crypto.randomUUID()}`;
  const project = input.project ?? current?.skill.project ?? null;
  const tags = input.tags ?? current?.skill.tags ?? [];
  const tagsJson = JSON.stringify(tags);
  let files: BundleManifestEntry[];
  try {
    files =
      carried ??
      (await writeBundle(env.BUNDLES, {
        userId: provenance.userId,
        skillId,
        version,
        files: input.files,
      }));
  } catch (error) {
    return { errors: [errorMessage(error)] };
  }

  const skill = {
    skillId,
    id: docKey("skill", skillId),
    name: parsed.name,
    description: parsed.description,
    frontmatter: parsed.frontmatter,
    source: origin?.source ?? current?.skill.source ?? null,
    sourceHash: origin?.sourceHash ?? current?.skill.sourceHash ?? null,
    disabled: current?.skill.disabled ?? false,
    deleted: false,
    autoUpdate: current?.skill.autoUpdate ?? false,
    version,
    project,
    tags,
    body: input.body,
    size: byteLength(input.body),
    files,
    sha256: bodySha256,
    createdAt: now,
  };
  const statements =
    current === null
      ? [
          env.DB.prepare(
            `INSERT INTO skills (
              skill_id, user_id, name, project, tags_json, visibility,
              head_version_id, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, 'private', NULL, ?, ?)`,
          ).bind(
            skillId,
            provenance.userId,
            parsed.name,
            project,
            tagsJson,
            now,
            now,
          ),
        ]
      : [];
  statements.push(
    env.DB.prepare(
      `INSERT INTO skill_versions (
          version_id, skill_id, version, body_md, body_sha256, files_json,
          created_at, created_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      versionId,
      skillId,
      version,
      input.body,
      bodySha256,
      JSON.stringify(files),
      now,
      provenance.agent,
    ),
    env.DB.prepare(
      // COALESCE, so republishing an imported skill by hand does not quietly
      // erase the attribution it was imported with.
      `UPDATE skills
            SET project = ?, tags_json = ?, head_version_id = ?, updated_at = ?,
                -- A publish over a deleted name brings the skill back.
                deleted_at = NULL,
                source = COALESCE(?, source),
                source_hash = COALESCE(?, source_hash),
                -- The version an import wrote, so a later head past it reads
                -- as edited here.
                source_version_id = COALESCE(?, source_version_id)
          WHERE skill_id = ? AND user_id = ?`,
    ).bind(
      project,
      tagsJson,
      versionId,
      now,
      origin?.source ?? null,
      origin?.sourceHash ?? null,
      origin ? versionId : null,
      skillId,
      provenance.userId,
    ),
    projectionStatement(
      env.DB,
      projectSkill({
        skillId,
        userId: provenance.userId,
        name: parsed.name,
        tagsJson,
        project,
        deletedAt: null,
        // Publishing a new version does not flip the off switch.
        disabledAt: current?.skill.disabled ? now : null,
        updatedAt: now,
        headBodyMd: input.body,
      }),
      skill.id,
    ),
  );
  await env.DB.batch(statements);
  return skill;
}

export async function listSkillVersions(
  db: D1Database,
  userId: string,
  name: string,
): Promise<SkillVersionHistory[]> {
  const { results } = await db
    .prepare(
      `SELECT v.version, v.body_md, v.body_sha256, v.files_json, v.created_at,
              v.created_by, v.version_id = s.head_version_id AS is_head
         FROM skills s
         JOIN skill_versions v ON v.skill_id = s.skill_id
        WHERE s.user_id = ? AND s.name = ?
        ORDER BY v.version DESC`,
    )
    .bind(userId, name)
    .all<{
      version: number;
      body_md: string;
      body_sha256: string;
      files_json: string;
      created_at: number;
      created_by: string;
      is_head: number;
    }>();
  return results.map((row) => ({
    version: row.version,
    body: row.body_md,
    sha256: row.body_sha256,
    files: parseFiles(row.files_json),
    createdAt: row.created_at,
    createdBy: row.created_by,
    isHead: row.is_head === 1,
  }));
}

export async function countSkills(
  db: D1Database,
  userId: string,
  filters: ListFilters = {},
) {
  const { results } = await skillListStatement(
    "SELECT s.deleted_at IS NOT NULL AS deleted, COUNT(*) AS count",
    "GROUP BY deleted",
    db,
  )
    .bind(userId, ...skillListParams(filters, "deleted"))
    .all<{ deleted: number; count: number }>();
  return {
    deleted: results.find((row) => row.deleted === 1)?.count ?? 0,
    total: results
      .filter((row) => filters.showDeleted || row.deleted === 0)
      .reduce((sum, row) => sum + row.count, 0),
  };
}

function skillListParams(filters: ListFilters, reach: SkillReach) {
  return [
    REACH[reach],
    REACH[reach],
    filters.query ?? "",
    filters.query ?? "",
    filters.query ?? "",
    filters.project ?? null,
    filters.project ?? null,
    tagsParam(filters),
  ];
}

function skillListStatement(select: string, tail: string, db: D1Database) {
  return db.prepare(`${select} FROM skills s
         JOIN skill_versions v ON v.version_id = s.head_version_id
        WHERE s.user_id = ?
          AND (? >= 2 OR s.deleted_at IS NULL)
          AND (? >= 1 OR s.disabled_at IS NULL)
          AND (? = '' OR instr(lower(s.name), lower(?)) > 0
            OR instr(lower(v.body_md), lower(?)) > 0)
          AND (? IS NULL OR s.project = ?)
          AND ${everyTagSql("s.tags_json")} ${tail}`);
}

export async function listSkills(
  db: D1Database,
  userId: string,
  filters: ListFilters = {},
  /** The console reaches past "enabled" to show what it can switch back on. */
  reach: SkillReach = "enabled",
  window?: ListWindow,
): Promise<ListedSkill[]> {
  const { results } = await skillListStatement(
    `SELECT s.name, s.project, s.tags_json, s.source, s.source_hash,
              s.disabled_at, s.deleted_at, s.auto_update, v.version, v.body_md`,
    "ORDER BY s.name LIMIT ? OFFSET ?",
    db,
  )
    .bind(
      userId,
      ...skillListParams(filters, reach),
      window?.limit ?? -1,
      window?.offset ?? 0,
    )
    .all<{
      name: string;
      project: string | null;
      tags_json: string;
      source: string | null;
      source_hash: string | null;
      disabled_at: number | null;
      deleted_at: number | null;
      auto_update: number;
      version: number;
      body_md: string;
    }>();
  return results.flatMap((row) => {
    const parsed = parseSkill(row.body_md);
    return Array.isArray(parsed)
      ? []
      : [
          {
            name: row.name,
            description: parsed.description,
            frontmatter: parsed.frontmatter,
            version: row.version,
            project: row.project,
            tags: parseTags(row.tags_json),
            source: row.source,
            sourceHash: row.source_hash,
            disabled: row.disabled_at !== null,
            deleted: row.deleted_at !== null,
            autoUpdate: row.auto_update === 1,
          },
        ];
  });
}

/*
 * D1 refuses a statement with more than 100 bound parameters, so a query
 * with one `?` per skill name fails outright past a hundred skills. Lists
 * that bind names go through this in slices instead.
 */
export const MAX_BOUND = 90;

/** Only the heads needed by list search and bundle counts, never their history. */
export async function listSkillHeads(
  db: D1Database,
  userId: string,
  names: string[],
) {
  return inChunks(names, async (chunk) => {
    const { results } = await db
      .prepare(
        `SELECT s.name, v.body_md AS body, v.files_json
         FROM skills s JOIN skill_versions v ON v.version_id = s.head_version_id
        WHERE s.user_id = ? AND s.name IN (${chunk.map(() => "?").join(", ")})`,
      )
      .bind(userId, ...chunk)
      .all<{ name: string; body: string; files_json: string }>();
    return new Map(
      results.map((row) => [
        row.name,
        {
          name: row.name,
          body: row.body,
          files: parseFiles(row.files_json).length,
        },
      ]),
    );
  });
}

export async function inChunks<T>(
  names: string[],
  read: (chunk: string[]) => Promise<Map<string, T>>,
): Promise<Map<string, T>> {
  const out = new Map<string, T>();
  for (let at = 0; at < names.length; at += MAX_BOUND) {
    for (const [key, value] of await read(names.slice(at, at + MAX_BOUND))) {
      out.set(key, value);
    }
  }
  return out;
}

/** Every import's `source`, disabled ones included, for "already added". */
export async function listImportedSources(
  db: D1Database,
  userId: string,
): Promise<string[]> {
  const { results } = await db
    .prepare(
      "SELECT source FROM skills WHERE user_id = ? AND deleted_at IS NULL AND source IS NOT NULL",
    )
    .bind(userId)
    .all<{ source: string }>();
  return results.map((row) => row.source);
}

/** The name behind a `skill:<id>`, which is what a search result carries. */
export async function skillNameForId(
  db: D1Database,
  userId: string,
  id: string,
): Promise<string | null> {
  const row = await db
    .prepare(
      "SELECT name FROM skills WHERE skill_id = ? AND user_id = ? AND deleted_at IS NULL",
    )
    .bind(id.slice("skill:".length), userId)
    .first<{ name: string }>();
  return row?.name ?? null;
}

/** The head version behind a `skill:<id>`, as `fetch` reads it. */
export type SkillDocument = {
  name: string;
  project: string | null;
  tags: string[];
  visibility: string;
  version: number;
  body: string;
  sha256: string;
  files: BundleManifestEntry[];
  createdAt: number;
  updatedAt: number;
};

/** An enabled, live skill by its stable id. Agent doors only. */
export async function getSkillDocument(
  db: D1Database,
  userId: string,
  skillId: string,
): Promise<SkillDocument | null> {
  const row = await db
    .prepare(
      `SELECT s.name, s.project, s.tags_json, s.visibility, s.updated_at,
              v.version, v.body_md, v.body_sha256, v.files_json, v.created_at
         FROM skills s
         JOIN skill_versions v ON v.version_id = s.head_version_id
        WHERE s.skill_id = ? AND s.user_id = ? AND s.deleted_at IS NULL
          AND s.disabled_at IS NULL`,
    )
    .bind(skillId, userId)
    .first<{
      name: string;
      project: string | null;
      tags_json: string;
      visibility: string;
      updated_at: number;
      version: number;
      body_md: string;
      body_sha256: string;
      files_json: string;
      created_at: number;
    }>();
  if (row === null) return null;
  return {
    name: row.name,
    project: row.project,
    tags: parseTags(row.tags_json),
    visibility: row.visibility,
    version: row.version,
    body: row.body_md,
    sha256: row.body_sha256,
    files: parseFiles(row.files_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSkill(
  db: D1Database,
  userId: string,
  name: string,
  version?: number,
  /** Agent doors stay at "enabled", so a disabled skill answers "not found". */
  reach: SkillReach = "enabled",
): Promise<StoredSkill | null> {
  const row = await db
    .prepare(
      `SELECT s.skill_id, s.name, s.project, s.tags_json, s.source,
              s.source_hash, s.disabled_at, s.deleted_at, s.auto_update,
              v.version, v.body_md,
              v.body_sha256, v.files_json, v.created_at
         FROM skills s
         JOIN skill_versions v ON v.skill_id = s.skill_id
        WHERE s.user_id = ? AND s.name = ?
          AND (? >= 2 OR s.deleted_at IS NULL)
          AND (? >= 1 OR s.disabled_at IS NULL)
          AND (
            (? IS NULL AND v.version_id = s.head_version_id)
            OR (? IS NOT NULL AND v.version = ?)
          )
        LIMIT 1`,
    )
    .bind(
      userId,
      name,
      REACH[reach],
      REACH[reach],
      version ?? null,
      version ?? null,
      version ?? null,
    )
    .first<{
      skill_id: string;
      name: string;
      project: string | null;
      tags_json: string;
      source: string | null;
      source_hash: string | null;
      disabled_at: number | null;
      deleted_at: number | null;
      auto_update: number;
      version: number;
      body_md: string;
      body_sha256: string;
      files_json: string;
      created_at: number;
    }>();
  if (row === null) return null;
  const parsed = parseSkill(row.body_md);
  if (Array.isArray(parsed)) return null;
  return {
    skillId: row.skill_id,
    id: docKey("skill", row.skill_id),
    name: row.name,
    description: parsed.description,
    frontmatter: parsed.frontmatter,
    source: row.source,
    sourceHash: row.source_hash,
    disabled: row.disabled_at !== null,
    deleted: row.deleted_at !== null,
    autoUpdate: row.auto_update === 1,
    version: row.version,
    project: row.project,
    tags: parseTags(row.tags_json),
    body: row.body_md,
    size: byteLength(row.body_md),
    files: parseFiles(row.files_json),
    sha256: row.body_sha256,
    createdAt: row.created_at,
  };
}

export type SkillChange =
  | "enable"
  | "disable"
  | "delete"
  | "restore"
  | "auto-on"
  | "auto-off";

export type SkillChangeReport = {
  changed: string[];
  /**
   * `builtin`: the next deploy would add a deleted built-in straight back.
   * `no-upstream`: written here or built in, so there is nothing to follow.
   */
  skipped: { name: string; reason: "missing" | "builtin" | "no-upstream" }[];
};

/**
 * Switches skills on or off, deletes them, restores them, or sets whether
 * they follow upstream, with every row and its search projection in one
 * batch. Off and deleted both close
 * every agent door; deleted also leaves the console's default list. Versions,
 * bundles and usage history are untouched either way, so each change is
 * undone by its opposite. A name already in the wanted state is left alone.
 */
export async function changeSkills(
  env: SkillEnv,
  userId: string,
  names: string[],
  change: SkillChange,
): Promise<SkillChangeReport> {
  const heads = await inChunks(names, async (chunk) => {
    const { results } = await env.DB.prepare(
      `SELECT s.skill_id, s.name, s.source,
              s.disabled_at, s.deleted_at, s.auto_update
         FROM skills s
         JOIN skill_versions v ON v.version_id = s.head_version_id
        WHERE s.user_id = ? AND s.name IN (${chunk.map(() => "?").join(", ")})`,
    )
      .bind(userId, ...chunk)
      .all<{
        skill_id: string;
        name: string;
        source: string | null;
        disabled_at: number | null;
        deleted_at: number | null;
        auto_update: number;
      }>();
    return new Map(results.map((row) => [row.name, row]));
  });
  const now = Math.floor(Date.now() / 1000);
  const report: SkillChangeReport = { changed: [], skipped: [] };
  const statements: D1PreparedStatement[] = [];
  for (const name of new Set(names)) {
    const row = heads.get(name);
    if (row === undefined) {
      report.skipped.push({ name, reason: "missing" });
      continue;
    }
    if (change === "delete" && row.source?.startsWith("builtin:")) {
      report.skipped.push({ name, reason: "builtin" });
      continue;
    }
    const follows = change === "auto-on" || change === "auto-off";
    if (follows && (row.source === null || row.source.startsWith("builtin:"))) {
      report.skipped.push({ name, reason: "no-upstream" });
      continue;
    }
    const disabledAt =
      change === "enable"
        ? null
        : change === "disable"
          ? (row.disabled_at ?? now)
          : row.disabled_at;
    const deletedAt =
      change === "delete"
        ? (row.deleted_at ?? now)
        : change === "restore"
          ? null
          : row.deleted_at;
    const autoUpdate =
      change === "auto-on" ? 1 : change === "auto-off" ? 0 : row.auto_update;
    if (
      disabledAt === row.disabled_at &&
      deletedAt === row.deleted_at &&
      autoUpdate === row.auto_update
    )
      continue;
    report.changed.push(name);
    // Set only the requested switch. Other switches may have changed since
    // the lookup (for example, a delete overtaking an enable).
    const column = follows
      ? "auto_update"
      : change === "enable" || change === "disable"
        ? "disabled_at"
        : "deleted_at";
    const value = follows
      ? autoUpdate
      : column === "disabled_at"
        ? disabledAt
        : deletedAt;
    const sourceGuard =
      change === "delete"
        ? "AND (source IS NULL OR substr(source, 1, 8) != 'builtin:')"
        : follows
          ? "AND source IS NOT NULL AND substr(source, 1, 8) != 'builtin:'"
          : "";
    statements.push(
      env.DB.prepare(
        `UPDATE skills SET ${column} = ?, updated_at = ? WHERE skill_id = ? AND user_id = ? ${sourceGuard}`,
      ).bind(value, now, row.skill_id, userId),
      ...currentSkillProjection(env.DB, userId, row.skill_id),
    );
  }
  if (statements.length > 0) await env.DB.batch(statements);
  return report;
}

/**
 * Moves a skill's project or tags without a new version. Neither is in the
 * SKILL.md, so a version would record a body that did not change; the row
 * and its search projection move together instead. Null when no such skill.
 */
export async function setSkillLabels(
  env: SkillEnv,
  userId: string,
  name: string,
  patch: { project?: string | null; tags?: string[] },
): Promise<boolean> {
  const skill = await env.DB.prepare(
    "SELECT skill_id FROM skills WHERE user_id = ? AND name = ? AND deleted_at IS NULL",
  )
    .bind(userId, name)
    .first<{ skill_id: string }>();
  if (skill === null) return false;
  const now = Math.floor(Date.now() / 1000);
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE skills SET project = CASE WHEN ? THEN ? ELSE project END,
         tags_json = CASE WHEN ? THEN ? ELSE tags_json END, updated_at = ?
       WHERE skill_id = ? AND user_id = ?`,
    ).bind(
      Number(patch.project !== undefined),
      patch.project ?? null,
      Number(patch.tags !== undefined),
      JSON.stringify(patch.tags ?? []),
      now,
      skill.skill_id,
      userId,
    ),
    ...currentSkillProjection(env.DB, userId, skill.skill_id),
  ]);
  return true;
}

/** Re-read the authoritative head, labels and visibility after the mutation in
 * its batch. Clearing first also removes a projection when a concurrent toggle
 * made the skill invisible; the select then publishes only a current live head. */
function currentSkillProjection(
  db: D1Database,
  userId: string,
  skillId: string,
): D1PreparedStatement[] {
  // SQL equivalent of capBody: cut at the UTF-8 byte budget, not characters,
  // backing off at most three bytes to avoid a split multibyte code point.
  const byte = (back: number) =>
    `hex(substr(CAST(v.body_md AS BLOB), ${MAX_BODY_BYTES - back}, 1))`;
  const continuation = (back: number) => `${byte(back)} BETWEEN '80' AND 'BF'`;
  const trim = `CASE WHEN ${byte(0)} >= 'C0' THEN 1
    WHEN ${continuation(0)} AND ${byte(1)} >= 'E0' THEN 2
    WHEN ${continuation(0)} AND ${continuation(1)} AND ${byte(2)} >= 'F0' THEN 3 ELSE 0 END`;
  const body = `CASE WHEN length(CAST(v.body_md AS BLOB)) <= ${MAX_BODY_BYTES} THEN v.body_md
    ELSE CAST(substr(CAST(v.body_md AS BLOB), 1, ${MAX_BODY_BYTES} - (${trim})) AS TEXT) END`;
  const projection: ProjectionSelect = {
    selectSql: `SELECT 'skill:' || s.skill_id, s.user_id, 'skill', s.skill_id, s.project, s.name,
      ${body}, COALESCE((SELECT group_concat(value, ' ') FROM json_each(s.tags_json)
        WHERE type = 'text'), ''), s.updated_at
      FROM skills s JOIN skill_versions v ON v.version_id = s.head_version_id
      WHERE s.user_id = ? AND s.skill_id = ? AND s.disabled_at IS NULL AND s.deleted_at IS NULL`,
    bindings: [userId, skillId],
  };
  const key = docKey("skill", skillId);
  return [
    projectionStatement(db, null, key),
    projectionStatement(db, projection, key),
  ];
}

/**
 * Whether a publish leaves the bundle as it is. No files sent means "keep
 * the bundle", which is what a body-only republish has always meant; files
 * sent are compared by path and digest, so an upstream update that changed
 * only a script still lands as a version.
 */
async function sameBundle(
  current: BundleManifestEntry[],
  sent: BundleFile[],
): Promise<boolean> {
  if (sent.length === 0) return true;
  if (sent.length !== current.length) return false;
  const held = new Map(current.map((entry) => [entry.path, entry.sha256]));
  for (const file of sent) {
    if (held.get(file.path) !== (await sha256Hex(file.content))) return false;
  }
  return true;
}

async function findSkillByName(db: D1Database, userId: string, name: string) {
  // Disabled and deleted included: publishing to either name is a new version
  // on the existing skill, never a colliding insert.
  const skill = await getSkill(db, userId, name, undefined, "deleted");
  if (skill === null) return null;
  return { skill, bodySha256: skill.sha256 };
}

async function highestVersion(
  db: D1Database,
  skillId: string,
): Promise<number> {
  const row = await db
    .prepare(
      "SELECT COALESCE(MAX(version), 0) AS version FROM skill_versions WHERE skill_id = ?",
    )
    .bind(skillId)
    .first<{ version: number }>();
  return row?.version ?? 0;
}

/**
 * Keep every top-level field for SEP-2640, not just name and description.
 * Collections stay source text in the string-map contract; they are never
 * flattened into sibling fields or converted to JS objects with alias expansion.
 */
function parseSkill(
  body: string,
):
  | { name: string; description: string; frontmatter: SkillFrontmatter }
  | string[] {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(body);
  if (match === null) return ["SKILL.md must start with YAML frontmatter"];
  // The newline before the closing fence belongs to the last YAML value.
  const source = `${match[1]}\n`;
  const document = parseDocument(source, {
    schema: "failsafe",
    stringKeys: true,
    resolveKnownTags: false,
  });
  const problems = [...document.errors, ...document.warnings];
  if (problems.length) {
    return problems.map((problem) => `Invalid frontmatter: ${problem.message}`);
  }
  if (!isMap(document.contents)) return ["frontmatter must be a YAML map"];
  const fields: [string, string][] = [];
  for (const { key, value } of document.contents.items) {
    if (!isScalar(key) || typeof key.value !== "string") {
      return ["frontmatter keys must be strings"];
    }
    if (value === null || (isScalar(value) && value.value === null)) {
      fields.push([key.value, ""]);
    } else if (isScalar(value) && typeof value.value === "string") {
      fields.push([key.value, value.value]);
    } else if (
      key.value !== "name" &&
      key.value !== "description" &&
      isCollection(value) &&
      value.range
    ) {
      const [start, end] = value.range;
      const lineStart = source.lastIndexOf("\n", start - 1) + 1;
      const prefix = source.slice(lineStart, start);
      const from = prefix.trim() ? start : lineStart;
      fields.push([key.value, source.slice(from, end)]);
    } else {
      return [`frontmatter ${key.value} must be a string`];
    }
  }
  const values: SkillFrontmatter = Object.fromEntries(fields);
  const errors: string[] = [];
  const name = values.name ?? "";
  const description = values.description ?? "";
  if (!/^[a-z0-9][a-z0-9-]{0,99}$/.test(name)) {
    errors.push("frontmatter name must be a lowercase slug");
  }
  if (!description.trim()) errors.push("frontmatter description is required");
  return errors.length ? errors : { name, description, frontmatter: values };
}

function parseTags(value: string): string[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

function parseFiles(value: string): BundleManifestEntry[] {
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed.filter(isBundleManifestEntry) : [];
  } catch {
    return [];
  }
}

function isBundleManifestEntry(value: unknown): value is BundleManifestEntry {
  if (typeof value !== "object" || value === null) return false;
  return (
    "path" in value &&
    typeof value.path === "string" &&
    "r2Key" in value &&
    typeof value.r2Key === "string" &&
    "sha256" in value &&
    typeof value.sha256 === "string" &&
    "size" in value &&
    typeof value.size === "number"
  );
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "bundle write failed";
}

/** How many skills `tools/list` serves as their own `skill_{name}` tool. */
export const SKILL_TOOL_LIMIT = 10;

/** The window `rankSkillTools` counts loads over. */
export const SKILL_TOOL_WINDOW_SECONDS = 30 * 86400;

/**
 * The enabled skills that get their own tool in `tools/list`: the most loaded
 * through a `skill_` tool or `get_skill` in the last 30 days, then the most
 * recently published, so a new skill gets a slot while fewer than the limit
 * have loads. Both loads read the `mcp_calls_tool_at` index; prompts and
 * resources are left out because neither has a tool to index on.
 * ADR-0005, amendment of 2026-11-15.
 */
export async function rankSkillTools(
  db: D1Database,
  userId: string,
  limit = SKILL_TOOL_LIMIT,
  now = Math.floor(Date.now() / 1000),
): Promise<string[]> {
  const { results } = await db
    .prepare(
      `WITH loads AS (
         -- 7 is past the 'skill_' prefix; '\`' is the character after '_'.
         SELECT substr(tool, 7) AS name
           FROM mcp_calls
          WHERE tool > 'skill_' AND tool < 'skill\`' AND at >= ?2 AND user_id = ?1
         UNION ALL
         SELECT CASE WHEN json_valid(args_json) THEN json_extract(args_json, '$.name') END
           FROM mcp_calls
          WHERE tool = 'get_skill' AND at >= ?2 AND user_id = ?1
       ),
       counted AS (SELECT name, COUNT(*) AS calls FROM loads GROUP BY name)
       SELECT s.name
         FROM skills s
         JOIN skill_versions v ON v.version_id = s.head_version_id
         LEFT JOIN counted c ON c.name = s.name
        WHERE s.user_id = ?1 AND s.deleted_at IS NULL AND s.disabled_at IS NULL
        ORDER BY COALESCE(c.calls, 0) DESC, v.created_at DESC, s.name
        LIMIT ?3`,
    )
    .bind(userId, now - SKILL_TOOL_WINDOW_SECONDS, limit)
    .all<{ name: string }>();
  return results.map((row) => row.name);
}

export type SkillUsage = {
  /** Calls to the skill's own `skill_{name}` tool. */
  asTool: number;
  /** Calls to `get_skill` naming it. */
  viaGetSkill: number;
  /** `resources/read` of its `skill://` uri. */
  asResource: number;
  asPrompt: number;
  lastSeen: number | null;
};

/**
 * Counts instruction loads by tool, get_skill, resource, and prompt.
 *
 * The resource door is counted through both argument shapes. Before V1-14 a
 * `resources/read` logged its uri as a bare JSON string, and after it the
 * whole `params` object, so a count that read only `$.uri` would show a cliff
 * on the day of that deploy rather than a change in behaviour.
 */
export async function readSkillUsage(
  db: D1Database,
  userId: string,
  names: string[],
): Promise<Map<string, SkillUsage>> {
  if (names.length > MAX_BOUND)
    return inChunks(names, (chunk) => readSkillUsage(db, userId, chunk));
  const usage = new Map<string, SkillUsage>();
  if (names.length === 0) return usage;
  const placeholders = names.map(() => "?").join(", ");
  const { results } = await db
    .prepare(
      `WITH resource_reads AS (
         SELECT
           replace(
              CASE WHEN json_valid(args_json) THEN COALESCE(
                json_extract(args_json, '$.uri'),
                json_extract(args_json, '$')
              ) END,
             'skill://',
             ''
           ) AS rest,
           at
           FROM mcp_calls
          WHERE user_id = ?1 AND method = 'resources/read' AND args_json IS NOT NULL
       ),
       reached AS (
         -- 7 is past the 'skill_' prefix that app/mcp/tools.ts registers.
         SELECT substr(tool, 7) AS name, 'tool' AS door, at
           FROM mcp_calls
          WHERE user_id = ?1 AND tool LIKE 'skill\\_%' ESCAPE '\\'
         UNION ALL
         SELECT CASE WHEN json_valid(args_json) THEN json_extract(args_json, '$.name') END, 'get_skill', at
           FROM mcp_calls
          WHERE user_id = ?1 AND tool = 'get_skill'
         UNION ALL
         SELECT CASE WHEN json_valid(args_json) THEN json_extract(args_json, '$.name') END, 'prompt', at
           FROM mcp_calls
          WHERE user_id = ?1 AND method = 'prompts/get' AND outcome = 'ok'
         UNION ALL
         -- skill://<name>/<path>, so the name stops at the first slash.
         SELECT
           CASE
             WHEN instr(rest, '/') > 0 THEN substr(rest, 1, instr(rest, '/') - 1)
             ELSE rest
           END,
           'resource',
           at
           FROM resource_reads
       )
       SELECT name, door, COUNT(*) AS calls, MAX(at) AS lastSeen
         FROM reached
        WHERE name IN (${placeholders})
        GROUP BY name, door`,
    )
    .bind(userId, ...names)
    .all<{ name: string; door: string; calls: number; lastSeen: number }>();

  for (const row of results) {
    const entry = usage.get(row.name) ?? {
      asTool: 0,
      viaGetSkill: 0,
      asResource: 0,
      asPrompt: 0,
      lastSeen: null,
    };
    if (row.door === "tool") entry.asTool = row.calls;
    if (row.door === "get_skill") entry.viaGetSkill = row.calls;
    if (row.door === "resource") entry.asResource = row.calls;
    if (row.door === "prompt") entry.asPrompt = row.calls;
    entry.lastSeen = Math.max(entry.lastSeen ?? 0, row.lastSeen) || null;
    usage.set(row.name, entry);
  }
  return usage;
}
