import {
  type ArticleInput,
  MAX_ARTICLE_CHARS,
  MIN_ARTICLE_WORDS,
} from "~/concepts/source-articles";

/**
 * Valise's own fetch of a bookmarked page, for sources that arrived without
 * an article: imports, and saves from clients that do not extract. It asks
 * robots.txt first, reads at most 3 MiB, follows at most three redirects, and
 * keeps nothing from a page that declares itself paywalled. What the Chrome
 * extension captured while the owner was logged in stays the snapshot for
 * paywalled pages; Valise never sends cookies or credentials. ADR-0015,
 * amendment of 2026-10-29 (bookmarks).
 */

/**
 * The fetcher's version: bumped when what it fetches or keeps changes, so the
 * user agent and the extractor name stored on each article move together. The
 * agent names the product and version only, not an install or a repository;
 * robots.txt rules match on `ValiseBot`.
 */
const FETCH_VERSION = 1;
export const FETCH_USER_AGENT = `ValiseBot/${FETCH_VERSION}`;
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_ROBOTS_BYTES = 256 * 1024;
const PAGE_TIMEOUT_MS = 8000;
const ROBOTS_TIMEOUT_MS = 4000;
export const FETCH_EXTRACTOR = `valise-fetch-${FETCH_VERSION}`;

export type FetchStatus =
  | "fetched"
  | "not_article"
  | "paywalled"
  | "robots_disallowed"
  | "fetch_failed";

export type FetchedArticle = {
  status: FetchStatus;
  text: string;
  wordCount: number;
  pageWordCount: number;
  title: string | null;
  authors: string[];
  published: string | null;
  siteName: string | null;
  canonicalUrl: string | null;
  description: string | null;
  language: string | null;
};

export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/** Only public http(s) pages by host name; never an IP literal or a local name. */
export function fetchableUrl(raw: string | null): URL | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "80" && url.port !== "443") return null;
  const host = url.hostname.toLowerCase();
  if (
    !host.includes(".") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "localhost" ||
    /^[\d.]+$/.test(host) ||
    host.startsWith("[")
  )
    return null;
  return url;
}

export async function fetchArticle(
  raw: string,
  fetcher: Fetcher = fetch,
): Promise<FetchedArticle> {
  const empty = (status: FetchStatus): FetchedArticle => ({
    status,
    text: "",
    wordCount: 0,
    pageWordCount: 0,
    title: null,
    authors: [],
    published: null,
    siteName: null,
    canonicalUrl: null,
    description: null,
    language: null,
  });
  const url = fetchableUrl(raw);
  if (!url) return empty("fetch_failed");
  if (!(await robotsAllow(url, fetcher))) return empty("robots_disallowed");
  const response = await fetchFollowing(
    url,
    "text/html,application/xhtml+xml",
    fetcher,
  );
  if (!response) return empty("fetch_failed");
  if ([401, 402, 403].includes(response.status)) return empty("paywalled");
  if (!response.ok || !/html/i.test(response.headers.get("content-type") ?? ""))
    return empty("fetch_failed");
  const html = await readCapped(response, MAX_PAGE_BYTES);
  const page = await extractPage(html);
  if (page.paywalled) return { ...page.article, status: "paywalled", text: "" };
  return page.article.wordCount >= MIN_ARTICLE_WORDS
    ? { ...page.article, status: "fetched" }
    : { ...page.article, status: "not_article", text: "" };
}

