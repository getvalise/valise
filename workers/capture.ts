import { MAX_PASTE_BYTES, savableUrl } from "~/concepts/source-paste";
import { SourceRefused, sourceRef } from "~/concepts/sources";
import { readerHref } from "~/features/library/presentation";
import { authorizeBearerStore } from "./config";

/**
 * `POST /capture`: the iPhone Shortcut's save, one request from the share
 * sheet with nothing opened in Safari. The body is JSON: `url` (required),
 * `title`, `notes`, `tags` (an array or a comma-separated string) and `text`,
 * the article text or page HTML the Shortcut took from the open page.
 *
 * The credential is a `sources:write` bearer token minted on Connections. The
 * capture URL the owner copies carries it in the fragment, which no HTTP
 * client sends, and the Shortcut moves it into the Authorization header, so
 * the secret is never part of a request URL and no access log can hold it.
 * ADR-0015, amendment of 2026-11-02; docs/operations/ios-capture.md.
 *
 * Every answer is JSON with a `message` the Shortcut shows as it is. A save
 * also carries `link`, the absolute address of the bookmark in Library, which
 * the Shortcut offers to open; its absence is how the Shortcut tells a refusal
 * from a save, since Get Contents of URL does not fail on an error status.
 */

export const CAPTURE_PATH = "/capture";

type CaptureEnv = Parameters<typeof authorizeBearerStore>[1] & {
  CAPTURE_LIMITER?: RateLimit;
};

export async function handleCapture(
  request: Request,
  env: CaptureEnv,
): Promise<Response> {
  if (request.method !== "POST")
    return answer(
      405,
      {
        error: "method_not_allowed",
        message:
          "This is the address the Valise Capture Shortcut posts to. Paste the whole capture URL into the Shortcut instead of opening it.",
      },
      { allow: "POST" },
    );
  // Writes through this door read as the Shortcut, under the token's session.
  const who = await authorizeBearerStore(request, env, ["sources:write"], {
    agent: "ios-shortcut",
    client: "capture",
  });
  if (who instanceof Response) {
    const message =
      who.status === 403
        ? "This capture URL cannot save to Library. Create a new one on Connections."
        : "This capture URL was revoked or is incomplete. Create a new one on Connections and paste it into the Shortcut again.";
    const challenge = who.headers.get("www-authenticate");
    return answer(
      who.status,
      {
        error: who.status === 403 ? "insufficient_scope" : "invalid_token",
        message,
      },
      challenge ? { "www-authenticate": challenge } : {},
    );
  }
  // Keyed by token, so one leaked capture URL cannot exhaust another's.
  if (env.CAPTURE_LIMITER) {
    const { success } = await env.CAPTURE_LIMITER.limit({ key: who.tokenId });
    if (!success)
      return answer(
        429,
        {
          error: "rate_limited",
          message: "Too many saves in the last minute. Try again in a minute.",
        },
        { "retry-after": "60" },
      );
  }

  const tooLarge = answer(413, {
    error: "too_large",
    message:
      "The article is over 3 MB. Share the page again with the article left out.",
  });
  if (Number(request.headers.get("content-length")) > MAX_PASTE_BYTES + 65536)
    return tooLarge;
  const raw = await request.text();
  if (raw.length > MAX_PASTE_BYTES + 65536) return tooLarge;
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
    if (body === null || typeof body !== "object" || Array.isArray(body))
      throw new Error("not an object");
  } catch {
    return answer(400, {
      error: "bad_request",
      message:
        "The Shortcut sent something other than a JSON body. Check that Get Contents of URL sends Request Body as JSON.",
    });
  }
  const url = text(body.url).trim();
  if (!savableUrl(url))
    return answer(400, {
      error: "bad_request",
      message: url
        ? `"${url}" is not an http or https link.`
        : "No link arrived. Share a web page, not text or a file.",
    });

  try {
    const { source, pasted } = await who.store.sources.captureBookmark({
      url,
      title: text(body.title),
      notes: text(body.notes),
      tags: tags(body.tags),
      pasted: text(body.text),
    });
    const words = pasted.wordCount.toLocaleString("en-US");
    return answer(200, {
      id: sourceRef(source.sourceId),
      link: new URL(readerHref(source.sourceId), request.url).href,
      title: source.title,
      article: pasted.article !== null,
      words: pasted.wordCount,
      message: pasted.article
        ? `Saved "${source.title}" with the article, ${words} words.`
        : pasted.wordCount > 0
          ? `Saved "${source.title}". The article held ${words} words, too few to keep, so Valise fetches the page itself.`
          : `Saved "${source.title}". Valise fetches the page itself in the next few minutes.`,
    });
  } catch (error) {
    if (error instanceof SourceRefused)
      return answer(409, { error: "refused", message: error.message });
    throw error;
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function tags(value: unknown): string[] {
  const list = Array.isArray(value)
    ? value.filter((tag): tag is string => typeof tag === "string")
    : text(value).split(",");
  return [...new Set(list.map((tag) => tag.trim()).filter(Boolean))];
}

function answer(
  status: number,
  body: Record<string, unknown>,
  headers: Record<string, string> = {},
): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}
