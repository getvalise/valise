import {
  createRequestHandler,
  RouterContextProvider,
  type ServerBuild,
} from "react-router";
import { checkBackups } from "~/backup/monitor";
import { startBackup } from "~/backup/workflow";
import { trimActivity } from "~/concepts/activity";
import { maintainAssetProcessing } from "~/concepts/asset-processing";
import {
  receiveAssetUpload,
  serveArchiveFile,
  serveAssetDownload,
} from "~/concepts/assets";
import {
  sweepBuiltinSkills,
  syncBuiltinSkills,
} from "~/concepts/builtin-skills";
import { cleanupLibrary } from "~/concepts/library";
import { overnightMemoryReview } from "~/concepts/memory-review";
import { checkAllUpstream } from "~/concepts/skills-upstream";
import { maintainSourceEnrichment } from "~/concepts/source-enrichment";
import { meterJob } from "~/concepts/spend";
import { consoleContext } from "~/console/context.server";
import type { SearchConcept } from "~/db/schema";
import { createSessionCookie, handleAuthorization } from "~/lib/auth.server";
import {
  assetVectorCandidates,
  maintainAssetVectors,
} from "~/search/asset-vectors";
import { search } from "~/search/query";
import { reindex, SEARCH_CONCEPTS } from "~/search/reindex";
import {
  RERANKERS,
  type Reranker,
  rerank,
  rerankedSearch,
  rerankMode,
} from "~/search/rerank";
import { type SeedMemory, seed, seedMemories } from "~/search/seed";
import {
  maintainSourceVectors,
  sourceVectorCandidates,
} from "~/search/source-vectors";
import {
  backfillVectors,
  drainVectors,
  maintainVectors,
  vectorStatus,
} from "~/search/vector-outbox";
import { memoryVectorCandidates, type VectorBindings } from "~/search/vectors";
import { CAPTURE_PATH, handleCapture } from "./capture";
import {
  HOOK_CONFIG_PATH,
  handleHookConfig,
  handleRecall,
  handleStartupBrief,
  RECALL_PATH,
  STARTUP_BRIEF_PATH,
} from "./config";
import { handleLibrary, LIBRARY_PREFIX } from "./library";
import { handleMcp } from "./mcp";
import {
  createOAuthProvider,
  isOAuthProviderPath,
  type OAuthEnv,
} from "./oauth";

export { BackupWorkflow } from "~/backup/workflow";
export { TodoCoordinator } from "~/do/todo-coordinator";

/**
 * V1-1 serves development levers only. V1-2 mounts the MCP handler here.
 *
 * The `/__dev/*` routes are the way a reviewer reruns the live lanes against
 * the real projection code rather than against SQL pasted into a CLI. They
 * answer on loopback only, so a deployed Worker never exposes them.
 */

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

const ASSET_TRANSFER = /^\/(uploads|downloads)\/(ast_[0-9a-f-]{36})$/;

const consoleRequestHandler = createRequestHandler(
  () => import("virtual:react-router/server-build") as Promise<ServerBuild>,
  import.meta.env.MODE,
);

