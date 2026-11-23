import { describe, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script with no declarations.
import { publishedDay, scoreArticle } from "../../evals/extraction/run.mjs";

const truth = {
  lead: "A standfirst the page prints.",
  start: "The article begins here.",
  end: "And it ends here.",
  authors: ["Ada Lovelace", "Charles Babbage"],
  published: "2024-10-21",
  site: ["Engines Weekly", "Engines"],
};

const result = (text: string, extra = {}) => ({
  detected: true,
  text,
  authors: ["Charles Babbage", "Ada Lovelace"],
  published: "2024-10-21T09:00:00+02:00",
  siteName: "Engines",
  ...extra,
});

describe("article extraction scoring", () => {
  test("a standfirst may precede the start; page chrome may not", () => {
    const body = "The article begins here. Middle. And it ends here.";
    expect(scoreArticle(result(body), truth).startOk).toBe(true);
    expect(
      scoreArticle(result(`A standfirst the page prints.\n${body}`), truth)
        .startOk,
    ).toBe(true);
    const banner = scoreArticle(result(`Subscribe now →\n${body}`), truth);
    expect(banner.startOk).toBe(false);
    expect(banner.before).toBe("subscribe now →");
  });

  test("a footnote mark may follow the end; a newsletter box may not", () => {
    const body = "The article begins here. And it ends here.";
    expect(scoreArticle(result(`${body} ↩`), truth).endOk).toBe(true);
    const footer = scoreArticle(result(`${body}\nGet the next one.`), truth);
    expect(footer.endOk).toBe(false);
    expect(footer.after).toBe("get the next one.");
  });

  test("quotes, dashes and space before punctuation fold together", () => {
    const scored = scoreArticle(
      result("The article begins here . And it ends here ."),
      truth,
    );
    expect(scored).toMatchObject({ startOk: true, endOk: true });
  });

  test("authors compare as sets, site against any accepted name", () => {
    const scored = scoreArticle(result("x"), truth);
    expect(scored).toMatchObject({ authorsOk: true, siteOk: true });
    expect(
      scoreArticle(result("x", { authors: ["Ada Lovelace", "Ph.D."] }), truth)
        .authorsOk,
    ).toBe(false);
  });

  test("a published day keeps the day it was written with", () => {
    expect(publishedDay("2017-10-03T03:59:59Z")).toBe("2017-10-03");
    expect(publishedDay("2024-10-21")).toBe("2024-10-21");
    expect(publishedDay("October 21, 2024")).toBe("2024-10-21");
    expect(publishedDay("February 3, 2023 T09:00:00+05:30, 2023-02-03")).toBe(
      null,
    );
    expect(publishedDay(null)).toBe(null);
  });

  test("a missing or unparseable date fails a page that prints one", () => {
    expect(
      scoreArticle(result("x", { published: null }), truth).publishedOk,
    ).toBe(false);
    expect(
      scoreArticle(result("x", { published: "2024-10-22" }), truth).publishedOk,
    ).toBe(true);
  });
});
