import { McpServer } from "@modelcontextprotocol/server";
import type { z } from "zod";
import {
  ASSET_COVERAGE,
  type PassageCitation,
  parsePassageKey,
} from "~/concepts/assets";
import { withoutAuthorName } from "~/concepts/authors";
import { routeReservedTags } from "~/concepts/facets";
import {
  editHookConfig,
  type HookConfigEdit,
  type HookEntry,
  hookEntries,
} from "~/concepts/hook-config";
import type { RunnableEntry, RunnableVersion } from "~/concepts/hook-runnables";
import { itemPath } from "~/concepts/item-path";
import {
  NEAR_TIE,
  orderByUse,
  useReasons,
  useScore,
} from "~/concepts/library-use";
import type { Provenance } from "~/concepts/memories";
import { MemorySubjectError } from "~/concepts/memories";
import { MemoryLinkError } from "~/concepts/memory-links";
import type { getSkill } from "~/concepts/skills";
import { SOURCE_COVERAGE } from "~/concepts/sources";
import type { ProjectBrief } from "~/concepts/startup-brief";
import {
  freshnessFields,
  NO_UPDATES,
  statusFields,
  todoStatus,
} from "~/concepts/todo-activity";
import { TodoCursorError } from "~/concepts/todo-query";
import type { TodoRelations } from "~/concepts/todo-relations";
import type { TodoUpdate } from "~/concepts/todos";
import {
  transcriptLines,
  transcriptRef,
  transcriptTurnRef,
} from "~/concepts/transcripts";
import { unreadableSummary } from "~/concepts/update-summary";
import type { SearchConcept } from "~/db/schema";
import { fetchAsset, registerAssetTools } from "~/mcp/asset-tools";
import {
  attachmentEntries,
  registerAttachmentResources,
} from "~/mcp/attachment-resources";
import {
  claimTodoInput,
  commentTodoInput,
  commentTodoOutput,
  completeTodoInput,
  createTodoInput,
  createTodoOutput,
  type EditHookInput,
  editHookInput,
  editHookOutput,
  editMemoryInput,
  editMemoryOutput,
  editSubjectInput,
  editSubjectOutput,
  editTodoTagsInput,
  editTodoTagsOutput,
  fetchInput,
  fetchOutput,
  getBriefInput,
  getBriefOutput,
  getSkillInput,
  getSkillOutput,
  listHooksInput,
  listHooksOutput,
  listReadyInput,
  listReadyOutput,
  listSkillsInput,
  listSkillsOutput,
  listSubjectsInput,
  listSubjectsOutput,
  listTodosInput,
  listTodosOutput,
  MAX_SEARCH_QUERY,
  proposeHookInput,
  proposeHookOutput,
  publishSkillInput,
  publishSkillOutput,
  readSkillFileInput,
  readSkillFileOutput,
  saveMemoryInput,
  saveMemoryOutput,
  saveSubjectInput,
  saveSubjectOutput,
  searchInput,
  searchOutput,
  skillToolInput,
  todoLeaseOutput,
  updateTodoInput,
  updateTodoOutput,
} from "~/mcp/contracts";
import nudges from "~/mcp/nudges.json";
import { RERANK_META } from "~/mcp/observe";
import { registerSkillPrompts } from "~/mcp/prompts";
import {
  readSkillFile,
  registerSkillResources,
  skillUri,
} from "~/mcp/resources";
import { textResult, toolError, withoutEmpty } from "~/mcp/results";
import { fetchSource, registerSourceTools } from "~/mcp/source-tools";
import type { SearchHit } from "~/search/query";
import {
  normaliseError,
  recallFingerprint,
  recallHitsText,
} from "~/search/recall";
import {
  ALL_CONCEPTS,
  PROJECTED_CONCEPTS,
  SEARCH_CONCEPTS,
} from "~/search/reindex";
import type { VectorBindings } from "~/search/vectors";
import type { TenantStore } from "~/store/tenant.server";

type McpEnv = VectorBindings & {
  DB: D1Database;
  BUNDLES: R2Bucket;
  TODO_COORDINATOR: DurableObjectNamespace<
    import("~/do/todo-coordinator").TodoCoordinator
  >;
  AI?: Ai;
  /** Which reranker `search` runs; unset in production. `rerankMode`. */
  VALISE_RERANK?: string;
  /** A Worker secret. Set, `search` reranks with Jev. ADR-0013. */
  TYPESAFE_API_KEY?: string;
  /** Keys asset upload credentials and download signatures. ADR-0015. */
  TOKEN_PEPPER?: string;
};

/** `capture-this` → `skill_capture-this`. */
export function skillToolName(name: string): string {
  return `${SKILL_TOOL_PREFIX}${name}`;
}

export const SKILL_TOOL_PREFIX = "skill_";

/**
 * What the request says about the client beyond provenance. `hooks` is true
 * when the valise plugin sent its header, which means the plugin's own Stop
 * hook already carries the capture nudge. `origin` is where the request
 * reached this Worker, so an item's console URL points back at the same host.
 * `method` is the JSON-RPC method, so `tools/list` can list fewer skill tools
 * than a call can reach.
 */
export type Caller = { hooks: boolean; origin?: string; method?: string };