/** The article row for text Valise extracted itself, from a fetch or a paste. */
export function articleInput(
  page: Omit<FetchedArticle, "status">,
  extractor: string,
): ArticleInput {
  return {
    detected: true,
    // Plain text, shown through the Markdown renderer: escape line starts
    // that would turn a sentence into a heading or list.
    markdown: page.text.replace(/^([#>*+-]|\d+\.)/gm, "\\$1"),
    text: page.text,
    truncated: page.text.length >= MAX_ARTICLE_CHARS,
    wordCount: page.wordCount,
    pageWordCount: page.pageWordCount,
    extractor,
    published: page.published,
    siteName: page.siteName,
    canonicalUrl: page.canonicalUrl,
    leadImage: null,
    description: page.description,
    language: page.language,
  };
}

/**
 * GET as ValiseBot, following at most three redirects, each to another
 * public http(s) host name. Null when a hop leaves that or the fetch fails.
 */
export async function fetchFollowing(
  start: URL,
  accept: string,
  fetcher: Fetcher = fetch,
  timeoutMs = PAGE_TIMEOUT_MS,
): Promise<Response | null> {
  let url = start;
  try {
    for (let hop = 0; hop < 4; hop++) {
      const response = await fetcher(url.toString(), {
        redirect: "manual",
        headers: { "user-agent": FETCH_USER_AGENT, accept },
        signal: AbortSignal.timeout(timeoutMs),
      });
      const location = response.headers.get("location");
      if (response.status < 300 || response.status >= 400 || !location)
        return response;
      const next = fetchableUrl(new URL(location, url).toString());
      if (!next) return null;
      url = next;
    }
  } catch {
    return null;
  }
  return null;
}

/** At most `cap` bytes of the body, and whether more followed. */
export async function readBytesCapped(
  response: Response,
  cap: number,
): Promise<{ bytes: Uint8Array; over: boolean }> {
  const reader = response.body?.getReader();
  if (!reader) return { bytes: new Uint8Array(), over: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let over = false;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) {
      over = true;
      break;
    }
    chunks.push(value);
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(over ? 0 : size);
  let at = 0;
  if (!over)
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
  return { bytes, over };
}

async function readCapped(response: Response, cap: number): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < cap) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const bytes = new Uint8Array(Math.min(size, cap));
  let at = 0;
  for (const chunk of chunks) {
    const part = chunk.subarray(0, Math.min(chunk.byteLength, cap - at));
    bytes.set(part, at);
    at += part.byteLength;
    if (at >= cap) break;
  }
  return new TextDecoder().decode(bytes);
}

/** Longest-match Allow/Disallow for our agent's group, else `*`. 5xx and timeouts disallow. */
export async function robotsAllow(
  url: URL,
  fetcher: Fetcher = fetch,
): Promise<boolean> {
  let body: string;
  try {
    const response = await fetcher(`${url.origin}/robots.txt`, {
      headers: { "user-agent": FETCH_USER_AGENT },
      signal: AbortSignal.timeout(ROBOTS_TIMEOUT_MS),
    });
    if (response.status >= 500) return false;
    if (!response.ok) return true;
    body = await readCapped(response, MAX_ROBOTS_BYTES);
  } catch {
    return false;
  }
  return robotsAllows(body, url.pathname + url.search);
}

export function robotsAllows(robots: string, path: string): boolean {
  type Group = { agents: string[]; rules: [boolean, string][] };
  const groups: Group[] = [];
  let current: Group | null = null;
  let lastWasAgent = false;
  for (const raw of robots.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, "").trim();
    const match = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!match) continue;
    const field = match[1].toLowerCase();
    const value = match[2].trim();
    if (field === "user-agent") {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((field === "allow" || field === "disallow") && current) {
      if (value) current.rules.push([field === "allow", value]);
      lastWasAgent = false;
    } else lastWasAgent = false;
  }
  const named = groups.filter((g) =>
    g.agents.some((a) => a !== "*" && "valisebot".includes(a)),
  );
  const ours = named.length
    ? named
    : groups.filter((g) => g.agents.includes("*"));
  let best: [boolean, number] = [true, -1];
  for (const group of ours)
    for (const [allow, pattern] of group.rules) {
      const anchored = pattern.endsWith("$");
      const body = (anchored ? pattern.slice(0, -1) : pattern)
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      const regex = new RegExp(`^${body}${anchored ? "$" : ""}`);
      if (
        regex.test(path) &&
        (pattern.length > best[1] || (pattern.length === best[1] && allow))
      )
        best = [allow, pattern.length];
    }
  return best[0];
}

const SKIP =
  "script, style, noscript, template, svg, nav, header, footer, aside, form, button, iframe, select";
const BLOCK = "p, h1, h2, h3, h4, h5, h6, li, blockquote, pre, tr, div, br";

/**
 * A Readability-style cut in HTMLRewriter, which a Worker has without a DOM:
 * text inside <article>, else <main>, else <body>, minus navigation, chrome
 * and scripts, with the page's own metadata.
 */
