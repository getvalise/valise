import { z } from "zod";
import { MAX_SOURCE_IMAGES } from "~/concepts/attachment-limits";
import { HOOK_EVENTS, MAX_HOOK_TEXT_LENGTH } from "~/concepts/hook-config";
import { MEMORY_LINK_KINDS } from "~/concepts/memory-links";
import { SUBJECT_KINDS } from "~/concepts/memory-subjects";
import { MEMORY_TYPES } from "~/concepts/memory-types";
import { MAX_ARTICLE_CHARS } from "~/concepts/source-articles";
import {
  MAX_AUTHORS,
  MAX_NOTES_LENGTH,
  MAX_SOURCE_ASSETS,
  publishedSeconds,
  SOURCE_KINDS,
  type SourceKind,
} from "~/concepts/sources";
import { TODO_REF_KINDS } from "~/concepts/todo-contracts";

/**
 * Why the agent says it is doing this, on the four tools whose arguments
 * cannot answer it: the three claim-path calls, whose arguments are an opaque
 * id and a fencing token, and `save_memory`, whose body says what was saved
 * and not why it was typed and tagged that way. Advisory, logged, never read
 * by the server. ADR-0007.
 *
 * It asks for an explanation rather than for reasoning on purpose: a
 * parameter that asks a model to reproduce its thinking is a documented
 * refusal class, and a refusal is billed.
 */
const why = z
  .string()
  .trim()
  .min(1)
  .max(280)
  .optional()
  .describe(
    "Why this call, in one sentence: the user request or goal it serves. Logged for debugging; never shown to the user and never used for access control.",
  );

/**
 * Library results require an explicit type or include_library, so a client
 * that cached this enum before assets existed never receives one. ADR-0015.
 */
const conceptSchema = z.enum([
  "skill",
  "memory",
  "todo",
  "asset",
  "source",
  "transcript",
]);

const memoryTypeGuide = MEMORY_TYPES.map(
  ([name, means]) => `${name} (${means})`,
).join(", ");

/**
 * Tags carry key-value facets by convention, per ADR-0009: `priority:1` is a
 * tag. The description is the only place a client learns that, so it says it.
 */
const tag = z.string().trim().min(1).max(100);
const writeTags = z
  .array(tag)
  .max(20)
  .describe(
    "Topics as plain words, such as duckdb. Use key:value only for an attribute someone will filter on, such as priority:1 or area:search. Project and type have their own fields; never write them as tags.",
  );

/** The longest query a model may send; a hook's raw error may run longer. */
export const MAX_SEARCH_QUERY = 500;

export const searchInput = z.object({
  query: z.string().trim().min(1).max(100_000),
  type: conceptSchema
    .optional()
    .describe(
      "Narrow to one kind, even with include_library. Use asset for files, books and PDFs; source for bookmarks and saved references. For broad questions across kinds, omit type and set include_library: true.",
    ),
  include_library: z
    .boolean()
    .optional()
    .describe(
      "Set true for broad questions about what is saved on a topic or author: search files and sources alongside skills, memories and to-dos. An explicit type still narrows to that kind.",
    ),
  project: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Exact project filter. Omit to search every project; never invent a project or send * or default as a wildcard.",
    ),
  tags: z
    .array(tag)
    .max(20)
    .optional()
    .describe(
      "Exact tag filter; a result carries every tag listed. Filter a facet such as priority:1 here, not in query.",
    ),
  author: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Only sources by this author, for what a person wrote or says about the query. Give the name as saved; an abbreviation such as Luke W matches Luke Wroblewski. Implies type: source.",
    ),
  limit: z.number().int().min(1).max(100).optional(),
  hook: z
    .literal("PostToolUseFailure")
    .optional()
    .describe(
      "Set only by the Valise plugin's hook, with the failed command's error as query. Never set it yourself.",
    ),
  session_id: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "Set only by the Valise plugin's hook, with hook. Never set it yourself.",
    ),
});

const subjectRef = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  members: z.number(),
});

export const searchOutput = z.looseObject({
  // Memory searches only, when the query names a live subject (ADR-0003).
  subjects: z.array(subjectRef).optional(),
  results: z.array(
    z.looseObject({
      id: z.string(),
      type: conceptSchema,
      title: z.string(),
      snippet: z.string(),
      score: z.number(),
      metadata: z.looseObject({
        project: z.string().nullable(),
        // Optional so a hit still matches the schema clients cached before
        // these existed (ADR-0003).
        created_at: z.number().optional(),
        saved_by: z.string().optional(),
        updated_at: z.number(),
        // To-do hits only, so a skill or memory hit still matches the
        // schema clients cached before these existed (ADR-0003).
        status: z.string().nullable().optional(),
        status_at: z.number().nullable().optional(),
        // Asset passage hits only: where in the file the snippet comes from.
        passage: z
          .looseObject({
            locator: z.string().nullable(),
            first: z.number().nullable(),
            last: z.number().nullable(),
            citation: z.string(),
          })
          .optional(),
        // Library hits the owner has used: why use moved it among near-ties.
        use: z.looseObject({ why: z.array(z.string()) }).optional(),
      }),
    }),
  ),
});

