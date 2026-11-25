// The recovery table policy and original-file inventory, shared by the
// operator CLI (`backup.mjs`), its restore rehearsal and the scheduled backup
// Workflow. Plain JavaScript with no Node imports, so the Worker bundles it.
// ADR-0019.

// Every application table must have an explicit recovery policy. Unknown tables
// fail backup rather than silently producing an incomplete recovery artifact.
export const TABLES = [
  "users",
  "skills",
  "skill_versions",
  "memories",
  "memory_revisions",
  "memory_links",
  "memory_subjects",
  "memory_subject_members",
  "memory_review_settings",
  "memory_review_groups",
  "memory_review_events",
  "memory_review_budgets",
  "memory_review_ranking",
  "memory_review_ranking_budgets",
  "memory_review_cost_caps",
  // A year of estimated spend; the ledgers it was built from are trimmed sooner.
  "spend_daily",
  // Model output, but each line cost a model call; keep it rather than pay again.
  "memory_lessons",
  "memory_reflections",
  "memory_principles",
  "todos",
  "todo_relations",
  "todo_relation_fences",
  "todo_updates",
  "todo_comments",
  "objects",
  "assets",
  "asset_folders",
  "asset_folder_files",
  "asset_processing",
  "asset_processing_outputs",
  "asset_processing_heads",
  "asset_suggestion_decisions",
  "asset_processing_admissions",
  "sources",
  "source_revisions",
  "source_revision_assets",
  "source_articles",
  "source_enrichments",
  "library_use_events",
  "library_ratings",
  "memory_attachments",
  "todo_attachments",
  "hook_configs",
  // Runnable hooks, ADR-0023: entries before the versions that reference them.
  "hook_runnables",
  "hook_runnable_versions",
  "hook_runnable_decisions",
  "vector_snapshots",
  "transcripts",
  "transcript_turns",
  // Load captured eligibility last: memory/link INSERT triggers have run by then.
  "memory_review_pending",
];
export const OMITTED = [
  // Derived from retained review snapshots by INSERT triggers during restore.
  "memory_review_sources",
  "invites",
  "sessions",
  "password_resets",
  "bearer_tokens",
  "bearer_token_scopes",
  "bearer_token_grants",
  "auth_events",
  "mcp_calls",
  // Runner reports, ADR-0023: kept 90 days like a log. A restore loses at
  // most the day's cross-machine cap counts; decisions they caused are in
  // hook_runnable_decisions, which is backed up.
  "hook_runs",
  "builtin_skill_sync",
  "builtin_skill_sweep",
  "vector_pending",
  "vector_backfills",
  "vector_drain_state",
  // Restore re-enqueues every memory through the ungated vector backfill.
  "vector_deferred",
  // Metering only; a restored day starts its count again.
  "embedding_usage_daily",
  // The failed-command hook's per-session dedupe; sessions last a day at most.
  "hook_recall_injections",
  "asset_drain_state",
  "asset_vector_pending",
  "source_vector_pending",
  "search_index",
  "search_docs",
  "search_fts",
  "search_fts_data",
  "search_fts_idx",
  "search_fts_docsize",
  "search_fts_config",
  "search_fts_vocab",
  "search_docs_fts",
  "search_docs_fts_data",
  "search_docs_fts_idx",
  "search_docs_fts_docsize",
  "search_docs_fts_config",
  "search_docs_vocab",
  // The scheduled backup's own run log and alert state. ADR-0019.
  "backup_runs",
  "backup_alerts",
];

export function checkTables(names) {
  const unknown = names.filter(
    (name) =>
      !TABLES.includes(name) &&
      !OMITTED.includes(name) &&
      ![
        "d1_migrations",
        "_cf_METADATA",
        "_cf_KV",
        "sqlite_sequence",
        "sqlite_stat1",
        "sqlite_stat4",
      ].includes(name),
  );
  if (unknown.length)
    throw new Error(`Unclassified tables: ${unknown.join(", ")}`);
  for (const name of TABLES) {
    if (!names.includes(name))
      throw new Error(`Missing recovery table: ${name}`);
  }
}

export const quote = (name) => `"${name.replaceAll('"', '""')}"`;

export function literal(value) {
  if (value === null) return "NULL";
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string") {
    if (!value.includes("\0")) return `'${value.replaceAll("'", "''")}'`;
    let hex = "";
    for (const byte of new TextEncoder().encode(value))
      hex += byte.toString(16).padStart(2, "0");
    return `CAST(X'${hex}' AS TEXT)`;
  }
  throw new Error("Unsupported recovery SQL value");
}

export function insert(table, row) {
  const columns = Object.keys(row);
  // Fresh migrations contain the bootstrap owner, and nothing else. The
  // restore preflight verifies that before this one allowed upsert is used.
  const conflict =
    table === "users"
      ? ` ON CONFLICT(user_id) DO UPDATE SET ${columns
          .filter((c) => c !== "user_id")
          .map((c) => `${quote(c)}=excluded.${quote(c)}`)
          .join(",")}`
      : "";
  return `INSERT INTO ${quote(table)} (${columns.map(quote).join(",")}) VALUES (${columns.map((c) => literal(row[c])).join(",")})${conflict};`;
}

/**
 * Every R2 key the snapshot's `objects` and `skill_versions` rows name, with
 * the size and SHA-256 recorded in D1, sorted by key. Callers add `file`.
 */
export function inventory(objectRows, versionRows) {
  const entries = new Map();
  function add(key, size, sha256, contentType = "application/octet-stream") {
    if (
      typeof key !== "string" ||
      !key ||
      key.includes("\0") ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      !/^[a-f0-9]{64}$/.test(sha256)
    ) {
      throw new Error("Invalid original-file metadata");
    }
    const previous = entries.get(key);
    if (previous && (previous.size !== size || previous.sha256 !== sha256))
      throw new Error("Conflicting original-file checksums");
    entries.set(key, { key, size, sha256, contentType });
  }
  for (const row of objectRows)
    add(row.r2_key, row.size, row.sha256, row.content_type);
  for (const row of versionRows) {
    for (const file of JSON.parse(row.files_json))
      add(file.r2Key, file.size, file.sha256);
  }
  return [...entries.values()].sort((a, b) => a.key.localeCompare(b.key));
}
