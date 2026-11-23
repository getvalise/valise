/**
 * The recommended memory vocabulary: one type per recall question, per
 * `docs/research/2026-10-17-memory-capture-redesign.md`. The column stays an
 * open string on purpose — a new kind of memory is an edit to this list, not
 * a migration — so this constant steers writers through the tool description
 * and the console's picker rather than rejecting them at the write.
 */
export const MEMORY_TYPES = [
  [
    "decision",
    "the rule a person explicitly chose or approved; name who decided and where, then why and what was rejected",
  ],
  ["insight", "what was learned, including an agent's implementation choices"],
  ["fact", "what is true about a system, project, or the world"],
  ["preference", "how the user wants things done"],
  ["reference", "where a resource is and what it is good for"],
  ["episode", "what happened, when the path is worth retelling"],
] as const;