export const fetchInput = z.object({
  id: z
    .string()
    .trim()
    .regex(
      /^(?:(skill|memory|todo|asset|source|subject|transcript):[^:\s]+|https?:\/\/\S+\/activity\/transcripts\?\S+)$/,
    ),
  full: z
    .boolean()
    .optional()
    .describe(
      "To-dos only: give every update on the page its full body. By default only the newest three carry their body and older ones a one-line summary.",
    ),
  cursor: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe(
      "To-dos, subjects and transcripts: next_cursor (or a transcript's prev_cursor) from the preceding fetch, for the next page of older updates, subject members or turns.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe(
      "To-dos: updates per page, newest first, default 10. Transcripts: turns per page, default 40, or 11 around a named message.",
    ),
});

/** At most one related library item, offered beside a to-do or the brief. */
const relatedLibrary = z
  .looseObject({
    id: z.string(),
    title: z.string(),
    reason: z.string(),
    quote: z.string(),
  })
  .optional();

export const fetchOutput = z.looseObject({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  metadata: z.record(z.string(), z.unknown()),
  url: z.string().optional(),
  related_library: relatedLibrary,
});

const memoryId = z
  .string()
  .trim()
  .regex(/^memory:[^:\s]+$/);
export const memoryRelates = z
  .array(z.object({ id: memoryId, kind: z.enum(MEMORY_LINK_KINDS) }))
  .max(20)
  .describe(
    "Links asserted from this memory. part-of points to its parent; supersedes to the memory it fully replaces. related and contradicts are symmetric. All MCP links are suggestions until a person confirms them in the console.",
  );
const subjectId = z
  .string()
  .trim()
  .regex(/^subject:sub_[0-9a-f-]{36}$/);

export const saveMemoryInput = z.object({
  type: z
    .string()
    .trim()
    .min(1)
    .max(100)
    .describe(
      `The recall question this answers: ${memoryTypeGuide}. Default session learnings to insight, or fact for observed state. An implementation or capture request alone is not approval of the agent's choices. Coin a new type only when none of these fit.`,
    ),
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "The claim itself in one sentence, judgeable from a search result list without the body. For a decision, state the applicable rule rather than work completed.",
    ),
  body: z
    .string()
    .trim()
    .min(1)
    .max(16 * 1024)
    .describe(
      "Markdown, conclusion first: the evidence, the alternatives rejected and why, and pointers back (file paths with branch, URLs, tickets). For a decision, rule first, then who decided and where the person explicitly approved it. Put implementation history last.",
    ),
  tags: writeTags.min(1),
  project: z.string().trim().min(1).max(200).optional(),
  relates: memoryRelates.optional(),
  subjects: z
    .array(subjectId)
    .min(1)
    .max(10)
    .optional()
    .describe(
      "Subjects this memory supports, as subject ids from search, get_brief or list_subjects: the person, topic, area or profile it is about. Never guess an id; when no subject fits, omit it.",
    ),
  why,
});

// A write receipt is a cached client contract. A client that discovered the
// closed pre-PR134 receipt still rejects any extra field, so keep this shape.
// Richer data belongs in fetch's open metadata, not this object.
export const saveMemoryOutput = z.looseObject({
  id: z.string(),
  title: z.string(),
  text: z.string(),
  metadata: z.looseObject({
    type: z.string(),
    tags: z.array(z.string()),
    project: z.string().nullable(),
    created_at: z.number(),
  }),
  // Frozen: clients cache this receipt (ADR-0003). Entries also carry
  // created_at and saved_by, which the open object lets through undeclared.
  similar: z.array(z.looseObject({ id: z.string(), title: z.string() })),
});

export const editMemoryInput = z
  .object({
    id: memoryId,
    title: z.string().trim().min(1).max(500).optional(),
    body: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024)
      .optional(),
    type: z.string().trim().min(1).max(100).optional(),
    tags: writeTags.optional(),
    project: z.string().trim().min(1).max(200).nullable().optional(),
    relates: memoryRelates.optional(),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.body !== undefined ||
      input.type !== undefined ||
      input.tags !== undefined ||
      input.project !== undefined ||
      (input.relates?.length ?? 0) > 0,
    "provide a content field or a non-empty relates list",
  );
export const editMemoryOutput = fetchOutput;

const subjectName = z.string().trim().min(1).max(200);
const subjectDescription = z.string().trim().max(1000);

export const listSubjectsInput = z.object({
  name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Keep subjects whose name contains this, ignoring case."),
  page: z.number().int().min(1).max(10000).optional(),
});
export const listSubjectsOutput = z.looseObject({
  subjects: z.array(
    z.looseObject({
      id: z.string(),
      name: z.string(),
      kind: z.string(),
      description: z.string(),
      members: z.number(),
      summary: z.string(),
    }),
  ),
  page: z.number(),
  has_more: z.boolean(),
});

export const saveSubjectInput = z.object({
  name: subjectName,
  kind: z
    .enum(SUBJECT_KINDS)
    .describe(
      "person for someone, topic for a subject of study, area for an ongoing responsibility, profile for the user themself.",
    ),
  description: subjectDescription.optional(),
});
export const saveSubjectOutput = z.looseObject({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  created: z.boolean(),
  url: z.string().optional(),
});

