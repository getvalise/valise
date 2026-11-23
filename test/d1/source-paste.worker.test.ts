import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { readSourceArticle } from "~/concepts/source-articles";
import { enrichSource } from "~/concepts/source-enrichment";
import { PASTE_EXTRACTOR, pastedArticle } from "~/concepts/source-paste";
import { saveSource } from "~/concepts/sources";

// Real D1 and HTMLRewriter. The clipboard is a string here; whether iOS
// Shortcuts and Safari hand over that string is docs/operations/ios-capture.md.
const provenance = {
  userId: "local",
  agent: "vitest",
  client: "test",
  session: null,
};
const words = (count: number) =>
  Array.from({ length: count }, (_, at) => `hedgerow${at}`).join(" ");

describe("pasted articles", () => {
  it("keeps plain text the phone copied as the article", async () => {
    const pasted = await pastedArticle(`  # Hedgerows\r\n\r\n${words(200)}  `);
    expect(pasted.wordCount).toBe(202);
    expect(pasted.article).toMatchObject({
      detected: true,
      extractor: PASTE_EXTRACTOR,
      wordCount: 202,
    });
    expect(pasted.article?.markdown.startsWith("\\# Hedgerows\n\n")).toBe(true);
  });

  it("cuts pasted HTML like a fetched page and keeps a paywalled one", async () => {
    const pasted = await pastedArticle(
      `<html lang="en"><head><title>Hedgerows</title><meta name="author" content="Ada Synthetic"><script type="application/ld+json">{"isAccessibleForFree": false}</script></head><body><nav>Subscribe</nav><article>${words(160)}</article></body></html>`,
    );
    expect(pasted.title).toBe("Hedgerows");
    expect(pasted.authors).toEqual(["Ada Synthetic"]);
    expect(pasted.article?.text).not.toContain("Subscribe");
    expect(pasted.article?.wordCount).toBe(160);
  });

  it("drops a clipboard too short to be an article", async () => {
    for (const short of ["", "https://example.org/x", words(149)])
      expect((await pastedArticle(short)).article).toBeNull();
  });

  it("saves the pasted article so Valise never fetches the page", async () => {
    const pasted = await pastedArticle(words(300));
    const source = await saveSource(
      env,
      {
        kind: "bookmark",
        title: "Gated hedgerows",
        url: `https://example.org/gated/${crypto.randomUUID()}`,
        ...(pasted.article ? { article: pasted.article } : {}),
      },
      provenance,
    );
    const stored = await readSourceArticle(env.DB, "local", source.sourceId);
    expect(stored).toMatchObject({ detected: true, wordCount: 300 });

    const fetcher = vi.fn(async () => new Response("", { status: 500 }));
    const ai = {
      run: vi.fn(async () => ({ response: "{}" })),
    } as unknown as Pick<Ai, "run">;
    await enrichSource(
      { DB: env.DB, AI: ai },
      "local",
      source.sourceId,
      fetcher,
    ).catch(() => null);
    expect(fetcher).not.toHaveBeenCalled();
  });
});