export async function createServer(
  env: McpEnv,
  provenance: Provenance,
  caller: Caller,
  /** Bound to the same tenant as `provenance` by the transport's auth step. */
  store: TenantStore,
  /** From `serverInstructions`; null leaves the handshake without any. */
  instructions: string | null = null,
): Promise<McpServer> {
  const server = new McpServer(
    { name: "valise", version: "0.1.0" },
    {
      ...(instructions ? { instructions } : {}),
      // dispatch creates a fresh stateless handler for each request. Neither
      // legacy GET nor a prior handler's modern subscription can receive our
      // catalog changes. Do not promise deployment-wide push invalidation.
      capabilities: {
        tools: { listChanged: false },
        prompts: { listChanged: false },
        resources: { listChanged: false },
      },
    },
  );
  /**
   * get_brief for a project nothing is filed under, often a repository whose
   * name is not its project: say so and list the projects that exist, so the
   * agent asks rather than guessing. ADR-0004, 2026-11-04.
   */
  async function unknownProject(
    project: string,
    since: number | undefined,
    scoped: ProjectBrief,
  ): Promise<ProjectBrief> {
    const all = await store.todos.brief({ since });
    const names = all.projects.items.map((row) => row.project);
    return {
      ...scoped,
      projects: all.projects,
      note:
        `No to-dos or memories are filed under project "${project}". ` +
        (names.length
          ? `Active projects: ${names.join(", ")}. Ask the user which one this work belongs to`
          : "Nothing is filed under any project yet. Ask the user what to call this one") +
        `; to make it stick for a repository, commit .valise.json with {"project": "<name>"} at its root. ${scoped.note}`,
    };
  }

  /**
   * search with `hook: "PostToolUseFailure"`, from the plugin's mcp_tool hook:
   * Claude Code reads the text as hook output, so the answer is the hook's
   * shape. The shipped entry injects recall hits, or nothing below the bar;
   * the owner's enabled custom PostToolUseFailure entries follow it.
   *
   * With `session_id`, the hits pass a deterministic gate first: an empty
   * normalised error, an error already injected this session, or a session
   * that already had three injections searches nothing. The call is still
   * one row in the call log, like every other. ADR-0004, 2026-11-04.
   */
  async function recallOnError(error: string, sessionId: string | undefined) {
    const read = hookEntries((await store.hooks.read()).document);
    const entries = "error" in read ? [] : read.entries;
    const texts: string[] = [];
    const shipped = entries.find((entry) => entry.id === "recall-on-error");
    if (shipped?.enabled !== false) {
      const query = normaliseError(error);
      if (query && sessionId) {
        const now = Math.floor(Date.now() / 1000);
        const fingerprint = await recallFingerprint(query);
        if (
          (await store.recallGate.read(sessionId, fingerprint, now)) === "open"
        ) {
          const hits = await store.recall(query);
          if (
            hits.length &&
            (await store.recallGate.record(sessionId, fingerprint, now))
          )
            texts.push(recallHitsText(hits));
        }
      } else if (query) {
        const hits = await store.recall(query);
        if (hits.length) texts.push(recallHitsText(hits));
      }
    }
    for (const entry of entries)
      if (
        !entry.shipped &&
        entry.enabled &&
        entry.event === "PostToolUseFailure"
      )
        texts.push(entry.text);
    return {
      results: [],
      ...(texts.length && {
        hookSpecificOutput: {
          hookEventName: "PostToolUseFailure",
          additionalContext: texts.join("\n\n"),
        },
      }),
    };
  }

  registerSkillResources(server, env.BUNDLES, store.skills);
  registerSkillPrompts(server, store.skills);
  registerAttachmentResources(server, store.files);
  registerAssetTools(server, store.library, caller.origin);
  registerSourceTools(server, store);
  await registerSkillTools(server, store, caller.method === "tools/list");

  server.registerTool(
    "read_skill_file",
    {
      description:
        "Read a text supporting file referenced by an already-loaded skill. Pass its name and a path from its files manifest, such as references/guide.md. Read only files needed for the task. To load the skill instructions first, use its skill_<name> tool or get_skill. Does not execute files; binary files require MCP resources/read.",
      inputSchema: readSkillFileInput,
      outputSchema: readSkillFileOutput,
    },
    async ({ name, path }) => {
      const uri = skillUri(name, path);
      const file = await readSkillFile(env.BUNDLES, store.skills, uri);
      if (file === null)
        return toolError(`No active skill supporting file exists at ${uri}.`);
      if (!("text" in file))
        return toolError(
          `This file is binary. Read ${uri} through MCP resources/read instead.`,
        );
      return textResult({ uri, ...file });
    },
  );

  server.registerTool(
    "create_todo",
    {
      title: "Create a Valise to-do",
      description:
        "Create durable cross-session work when another agent may need to claim it. Use a concise title and the project that owns the work. Name the repo, files, or page in refs when you already know them; do not go looking first.",
      inputSchema: createTodoInput,
      outputSchema: createTodoOutput,
    },
    async (input) => {
      const routed = routeReservedTags(input.tags ?? [], {
        project: input.project,
      });
      if ("error" in routed) return toolError(routed.error);
      const todo = await store.todos.create({
        ...input,
        tags: input.tags && routed.tags,
      });
      return textResult({
        id: todo.id,
        title: todo.title,
        created_at: todo.createdAt,
        ...consoleUrl(caller, todo.id),
      });
    },
  );

  server.registerTool(
    "list_ready",
    {
      title: "List ready Valise to-dos",
      description:
        "List pending, unblocked to-dos before starting cross-session work. Call claim_todo before working a listed ticket. Pass include_blocked to also see blocked ones with their blocked_on, such as a to-do waiting on a PR that may have merged since. A pending to-do can still hold progress in its updates; for what is going on in a project, pass activity.",
      inputSchema: listReadyInput,
      outputSchema: listReadyOutput,
    },
    async (input) => {
      if (input.activity)
        return textResult({
          todos: (await store.todos.activity(input.project, input.limit)).map(
            (todo) => ({
              id: todo.id,
              title: todo.title,
              // Required by the schema clients cached on 2026-10-25, so sent
              // even when null. The rest is optional and left out when empty.
              ...statusFields(todo),
              project: todo.project,
              ...withoutEmpty({
                blocked_on: todo.blockedOn,
                state: todo.state,
                lease_holder: todo.leaseHolder,
                ...freshnessFields(todo),
                update_count: todo.updateCount === 0 ? null : todo.updateCount,
                last_update_summary:
                  todo.lastUpdateSummary === todo.status
                    ? null
                    : todo.lastUpdateSummary,
              }),
            }),
          ),
        });
      // The row and the result stay in the strict shape clients cached on
      // 2026-10-25, so a shorter page is the saving here, not fewer keys.
      const todos = await store.todos.ready(
        input.project,
        input.limit ?? LIST_READY_LIMIT,
        input.include_blocked,
      );
      const freshness = await store.todos.freshness(
        todos.map((todo) => todo.id.slice("todo:".length)),
      );
      return textResult({
        todos: todos.map((todo) => ({
          id: todo.id,
          title: todo.title,
          ...statusFields(
            freshness.get(todo.id.slice("todo:".length)) ?? NO_UPDATES,
          ),
          project: todo.project,
          ...(todo.blockedOn !== null && { blocked_on: todo.blockedOn }),
        })),
      });
    },
  );

  server.registerTool(
    "get_brief",
    {
      title: "Get bounded Valise orientation",
      description:
        "Orient a new session without hooks or guessed search keywords: recent projects and rollup IDs, ready work, active claims, blockers, recent completions and changed memories. Optional project and since (Unix seconds, omit for last 24h). Each section has explicit bounds; fetch listed IDs before acting. related_library, when present, is one saved page or file that may bear on the current work: use it only if it changes the answer, citing it; otherwise ignore it. For complete task enumeration or completion reports use list_todos. For choosing work or checking whether blockers cleared, use list_ready (include_blocked: true for blockers).",
      inputSchema: getBriefInput,
      outputSchema: getBriefOutput,
    },
    async (input) => {
      if (
        input.since !== undefined &&
        input.since > Math.floor(Date.now() / 1000)
      )
        return toolError(
          "since must not be in the future (use Unix seconds, not milliseconds).",
        );
      const scoped = briefOnWire(
        await store.todos.brief({
          project: input.project,
          since: input.since,
        }),
        input.project,
      );
      // The plugin's SessionStart hook after a compaction: Claude Code reads
      // this result's text as hook output, so the worktree's claims ride in
      // `hookSpecificOutput` and the brief's own keys are ignored. ADR-0004.
      if (input.hook === "SessionStart") {
        const claims = input.cwd
          ? await store.startupBrief({ cwd: input.cwd, claimedOnly: true })
          : "";
        return textResult(
          claims
            ? {
                ...scoped,
                hookSpecificOutput: {
                  hookEventName: "SessionStart",
                  additionalContext: claims,
                },
              }
            : scoped,
        );
      }
      const oriented =
        input.project && scoped.projects.items.length === 0
          ? await unknownProject(input.project, input.since, scoped)
          : scoped;
      const brief = {
        ...oriented,
        subjects: await store.subjects.brief(input.project ?? null),
      };
      // About what the session is most likely to work on: its claim, else
      // the next ready to-do. Absent unless something clears the bar.
      const focus = brief.claimed.items[0] ?? brief.ready.items[0];
      const related = focus ? await store.library.related(focus.title) : null;
      return textResult(
        related ? { ...brief, related_library: related } : brief,
      );
    },
  );

  server.registerTool(
    "list_todos",
    {
      title: "Page through Valise to-dos",
      description:
        "Enumerate tasks by project, state, or completion time: completed_since (inclusive) and completed_before (exclusive), Unix seconds. Returns compact state, blockers and progress summaries, never full task bodies. Follow next_cursor with the same filters until null for a complete report; fetch IDs for evidence. Stable creation-time ordering excludes later inserts; state membership stays live, not a snapshot. For a bounded mixed-context orientation use get_brief; for work to claim use list_ready.",
      inputSchema: listTodosInput,
      outputSchema: listTodosOutput,
    },
    async (input) => {
      try {
        const page = await store.todos.query(input);
        return textResult({
          ...page,
          // refs are fetch's: a listing names the work, fetch says where it is.
          todos: page.todos.map(({ refs: _refs, ...todo }) =>
            todoRowOnWire(todo, input.project),
          ),
        });
      } catch (error) {
        if (error instanceof TodoCursorError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "claim_todo",
    {
      title: "Claim a Valise to-do",
      description:
        "Atomically claim a ready to-do before beginning it. With its id already in the conversation, claim it directly; do not search for it first. Keep the returned fencing token for update_todo and complete_todo. Claiming a manually blocked to-do reopens it: do that only once its blocked_on is resolved. Claiming a done to-do reopens it too: do that only when its work turns out unfinished or has to be redone. Structured prerequisites must all be done; claim never clears them.",
      inputSchema: claimTodoInput,
      outputSchema: todoLeaseOutput,
    },
    async (input) => {
      const claimed = await store.todos.claim(input);
      if (!claimed.ok) return todoFailure(input.id, claimed);
      const result = textResult({
        id: input.id,
        token: claimed.token,
        expires_at: claimed.expiresAt,
      });
      return {
        ...result,
        content: [
          ...result.content,
          { type: "text" as const, text: PROGRESS_NUDGE },
        ],
      };
    },
  );

  server.registerTool(
    "update_todo",
    {
      title: "Update a claimed Valise to-do",
      description:
        "Append a finding, renew the lease, repoint refs, manually block, or release a to-do you hold, with its fencing token. Release when you stop before finishing, so it is claimable again at once instead of when the lease expires. For a relation-only edit, pass relations without token: set its parent or add/remove blocking prerequisites. Relations never clear manual blocked_on or cascade completion.",
      inputSchema: updateTodoInput,
      outputSchema: updateTodoOutput,
    },
    async (input) => {
      // A block stores its own line: the summary when no body takes it,
      // else the blocker's opening sentences.
      const unreadable =
        unreadableSummary(input.body, input.summary) ??
        unreadableSummary(
          input.blocked_on,
          input.body === undefined ? input.summary : null,
        );
      if (unreadable) return toolError(unreadable);
      const updated = await store.todos.update(input);
      if (!updated.ok) return todoFailure(input.id, updated);
      const result = textResult({
        id: input.id,
        token: updated.token,
        expires_at: updated.expiresAt,
      });
      return input.relations?.reconcile
        ? {
            ...result,
            content: [
              ...result.content,
              {
                type: "text" as const,
                text: "Interrupted relation writes are fenced. Fetch the attempted to-do to inspect what committed before retrying. Reconciliation never replays an edit or grants a claim.",
              },
            ],
          }
        : result;
    },
  );

  server.registerTool(
    "complete_todo",
    {
      title: "Complete a Valise to-do",
      description:
        "Close a to-do with a concise result summary. If you hold it, include the fencing token returned by claim_todo. To close one nobody holds, such as work already finished elsewhere, omit the token; do not claim it first. A to-do another agent holds is refused.",
      inputSchema: completeTodoInput,
      outputSchema: todoLeaseOutput,
    },
    async (input) => {
      const unreadable = unreadableSummary(input.summary);
      if (unreadable) return toolError(unreadable);
      const completed = await store.todos.complete(
        input.id,
        input.token,
        input.summary,
      );
      if (!completed.ok) return todoFailure(input.id, completed);
      const result = textResult({
        id: input.id,
        token: completed.token,
        expires_at: completed.expiresAt,
      });
      // Once per session, read from the call log; without a session id every
      // completion nudges, which is still one line per finished to-do.
      if (
        caller.hooks ||
        (provenance.session !== null &&
          (await store.activity.completedTodoInSession(provenance.session)))
      )
        return result;
      return {
        ...result,
        content: [
          ...result.content,
          { type: "text" as const, text: CAPTURE_NUDGE },
        ],
      };
    },
  );

  server.registerTool(
    "edit_todo_tags",
    {
      title: "Edit a Valise to-do's tags",
      description:
        "Add or remove tags on an existing to-do, including priority:1 (highest) through priority:5 (lowest). Pass add_tags and/or remove_tags; other tags stay unchanged. To replace a priority, remove the old tag and add the new one together. Needs no claim or token and never changes state, blockers or another agent's lease. Returns the saved tags; does not delete or recreate the to-do.",
      inputSchema: editTodoTagsInput,
      outputSchema: editTodoTagsOutput,
    },
    async ({ id, ...edit }) => {
      const saved = await store.todos.editTags(id.slice("todo:".length), edit);
      if ("error" in saved) return toolError(saved.error);
      return textResult({ id, tags: saved.tags, updated_at: saved.updatedAt });
    },
  );

  server.registerTool(
    "comment_todo",
    {
      title: "Comment on a Valise to-do",
      description:
        "Leave a comment on any to-do: a question for whoever holds it, an answer to one, or context the next agent needs. Needs no claim and no token, and does not change who holds it or its state. Your own findings on a to-do you hold go in update_todo.",
      inputSchema: commentTodoInput,
      outputSchema: commentTodoOutput,
    },
    async (input) => {
      const unreadable = unreadableSummary(input.body, input.summary);
      if (unreadable) return toolError(unreadable);
      const commented = await store.todos.comment(
        input.id.slice("todo:".length),
        input.body,
        input.summary ?? null,
      );
      if (commented === null) return toolError(`${input.id}: todo not found.`);
      return textResult({
        id: input.id,
        comment_id: commented.commentId,
        created_at: commented.createdAt,
      });
    },
  );

  server.registerTool(
    "search",
    {
      title: "Search Valise",
      description:
        "Search context another client saved in Valise. For broad questions about what is saved on a topic or author, omit type and set include_library: true to search all kinds together. For requests specifically for files, books or PDFs, use type: asset; for bookmarks and saved references, use type: source. Files match metadata and available processed text; unprocessed file contents are not indexed. Sources match notes, authors and captured page text; set author for one person's sources. Use a returned id with fetch for the full item and extraction coverage. Cite a library passage you use; do not pad an answer with ones you do not.",
      inputSchema: searchInput,
      outputSchema: searchOutput,
    },
    async (input) => {
      if (input.hook === "PostToolUseFailure")
        return textResult(await recallOnError(input.query, input.session_id));
      if (input.query.length > MAX_SEARCH_QUERY)
        return toolError(
          `query: at most ${MAX_SEARCH_QUERY} characters; search the distinctive words.`,
        );
      const routed = routeReservedTags(input.tags ?? [], {
        project: input.project,
        type: input.type,
      });
      if ("error" in routed) return toolError(routed.error);
      const concept = conceptOf(routed.routed.type ?? input.type);
      if (concept === null)
        return toolError(
          `type: is the kind of item, one of ${SEARCH_CONCEPTS.join(", ")}.`,
        );
      // Only sources carry a byline, so an author narrows to sources, and a
      // client that sends one discovered the schema that has them. ADR-0015.
      if (input.author && concept && concept !== "source")
        return toolError(
          `author: only sources have authors; omit type or use type: source, not ${concept}.`,
        );
      const byAuthor = input.author
        ? await store.library.sourcesByAuthor(input.author)
        : null;
      if (byAuthor && !byAuthor.author) {
        const empty = textResult({ results: [] });
        return {
          ...empty,
          content: [
            ...empty.content,
            {
              type: "text" as const,
              text: `No saved source names an author matching "${input.author}". Search without author to look for the name in titles, notes and page text.`,
            },
          ],
        };
      }
      const filters = {
        query: byAuthor?.author
          ? withoutAuthorName(input.query, byAuthor.author)
          : input.query,
        // Library types require opt-in from a freshly discovered input
        // schema; default calls keep the cached output contract. ADR-0015.
        concepts: byAuthor
          ? (["source"] as SearchConcept[])
          : concept
            ? [concept]
            : input.include_library
              ? SEARCH_CONCEPTS
              : ALL_CONCEPTS,
        project: routed.routed.project ?? input.project,
        tags: routed.tags,
        ...(byAuthor && { sourceIds: byAuthor.sourceIds }),
        limit: input.limit,
      };
      const ranked = await store.rankedSearch(filters);
      const owned = ranked.hits;
      // Use reorders near-ties among reranked hits, exact ties otherwise:
      // BM25 scores are not on a scale a fixed tolerance means anything on.
      const signals = await store.library.useSignals(
        owned.flatMap((hit) =>
          hit.concept === "source" || hit.concept === "asset"
            ? [{ concept: hit.concept, conceptId: hit.conceptId }]
            : [],
        ),
      );
      const useOf = (hit: SearchHit) =>
        signals.get(`${hit.concept}:${hit.conceptId}`);
      const hits = orderByUse(
        owned,
        (hit) => useScore(useOf(hit)),
        ranked.rerank?.reranked ? NEAR_TIE : 0,
      );
      const coverage = [
        ...(hits.some((hit) => hit.concept === "asset")
          ? [ASSET_COVERAGE]
          : []),
        ...(hits.some((hit) => hit.concept === "source")
          ? [SOURCE_COVERAGE]
          : []),
      ].map((text) => ({ type: "text" as const, text }));
      const freshness = await store.todos.freshness(
        hits
          .filter((hit) => hit.concept === "todo")
          .map((hit) => hit.docKey.slice("todo:".length)),
      );
      const passages = await store.library.passages(
        hits.map((hit) => hit.docKey),
      );
      const provenance = await store.provenance(hits);
      // Subjects are not in search_docs; a memory search names the ones its
      // query names, so a save can attach to them. ADR-0003, 2026-11-05.
      const subjects =
        !byAuthor && (concept === undefined || concept === "memory")
          ? await store.subjects.matching(input.query)
          : [];
      const result = textResult({
        ...(subjects.length > 0 && { subjects }),
        results: hits.map((hit) => ({
          // A passage hit fetches as its asset; the passage says where in it.
          id: parsePassageKey(hit.docKey)
            ? `${hit.concept}:${hit.conceptId}`
            : hit.docKey,
          type: hit.concept,
          title: passages.get(hit.docKey)?.title ?? hit.title,
          snippet: hit.snippet,
          score: hit.score,
          metadata: {
            project: hit.project,
            ...provenance.get(`${hit.concept}:${hit.conceptId}`),
            updated_at: hit.updatedAt,
            ...(passages.has(hit.docKey) && {
              passage: passageMetadata(passages.get(hit.docKey)),
            }),
            ...(useReasons(useOf(hit)).length > 0 && {
              use: { why: useReasons(useOf(hit)) },
            }),
            ...(hit.concept === "todo" &&
              statusFields(
                freshness.get(hit.docKey.slice("todo:".length)) ?? NO_UPDATES,
              )),
          },
        })),
      });
      return {
        ...result,
        content: [...result.content, ...coverage],
        // Read back off the response by `observeCall` for the call row, so
        // the log and an eval transcript say the same thing about a search.
        ...(ranked.rerank ? { _meta: { [RERANK_META]: ranked.rerank } } : {}),
      };
    },
  );

  server.registerTool(
    "list_skills",
    {
      title: "List Valise skills",
      description:
        "List every available skill when you need reusable instructions; only the most-used ones also appear as skill_ tools. Call get_skill only for a skill you decide to use.",
      inputSchema: listSkillsInput,
      outputSchema: listSkillsOutput,
    },
    // Name each field: ListedSkill also carries the console's source and
    // disabled columns, and the schema rejects properties it does not declare.
    async () =>
      textResult({
        skills: (await store.skills.list()).map((skill) => ({
          name: skill.name,
          description: skill.description,
          version: skill.version,
          project: skill.project,
          tags: skill.tags,
          frontmatter: skill.frontmatter,
        })),
      }),
  );

  server.registerTool(
    "get_skill",
    {
      title: "Get a Valise skill",
      description:
        "Get the full SKILL.md for a listed skill. Omit version for the current version, or provide it to retrieve an older immutable version.",
      inputSchema: getSkillInput,
      outputSchema: getSkillOutput,
    },
    async ({ name, version }) => {
      const skill = await store.skills.get(name, version);
      if (skill === null)
        return toolError(`No active skill exists for ${name}.`);
      return textResult(skillOutput(skill));
    },
  );

  server.registerTool(
    "publish_skill",
    {
      title: "Publish a Valise skill",
      description:
        "Publish a reusable procedure as a skill: a complete SKILL.md with YAML name and description frontmatter. Use this whenever the user wants instructions others should follow, including a house procedure, a checklist, or a workflow. A fact or a preference is save_memory instead. Publishing creates an immutable version and makes it current.",
      inputSchema: publishSkillInput,
      outputSchema: publishSkillOutput,
    },
    async (input) => {
      const routed = routeReservedTags(input.tags ?? [], {
        project: input.project,
      });
      if ("error" in routed) return toolError(routed.error);
      const published = await store.skills.publish({
        ...input,
        project: routed.routed.project ?? input.project,
        tags: input.tags && routed.tags,
      });
      if ("errors" in published) return toolError(published.errors.join("\n"));
      return textResult(skillOutput(published));
    },
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a Valise item",
      description:
        "Fetch the full authoritative skill, memory, to-do, or subject after search or list_subjects returns its id. Do not guess ids. A to-do leads with its status line; its updates come newest first, ten per page, with next_cursor for older ones. A to-do may carry related_library, one saved page or file that may bear on it: use it only if it changes the answer, citing it; otherwise ignore it. A transcript comes a page of turns at a time, each line tagged [t-<n>]: pass a link to one message (transcript:<id>#t-<n>, or the console URL a person pastes) to read it with five turns either side, and follow prev_cursor or next_cursor only if you need more.",
      inputSchema: fetchInput,
      outputSchema: fetchOutput,
    },
    async ({ id: given, full, cursor, limit }) => {
      // A pasted console link to a message reads as its transcript id.
      const turnRef = given.startsWith("http")
        ? transcriptTurnRef(given)
        : null;
      if (given.startsWith("http") && turnRef === null)
        return toolError(`${given} is not a link to a Valise transcript.`);
      const id = turnRef
        ? `${transcriptRef(turnRef.transcriptId)}${turnRef.position === null ? "" : `#t-${turnRef.position}`}`
        : given;
      const document = await fetchDocument(
        store,
        id,
        { full: full === true, cursor, limit },
        provenance,
      );
      if (document === null)
        return toolError(`No active item exists for ${id}.`);
      if ("error" in document) return toolError(document.error);
      const [concept, conceptId] = id.split(":");
      if (concept === "source" || concept === "asset")
        await store.library.recordUse(concept, conceptId, "fetched");
      const related =
        concept === "todo" ? await store.library.related(document.title) : null;
      return textResult({
        ...document,
        ...consoleUrl(caller, document.id),
        ...(related && { related_library: related }),
      });
    },
  );

  server.registerTool(
    "save_memory",
    {
      title: "Save a memory",
      description:
        "Save one durable claim another session can act on: an insight, a fact, a preference, a reference, or a decision a person explicitly chose or approved. Default session learnings to insight. For a decision, lead with the applicable rule and name who decided and where. Title the claim in one sentence; put conclusion, evidence, and pointers back in the body. One memory per claim, not a session digest. A reusable procedure others should follow is publish_skill instead.",
      inputSchema: saveMemoryInput,
      outputSchema: saveMemoryOutput,
    },
    async (input) => {
      const routed = routeReservedTags(input.tags, {
        project: input.project,
        type: input.type,
      });
      if ("error" in routed) return toolError(routed.error);
      const project = routed.routed.project ?? input.project;
      const similar = await store.memories.similar(
        input.title,
        project ?? null,
      );
      let memory;
      try {
        memory = await store.memories.save({
          ...input,
          project,
          tags: routed.tags,
          subjects: input.subjects?.map((id) => id.slice("subject:".length)),
        });
      } catch (error) {
        if (
          error instanceof MemoryLinkError ||
          error instanceof MemorySubjectError
        )
          return toolError(error.message);
        throw error;
      }
      const deferral = await store.memories.vectorDeferral(
        memory.id.slice("memory:".length),
      );
      const result = textResult({
        id: memory.id,
        title: memory.title,
        text: memory.body,
        metadata: {
          type: memory.type,
          tags: memory.tags,
          project: memory.project,
          created_at: memory.createdAt,
          // Saved and searchable; only semantic indexing waits. ADR-0017.
          ...(deferral && { vector_indexing: deferral }),
        },
        similar,
      });
      // The receipt is a closed, cached schema, so the links it made are
      // left to fetch rather than a text block Claude Code would drop.
      return {
        ...result,
        content: [
          ...result.content,
          ...(similar.length > 0
            ? [{ type: "text" as const, text: SIMILAR_NUDGE }]
            : []),
        ],
      };
    },
  );

  server.registerTool(
    "edit_memory",
    {
      title: "Edit or link a memory",
      description:
        "Change an existing memory's title, body, type, tags, or project, or link it to another memory with relates. Send only fields you are changing; project: null clears the project. Content edits keep the previous wording in history. A link-only call does not edit the claim. MCP links are model suggestions; supersedes hides the older memory from search only after a person confirms it in the console.",
      inputSchema: editMemoryInput,
      outputSchema: editMemoryOutput,
    },
    async ({ id, relates, ...patch }) => {
      const routed = routeReservedTags(patch.tags ?? [], {
        project: patch.project ?? undefined,
        type: patch.type,
      });
      if ("error" in routed) return toolError(routed.error);
      if (patch.project === null && routed.routed.project !== undefined)
        return toolError("project: null conflicts with a project: tag.");
      try {
        const memory = await store.memories.edit(
          id.slice("memory:".length),
          {
            ...patch,
            ...(routed.routed.project !== undefined && {
              project: routed.routed.project,
            }),
            ...(routed.routed.type !== undefined && {
              type: routed.routed.type,
            }),
            ...(patch.tags !== undefined && { tags: routed.tags }),
          },
          relates,
        );
        if (!memory) return toolError(`No active item exists for ${id}.`);
        const document = await fetchMemory(
          store,
          id,
          id.slice("memory:".length),
        );
        if (!document) return toolError(`No active item exists for ${id}.`);
        const deferral = await store.memories.vectorDeferral(
          id.slice("memory:".length),
        );
        return textResult({
          ...document,
          metadata: {
            ...document.metadata,
            ...(deferral && { vector_indexing: deferral }),
            removed_links: (
              await store.memories.links(id.slice("memory:".length), true)
            )
              .filter(
                (link) =>
                  link.removed_at !== null &&
                  relates?.some(
                    (relation) =>
                      relation.id === link.id && relation.kind === link.kind,
                  ),
              )
              .map(
                ({ kind, id, title, confirmed, asserted_by, removed_at }) => ({
                  kind,
                  id,
                  title,
                  confirmed,
                  asserted_by,
                  removed_at,
                }),
              ),
          },
          ...consoleUrl(caller, id),
        });
      } catch (error) {
        if (error instanceof MemoryLinkError) return toolError(error.message);
        throw error;
      }
    },
  );

  server.registerTool(
    "list_subjects",
    {
      title: "List memory subjects",
      description:
        "List the user's memory subjects: a person, topic, area or profile that groups supporting memories under a current understanding. Pass name to find one. 30 a page, by name; has_more means another page. fetch a subject's id for its summary and members.",
      inputSchema: listSubjectsInput,
      outputSchema: listSubjectsOutput,
    },
    async ({ name, page = 1 }) => {
      const { rows, hasMore } = await store.subjects.list(page, name);
      return textResult({
        subjects: rows.map((subject) => ({
          id: `subject:${subject.id}`,
          name: subject.name,
          kind: subject.kind,
          description: subject.description,
          members: subject.count,
          summary: subject.freshness,
        })),
        page,
        has_more: hasMore,
      });
    },
  );

  server.registerTool(
    "save_subject",
    {
      title: "Create a memory subject",
      description:
        "Create a subject to group memories about one person, topic, area or the user's profile. Names are unique per user, ignoring case: when one already exists, it is returned with created: false and nothing is created. Add memories and a summary with edit_subject.",
      inputSchema: saveSubjectInput,
      outputSchema: saveSubjectOutput,
    },
    async ({ name, kind, description = "" }) => {
      const { id, created } = await store.subjects.create({
        name,
        kind,
        description,
      });
      const subject = await store.subjects.get(id);
      if (!subject) return toolError(`No subject exists for subject:${id}.`);
      return textResult({
        id: `subject:${id}`,
        name: subject.name,
        kind: subject.kind,
        created,
        ...consoleUrl(caller, `subject:${id}`),
      });
    },
  );

  server.registerTool(
    "edit_subject",
    {
      title: "Edit, organize or delete a memory subject",
      description:
        "Change a subject's name, kind or description, add or remove supporting memories, set its summary to an existing memory or write a new one, or delete or restore it. Send only what changes; deleted goes alone. Deleting hides the subject and keeps every memory; deleted: false brings it back.",
      inputSchema: editSubjectInput,
      outputSchema: editSubjectOutput,
    },
    async (input) => {
      const result = await editSubject(store, input);
      if ("error" in result) return toolError(result.error);
      const document = await fetchSubject(store, input.id);
      if (!document || "error" in document)
        return toolError(`No subject exists for ${input.id}.`);
      return textResult({
        ...document,
        metadata: {
          ...document.metadata,
          ...(result.unchanged.length > 0 && { unchanged: result.unchanged }),
        },
        ...consoleUrl(caller, input.id),
      });
    },
  );

  server.registerTool(
    "list_hooks",
    {
      title: "List Valise hook text",
      description:
        "List the text Valise injects into a session at SessionStart, at Stop, and after a failed shell command, with each entry's id, and the runnable hooks with the version approved to run and any awaiting the owner. A client without Valise's hooks receives the enabled text as server instructions instead. Call this before edit_hook changes or removes an entry.",
      inputSchema: listHooksInput,
      outputSchema: listHooksOutput,
    },
    async () => {
      const [{ document, updatedAt }, runnable] = await Promise.all([
        store.hooks.read(),
        store.hooks.runnables.list(),
      ]);
      const read = hookEntries(document);
      if ("error" in read)
        return toolError(
          `The stored hook config is invalid: ${read.error}. Fix it on the console's Hooks page.`,
        );
      return textResult({
        ...hooksOutput(read.entries, updatedAt),
        runnable: runnable.map(runnableOutput),
      });
    },
  );

  server.registerTool(
    "edit_hook",
    {
      title: "Edit Valise hook text",
      description:
        "Change the text Valise injects into every future session, when the user asks to change what their hooks say. One entry per call: add puts new text in its own entry, change edits an entry's text, enabled, or every_turns, and remove deletes a custom entry. Send only the fields you are changing. Machines with the hooks pick up the change within ten minutes; a chat app reads it when it next connects, and ChatGPT only after its connector is refreshed.",
      inputSchema: editHookInput,
      outputSchema: editHookOutput,
    },
    async (input) => {
      if (
        input.id !== undefined &&
        (await store.hooks.runnables.isName(input.id))
      )
        return toolError(
          `${input.id} is a runnable hook, and edit_hook changes injected text only. Send a new version with propose_hook; it runs once the owner approves it in the console.`,
        );
      const { document } = await store.hooks.read();
      const edited = applyHookEdit(document, input);
      if ("error" in edited) return toolError(edited.error);
      await store.hooks.write(edited.document);
      const read = hookEntries(edited.document);
      if ("error" in read) return toolError(read.error);
      return textResult(
        hooksOutput(read.entries, Math.floor(Date.now() / 1000)),
      );
    },
  );

  server.registerTool(
    "propose_hook",
    {
      title: "Propose a runnable Valise hook",
      description:
        "Propose a hook that runs a command on the user's machines at SessionStart, Stop or SessionEnd, with its scripts inline, when the user asks for a hook that does something rather than says something. Nothing runs until the owner approves this exact version in the console; until then the previously approved version, if any, keeps running. The hook must print nothing, write only its declared outputs, and report its cost to $VALISE_HOOK_REPORT. For hook text, use edit_hook.",
      inputSchema: proposeHookInput,
      outputSchema: proposeHookOutput,
    },
    async (input) => {
      const proposed = await store.hooks.runnables.propose(input);
      if ("error" in proposed)
        return toolError(`${proposed.error}. Nothing was proposed.`);
      const { version, running, outcome } = proposed;
      const name = version.content.name;
      const approveUrl = caller.origin
        ? `${caller.origin}/hooks?runnable=${encodeURIComponent(name)}`
        : undefined;
      const message =
        outcome === "running"
          ? `${name} already runs this exact version; nothing changed.`
          : `${name} version ${version.versionHash.slice(0, 12)} is ${outcome === "pending" ? "already " : ""}awaiting the owner's approval in the console${approveUrl ? ` at ${approveUrl}` : ""}. Nothing runs until they approve it${running ? `; version ${running.versionHash.slice(0, 12)} keeps running until then` : ""}. Unapproved, it expires ${new Date(version.expiresAt * 1000).toISOString().slice(0, 10)}.`;
      return textResult({
        name,
        version_hash: version.versionHash,
        state: outcome === "running" ? "approved" : "pending",
        expires_at: outcome === "running" ? null : version.expiresAt,
        files: version.files.map(({ path, sha256, size }) => ({
          path,
          sha256,
          size,
        })),
        running_version_hash: running?.versionHash ?? null,
        ...(approveUrl ? { approve_url: approveUrl } : {}),
        message,
      });
    },
  );

  return server;
}

function runnableVersionOutput(version: RunnableVersion | null) {
  if (version === null) return null;
  return {
    version_hash: version.versionHash,
    event: version.content.event,
    proposed_at: version.proposedAt,
    ...(version.state === "pending" ? { expires_at: version.expiresAt } : {}),
  };
}

function runnableOutput(entry: RunnableEntry) {
  return {
    name: entry.name,
    enabled: !entry.disabled,
    approved: runnableVersionOutput(entry.running),
    pending: runnableVersionOutput(entry.pending),
  };
}

/**
 * Turns one edit_hook call into the console's one-field edits, applied in
 * order. An add lands as `custom-<n>`, so the fields that follow it address
 * that id.
 */
function applyHookEdit(
  document: string,
  input: EditHookInput,
): { document: string } | { error: string } {
  const read = hookEntries(document);
  if ("error" in read) return read;
  const edits: HookConfigEdit[] = [];
  let id = input.id ?? "";
  if (input.action === "remove") {
    edits.push({ kind: "remove", id });
  } else {
    if (input.action === "add" && input.event && input.text) {
      edits.push({ kind: "add", event: input.event, text: input.text });
      id = `custom-${read.entries.filter((entry) => !entry.shipped).length}`;
    } else if (input.text !== undefined) {
      edits.push({ kind: "text", id, text: input.text });
    }
    if (input.enabled !== undefined)
      edits.push({ kind: "enabled", id, enabled: input.enabled });
    // Models that fill every optional field send every_turns for a
    // SessionStart entry too, where it means nothing, so it is dropped there.
    const event =
      input.event ?? read.entries.find((entry) => entry.id === id)?.event;
    if (input.every_turns !== undefined && event === "Stop")
      edits.push({ kind: "every-turns", id, everyTurns: input.every_turns });
  }
  let next: { document: string } | { error: string } = { document };
  for (const edit of edits) {
    if ("error" in next) break;
    next = editHookConfig(next.document, edit);
  }
  return next;
}

function hooksOutput(entries: HookEntry[], updatedAt: number | null) {
  return {
    entries: entries.map((entry) => ({
      id: entry.id,
      label: entry.label,
      shipped: entry.shipped,
      event: entry.event,
      text: entry.text,
      enabled: entry.enabled,
      every_turns: entry.everyTurns,
      default_text: entry.defaultText,
    })),
    updated_at: updatedAt,
  };
}

/**
 * One tool per published skill, so a client that does not speak SEP-2640 sees
 * the skill itself rather than a listing tool it has to think to call. The
 * description is the skill's own frontmatter description, which is the line
 * the model reads to decide; the body arrives only on call, which is the
 * progressive disclosure the extension exists for.
 *
 * `tools/list` lists only the most loaded skills, because every listed tool
 * costs tokens on every turn and most skills go unused. Every other request
 * registers them all, so a client holding an older list can still call any
 * enabled skill's tool. ADR-0005, amendment of 2026-11-15.
 */
async function registerSkillTools(
  server: McpServer,
  store: TenantStore,
  listing: boolean,
) {
  const [skills, listed] = await Promise.all([
    store.skills.list(),
    listing ? store.skills.toolNames().then((names) => new Set(names)) : null,
  ]);
  for (const skill of skills) {
    if (listed && !listed.has(skill.name)) continue;
    server.registerTool(
      skillToolName(skill.name),
      {
        title: skill.name,
        // The lead clause is doing real work. A skill's own description is
        // written for a host that activates it as a mode; as a tool it sits
        // next to the tools it talks about, and without this it wins turns
        // that belong to them. The evals caught it on capture-this.
        description: `Returns instructions, takes no action. Read the "${skill.name}" skill before doing the work it covers, then use the tools it names. ${skill.description}`,
        inputSchema: skillToolInput,
        outputSchema: getSkillOutput,
      },
      async () => {
        const current = await store.skills.get(skill.name);
        if (current === null)
          return toolError(`No active skill exists for ${skill.name}.`);
        return textResult(skillOutput(current));
      },
    );
  }
}

type FetchedDocument = {
  id: string;
  title: string;
  text: string;
  metadata: Record<string, unknown>;
  /** A transcript's neighbouring pages of turns. */
  prev_cursor?: string | null;
  next_cursor?: string | null;
};

/** Turns either side of a named message. */
const TURN_WINDOW = 5;
/** Turns in a page that names no message. */
const TURN_PAGE = 40;

/**
 * A page of a session's distilled turns, one line each, with where it ran.
 * A session can hold hundreds of turns of up to 60,000 characters, so a
 * reader asks for a message and the turns around it, or pages from the top,
 * rather than taking the whole session at once.
 */
async function fetchTranscript(
  transcripts: TenantStore["transcripts"],
  id: string,
  page: ThreadPage,
): Promise<FetchedDocument | { error: string } | null> {
  const ref = transcriptTurnRef(id);
  if (ref === null) return null;
  const { transcriptId, position } = ref;
  const transcript = await transcripts.get(transcriptId);
  if (transcript === null) return null;
  let start = position === null ? 0 : Math.max(0, position - TURN_WINDOW);
  if (page.cursor !== undefined) {
    const cursor = /^t-(\d+)$/.exec(page.cursor);
    if (!cursor)
      return {
        error: `cursor ${page.cursor} is not a next_cursor or prev_cursor this transcript gave.`,
      };
    start = Number(cursor[1]);
  }
  const size =
    page.limit ??
    (position !== null && page.cursor === undefined
      ? TURN_WINDOW * 2 + 1
      : TURN_PAGE);
  const turns = (await transcripts.turnPage(transcriptId, start, size)) ?? [];
  const end = start + turns.length;
  return {
    id: `${transcriptRef(transcriptId)}${position === null ? "" : `#t-${position}`}`,
    title: transcript.title || `Session in ${transcript.client}`,
    text: transcriptLines(turns, position),
    prev_cursor: start > 0 ? `t-${Math.max(0, start - size)}` : null,
    next_cursor: end < transcript.turnCount ? `t-${end}` : null,
    metadata: {
      turns_shown: turns.length ? `t-${start} to t-${end - 1}` : "none",
      ...(position === null ? {} : { message: `t-${position}` }),
      client: transcript.client,
      device: transcript.device,
      session_id: transcript.sessionId,
      cwd: transcript.cwd,
      git_branch: transcript.gitBranch,
      project: transcript.project,
      model: transcript.model,
      turn_count: transcript.turnCount,
      first_at: transcript.firstAt,
      last_at: transcript.lastAt,
      source_agent: transcript.sourceAgent,
      source_client: transcript.sourceClient,
    },
  };
}

async function fetchDocument(
  store: TenantStore,
  id: string,
  page: ThreadPage = { full: false },
  viewer: Viewer | null = null,
): Promise<FetchedDocument | { error: string } | null> {
  const [concept, conceptId] = id.split(":");
  switch (concept) {
    case "memory":
      return fetchMemory(store, id, conceptId);
    case "skill":
      return fetchSkill(store, id, conceptId);
    case "todo":
      return fetchTodo(store, id, conceptId, page, viewer);
    case "asset":
      return fetchAsset(store.library, id);
    case "source":
      return fetchSource(store.sources, id);
    case "transcript":
      return fetchTranscript(store.transcripts, id, page);
    case "subject":
      return fetchSubject(store, id, page.cursor);
    default:
      return null;
  }
}

async function fetchMemory(
  store: TenantStore,
  id: string,
  memoryId: string,
): Promise<FetchedDocument | null> {
  const memory = await store.memories.get(memoryId);
  if (memory === null) return null;
  const files = await store.memories.attachments([memoryId]);
  return {
    id,
    title: memory.title,
    text: memory.body,
    metadata: {
      type: memory.type,
      files: attachmentEntries(
        { concept: "memory", id: memoryId },
        files.get(memoryId) ?? [],
      ),
      tags: memory.tags,
      project: memory.project,
      source_agent: memory.sourceAgent,
      source_client: memory.sourceClient,
      source_session: memory.sourceSession,
      source_session_name: memory.sourceSessionName,
      created_at: memory.createdAt,
      updated_at: memory.updatedAt,
      links: (await store.memories.links(memoryId)).map(
        ({ kind, id, title, confirmed, asserted_by }) => ({
          kind,
          id,
          title,
          confirmed,
          asserted_by,
        }),
      ),
    },
  };
}

/** A subject's summary as its text, then its members 30 a page; `cursor` is the page number. */
async function fetchSubject(
  store: TenantStore,
  id: string,
  cursor?: string,
): Promise<FetchedDocument | { error: string } | null> {
  const page = cursor === undefined ? 1 : Number(cursor);
  if (!Number.isInteger(page) || page < 1 || page > 10000)
    return {
      error: `cursor ${cursor} is not a next_cursor this subject gave.`,
    };
  const subject = await store.subjects.get(id.slice("subject:".length), {
    includeDeleted: true,
  });
  if (!subject) return null;
  const members = await store.subjects.members(subject.id, page);
  const suggested =
    page === 1 && !subject.deletedAt
      ? (await store.subjects.suggestions(subject.id)).rows
      : [];
  return {
    id,
    title: subject.name,
    text: subject.summary?.body ?? "",
    metadata: {
      kind: subject.kind,
      description: subject.description,
      summary: subject.summary
        ? {
            id: subject.summary.id,
            title: subject.summary.title,
            updated_at: subject.summary.updatedAt,
          }
        : null,
      freshness: subject.freshness,
      conflicts: subject.conflicts,
      member_count: subject.count,
      members: members.rows.map((member) => ({
        id: member.id,
        title: member.title,
        type: member.type,
        created_at: member.createdAt,
        confirmed: member.confirmed,
      })),
      next_cursor: members.hasMore ? String(page + 1) : null,
      // Not members: add_members confirms one, remove_members dismisses it.
      suggested: suggested.map((memory) => ({
        id: memory.id,
        title: memory.title,
        reason: memory.reason,
      })),
      deleted_at: subject.deletedAt,
    },
  };
}

/**
 * Applies one edit_subject call. Everything is checked before the first
 * write, so a refusal changes nothing; `unchanged` names requests that were
 * already true, such as adding a memory that is already a member.
 */
async function editSubject(
  store: TenantStore,
  input: z.infer<typeof editSubjectInput>,
): Promise<{ unchanged: string[] } | { error: string }> {
  const {
    id,
    add_members = [],
    remove_members = [],
    summary,
    new_summary,
    deleted,
    ...fields
  } = input;
  const raw = id.slice("subject:".length);
  const subject = await store.subjects.get(raw, { includeDeleted: true });
  if (!subject) return { error: `No subject exists for ${id}.` };
  const edits = (["name", "kind", "description"] as const).filter(
    (field) => fields[field] !== undefined,
  );
  const changes =
    edits.length +
    add_members.length +
    remove_members.length +
    (summary !== undefined ? 1 : 0) +
    (new_summary !== undefined ? 1 : 0);
  if (deleted !== undefined) {
    if (changes > 0)
      return { error: "Send deleted alone, then make other changes." };
    if (deleted === Boolean(subject.deletedAt))
      return {
        unchanged: [`${id} is already ${deleted ? "deleted" : "live"}.`],
      };
    if (await store.subjects.setDeleted(raw, deleted)) return { unchanged: [] };
    return {
      error: `Another subject is now named "${subject.name}". Rename or delete it, then restore this one.`,
    };
  }
  if (changes === 0) return { error: "Nothing to change was sent." };
  if (subject.deletedAt)
    return {
      error: `${id} is deleted. Restore it with deleted: false before changing it.`,
    };
  if (summary !== undefined && new_summary !== undefined)
    return { error: "Send summary or new_summary, not both." };
  if (fields.name !== undefined) {
    const taken = await store.subjects.findByName(fields.name);
    if (taken && taken !== raw)
      return {
        error: `Another subject is already named "${fields.name}": subject:${taken}.`,
      };
  }
  const memoryIds = [
    ...add_members,
    ...remove_members,
    ...(summary ? [summary] : []),
  ];
  for (const memory of new Set(memoryIds))
    if (!(await store.memories.get(memory.slice("memory:".length))))
      return { error: `No active memory exists for ${memory}.` };
  const both = add_members.filter((memory) => remove_members.includes(memory));
  if (both.length)
    return { error: `${both[0]} is in both add_members and remove_members.` };
  if (
    summary &&
    !remove_members.includes(summary) &&
    (await store.subjects.ofMemory(summary.slice("memory:".length))).some(
      (s) => s.id === raw,
    )
  )
    return {
      error: `${summary} is a member of ${id}. Remove it in the same call, or choose another memory.`,
    };
  const summaryAfter = summary === undefined ? subject.summary?.id : summary;
  if (summaryAfter && add_members.includes(summaryAfter))
    return {
      error: `${summaryAfter} is the summary, so it cannot also be a member.`,
    };

  const unchanged: string[] = [];
  for (const field of edits)
    if (!(await store.subjects.edit(raw, field, fields[field]!)))
      return {
        error: `${id} changed while this edit ran. Fetch it and try again.`,
      };
  for (const memory of remove_members)
    if (
      !(await store.subjects.changeMember(
        raw,
        memory.slice("memory:".length),
        "remove",
      ))
    )
      unchanged.push(`${memory} was not a member.`);
  if (
    summary !== undefined &&
    !(await store.subjects.setSummary(
      raw,
      summary?.slice("memory:".length) ?? null,
    ))
  )
    return {
      error: `${summary} is a member of ${id}. Remove it first, or choose another memory.`,
    };
  if (
    new_summary !== undefined &&
    (await store.subjects.createSummary(raw, new_summary)) === null
  )
    return { error: `No subject exists for ${id}.` };
  for (const memory of add_members)
    if (
      !(await store.subjects.changeMember(
        raw,
        memory.slice("memory:".length),
        "add",
        "model",
      ))
    )
      unchanged.push(`${memory} was already a member.`);
  return { unchanged };
}

async function fetchSkill(
  store: TenantStore,
  id: string,
  skillId: string,
): Promise<FetchedDocument | null> {
  const skill = await store.skills.document(skillId);
  if (skill === null) return null;
  return {
    id,
    title: skill.name,
    text: skill.body,
    metadata: {
      version: skill.version,
      sha256: skill.sha256,
      files: skill.files,
      tags: skill.tags,
      project: skill.project,
      visibility: skill.visibility,
      created_at: skill.createdAt,
      updated_at: skill.updatedAt,
    },
  };
}

/** Who is reading, for what only the lease holder may see. */
type Viewer = Pick<Provenance, "agent" | "session">;

/**
 * The holder, as the coordinator's `isHolder` names it: the lease's agent,
 * and its session when the claim recorded one. ADR-0002, 2026-11-24.
 */
function holdsLease(
  todo: { leaseHolder: string | null; holderSession: string | null },
  viewer: Viewer | null,
): boolean {
  return (
    viewer !== null &&
    todo.leaseHolder === viewer.agent &&
    (todo.holderSession === null || todo.holderSession === viewer.session)
  );
}

async function fetchTodo(
  store: TenantStore,
  id: string,
  todoId: string,
  page: ThreadPage,
  viewer: Viewer | null,
): Promise<FetchedDocument | { error: string } | null> {
  const todo = await store.todos.get(todoId);
  if (todo === null) return null;
  const [newestFirst, files] = await Promise.all([
    store.todos.thread(todoId),
    store.todos.attachments([todoId]),
  ]);
  const thread = todoThreadDigest(newestFirst, {
    ...page,
    owner: todo.sourceAgent,
  });
  if ("error" in thread) return { error: `${id}: ${thread.error}` };
  const { status, statusAt } = todoStatus(newestFirst);
  // The first page opens with the newest update, which already says what the
  // last_update_ fields would.
  const {
    last_update_at,
    last_update_kind,
    last_update_author,
    last_update_summary,
    ...page_of_updates
  } = thread;
  return {
    id,
    title: todo.title,
    text: todo.body,
    // A key with nothing to say is left out: null, an empty list, a token
    // never issued, relations the to-do does not have. ADR-0003, amendment
    // of 2026-11-15.
    metadata: withoutEmpty({
      // Where the work stands comes before anything else a reader sees.
      status,
      status_at: statusAt,
      tags: todo.tags,
      files: attachmentEntries(
        { concept: "todo", id: todoId },
        files.get(todoId) ?? [],
      ),
      refs: todo.refs,
      project: todo.project,
      state: todo.state,
      lease_holder: todo.leaseHolder,
      lease_expires_at: todo.leaseExpiresAt,
      // The holder's alone: another session with the token could write
      // under this claim. The claim writes the holder with the fence, so the
      // holder sees it at once. 0 is never claimed.
      fencing_token:
        todo.fencingToken !== 0 && holdsLease(todo, viewer)
          ? todo.fencingToken
          : null,
      blocked_on: todo.blockedOn,
      relations: relationsOnWire(await store.todos.relationsOf(todoId)),
      source_agent: todo.sourceAgent,
      source_client: todo.sourceClient,
      source_session: todo.sourceSession,
      source_session_name: todo.sourceSessionName,
      created_at: todo.createdAt,
      updated_at: todo.updatedAt === todo.createdAt ? null : todo.updatedAt,
      completed_at: todo.completedAt,
      ...(page.cursor && {
        last_update_at,
        last_update_kind,
        last_update_author,
        last_update_summary,
      }),
      ...page_of_updates,
      update_count:
        page_of_updates.update_count === 0
          ? null
          : page_of_updates.update_count,
    }),
  };
}

/** Rows `list_ready` returns when the call names no limit. */
export const LIST_READY_LIMIT = 20;

/**
 * A to-do row as `list_todos` and `get_brief` send it. A key with nothing to
 * say is left out: null, an empty list, no updates, `updated_at` equal to
 * `created_at`, the project the call already filtered on, and the newest
 * update's summary when it is the status. ADR-0003, amendment of 2026-11-15.
 */
function todoRowOnWire<T extends Record<string, unknown>>(
  row: T,
  filteredProject?: string,
) {
  const restated = row.status != null && row.last_update_summary === row.status;
  return withoutEmpty({
    ...row,
    project: filteredProject === undefined ? row.project : null,
    updated_at: row.updated_at === row.created_at ? null : row.updated_at,
    update_count: row.update_count === 0 ? null : row.update_count,
    last_update_summary: restated ? null : row.last_update_summary,
    last_update_at:
      restated && row.last_update_at === row.status_at
        ? null
        : row.last_update_at,
  });
}

/** `get_brief` with every section's rows as the lists send them. */
function briefOnWire<B extends ProjectBrief>(brief: B, project?: string): B {
  const section = <S extends { items: Record<string, unknown>[] }>(
    part: S,
  ): S => ({
    ...part,
    items: part.items.map((item) => todoRowOnWire(item, project)),
  });
  return {
    ...brief,
    ready: section(brief.ready),
    claimed: section(brief.claimed),
    blocked: section(brief.blocked),
    completed: section(brief.completed),
  };
}

/**
 * A to-do's relations as `fetch` sends them: nothing when it has none, and
 * otherwise only the lists that hold something, with child progress beside
 * children and a truncation flag only when it is set.
 */
function relationsOnWire(relations: TodoRelations) {
  const { parent, children, depends_on, blocks } = relations;
  if (!parent && !children.length && !depends_on.length && !blocks.length)
    return null;
  return {
    parent,
    children,
    ...(children.length > 0 && { child_progress: relations.child_progress }),
    ...(relations.children_truncated && { children_truncated: true }),
    depends_on,
    blocks,
    ...(relations.blocks_truncated && { blocks_truncated: true }),
    note: relations.note,
  };
}

/** Newest updates that keep their body in a default `fetch`. */
export const FETCH_FULL_UPDATES = 3;

/** Updates on one page of a to-do's `fetch`. */
export const FETCH_PAGE_UPDATES = 10;

type ThreadPage = {
  full: boolean;
  cursor?: string;
  limit?: number;
  /** The to-do's own author, left off every entry that shares it. */
  owner?: string;
};

/**
 * A to-do's thread as `fetch` returns it: one page of entries, newest first,
 * lifecycle rows and comments interleaved. Each entry has its kind and time
 * and either its body or, past the newest three unless `full`, its one-line
 * summary, never both. The to-do's status already says where the work stands.
 * The author appears only when it differs from the to-do's own. Ids and
 * fencing tokens are left out: `next_cursor`, the id of the page's oldest
 * entry, is the only id a reader needs, and the next page starts below it.
 * Entries are append only, so a cursor stays valid while new updates arrive.
 * A page holds ten by default. A to-do once returned 127 entries in one fetch,
 * 44,615 characters, of which ids, tokens and one repeated author URL took
 * 21,437.
 */
export function todoThreadDigest(
  newestFirst: TodoUpdate[],
  { full, cursor, limit = FETCH_PAGE_UPDATES, owner }: ThreadPage,
): Record<string, unknown> | { error: string } {
  const start = cursor
    ? newestFirst.findIndex((update) => update.id === cursor) + 1
    : 0;
  if (cursor && start === 0)
    return {
      error: `cursor ${cursor} is not an update on this to-do. Fetch without cursor to start from the newest.`,
    };
  const page = newestFirst.slice(start, start + limit);
  const older = newestFirst.length - start - page.length;
  const updates = page.map((update, index) => ({
    kind: update.kind,
    ...(update.author !== owner ? { author: update.author } : {}),
    ...(update.sessionName ? { session_name: update.sessionName } : {}),
    ...(full || start + index < FETCH_FULL_UPDATES
      ? { body: update.body }
      : { summary: update.summary }),
    created_at: update.createdAt,
  }));
  const bodiless = updates.filter((update) => !("body" in update)).length;
  const next = older > 0 ? (page.at(-1)?.id ?? null) : null;
  const latest = newestFirst[0];
  const notes = [
    bodiless > 0
      ? `${bodiless} of these updates carry a summary only; fetch with full: true for their bodies.`
      : null,
    next
      ? `${older} older updates are on later pages; fetch with cursor: "${next}" for the next ${Math.min(limit, older)}.`
      : null,
  ].filter((note) => note !== null);
  return {
    ...freshnessFields(
      latest
        ? {
            ...todoStatus(newestFirst),
            updateCount: newestFirst.length,
            lastUpdateAt: latest.createdAt,
            lastUpdateKind: latest.kind,
            lastUpdateAuthor: latest.author,
            lastUpdateSummary: latest.summary,
          }
        : NO_UPDATES,
    ),
    updates,
    next_cursor: next,
    ...(notes.length > 0 ? { updates_note: notes.join(" ") } : {}),
  };
}

/**
 * The server-side capture nudge, tier 2 of the capture design in
 * `docs/research/2026-10-17-memory-capture-redesign.md`. A client without the
 * plugin has no Stop hook, and finishing a to-do is the moment its work is
 * most likely to have produced something worth saving. It follows the
 * plugin's `capture-nudge` but ends "carry on", not "stop", because a tool
 * result arrives mid-session. The text lives in JSON so `evals/run.mjs` sends
 * the same string the server does.
 */
export const CAPTURE_NUDGE: string = nudges.complete_todo;

/**
 * Appended to every `claim_todo` result. The coordinator logs the claim, the
 * block, the release and the completion by itself, but what happened between
 * them reaches the to-do's history only if the agent posts it. Every claim
 * gets it, because each claim starts a stretch of work the history would
 * otherwise skip. The text lives in JSON so `evals/run.mjs` sends the same
 * string.
 */
export const PROGRESS_NUDGE: string = nudges.claim_todo;

/**
 * Appended to a `save_memory` result that listed similar memories. The save
 * has already happened; `edit_memory` can assert a link without changing
 * content. Only a person's confirmation can unpublish a superseded claim.
 * The text lives in JSON so `evals/run.mjs` sends the same string.
 */
export const SIMILAR_NUDGE: string = nudges.save_memory;

/**
 * The console page that opens this item, as `{ url }`, so a model can give a
 * person a link rather than an id to paste. Empty without an origin.
 */
function consoleUrl(caller: Caller, id: string): { url?: string } {
  const path = itemPath(id);
  return caller.origin && path ? { url: `${caller.origin}${path}` } : {};
}

function todoFailure(
  id: string,
  failure: {
    reason: string;
    holder: string | null;
    token: number | null;
  },
) {
  const holder = failure.holder ? ` Current holder: ${failure.holder}.` : "";
  return toolError(`${id}: ${failure.reason}.${holder}`);
}

function skillOutput(skill: Awaited<ReturnType<typeof getSkill>> & {}) {
  if (skill === null) throw new Error("skill output requires a skill");
  return {
    id: skill.id,
    uri: skillUri(skill.name),
    name: skill.name,
    description: skill.description,
    version: skill.version,
    project: skill.project,
    tags: skill.tags,
    body: skill.body,
    files: skill.files.map((file) => ({
      ...file,
      uri: skillUri(skill.name, file.path),
    })),
    sha256: skill.sha256,
    created_at: skill.createdAt,
  };
}

function passageMetadata(passage: PassageCitation | undefined) {
  if (!passage) return undefined;
  const { title: _title, ...rest } = passage;
  return rest;
}

/** A search `type`, from its argument or a `type:` tag. Null if unknown. */
function conceptOf(
  value: string | undefined,
): SearchConcept | undefined | null {
  if (value === undefined) return undefined;
  return (PROJECTED_CONCEPTS as readonly string[]).includes(value)
    ? (value as SearchConcept)
    : null;
}