export const editSubjectInput = z.object({
  id: subjectId,
  name: subjectName.optional(),
  kind: z.enum(SUBJECT_KINDS).optional(),
  description: subjectDescription.optional(),
  add_members: z
    .array(memoryId)
    .max(20)
    .optional()
    .describe("Memories that support this subject."),
  remove_members: z
    .array(memoryId)
    .max(20)
    .optional()
    .describe(
      "Memories to take out of this subject. A suggested memory listed here is dismissed and not suggested again.",
    ),
  summary: memoryId
    .nullable()
    .optional()
    .describe(
      "An existing memory to use as the current understanding; null clears it. It cannot also be a member.",
    ),
  new_summary: z
    .string()
    .trim()
    .min(1)
    .max(16 * 1024)
    .optional()
    .describe(
      "Write a new summary memory and make it the current understanding. Not with summary.",
    ),
  deleted: z
    .boolean()
    .optional()
    .describe(
      "true deletes the subject, false restores it. Send it alone. Memories and memberships are kept.",
    ),
});
export const editSubjectOutput = fetchOutput;

const todoId = z
  .string()
  .trim()
  .regex(/^todo:[^:\s]+$/);

/**
 * The one line a reader sees for an update wherever the thread is not shown
 * whole. Optional: without it the body's opening sentences are used.
 */
const updateSummaryInput = z
  .string()
  .trim()
  .min(1)
  .max(500)
  .optional()
  .describe(
    "One plain sentence, under 160 characters, saying where the work stands. It becomes the to-do's status, shown first in fetch and in every list. Omitted, the body's opening sentences, up to 160 characters, are used. Words run together without spaces are refused.",
  );

/**
 * Where a to-do's work stands, in one line, and when that line was written:
 * the summary of its newest progress, comment, blocker or completion. Inside
 * the structured result because Claude Code shows a model `structuredContent`
 * only and drops every extra text block. ADR-0003, amendment of 2026-10-25.
 */
export const todoStatusOutput = {
  status: z.string().nullable(),
  status_at: z.number().nullable(),
};

/**
 * How fresh a to-do's thread is: progress, comments, claims, blocks. A pending
 * to-do with a day-old verification update is not idle, and its state alone
 * does not say so.
 */
export const todoFreshnessOutput = {
  update_count: z.number().int().optional(),
  last_update_at: z.number().nullable().optional(),
  last_update_kind: z.string().nullable().optional(),
  last_update_author: z.string().nullable().optional(),
  last_update_summary: z.string().nullable().optional(),
};

const refKindGuide = TODO_REF_KINDS.map(
  ([name, means]) => `${name} (${means})`,
).join(", ");

const todoRefs = z
  .array(
    z.object({
      kind: z
        .string()
        .trim()
        .min(1)
        .max(32)
        .describe(
          `What this points at: ${refKindGuide}. Coin a new kind only when none of these fit.`,
        ),
      value: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .describe("The pointer itself, exact enough to open or clone."),
    }),
  )
  .max(20)
  .describe(
    "Where the work is, for an agent that was not in this conversation: the repo, the files to change, the page or ticket behind it. Searchable alongside the body.",
  );

export const todoRelationPatch = z
  .object({
    reconcile: z
      .literal(true)
      .optional()
      .describe(
        "Recover an interrupted relation write only: fence any delayed original commit, then inspect the graph. Never replays the edit; do not combine with other relation fields.",
      ),
    parent: todoId
      .nullable()
      .optional()
      .describe(
        "One organizational parent; null removes it. Does not block, claim or complete children.",
      ),
    add_depends_on: z
      .array(todoId)
      .max(20)
      .optional()
      .describe(
        "Prerequisites that must be done before claim. Same owner, across projects allowed.",
      ),
    remove_depends_on: z
      .array(todoId)
      .max(20)
      .optional()
      .describe("Remove these prerequisites. Never clears manual blocked_on."),
  })
  .refine(
    (input) =>
      input.reconcile
        ? input.parent === undefined &&
          input.add_depends_on === undefined &&
          input.remove_depends_on === undefined
        : input.parent !== undefined ||
          (input.add_depends_on?.length ?? 0) > 0 ||
          (input.remove_depends_on?.length ?? 0) > 0,
    "provide a relation change, or reconcile alone",
  );

export const createTodoInput = z.object({
  title: z.string().trim().min(1).max(500),
  project: z.string().trim().min(1).max(200),
  body: z
    .string()
    .trim()
    .max(16 * 1024)
    .optional()
    .describe(
      "Markdown: what done looks like, what has been ruled out, and anything the title cannot carry. Write the next step with identifiers, file paths and parameter values exactly as the user or a tool gave them; never invent a command nobody gave. When the user names subtasks, write each as a `- [ ] step` line here, one line of work each; do not invent them. A step another session should claim on its own is a separate to-do, listed here by its id.",
    ),
  tags: writeTags.optional(),
  refs: todoRefs.optional(),
  parent: todoId
    .optional()
    .describe(
      "Organizational parent for independently claimable work. Markdown checklist steps remain separate.",
    ),
  depends_on: z
    .array(todoId)
    .max(20)
    .optional()
    .describe(
      "Prerequisites that must be done before this to-do can be claimed. Does not replace manual blocked_on.",
    ),
});

