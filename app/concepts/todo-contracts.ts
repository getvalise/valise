/**
 * What a to-do write takes, whichever door it came through. The MCP schemas in
 * `app/mcp/contracts.ts` and the console's form parsers both produce these;
 * neither defines them. Field names follow the MCP arguments because those are
 * the cached client contract, and renaming them here would only add a mapping.
 */

/**
 * Where a to-do's work lives, one kind per question a claimant asks before
 * starting. The column is an open string: this list steers through the tool
 * description and the console's picker, and the console shows whatever was
 * written. V1-20.
 */
export const TODO_REF_KINDS = [
  ["repo", "the repository, as `owner/name` or a clone URL"],
  ["file", "a repo-relative path, with a line or symbol when it narrows"],
  ["url", "a page that explains the work or prompted it"],
  ["issue", "the ticket or PR this came from"],
  ["doc", "the spec, plan, or ADR it implements"],
] as const;

export type TodoRef = { kind: string; value: string };

/** A new to-do. The console's composer may leave the project empty. */
export type TodoDraft = {
  title: string;
  project: string | null;
  body?: string;
  tags?: string[];
  refs?: TodoRef[];
  /** Ids as `todo:<id>`. */
  parent?: string;
  depends_on?: string[];
};

export type TodoClaim = { id: string; ttl_seconds?: number };

export type TodoRelationPatch = {
  reconcile?: true;
  parent?: string | null;
  add_depends_on?: string[];
  remove_depends_on?: string[];
};

/**
 * A fenced update, or a relation-only edit without a token. Which fields may
 * combine is the MCP schema's refinement; the operation trusts it.
 */
export type TodoUpdateRequest = {
  id: string;
  token?: number;
  relations?: TodoRelationPatch;
  body?: string;
  renew_ttl_seconds?: number;
  blocked_on?: string;
  release?: true;
  summary?: string;
  refs?: TodoRef[];
};
