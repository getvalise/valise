import { mcpPrincipal, mcpProvenance } from "~/auth/principal";
import type { McpScope } from "~/auth/scopes";
import {
  attachMemoryFile,
  listMemoryAttachments,
  setFileAttached,
} from "~/concepts/attachments";
import { listFacets } from "~/concepts/facets";
import type { ListFilters } from "~/concepts/list-filters";
import {
  archiveMemory,
  countMemories,
  editMemory,
  getMemory,
  listMemories,
  listMemoryRevisions,
  listMemoryTypes,
  type MemoryEdit,
  type Provenance,
  readMemoryUsage,
  saveMemory,
  similarMemories,
} from "~/concepts/memories";
import {
  assertPersonMemoryLink,
  changeMemoryLink,
  listMemoryLinks,
  listMemoryLinkTargets,
  type MemoryRelation,
} from "~/concepts/memory-links";
import { type MemoryQuery, queryMemories } from "~/concepts/memory-query";
import { readOnboarding, setOnboardingDismissed } from "~/concepts/onboarding";
import type { ListWindow } from "~/concepts/pagination";
import {
  readStartupBrief,
  type StartupBriefInput,
} from "~/concepts/startup-brief";
import { resolveBearerToken } from "~/concepts/tokens";
import { accountAdmitted } from "~/concepts/users";
import { readVocabulary } from "~/concepts/vocabulary";
import type { Concept } from "~/db/schema";
import type { TodoCoordinator } from "~/do/todo-coordinator";
import { requireUser, type SessionEnv } from "~/lib/auth.server";
import { readProvenance } from "~/search/provenance";
import { type SearchFilters, search } from "~/search/query";
import { readRecallGate, recall, recordRecallInjection } from "~/search/recall";
import { vectorDeferral } from "~/search/vector-outbox";
import { activityStore, fileStore, hookStore } from "./activity.server";
import { libraryStore } from "./library.server";
import { reviewStore, subjectStore } from "./review.server";
import {
  controlDatabase,
  type TenantStorage,
  tenantStorage,
} from "./routing.server";
import { rankedSearch } from "./search.server";
import { skillStore } from "./skills.server";
import { sourceStore } from "./sources.server";
import { todoStore } from "./todos.server";
import { transcriptStore } from "./transcripts.server";

type StoreEnv = {
  DB: D1Database;
  BUNDLES: R2Bucket;
  TODO_COORDINATOR: DurableObjectNamespace<TodoCoordinator>;
  SKILLS_REGISTRY_URL?: string;
  // Model and vector providers a memory review pass calls.
  AI?: Ai;
  OPENROUTER_API_KEY?: string;
  TYPESAFE_API_KEY?: string;
  VECTOR_INDEX?: Pick<Vectorize, "query">;
  VALISE_VECTOR_NAMESPACE?: string;
  VALISE_VECTOR_BACKLOG_CAP?: string;
  VALISE_RERANK?: string;
  /** Keys asset upload credentials and download signatures. ADR-0015. */
  TOKEN_PEPPER?: string;
  /** Per-tenant daily allowance for bookmark summaries. */
  VALISE_SOURCE_DAILY_USD?: string;
  /** `owner` gives members the owner's file allowance. */
  VALISE_MEMBER_ALLOWANCE?: string;
  /** Admins get the owner's file allowance. */
  VALISE_ADMIN_EMAILS?: string;
};

/** Only authentication adapters construct stores; operations never take an owner. */
export async function requireBrowserStore(
  env: StoreEnv & SessionEnv,
  request: Request,
) {
  const user = await requireUser({ ...env, DB: controlDatabase(env) }, request);
  const route = tenantStorage(env, user);
  const provenance: Provenance = Object.freeze({
    userId: user.userId,
    agent: "console",
    client: "web",
    session: null,
  });
  const store = memoryStore(env, route, provenance);
  const data = dataEnvironment(env, route);
  return {
    user,
    provenance,
    store: Object.freeze({
      ...store,
      // The first-run checklist reads the tenant's calls and skills and keeps
      // its dismissal on the account, so it is a console concern only.
      onboarding: Object.freeze({
        read: () => readOnboarding(data.DB, controlDatabase(env), route.userId),
        dismiss: (dismissed: boolean) =>
          setOnboardingDismissed(controlDatabase(env), route.userId, dismissed),
      }),
      // Human assertion authority is not part of an MCP store.
      personMemoryLinks: Object.freeze({
        assert: (id: string, relation: MemoryRelation) =>
          assertPersonMemoryLink(data, id, relation, provenance),
        change: (
          id: string,
          link: string,
          action: "confirm" | "remove" | "restore",
        ) => changeMemoryLink(data, id, link, action, route.userId),
      }),
    }),
  };
}

