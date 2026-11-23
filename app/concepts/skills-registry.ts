import type { BundleFile } from "~/r2/bundles";

/**
 * skills.sh, read from the Worker.
 *
 * Two endpoints, neither documented: `/api/search` and `/api/download`. The
 * documented `/api/v1` authenticates with a Vercel OIDC token, which only a
 * Vercel runtime can mint, so it is not an option at any price. The two used
 * here are what every `npx skills` invocation depends on, they are pinned in
 * MIT-licensed source that can be watched, and the CLI honours a base-URL
 * override — which is why the base is a Worker var rather than a constant.
 *
 * Every call is made here rather than in the browser. skills.sh answers both
 * endpoints with no `access-control-*` header at all, so a direct call from
 * the console is blocked before it is sent.
 */

export const DEFAULT_REGISTRY = "https://skills.sh";

/** Search results, so one typo does not cost a long wait. */
const SEARCH_TIMEOUT_MS = 8_000;
const DOWNLOAD_TIMEOUT_MS = 20_000;

/** A SKILL.md and its bundle. Generous for prose, closed against a tarball. */
const MAX_FILES = 50;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export type RegistryEnv = { SKILLS_REGISTRY_URL?: string };

export type RegistryHit = {
  /** `owner/repo/skill`, which is also the download path. */
  id: string;
  /** `owner/repo` on GitHub. */
  source: string;
  skillId: string;
  name: string;
  installs: number;
  listingUrl: string;
};

export type RegistryDownload = {
  id: string;
  /** The upstream's own content digest, so a later check is a comparison. */
  hash: string;
  body: string;
  files: BundleFile[];
  listingUrl: string;
};

export type RegistryFailure = { errors: string[] };

export function isFailure<T>(
  value: T | RegistryFailure,
): value is RegistryFailure {
  return typeof value === "object" && value !== null && "errors" in value;
}

export async function searchRegistry(
  env: RegistryEnv,
  query: string,
  limit = 20,
): Promise<RegistryHit[] | RegistryFailure> {
  const trimmed = query.trim();
  if (trimmed === "") return [];
  const url = new URL("/api/search", base(env));
  url.searchParams.set("q", trimmed);
  url.searchParams.set("limit", String(limit));

  const answered = await read(url, SEARCH_TIMEOUT_MS);
  if (isFailure(answered)) return answered;
  const skills = (answered as { skills?: unknown }).skills;
  if (!Array.isArray(skills)) {
    return { errors: ["The registry returned no results list."] };
  }
  return skills.flatMap((hit) => {
    const row = hit as Record<string, unknown>;
    const source = typeof row.source === "string" ? row.source : "";
    const skillId = typeof row.skillId === "string" ? row.skillId : "";
    // The index carries bare-domain sources like `docs.stripe.com`, and
    // `/api/download` answers 404 for every one of them. Offering a row that
    // cannot be imported is worse than not offering it.
    if (!/^[\w.-]+\/[\w.-]+$/.test(source) || skillId === "") return [];
    const id = `${source}/${skillId}`;
    return [
      {
        id,
        source,
        skillId,
        name: typeof row.name === "string" ? row.name : skillId,
        installs: typeof row.installs === "number" ? row.installs : 0,
        listingUrl: listingUrl(id),
      },
    ];
  });
}

export async function downloadFromRegistry(
  env: RegistryEnv,
  id: string,
): Promise<RegistryDownload | RegistryFailure> {
  // The id becomes three path segments, so a slash or a dot-dot inside one of
  // them is a request to somewhere else entirely.
  if (!/^[\w.-]+\/[\w.-]+\/[\w.-]+$/.test(id) || id.includes("..")) {
    return { errors: [`${id} is not an owner/repo/skill id.`] };
  }

  const answered = await read(
    new URL(`/api/download/${id}`, base(env)),
    DOWNLOAD_TIMEOUT_MS,
  );
  if (isFailure(answered)) return answered;

  const payload = answered as { files?: unknown; hash?: unknown };
  if (!Array.isArray(payload.files)) {
    return { errors: ["The registry returned no files for that skill."] };
  }
  if (payload.files.length > MAX_FILES) {
    return { errors: [`That skill carries more than ${MAX_FILES} files.`] };
  }

  let body: string | null = null;
  const files: BundleFile[] = [];
  let total = 0;
  for (const entry of payload.files) {
    const file = entry as Record<string, unknown>;
    const path = typeof file.path === "string" ? file.path : "";
    const contents = typeof file.contents === "string" ? file.contents : null;
    if (path === "" || contents === null) {
      return { errors: ["The registry returned a file with no path or body."] };
    }
    // `writeBundle` refuses these too, but a rejection that names the file is
    // worth more here than one that names the bucket.
    if (path.startsWith("/") || path.split("/").includes("..")) {
      return { errors: [`${path} escapes the bundle.`] };
    }
    total += contents.length;
    if (total > MAX_TOTAL_BYTES) {
      return { errors: ["That skill is larger than 2MB."] };
    }
    if (path === "SKILL.md") body = contents;
    else files.push({ path, content: contents });
  }

  if (body === null) {
    return { errors: ["That skill has no SKILL.md at its root."] };
  }
  return {
    id,
    hash: typeof payload.hash === "string" ? payload.hash : "",
    body,
    files,
    listingUrl: listingUrl(id),
  };
}