export async function extractPage(html: string): Promise<{
  article: Omit<FetchedArticle, "status">;
  paywalled: boolean;
}> {
  const buffers = {
    article: [] as string[],
    main: [] as string[],
    body: [] as string[],
  };
  let skip = 0;
  let inArticle = 0;
  let inMain = 0;
  let inBody = 0;
  let inTitle = false;
  let title = "";
  let jsonLd = "";
  const meta: Record<string, string> = {};
  let canonical: string | null = null;
  let language: string | null = null;
  const push = (text: string) => {
    if (skip) return;
    if (inArticle) buffers.article.push(text);
    if (inMain) buffers.main.push(text);
    buffers.body.push(text);
  };
  const rewriter = new HTMLRewriter()
    .on("html", {
      element(element) {
        language = element.getAttribute("lang");
      },
    })
    .on("title", {
      element(element) {
        inTitle = true;
        element.onEndTag(() => {
          inTitle = false;
        });
      },
      text(chunk) {
        if (inTitle) title += chunk.text;
      },
    })
    .on("meta", {
      element(element) {
        const key = (
          element.getAttribute("property") ??
          element.getAttribute("name") ??
          ""
        ).toLowerCase();
        const content = element.getAttribute("content");
        if (key && content && !(key in meta)) meta[key] = content;
      },
    })
    .on('link[rel="canonical"]', {
      element(element) {
        canonical ??= element.getAttribute("href");
      },
    })
    // No end-tag handler here: an element keeps only the last one set, and
    // SKIP below needs it to stop skipping after this script.
    .on('script[type="application/ld+json"]', {
      text(chunk) {
        if (jsonLd.length < 200_000) jsonLd += chunk.text;
      },
    })
    .on(SKIP, {
      element(element) {
        skip++;
        element.onEndTag(() => {
          skip--;
        });
      },
    })
    .on("article", {
      element(element) {
        inArticle++;
        element.onEndTag(() => {
          inArticle--;
        });
      },
    })
    .on("main", {
      element(element) {
        inMain++;
        element.onEndTag(() => {
          inMain--;
        });
      },
    })
    .on(BLOCK, {
      element(element) {
        push("\n");
        if (element.tagName !== "br" && !element.removed)
          try {
            element.onEndTag(() => push("\n"));
          } catch {
            /* a void or self-closing element has no end tag */
          }
      },
    })
    .on("body", {
      element(element) {
        inBody++;
        element.onEndTag(() => {
          inBody--;
        });
      },
    })
    .onDocument({
      text(chunk) {
        if (inBody) push(chunk.text);
      },
    });
  await rewriter.transform(new Response(html)).text();
  const clean = (parts: string[]) =>
    decodeEntities(parts.join(""))
      .replace(/[ \t\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const words = (text: string) => (text.match(/\S+/g) ?? []).length;
  const body = clean(buffers.body);
  const chosen =
    [clean(buffers.article), clean(buffers.main)].find(
      (text) => words(text) >= MIN_ARTICLE_WORDS,
    ) ?? body;
  const author = meta.author ?? meta["article:author"] ?? null;
  return {
    paywalled: /"isAccessibleForFree"\s*:\s*(false|"false")/i.test(jsonLd),
    article: {
      text: chosen.slice(0, 200_000),
      wordCount: words(chosen),
      pageWordCount: words(body),
      title: decodeEntities(meta["og:title"] ?? title).trim() || null,
      authors:
        author && !/^https?:/.test(author)
          ? [decodeEntities(author).trim()]
          : [],
      published: meta["article:published_time"] ?? null,
      siteName: meta["og:site_name"] ?? null,
      canonicalUrl: canonical,
      description: meta.description ?? meta["og:description"] ?? null,
      language,
    },
  };
}

function decodeEntities(text: string): string {
  const named: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " ",
    mdash: "—",
    ndash: "–",
    hellip: "…",
    rsquo: "’",
    lsquo: "‘",
    rdquo: "”",
    ldquo: "“",
  };
  return text.replace(
    /&(#x[\da-f]+|#\d+|[a-z]+);/gi,
    (whole, entity: string) => {
      if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? whole;
      const code =
        entity[1].toLowerCase() === "x"
          ? Number.parseInt(entity.slice(2), 16)
          : Number(entity.slice(1));
      return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff)
        ? String.fromCodePoint(code)
        : "";
    },
  );
}