/**
 * The store for an MCP request the provider has already authenticated, with
 * the provenance its writes carry. Null without a principal or an admitted
 * account. Scope preflight remains the transport's job; this does not grant
 * scopes.
 */
export async function mcpTenantStore(
  env: StoreEnv,
  ctx: ExecutionContext,
  headers: { session: string | null; sessionName: string | null } = {
    session: null,
    sessionName: null,
  },
) {
  const principal = mcpPrincipal(ctx);
  if (
    principal === null ||
    !(await accountAdmitted(controlDatabase(env), principal.userId))
  )
    return null;
  const provenance = Object.freeze(mcpProvenance(principal, headers));
  return Object.freeze({
    provenance,
    store: memoryStore(env, tenantStorage(env, principal), provenance),
  });
}

/**
 * The store for a plain HTTP request carrying a console-issued bearer token
 * that holds every scope named. The token's user is the tenant; nothing in
 * the request can name another. `door` labels writes made through this
 * endpoint (an iPhone Shortcut, the library script); the token id is always
 * the session. A refusal says why, for the caller's challenge header.
 */
export async function bearerTenantStore(
  env: StoreEnv & { TOKEN_PEPPER?: string },
  request: Request,
  scopes: readonly McpScope[],
  door?: { agent: string; client: string },
): Promise<
  | {
      store: ReturnType<typeof memoryStore>;
      provenance: Provenance;
      tokenId: string;
    }
  | { refused: "invalid_token" }
  | { refused: "insufficient_scope"; missing: McpScope[] }
> {
  const header = request.headers.get("authorization") ?? "";
  const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  const control = controlDatabase(env);
  const record =
    token && env.TOKEN_PEPPER
      ? await resolveBearerToken(
          { DB: control, TOKEN_PEPPER: env.TOKEN_PEPPER },
          token,
        )
      : null;
  if (record === null || !(await accountAdmitted(control, record.userId)))
    return { refused: "invalid_token" };
  const missing = scopes.filter((scope) => !record.scopes.includes(scope));
  if (missing.length > 0) return { refused: "insufficient_scope", missing };
  const provenance: Provenance = Object.freeze({
    userId: record.userId,
    agent: door?.agent ?? record.label,
    client: door?.client ?? "bearer",
    session: record.tokenId,
  });
  return {
    store: memoryStore(env, tenantStorage(env, record), provenance),
    provenance,
    tokenId: record.tokenId,
  };
}

/**
 * Development impersonation for the loopback-only MCP surface, which takes its
 * identity from request headers. Never call this from a production path: the
 * caller, not an authenticated principal, chooses the tenant. Kept apart from
 * the authenticated factories above so that difference stays visible.
 */
export function loopbackTenantStore(env: StoreEnv, provenance: Provenance) {
  const bound = Object.freeze({ ...provenance });
  return memoryStore(env, tenantStorage(env, bound), bound);
}

function dataEnvironment(env: StoreEnv, route: TenantStorage) {
  // Capture the selected bindings and configuration, not a mutable caller env.
  return Object.freeze({
    DB: route.DB,
    BUNDLES: env.BUNDLES,
    TODO_COORDINATOR: env.TODO_COORDINATOR,
    SKILLS_REGISTRY_URL: env.SKILLS_REGISTRY_URL,
    AI: env.AI,
    OPENROUTER_API_KEY: env.OPENROUTER_API_KEY,
    TYPESAFE_API_KEY: env.TYPESAFE_API_KEY,
    VECTOR_INDEX: env.VECTOR_INDEX,
    VALISE_VECTOR_NAMESPACE: env.VALISE_VECTOR_NAMESPACE,
    VALISE_VECTOR_BACKLOG_CAP: env.VALISE_VECTOR_BACKLOG_CAP,
    VALISE_RERANK: env.VALISE_RERANK,
    TOKEN_PEPPER: env.TOKEN_PEPPER,
    VALISE_SOURCE_DAILY_USD: env.VALISE_SOURCE_DAILY_USD,
    VALISE_MEMBER_ALLOWANCE: env.VALISE_MEMBER_ALLOWANCE,
    VALISE_ADMIN_EMAILS: env.VALISE_ADMIN_EMAILS,
  });
}