export const createTodoOutput = z.looseObject({
  id: todoId,
  title: z.string(),
  created_at: z.number(),
  url: z.string().optional(),
});

export const listReadyInput = z.object({
  project: z.string().trim().min(1).max(200).optional(),
  limit: z
    .number()
    .int()
    .min(1)
    .max(100)
    .optional()
    .describe("Default 20, most recently updated first; raise it to see more."),
  include_blocked: z
    .boolean()
    .optional()
    .describe(
      "Also list manually or dependency-blocked to-dos. Manual reasons remain in blocked_on; fetch relations for structured prerequisites. Claiming resolves only manual blockers, never unfinished prerequisites.",
    ),
  activity: z
    .boolean()
    .optional()
    .describe(
      "Project status instead of the ready queue: claimed, pending, blocked, and done in the last seven days, grouped in that order and newest activity first, each with its state, update count and latest update's summary. Use it for what is going on in a project.",
    ),
});

/**
 * Closed, and cached by clients that discovered it before `activity` existed.
 * A row is the minimum to choose and claim work; tags and refs come from
 * `fetch`. ADR-0003, amendment of 2026-10-25.
 * The fields past `blocked_on` are optional and sent only in answer to
 * `activity: true`, which a client can send only after discovering this
 * schema. A default call stays in the original shape and carries freshness
 * in a second text block. ADR-0003, amendment of 2026-10-22.
 */
export const listReadyOutput = z.looseObject({
  todos: z.array(
    z.looseObject({
      id: todoId,
      title: z.string(),
      ...todoStatusOutput,
      project: z.string().nullable(),
      blocked_on: z.string().optional(),
      state: z.enum(["claimed", "pending", "blocked", "done"]).optional(),
      lease_holder: z.string().nullable().optional(),
      ...todoFreshnessOutput,
    }),
  ),
});

