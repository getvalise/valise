#!/usr/bin/env node
/**
 * Scores capture-time article extraction on live public pages.
 *
 * node evals/extraction/run.mjs [--out <file>] [--dump <dir>] [--only <n,...>]
 *
 * Each page in articles.json is opened in headless Chromium, the extension's
 * extractArticle runs in it as the extension injects it (one bundled script,
 * then one call), and the result is scored against the hand-read truth:
 * where the article starts and ends, its authors, its published date, and its
 * site name. Pages are fetched live and never stored in the repository;
 * --dump writes each page's visible text and the extractor's output to a
 * directory of your choosing, for reading the truth off a page.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { chromium } from "@playwright/test";
import { build } from "esbuild";

/** Trailing marks such as a footnote's ↩ or a Substack ∙ are not content. */
export const END_SLACK = 4;
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36";

const fold = (value) =>
  String(value ?? "")
    .normalize("NFKC")
    .replace(/[‘’‛′]/g, "'")
    .replace(/[“”‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/ ([,.;:!?])/g, "$1")
    .trim()
    .toLowerCase();
const list = (value) => (Array.isArray(value) ? value : value ? [value] : []);

/**
 * Where the truth's opening and closing phrases sit in the extracted text.
 * Before the opening phrase only a standfirst the page prints as part of the
 * article (`lead`) may appear; anything else is page chrome.
 */
export function scoreBounds(text, truth) {
  const body = fold(text);
  const first = body.indexOf(fold(truth.start));
  const before = first < 0 ? null : body.slice(0, first).trim();
  const lastPhrase = fold(truth.end);
  const last = body.lastIndexOf(lastPhrase);
  const after = last < 0 ? null : body.slice(last + lastPhrase.length).trim();
  return {
    startOk:
      before !== null &&
      (before === "" || list(truth.lead).some((lead) => before === fold(lead))),
    before: before ? before.slice(0, 200) : before,
    endOk: after !== null && after.length <= END_SLACK,
    after: after ? after.slice(0, 200) : after,
  };
}

const sameAuthors = (got, want) => {
  const a = [...new Set((got ?? []).map(fold))].sort();
  const b = [...new Set((want ?? []).map(fold))].sort();
  return a.length === b.length && a.every((name, index) => name === b[index]);
};

/**
 * Calendar day of a published value. An ISO value keeps the day it was
 * written with, before any offset; anything else Date can parse is read as a
 * local date, which is how Date reads a zoneless "October 21, 2024".
 */
export function publishedDay(value) {
  if (!value) return null;
  const text = String(value).trim();
  const iso = text.match(/^(\d{4}-\d{2}-\d{2})(?:$|T)/);
  if (iso) return iso[1];
  const time = Date.parse(text);
  if (Number.isNaN(time)) return null;
  const date = new Date(time);
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

export function scoreArticle(result, truth) {
  const bounds = scoreBounds(result.text ?? "", truth);
  const day = publishedDay(result.published);
  // Dates within a day count: the truth is the date the page prints, and an
  // ISO timestamp in another time zone can land on its neighbour.
  const dayGap =
    day && truth.published
      ? Math.abs(Date.parse(day) - Date.parse(truth.published)) / 86_400_000
      : null;
  return {
    detected: result.detected === true,
    ...bounds,
    authorsOk: sameAuthors(result.authors, truth.authors),
    publishedOk: truth.published
      ? dayGap !== null && dayGap <= 1
      : result.published == null,
    siteOk: list(truth.site).some(
      (site) => fold(result.siteName) === fold(site),
    ),
  };
}

async function bundleExtractor() {
  const bundled = await build({
    stdin: {
      contents:
        'import { extractArticle } from "./extract.mjs"; globalThis.valiseExtractArticle = extractArticle;',
      resolveDir: new URL("../../clients/chrome-extension/", import.meta.url)
        .pathname,
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    write: false,
  });
  return bundled.outputFiles[0].text;
}

async function extractLive(browser, extractor, url) {
  const context = await browser.newContext({
    userAgent: USER_AGENT,
    viewport: { width: 1280, height: 900 },
    locale: "en-GB",
    // chrome.scripting injects past a page's Content-Security-Policy; an
    // inline script tag does not, so the harness has to bypass it too.
    bypassCSP: true,
  });
  const page = await context.newPage();
  try {
    const response = await page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 45_000,
    });
    await page
      .waitForLoadState("networkidle", { timeout: 10_000 })
      .catch(() => {});
    await page.addScriptTag({ content: extractor });
    const result = await page.evaluate("globalThis.valiseExtractArticle()");
    const pageText = await page.evaluate("document.body.innerText");
    return { status: response?.status() ?? null, result, pageText };
  } finally {
    await context.close();
  }
}

async function main() {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      dump: { type: "string" },
      only: { type: "string" },
    },
  });
  const articles = JSON.parse(
    await readFile(new URL("./articles.json", import.meta.url), "utf8"),
  );
  const only = values.only
    ? new Set(values.only.split(",").map((n) => Number(n)))
    : null;
  const extractor = await bundleExtractor();
  const browser = await chromium.launch();
  if (values.dump) await mkdir(values.dump, { recursive: true });
  const rows = [];
  try {
    for (const [index, truth] of articles.entries()) {
      const n = index + 1;
      if (only && !only.has(n)) continue;
      let row;
      try {
        const { status, result, pageText } = await extractLive(
          browser,
          extractor,
          truth.url,
        );
        if (values.dump) {
          const stem = join(values.dump, String(n).padStart(2, "0"));
          await writeFile(`${stem}.page.txt`, pageText);
          await writeFile(`${stem}.text.txt`, result.text ?? "");
          await writeFile(
            `${stem}.json`,
            JSON.stringify(
              { ...result, markdown: undefined, text: undefined },
              null,
              2,
            ),
          );
        }
        row = {
          n,
          url: truth.url,
          status,
          extractor: result.extractor,
          wordCount: result.wordCount,
          pageWordCount: result.pageWordCount,
          got: {
            authors: result.authors,
            published: result.published,
            site: result.siteName,
          },
          ...(truth.start ? scoreArticle(result, truth) : {}),
        };
      } catch (error) {
        row = { n, url: truth.url, error: String(error?.message ?? error) };
      }
      rows.push(row);
      const marks = [
        "detected",
        "startOk",
        "endOk",
        "authorsOk",
        "publishedOk",
        "siteOk",
      ]
        .map((key) => (row[key] === undefined ? "?" : row[key] ? "+" : "-"))
        .join("");
      console.log(
        `${String(n).padStart(2)} ${marks} ${row.error ?? ""}${truth.url}`,
      );
    }
  } finally {
    await browser.close();
  }
  const scored = rows.filter((row) => row.startOk !== undefined);
  const totals = Object.fromEntries(
    ["detected", "startOk", "endOk", "authorsOk", "publishedOk", "siteOk"].map(
      (key) => [key, scored.filter((row) => row[key]).length],
    ),
  );
  console.log(`\n${scored.length} scored:`, totals);
  if (values.out)
    await writeFile(
      values.out,
      `${JSON.stringify({ ranAt: new Date().toISOString(), totals, rows }, null, 2)}\n`,
    );
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