const oauthDefaultHandler: ExportedHandler<OAuthEnv> = {
  async fetch(
    request: Request,
    env: OAuthEnv,
    _ctx: ExecutionContext,
  ): Promise<Response> {
    if (new URL(request.url).pathname === "/authorize") {
      return handleAuthorization(request, env, oauthDefaultHandler);
    }
    return json({ error: "not found" }, 404);
  },
} satisfies ExportedHandler<OAuthEnv>;

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true });
    }

    if (url.pathname === HOOK_CONFIG_PATH) {
      return handleHookConfig(request, env);
    }

    if (url.pathname === STARTUP_BRIEF_PATH) {
      return handleStartupBrief(request, env);
    }

    if (url.pathname === RECALL_PATH) {
      return handleRecall(request, env);
    }

    if (url.pathname === CAPTURE_PATH) {
      return handleCapture(request, env);
    }

    // Asset bytes over plain HTTP, authorized by the capability in the URL
    // rather than a session, so any HTTP client an agent has can use them.
    // ADR-0015.
    const transfer = ASSET_TRANSFER.exec(url.pathname);
    if (transfer) {
      return transfer[1] === "uploads"
        ? receiveAssetUpload(env, transfer[2], request)
        : request.method === "GET" || request.method === "HEAD"
          ? serveAssetDownload(env, transfer[2], url)
          : new Response(null, { status: 405, headers: { allow: "GET" } });
    }

    if (url.pathname.startsWith("/archives/")) {
      return request.method === "GET" || request.method === "HEAD"
        ? serveArchiveFile(env, url)
        : new Response(null, { status: 405, headers: { allow: "GET" } });
    }

    if (url.pathname.startsWith(LIBRARY_PREFIX)) {
      const library = await handleLibrary(request, env, url);
      if (library) return library;
    }

    if (url.pathname === "/mcp") {
      if (LOOPBACK.has(url.hostname) && request.headers.has("x-valise-agent")) {
        return handleMcp(request, env, ctx);
      }
      const oauthEnv = oauthEnvironment(env, url);
      return createOAuthProvider(oauthEnv, oauthDefaultHandler).fetch(
        request,
        oauthEnv,
        ctx,
      );
    }

    if (isOAuthProviderPath(url.pathname, oauthEnvironment(env, url))) {
      const oauthEnv = oauthEnvironment(env, url);
      return createOAuthProvider(oauthEnv, oauthDefaultHandler).fetch(
        request,
        oauthEnv,
        ctx,
      );
    }

    if (url.pathname.startsWith("/__dev/")) {
      if (!LOOPBACK.has(url.hostname)) {
        return json({ error: "dev routes answer on loopback only" }, 404);
      }
      return devRoute(request, url, env);
    }

    const consoleRequestContext = new RouterContextProvider();
    consoleRequestContext.set(consoleContext, { env, ctx });
    return consoleRequestHandler(request, consoleRequestContext);
  },

  /**
   * Bounded minute delivery and builtin upgrades are separate from nightly maintenance.
   */
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<void> {
    // The backup cron is named by a var, so a self-host can stagger it.
    // Every other cron also checks for a failed or stale backup; the minute
    // cron does so once an hour. ADR-0019.
    const backupCheck = () =>
      ctx.waitUntil(
        meterJob(env, "backup_check", (env) =>
          checkBackups(env, Date.now()),
        ).then((report) => {
          if (report.incident)
            console.log(JSON.stringify({ event: "backup_check", ...report }));
        }),
      );
    if (
      (env as Partial<Env>).VALISE_BACKUP_CRON &&
      controller.cron === env.VALISE_BACKUP_CRON
    ) {
      ctx.waitUntil(
        meterJob(env, "backup", (env) =>
          startBackup(env, controller.scheduledTime),
        ).then((report) => {
          console.log(JSON.stringify({ event: "backup_start", ...report }));
        }),
      );
      backupCheck();
      return;
    }
    if (controller.cron === "* * * * *") {
      if (new Date(controller.scheduledTime).getUTCMinutes() === 30)
        backupCheck();
      ctx.waitUntil(meterJob(env, "asset_processing", maintainAssetProcessing));
      // Nightly memory upkeep: one pass per due account a minute, until the
      // queue or today's limit is used, then due again at 02:00 UTC. ADR-0012.
      ctx.waitUntil(
        meterJob(env, "memory_review", overnightMemoryReview).then((report) => {
          if (report.users)
            console.log(JSON.stringify({ event: "memory_review", ...report }));
        }),
      );
      ctx.waitUntil(
        meterJob(env, "source_enrichment", maintainSourceEnrichment).then(
          (report) => {
            if (report.attempted)
              console.log(
                JSON.stringify({ event: "source_enrichment", ...report }),
              );
          },
        ),
      );
      ctx.waitUntil(
        meterJob(env, "builtin_sweep", sweepBuiltinSkills).then((report) => {
          console.log(JSON.stringify({ event: "builtin_sweep", report }));
        }),
      );
      ctx.waitUntil(
        meterJob(env, "asset_vectors", maintainAssetVectors).then((report) => {
          console.log(
            JSON.stringify({ event: "asset_vector_drain", ...report }),
          );
        }),
      );
      ctx.waitUntil(
        meterJob(env, "source_vectors", maintainSourceVectors).then(
          (report) => {
            console.log(
              JSON.stringify({ event: "source_vector_drain", ...report }),
            );
          },
        ),
      );
      ctx.waitUntil(
        meterJob(env, "vectors", (env) =>
          maintainVectors(
            env,
            Math.floor(controller.scheduledTime / 60_000) % 5 === 0,
          ),
        ).then((report) => {
          console.log(JSON.stringify({ event: "vector_drain", ...report }));
        }),
      );
      return;
    }
    backupCheck();
    ctx.waitUntil(
      meterJob(env, "trim", trimActivity).then((removed) => {
        console.log(
          `trim: ${removed.calls} calls, ${removed.authEvents} auth events, ${removed.sessions} sessions, ${removed.embeddingUsage} embedding usage days`,
        );
      }),
    );
    // Abandoned uploads, expired assets, and bytes no row names. Each step
    // retries on the next night if it fails. ADR-0015.
    ctx.waitUntil(
      meterJob(env, "library_cleanup", cleanupLibrary).then((report) => {
        console.log(JSON.stringify({ event: "library_cleanup", ...report }));
      }),
    );
    // One tarball per GitHub repository and one download per skills.sh
    // skill, so the dialog and the list read a column, not the network.
    // Skills set to auto-update get the new version here.
    ctx.waitUntil(
      meterJob(env, "upstream", checkAllUpstream).then(
        ({ errors, applied, held }) => {
          for (const error of errors) console.log(`upstream: ${error}`);
          if (applied.length)
            console.log(`upstream: updated ${applied.join(", ")}`);
          if (held.length)
            console.log(`upstream: held ${held.join(", ")}, edited here`);
        },
      ),
    );
  },
} satisfies ExportedHandler<Env>;