const unixSeconds = z.number().int().min(0).max(253402300799);
const queryTodoState = z.enum(["pending", "claimed", "blocked", "done"]);
export const listTodosInput = z
  .object({
    project: z.string().trim().min(1).max(200).optional(),
    state: queryTodoState.optional(),
    completed_since: unixSeconds
      .optional()
      .describe(
        "Inclusive Unix seconds on completed_at, not edit time. Implies done; omit state or pass done.",
      ),
    completed_before: unixSeconds
      .optional()
      .describe(
        "Exclusive Unix seconds on completed_at: with completed_since, the window [completed_since, completed_before). Implies done.",
      ),
    // Null and "" start a listing too: a model that fills every field has no
    // other way to say "no cursor", and neither can be a real cursor. Anything
    // else that is not a next_cursor is still refused.
    cursor: z
      .string()
      .max(4096)
      .nullable()
      .optional()
      .describe(
        "Opaque next_cursor from the preceding page. Repeat the same filters. Omit or pass null to start a new listing.",
      ),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .refine(
    (input) =>
      (input.completed_since === undefined &&
        input.completed_before === undefined) ||
      input.state === undefined ||
      input.state === "done",
    "completed_since and completed_before require state done or omitted",
  )
  .refine(
    (input) =>
      input.completed_since === undefined ||
      input.completed_before === undefined ||
      input.completed_before > input.completed_since,
    "completed_before must be later than completed_since",
  );

/**
 * A row of `list_todos` and `get_brief`. Since 2026-11-15 a key with nothing
 * to say is left out rather than sent null, so every field past state and
 * created_at is optional (ADR-0003).
 */
const briefTodo = z.looseObject({
  id: todoId,
  title: z.string(),
  status: z.string().nullable().optional(),
  status_at: z.number().nullable().optional(),
  project: z.string().nullable().optional(),
  state: queryTodoState,
  lease_holder: z.string().nullable().optional(),
  lease_expires_at: z.number().nullable().optional(),
  blocked_on: z.string().nullable().optional(),
  created_at: z.number(),
  updated_at: z.number().optional(),
  completed_at: z.number().nullable().optional(),
  update_count: z.number().int().optional(),
  last_update_at: z.number().nullable().optional(),
  last_update_kind: z
    .enum(["progress", "claim", "release", "complete", "blocked", "comment"])
    .nullable()
    .optional(),
  last_update_author: z.string().nullable().optional(),
  last_update_summary: z.string().nullable().optional(),
});
export const listTodosOutput = z.looseObject({
  generated_at: z.number(),
  as_of: z.number(),
  limit: z.number(),
  next_cursor: z.string().nullable(),
  has_more: z.boolean(),
  todos: z.array(
    briefTodo.extend({
      tags: z.array(z.string()).optional(),
      // fetch carries refs; a listing has not sent them since 2026-11-15.
      refs: z
        .array(z.looseObject({ kind: z.string(), value: z.string() }))
        .optional(),
    }),
  ),
});
export const getBriefInput = z.object({
  project: z.string().trim().min(1).max(200).optional(),
  cwd: z
    .string()
    .trim()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Set only by the Valise plugin's hook: the session's working directory, whose worktree claims it re-injects.",
    ),
  hook: z
    .literal("SessionStart")
    .optional()
    .describe("Set only by the Valise plugin's hook. Never set it yourself."),
  since: unixSeconds
    .optional()
    .describe(
      "Inclusive Unix seconds for recent completions and changed memories. Omit unless the user specifies a start time: the server defaults to the preceding 24 hours. Never invent a date. Open work is not time-filtered.",
    ),
});
const briefTodoSection = z.looseObject({
  limit: z.number(),
  has_more: z.boolean(),
  items: z.array(briefTodo),
});
export const getBriefOutput = z.looseObject({
  related_library: relatedLibrary,
  generated_at: z.number(),
  project: z.string().nullable(),
  note: z.string(),
  window: z.looseObject({ since: z.number(), until: z.number() }),
  projects: z.looseObject({
    limit: z.number(),
    has_more: z.boolean(),
    items: z.array(
      z.looseObject({
        project: z.string(),
        active_at: z.number(),
        rollup_id: z.string().nullable(),
        covers_up_to: z.string().nullable(),
      }),
    ),
  }),
  ready: briefTodoSection,
  claimed: briefTodoSection,
  blocked: briefTodoSection,
  completed: briefTodoSection,
  // Optional so a brief still matches the schema clients cached before it.
  subjects: z
    .looseObject({
      limit: z.number(),
      has_more: z.boolean(),
      items: z.array(subjectRef),
    })
    .optional(),
  changed_memories: z.looseObject({
    limit: z.number(),
    has_more: z.boolean(),
    items: z.array(
      z.looseObject({
        id: z.string(),
        title: z.string(),
        type: z.string(),
        project: z.string().nullable(),
        updated_at: z.number(),
      }),
    ),
  }),
});

export const claimTodoInput = z.object({
  id: todoId,
  ttl_seconds: z
    .number()
    .int()
    .min(5)
    .max(24 * 60 * 60)
    .optional(),
  why,
});

export const todoLeaseOutput = z.looseObject({
  id: todoId,
  token: z.number().int().positive(),
  expires_at: z.number().nullable(),
});

/** Relation-only edits mint no lease; zero is the unclaimed ticket's floor. */
export const updateTodoOutput = todoLeaseOutput.extend({
  token: z
    .number()
    .int()
    .nonnegative()
    .describe(
      "Current fencing floor; a relation-only receipt does not grant a claim or authorize guarded writes.",
    ),
});

export const updateTodoInput = z
  .object({
    id: todoId,
    token: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "Required for progress, renewal, refs or manual blocking; omit for a relation-only edit.",
      ),
    relations: todoRelationPatch
      .optional()
      .describe(
        "Relation-only edit: omit token and other changes. Adding unfinished prerequisites to a live claim is refused; release it first.",
      ),
    body: z
      .string()
      .trim()
      .min(1)
      .max(16 * 1024)
      .optional()
      .describe(
        "A finding, appended to the to-do's log. Give a next step with identifiers, file paths and parameter values exactly as the user or a tool gave them; never invent a command. It never edits the to-do's own body, so it cannot tick a `- [ ]` subtask; name the step you finished instead. Ticking is console-only.",
      ),
    renew_ttl_seconds: z
      .number()
      .int()
      .min(5)
      .max(24 * 60 * 60)
      .optional(),
    blocked_on: z.string().trim().min(1).max(500).optional(),
    release: z
      .literal(true)
      .optional()
      .describe(
        "Give the to-do back, pending and claimable, when you stop without finishing it and nothing outside blocks it. Put what is done and what is left in body. Not with blocked_on or renew_ttl_seconds.",
      ),
    summary: updateSummaryInput,
    refs: todoRefs
      .optional()
      .describe(
        "Replaces the pointer list. Send it when the work turned out to live somewhere the ticket does not name yet.",
      ),
    why,
  })
  .refine((input) => {
    const content =
      input.body !== undefined ||
      input.renew_ttl_seconds !== undefined ||
      input.blocked_on !== undefined ||
      input.release !== undefined ||
      input.refs !== undefined;
    return input.relations !== undefined
      ? !content && input.token === undefined && input.summary === undefined
      : content && input.token !== undefined;
  }, "provide a relation-only edit without token, or body/renew_ttl_seconds/blocked_on/release/refs with token")
  .refine(
    (input) =>
      input.release === undefined ||
      (input.blocked_on === undefined && input.renew_ttl_seconds === undefined),
    {
      message:
        "release hands the to-do back; it cannot also block it or renew its lease",
      path: ["release"],
    },
  );

export const completeTodoInput = z.object({
  id: todoId,
  token: z.number().int().positive().optional(),
  summary: z
    .string()
    .trim()
    .min(1)
    .max(16 * 1024),
  why,
});

export const commentTodoInput = z.object({
  id: todoId,
  body: z
    .string()
    .trim()
    .min(1)
    .max(16 * 1024)
    .describe(
      "Markdown. A question for whoever holds the to-do, an answer to one, or context the next agent needs.",
    ),
  summary: updateSummaryInput,
});

export const commentTodoOutput = z.looseObject({
  id: todoId,
  comment_id: z.string(),
  created_at: z.number(),
});