function memoryStore(
  env: StoreEnv,
  route: TenantStorage,
  provenance: Provenance,
) {
  if (route.userId !== provenance.userId) {
    throw new Error("Tenant route and provenance disagree.");
  }
  const data = dataEnvironment(env, route);
  const { DB: db, userId } = route;
  return Object.freeze({
    storage: route.kind,
    // Lexical only: MCP adoption must retain reranking and owned hydration.
    search: (filters: Omit<SearchFilters, "userId">) =>
      search(data, { ...filters, userId }),
    /** The transport's search: reranked when configured, then owned only. */
    rankedSearch: (filters: Omit<SearchFilters, "userId">) =>
      rankedSearch(data, userId, filters),
    /** When each hit was first saved and by which session. */
    provenance: (hits: Parameters<typeof readProvenance>[2]) =>
      readProvenance(db, userId, hits),
    vocabulary: () => readVocabulary(db, userId),
    /** The plain-text session brief the hook script fetches. */
    startupBrief: (input: StartupBriefInput = {}) =>
      readStartupBrief(db, userId, Date.now(), input),
    /** What the hook injects after a failed command. */
    recall: (query: string) => recall(db, userId, query),
    /** The hook's once-per-error, three-per-session gate on recall. */
    recallGate: Object.freeze({
      read: (sessionId: string, fingerprint: string, now: number) =>
        readRecallGate(db, userId, sessionId, fingerprint, now),
      record: (sessionId: string, fingerprint: string, now: number) =>
        recordRecallInjection(db, userId, sessionId, fingerprint, now),
    }),
    facets: (concept: Concept) => listFacets(db, userId, concept),
    todos: todoStore(data, userId, provenance),
    skills: skillStore(data, userId, provenance),
    activity: activityStore(data, userId),
    hooks: hookStore(data, userId, provenance),
    files: fileStore(data, userId),
    review: reviewStore(data, userId, provenance),
    subjects: subjectStore(data, userId, provenance),
    library: libraryStore(data, userId, provenance),
    sources: sourceStore(data, userId, provenance),
    transcripts: transcriptStore(data, userId, provenance),
    memories: Object.freeze({
      save: (input: Parameters<typeof saveMemory>[1]) =>
        saveMemory(data, input, provenance),
      edit: (
        id: string,
        edit: Partial<MemoryEdit>,
        relates: readonly MemoryRelation[] = [],
      ) => editMemory(data, id, edit, provenance, relates),
      get: (id: string) => getMemory(db, userId, id),
      list: (filters: ListFilters = {}, window?: ListWindow) =>
        listMemories(db, userId, filters, window),
      count: (filters: ListFilters = {}) => countMemories(db, userId, filters),
      /** `list_memories`: compact rows a keyset page at a time. */
      query: (input: MemoryQuery) => queryMemories(db, userId, input),
      types: () => listMemoryTypes(db, userId),
      usage: () => readMemoryUsage(db, userId),
      revisions: (id: string) => listMemoryRevisions(db, userId, id),
      archive: (id: string) => archiveMemory(data, userId, id),
      similar: (title: string, project: string | null) =>
        similarMemories(data, userId, title, project),
      /** Whether semantic indexing of this memory waits behind the backlog cap. */
      vectorDeferral: (id: string) => vectorDeferral(data, userId, id),
      links: (id: string, includeRemoved = false) =>
        listMemoryLinks(db, userId, id, includeRemoved),
      linkTargets: (
        id: string,
        options?: { query?: string; offset?: number },
      ) => listMemoryLinkTargets(db, userId, id, options),
      attachments: (ids: string[]) => listMemoryAttachments(db, userId, ids),
      attach: (id: string, file: File) =>
        attachMemoryFile(data, userId, id, file),
      setFileAttached: (id: string, objectId: string, attached: boolean) =>
        setFileAttached(
          db,
          userId,
          { concept: "memory", id },
          objectId,
          attached,
        ),
    }),
  });
}

export type TenantStore = NonNullable<
  Awaited<ReturnType<typeof mcpTenantStore>>
>["store"];
export type BrowserTenantStore = Awaited<
  ReturnType<typeof requireBrowserStore>
>["store"];