async function devRoute(
  request: Request,
  url: URL,
  env: Env,
): Promise<Response> {
  switch (url.pathname) {
    case "/__dev/seed":
      return json(await seed(env));

    case "/__dev/memories": {
      // The runner builds the retrieval corpus and posts it, so the fixture
      // text stays out of the Worker bundle.
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const memories = (await request.json()) as SeedMemory[];
      return json(await seedMemories(env, memories));
    }

    case "/__dev/store":
      return json(await storeContents(env));

    case "/__dev/reindex":
      return json(await reindex(env, conceptsParam(url)));

    case "/__dev/vectors": {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      if (url.searchParams.get("drain") === "1")
        return json(await drainVectors(env));
      return json(
        await backfillVectors(env, url.searchParams.get("after") ?? ""),
      );
    }

    case "/__dev/source-enrichment": {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return json(await maintainSourceEnrichment(env));
    }

    case "/__dev/asset-vectors": {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return json(await maintainAssetVectors(env));
    }

    case "/__dev/asset-vector-candidates": {
      const query = url.searchParams.get("q");
      const userId = url.searchParams.get("user");
      if (!query || !userId)
        return json({ error: "q and user are required" }, 400);
      return json({
        heads: await assetVectorCandidates(env, {
          query,
          userId,
          concepts: ["asset"],
          project: url.searchParams.get("project") ?? undefined,
          tags: url.searchParams.getAll("tag"),
        }),
      });
    }

    case "/__dev/source-vectors": {
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      return json(await maintainSourceVectors(env));
    }

    case "/__dev/source-vector-candidates": {
      const query = url.searchParams.get("q");
      const userId = url.searchParams.get("user");
      if (!query || !userId)
        return json({ error: "q and user are required" }, 400);
      return json({
        heads: await sourceVectorCandidates(env, {
          query,
          userId,
          concepts: ["source"],
          project: url.searchParams.get("project") ?? undefined,
          tags: url.searchParams.getAll("tag"),
        }),
      });
    }

    case "/__dev/vector-status":
      return json({
        namespace: env.VALISE_VECTOR_NAMESPACE,
        ...(await vectorStatus(env.DB, env.VALISE_VECTOR_NAMESPACE)),
      });

    case "/__dev/vector-candidates":
    case "/__dev/hybrid-search": {
      const query = url.searchParams.get("q");
      if (!query) return json({ error: "q is required" }, 400);
      const filters = {
        query,
        userId: url.searchParams.get("user") ?? "local",
        project: url.searchParams.get("project") ?? undefined,
        tags: url.searchParams.getAll("tag"),
        limit: 50,
      };
      return json(
        url.pathname === "/__dev/vector-candidates"
          ? { heads: await memoryVectorCandidates(env, filters) }
          : await rerankedSearch(env, "hybrid", filters),
      );
    }

    case "/__dev/search": {
      const query = url.searchParams.get("q");
      if (!query) return json({ error: "q is required" }, 400);
      const tags = url.searchParams.getAll("tag");
      const project = url.searchParams.get("project") ?? undefined;
      const limitParam = url.searchParams.get("limit");
      return json({
        query,
        hits: await search(env, {
          query,
          userId: url.searchParams.get("user") ?? "local",
          concepts: conceptsParam(url),
          project,
          tags: tags.length ? tags : undefined,
          limit: limitParam ? Number(limitParam) : undefined,
        }),
      });
    }

    case "/__dev/rerank": {
      // GET reports the mode without invoking paid inference or warming a
      // store. POST scores only the candidate texts the caller sends.
      if (request.method === "GET") {
        const mode = rerankMode(env as Env & { VALISE_RERANK?: string });
        const vectorEnv: Env & VectorBindings = env;
        if (
          mode === "hybrid" &&
          (!env.TYPESAFE_API_KEY ||
            !vectorEnv.VECTOR_INDEX ||
            !vectorEnv.VALISE_VECTOR_NAMESPACE)
        ) {
          // The runner must not label an unconfigured, lexical-only fallback
          // as evidence for the union. Presence is not a backfill/live check.
          return json(
            { error: "hybrid needs Jev and configured vector resources" },
            503,
          );
        }
        return json({ mode, embedded: 0 });
      }
      if (request.method !== "POST") return json({ error: "GET or POST" }, 405);
      const { model, query, candidates } = (await request.json()) as {
        model: Reranker;
        query: string;
        candidates: string[];
      };
      if (!RERANKERS.includes(model)) {
        return json({ error: `model is one of ${RERANKERS.join(", ")}` }, 400);
      }
      const started = Date.now();
      const result = await rerank(env, model, query, candidates);
      return json({ ...result, ms: Date.now() - started });
    }

    case "/__dev/sync-builtins":
      return json(
        await syncBuiltinSkills(env, url.searchParams.get("user") ?? "local"),
      );

    case "/__dev/todos/reset": {
      const userId = url.searchParams.get("user") ?? "local";
      const coordinator = env.TODO_COORDINATOR.getByName(`todos:${userId}`);
      // Reseeding leaves a claimed seed to-do claimed, and the eval harness
      // lane claims it for real, so it returns one to-do to pending through
      // the coordinator rather than by writing the row. ADR-0002.
      const todoId = url.searchParams.get("todo");
      if (todoId) {
        return json(
          await coordinator.override(
            todoId,
            "dev-reset",
            "pending",
            "reset between eval harness cases",
          ),
        );
      }
      await coordinator.resetForDevelopment();
      return json({ reset: userId });
    }

    case "/__dev/member": {
      // A member as Google sign-in leaves one: verified, with no password,
      // and a browser session. The account page's tests start from it.
      if (request.method !== "POST") return json({ error: "POST only" }, 405);
      const email = url.searchParams.get("email");
      if (!email) return json({ error: "email is required" }, 400);
      // An address that already has an account signs in to it, so a test
      // with a fixed address (the admin one) can run twice on one store.
      const now = Math.floor(Date.now() / 1000);
      const row = await env.DB.prepare(
        `INSERT INTO users (user_id, email, display_name, role, plan, created_at, email_verified)
           VALUES (?, ?, ?, 'member', 'free', ?, 1)
           ON CONFLICT (email) DO UPDATE SET email = excluded.email
           RETURNING user_id AS userId`,
      )
        .bind(
          `usr_dev_${crypto.randomUUID()}`,
          email.toLowerCase(),
          email.split("@")[0],
          now,
        )
        .first<{ userId: string }>();
      if (row === null) return json({ error: "no account" }, 500);
      const { userId } = row;
      const cookie = await createSessionCookie(env, request, userId);
      return new Response(JSON.stringify({ userId }), {
        headers: { "content-type": "application/json", "set-cookie": cookie },
      });
    }

    default:
      return json({ error: "not found" }, 404);
  }
}