export const editTodoTagsInput = z
  .strictObject({
    id: todoId,
    add_tags: writeTags
      .optional()
      .describe(
        "Tags to add, keeping all others. Use priority:1 (highest) through priority:5 (lowest) for priorities. Project, type and state are not tags.",
      ),
    remove_tags: writeTags
      .optional()
      .describe(
        "Exact tags to remove. To change a priority, remove its old tag and add the new one in this same call.",
      ),
  })
  .refine(
    (input) =>
      (input.add_tags?.length ?? 0) + (input.remove_tags?.length ?? 0) > 0,
    "provide non-empty add_tags or remove_tags",
  );

export const editTodoTagsOutput = z.looseObject({
  id: todoId,
  tags: z.array(z.string()),
  updated_at: z.number(),
});

const bundleFile = z.object({
  path: z.string().trim().min(1).max(512),
  content: z.string().max(256 * 1024),
});

export const publishSkillInput = z.object({
  body: z
    .string()
    .trim()
    .min(1)
    .max(256 * 1024),
  project: z.string().trim().min(1).max(200).optional(),
  tags: writeTags.optional(),
  files: z.array(bundleFile).max(50).default([]),
});

const skillSummary = z.looseObject({
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  project: z.string().nullable(),
  tags: z.array(z.string()),
  frontmatter: z.record(z.string(), z.string()),
});

const bundleManifestEntry = z.looseObject({
  path: z.string(),
  uri: z.string(),
  r2Key: z.string(),
  sha256: z.string(),
  size: z.number().int().nonnegative(),
});

export const listSkillsInput = z.object({});
export const listSkillsOutput = z.looseObject({
  skills: z.array(skillSummary),
});

export const getSkillInput = z.object({
  name: z.string().trim().min(1).max(100),
  version: z.number().int().positive().optional(),
});

export const readSkillFileInput = z.object({
  name: z.string().trim().min(1).max(100),
  path: z
    .string()
    .min(1)
    .max(1024)
    .refine(
      (path) =>
        path !== "SKILL.md" && !path.startsWith("/") && !path.includes(".."),
      "Use a supporting-file path from the loaded skill's manifest, not SKILL.md.",
    ),
});
export const readSkillFileOutput = z.looseObject({
  uri: z.string(),
  mimeType: z.string(),
  text: z.string(),
});

/** Per-skill tools take no arguments: the skill is the tool. */
export const skillToolInput = z.object({});

export const getSkillOutput = z.looseObject({
  id: z.string(),
  uri: z.string(),
  name: z.string(),
  description: z.string(),
  version: z.number().int().positive(),
  project: z.string().nullable(),
  tags: z.array(z.string()),
  body: z.string(),
  files: z.array(bundleManifestEntry),
  sha256: z.string(),
  created_at: z.number(),
});

export const publishSkillOutput = getSkillOutput;

export const listHooksInput = z.object({});

const hookEntry = z.looseObject({
  id: z.string(),
  label: z.string(),
  shipped: z.boolean(),
  event: z.enum(HOOK_EVENTS),
  text: z.string(),
  enabled: z.boolean(),
  every_turns: z.number().int().positive().nullable(),
  default_text: z.string().nullable(),
});

export const listHooksOutput = z.looseObject({
  entries: z.array(hookEntry),
  updated_at: z.number().nullable(),
});

/**
 * One entry per call. `add` makes a custom entry, `change` sets any of text,
 * enabled, and every_turns on an existing one, `remove` deletes a custom one.
 * Flat rather than a union, because a client renders a flat schema as fields.
 */
export const editHookInput = z
  .object({
    action: z.enum(["add", "change", "remove"]),
    id: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .optional()
      .describe(
        "The entry to change or remove, as list_hooks returns it. Omit for add.",
      ),
    event: z
      .enum(HOOK_EVENTS)
      .optional()
      .describe(
        "For add: SessionStart injects at the start of a session, Stop when the model stops, PostToolUseFailure after a shell command fails.",
      ),
    text: z
      .string()
      .trim()
      .min(1)
      .max(MAX_HOOK_TEXT_LENGTH)
      .optional()
      .describe("The text the hook injects. Required for add."),
    enabled: z.boolean().optional(),
    every_turns: z
      .number()
      .int()
      .min(1)
      .optional()
      .describe(
        "Stop entries only: inject on every Nth stop. Ignored for SessionStart.",
      ),
  })
  .superRefine((input, ctx) => {
    // Each issue carries the field it is about, so the repair message names
    // it the way a missing required field would be named.
    const need = (field: "id" | "event" | "text", message: string) =>
      ctx.addIssue({ code: "custom", path: [field], message });
    if (input.action === "add") {
      if (input.event === undefined) need("event", "add needs event");
      if (input.text === undefined) need("text", "add needs text");
    } else if (input.id === undefined) {
      need("id", `${input.action} needs id`);
    }
    if (
      input.action === "change" &&
      input.text === undefined &&
      input.enabled === undefined &&
      input.every_turns === undefined
    ) {
      need("text", "change needs text, enabled, or every_turns");
    }
  });

export const editHookOutput = listHooksOutput;