export type PopularSkill = RegistryHit & {
  /** Eight weekly install counts, oldest first, as the skills.sh sparkline draws them. */
  weeklyInstalls: number[];
  isOfficial: boolean;
  /** Last week against the eight-week mean: 1.5 is half again its usual pace. */
  trend: number | null;
};

const POPULAR_TTL_SECONDS = 24 * 60 * 60;
const POPULAR_RETRY_SECONDS = 60 * 60;
const POPULAR_TIMEOUT_MS = 3_000;

/**
 * The top of skills.sh's all-time list, page 0 only: 200 skills, cached for
 * a day in the Workers Cache API so the console costs skills.sh one request
 * a day at most. `robots.txt` disallows `/api/`, the same as the search and
 * download this file already depends on, which is why once a day is the
 * ceiling. Any failure, including a changed shape, is an empty list: the
 * section hides rather than the page erroring.
 */
export async function readPopular(env: RegistryEnv): Promise<PopularSkill[]> {
  const url = new URL("/api/skills/all-time/0", base(env));
  const cache = typeof caches === "undefined" ? null : caches.default;
  let payload: unknown = null;
  const cached = await cache?.match(url.toString());
  if (cached) {
    payload = await cached.json().catch(() => null);
  } else {
    // The console's loader waits on this, so it gets less time than a search.
    const answered = await read(url, POPULAR_TIMEOUT_MS);
    payload = isFailure(answered) ? null : answered;
    // A failure is kept too, for an hour, so a slow or broken skills.sh costs
    // one wait an hour rather than one on every load of the page.
    const usable = parsePopular(payload).length > 0;
    await cache?.put(
      url.toString(),
      new Response(JSON.stringify(usable ? payload : { skills: [] }), {
        headers: {
          "content-type": "application/json",
          "cache-control": `max-age=${usable ? POPULAR_TTL_SECONDS : POPULAR_RETRY_SECONDS}`,
        },
      }),
    );
  }
  return parsePopular(payload);
}

function parsePopular(payload: unknown): PopularSkill[] {
  const skills = (payload as { skills?: unknown } | null)?.skills;
  if (!Array.isArray(skills)) return [];
  return skills.flatMap((entry) => {
    const row = entry as Record<string, unknown>;
    const source = typeof row.source === "string" ? row.source : "";
    const skillId = typeof row.skillId === "string" ? row.skillId : "";
    if (!/^[\w.-]+\/[\w.-]+$/.test(source) || !/^[\w.-]+$/.test(skillId)) {
      return [];
    }
    const weekly = Array.isArray(row.weeklyInstalls)
      ? row.weeklyInstalls.filter((n): n is number => typeof n === "number")
      : [];
    const mean =
      weekly.length === 0
        ? 0
        : weekly.reduce((sum, n) => sum + n, 0) / weekly.length;
    const id = `${source}/${skillId}`;
    return [
      {
        id,
        source,
        skillId,
        name: typeof row.name === "string" ? row.name : skillId,
        installs: typeof row.installs === "number" ? row.installs : 0,
        listingUrl: listingUrl(id),
        weeklyInstalls: weekly,
        isOfficial: row.isOfficial === true,
        trend: mean > 0 ? (weekly.at(-1) ?? 0) / mean : null,
      },
    ];
  });
}

export function listingUrl(id: string): string {
  return `https://www.skills.sh/${id}`;
}

function base(env: RegistryEnv): string {
  return env.SKILLS_REGISTRY_URL?.trim() || DEFAULT_REGISTRY;
}

/**
 * The registry being down is a message on the page, never a 500. A console
 * that cannot search is worse than one that says why it cannot.
 */
async function read(
  url: URL,
  timeoutMs: number,
): Promise<unknown | RegistryFailure> {
  let response: Response;
  try {
    response = await fetch(url, {
      headers: { accept: "application/json", "user-agent": "valise" },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    return { errors: [`Could not reach the registry: ${message(error)}`] };
  }
  if (!response.ok) {
    return { errors: [`The registry answered ${response.status}.`] };
  }
  try {
    return await response.json();
  } catch {
    return {
      errors: ["The registry answered with something that is not JSON."],
    };
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