/**
 * Everything a read tool can reach, without timestamps, so the eval runner
 * can hash it and two runs that saw the same store say so. `search_docs`
 * holds every live skill, memory, and to-do; the to-do states decide what
 * `list_ready` returns, and the hook documents what `list_hooks` does.
 */
async function storeContents(env: Env) {
  const docs = await env.DB.prepare(
    "SELECT doc_key, project, title, body, tags FROM search_docs ORDER BY doc_key",
  ).all();
  const todos = await env.DB.prepare(
    "SELECT todo_id, state, blocked_on FROM todos ORDER BY todo_id",
  ).all();
  const hooks = await env.DB.prepare(
    "SELECT user_id, document FROM hook_configs ORDER BY user_id",
  ).all();
  return { docs: docs.results, todos: todos.results, hooks: hooks.results };
}

type RuntimeOAuthEnv = Omit<Env, "APP_ORIGIN" | "MCP_RESOURCE_URL"> & OAuthEnv;

function oauthEnvironment(env: Env, url: URL): RuntimeOAuthEnv {
  if (!LOOPBACK.has(url.hostname)) return env;
  const origin = url.origin;
  return { ...env, APP_ORIGIN: origin, MCP_RESOURCE_URL: `${origin}/mcp` };
}

function conceptsParam(url: URL): SearchConcept[] | undefined {
  const values = url.searchParams
    .getAll("concept")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v): v is SearchConcept =>
      (SEARCH_CONCEPTS as string[]).includes(v),
    );
  return values.length ? values : undefined;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