export type EditHookInput = z.infer<typeof editHookInput>;

// --- Assets, ADR-0015 ---------------------------------------------------------

export const assetId = z
  .string()
  .trim()
  .regex(/^asset:ast_[0-9a-f-]{36}$/)
  .describe("The asset's stable id, as asset:ast_…. Never a URL.");

/** Seconds, so a model writes 86400 rather than reckoning a timestamp. */
const expiresInSeconds = z
  .number()
  .int()
  .min(60)
  .max(366 * 24 * 60 * 60);

const assetText = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(500)
    .describe(
      "What the file is, in words someone would search for. Defaults to the file name.",
    ),
  description: z
    .string()
    .trim()
    .max(4 * 1024)
    .describe(
      "What is in the file and why it was kept. Searchable; the file's own contents are not.",
    ),
  project: z.string().trim().min(1).max(200),
};

export const uploadAssetInput = z.object({
  file_name: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .describe("The file's name, such as screenshot.png."),
  content_type: z
    .string()
    .trim()
    .max(200)
    .optional()
    .describe("Its MIME type, such as image/png or application/pdf."),
  size: z
    .number()
    .int()
    .min(1)
    .max(25 * 1024 * 1024)
    .describe("The exact byte count, which the upload must match."),
  sha256: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{64}$/)
    .optional()
    .describe("Hex SHA-256 of the file. Given, the upload must match it."),
  title: assetText.title.optional(),
  description: assetText.description.optional(),
  project: assetText.project.optional(),
  tags: writeTags.optional(),
  expires_in_seconds: expiresInSeconds
    .optional()
    .describe(
      "Only for a temporary handoff: delete the file this many seconds after now. Omit to keep it.",
    ),
  folder: assetId
    .optional()
    .describe(
      "A ready asset of yours: the new file joins the folder that asset is in, at most 100 files.",
    ),
});

export const uploadAssetOutput = z.looseObject({
  id: assetId,
  folder: assetId.optional(),
  state: z.literal("pending"),
  upload: z.looseObject({
    method: z.literal("PUT"),
    url: z.string(),
    headers: z.record(z.string(), z.string()),
    expires_at: z.number(),
    command: z.string(),
  }),
  max_bytes: z.number(),
  next: z.string(),
});

const assetRecord = z.looseObject({
  id: assetId,
  state: z.enum(["pending", "ready", "failed"]),
  title: z.string(),
  description: z.string(),
  file_name: z.string(),
  content_type: z.string(),
  size: z.number().nullable(),
  sha256: z.string().nullable(),
  project: z.string().nullable(),
  tags: z.array(z.string()),
  expires_at: z.number().nullable(),
  created_at: z.number(),
  updated_at: z.number(),
  finalized_at: z.number().nullable(),
  content_indexed: z.literal(false),
});

export const updateAssetInput = z
  .object({
    id: assetId,
    title: assetText.title.optional(),
    description: assetText.description.optional(),
    project: assetText.project.nullable().optional(),
    tags: writeTags.optional(),
    expires_in_seconds: expiresInSeconds
      .nullable()
      .optional()
      .describe(
        "Delete the file this many seconds from now; null keeps it durably. Refused while a source, to-do or memory refers to it.",
      ),
    folder: assetId
      .optional()
      .describe(
        "A ready file of yours: move this file into the folder that file is in, at most 100 files. Its original, details, links and extracted text stay as they are.",
      ),
    folder_name: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .optional()
      .describe("Rename the folder this file is in, after any move."),
  })
  .refine(
    (input) =>
      input.title !== undefined ||
      input.description !== undefined ||
      input.project !== undefined ||
      input.tags !== undefined ||
      input.expires_in_seconds !== undefined ||
      input.folder !== undefined ||
      input.folder_name !== undefined,
    "provide a field to change",
  );
/** The folder a file is in, by name, and the files it holds. */
const folderSummary = z
  .looseObject({
    name: z.string().nullable(),
    tags: z.array(z.string()).optional(),
    notes: z.string().optional(),
    count: z.number(),
    files: z.array(
      z.looseObject({
        id: z.string(),
        title: z.string(),
        file_name: z.string(),
      }),
    ),
  })
  .nullable();
export const updateAssetOutput = assetRecord.extend({
  folder: folderSummary.optional(),
});

export const getAssetDownloadInput = z.object({ id: assetId });
export const getAssetDownloadOutput = z.looseObject({
  id: assetId,
  url: z.string(),
  expires_at: z.number(),
  file_name: z.string(),
  content_type: z.string(),
  size: z.number(),
  sha256: z.string(),
});

export type UploadAssetInput = z.infer<typeof uploadAssetInput>;
export type UpdateAssetInput = z.infer<typeof updateAssetInput>;

// --- Sources, ADR-0015 --------------------------------------------------------

const sourceId = z
  .string()
  .trim()
  .regex(/^source:src_[0-9a-f-]{36}$/);

const sourceKindGuide = SOURCE_KINDS.map(
  ([name, means]) => `${name} (${means})`,
).join(", ");

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();
const optionalUrl = z
  .url({ protocol: /^https?$/ })
  .max(2048)
  .nullable()
  .optional();

const sourceArticleInput = z.object({
  detected: z.boolean(),
  markdown: z.string().max(MAX_ARTICLE_CHARS),
  text: z.string().max(MAX_ARTICLE_CHARS),
  truncated: z.boolean().optional(),
  word_count: z.number().int().min(0),
  page_word_count: z.number().int().min(0),
  extractor: z.string().trim().min(1).max(100),
  published: optionalText(100),
  site_name: optionalText(200),
  canonical_url: optionalUrl,
  lead_image: optionalUrl,
  description: optionalText(1000),
  language: optionalText(35),
});

export const saveSourceInput = z
  .object({
    id: sourceId
      .optional()
      .describe("Omit to create a source. Pass it to save a new revision."),
    expected_revision: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(
        "With id: the revision you last read. A stale one is refused, not overwritten.",
      ),
    kind: z
      .enum(SOURCE_KINDS.map(([name]) => name) as [SourceKind, ...SourceKind[]])
      .optional()
      .describe(`Required to create: ${sourceKindGuide}.`),
    title: z.string().trim().min(1).max(500).optional(),
    url: z
      .url({ protocol: /^https?$/ })
      .max(2048)
      .nullable()
      .optional()
      .describe("The page this is about, saved as given."),
    notes: z
      .string()
      .trim()
      .max(MAX_NOTES_LENGTH)
      .optional()
      .describe(
        "Markdown: why it matters and what is in it, in your words. Searchable, unlike the page or file itself.",
      ),
    published: z
      .string()
      .trim()
      .max(100)
      .refine((value) => publishedSeconds(value) !== null, {
        message: "an ISO 8601 date or datetime, such as 2026-10-30T09:15:00Z",
      })
      .nullable()
      .optional()
      .describe(
        "When the page or post was published, ISO 8601, as it states. Null clears it. Omitted, the article's published date is used.",
      ),
    project: z.string().trim().min(1).max(200).nullable().optional(),
    tags: writeTags.optional(),
    asset_ids: z
      .array(assetId)
      .max(MAX_SOURCE_ASSETS)
      .optional()
      .describe(
        "Uploaded files this source refers to, from upload_asset. Replaces the list. Needs assets:read.",
      ),
    authors: z
      .array(z.string().trim().min(1).max(200))
      .max(MAX_AUTHORS)
      .optional()
      .describe("Who wrote it, one person per entry. Replaces the list."),
    images: z
      .array(z.url({ protocol: /^https?$/ }).max(2048))
      .max(MAX_SOURCE_IMAGES)
      .optional()
      .describe(
        "A bookmark's images as public URLs, such as a post's photos. Valise fetches and links each one, within the account's size limits. Needs assets:write.",
      ),
    article: sourceArticleInput
      .optional()
      .describe(
        "Only from a client that extracted the article from the live page at capture: its text and the page's metadata. Searchable. Never write your own summary here; that belongs in notes.",
      ),
    check: z
      .boolean()
      .optional()
      .describe(
        "true: save nothing; list your unarchived sources at exactly url, newest first, at most 10, and your 50 most used projects and tags.",
      ),
  })
  .superRefine((input, ctx) => {
    if (input.check) {
      if (!input.url)
        ctx.addIssue({
          code: "custom",
          path: ["url"],
          message: "required with check",
        });
    } else if (input.id === undefined) {
      if (input.kind === undefined)
        ctx.addIssue({ code: "custom", path: ["kind"], message: "required" });
      if (input.title === undefined)
        ctx.addIssue({ code: "custom", path: ["title"], message: "required" });
    } else if (input.expected_revision === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["expected_revision"],
        message: "required with id",
      });
    }
  });

const savedSourceRecord = z.looseObject({
  id: sourceId,
  revision: z.number(),
  kind: z.string(),
  title: z.string(),
  url: z.string().nullable(),
  notes: z.string(),
  project: z.string().nullable(),
  tags: z.array(z.string()),
  authors: z.array(z.string()),
  assets: z.array(
    z.looseObject({
      id: assetId,
      title: z.string(),
      file_name: z.string(),
      available: z.boolean(),
    }),
  ),
  article: z
    .looseObject({ detected: z.boolean(), word_count: z.number() })
    .nullable(),
  published_at: z.number().nullable(),
  images: z
    .array(
      z.looseObject({
        url: z.string(),
        id: z.string().nullable(),
        refused: z.string().nullable(),
      }),
    )
    .optional(),
  created_at: z.number(),
  updated_at: z.number(),
  content_indexed: z.literal(false),
});

/** A save returns the source; `check: true` returns what is saved at the URL and the owner's vocabulary. */
export const saveSourceOutput = z.union([
  savedSourceRecord,
  z.looseObject({
    saved: z.array(
      z.looseObject({
        id: sourceId,
        kind: z.string(),
        title: z.string(),
        revision: z.number(),
        updated_at: z.number(),
        notes: z.string(),
        archive_asset_id: assetId.nullable(),
      }),
    ),
    vocabulary: z.looseObject({
      projects: z.array(z.string()),
      tags: z.array(z.string()),
    }),
  }),
]);

export type SaveSourceInput = z.infer<typeof saveSourceInput>;
