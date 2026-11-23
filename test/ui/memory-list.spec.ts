import { expect, goto, mcp, seed, test } from "./fixtures/session";

test.beforeEach(async ({ request }) => seed(request));

/**
 * The memory list's row: the whole title, the excerpt as rendered inline
 * Markdown, and one facts line under the text with the type first and the
 * date last, so each sits in the same place whatever else the row carries.
 * A left rule names the type. Variants: long titles, many tags, one tag, each
 * recommended type, a coined type, and no project.
 */
test("memory rows show the whole title, one facts line and a rule per type", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const longTitle = `Row proof ${id} ${"a claim long enough to need two lines at a desktop width ".repeat(3)}end`;
  const variants = [
    {
      type: "insight",
      title: longTitle,
      body: "**Conclusion.** A slot gives one request in flight, `cached` and _cheap_.\n\nSecond paragraph stays out.",
      tags: [
        "gpu-economics",
        "inference",
        "llm-pricing",
        "openrouter",
        "investment-due-diligence",
        "kv-cache",
      ],
      project: undefined,
    },
    {
      type: "decision",
      title: `Row proof ${id} decision`,
      body: "**The rule:**",
      tags: ["licensing"],
      project: "valise",
    },
    {
      type: "reference",
      title: `Row proof ${id} reference`,
      body: "See [the runbook](https://example.com/runbook) for `resume`.",
      tags: ["ui"],
      project: "stash-tool",
    },
    {
      type: "fact",
      title: `Row proof ${id} fact`,
      body: "# Heading\nPlain fact.",
      tags: ["one"],
      project: undefined,
    },
    {
      type: "hunch",
      title: `Row proof ${id} coined`,
      body: "A coined type.",
      tags: ["ui"],
      project: undefined,
    },
  ];
  for (const variant of variants) {
    await mcp(request, "save_memory", {
      type: variant.type,
      title: variant.title,
      body: variant.body,
      tags: variant.tags,
      ...(variant.project ? { project: variant.project } : {}),
    });
  }

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/memories?q=${id}`);
    const rows = page.locator("ul.memories > li.item-row");
    await expect(rows).toHaveCount(variants.length);

    // A string, not a closure: this repo compiles without the DOM lib.
    const measured = await page.evaluate<
      {
        title: string;
        type: string;
        clipped: boolean;
        titleBottom: number;
        metaTop: number;
        typeLeft: number;
        rowLeft: number;
        rowRight: number;
        timeRight: number;
        rule: string;
        excerptHtml: string;
      }[]
    >(`[...document.querySelectorAll("ul.memories > li.item-row")].map((row) => {
      const title = row.querySelector("a.item-title");
      const meta = row.querySelector(".item-meta");
      const type = meta.querySelector("a.facet");
      const time = meta.querySelector("time");
      const box = row.getBoundingClientRect();
      return {
        title: title.textContent,
        type: type.textContent,
        clipped: title.scrollWidth > title.clientWidth + 1 || getComputedStyle(title).textOverflow === "ellipsis",
        titleBottom: title.getBoundingClientRect().bottom,
        metaTop: meta.getBoundingClientRect().top,
        typeLeft: type.getBoundingClientRect().left,
        rowLeft: box.left,
        rowRight: box.right,
        timeRight: time.getBoundingClientRect().right,
        rule: getComputedStyle(row).boxShadow,
        excerptHtml: row.querySelector(".item-description")?.innerHTML ?? "",
      };
    })`);

    const typeLefts = new Set(measured.map((row) => Math.round(row.typeLeft)));
    expect(typeLefts.size, `type column at ${width}`).toBe(1);
    for (const row of measured) {
      expect(row.clipped, `${row.title} at ${width}`).toBe(false);
      expect(row.metaTop).toBeGreaterThanOrEqual(row.titleBottom - 1);
      // The date ends the facts line at the row's right padding.
      expect(row.rowRight - row.timeRight).toBeLessThan(24);
      expect(row.rule).toMatch(/inset/);
    }
    const long = measured.find((row) => row.title === longTitle);
    expect(long, "the long title is shown whole").toBeDefined();

    // Five rows, five rules; the coined type shares the neutral one.
    const rule = (type: string) =>
      measured.find((row) => row.type === type)?.rule;
    const ruled = ["insight", "decision", "reference", "fact"].map(rule);
    expect(new Set(ruled).size).toBe(4);
    expect(ruled).not.toContain(rule("hunch"));
  }

  // The excerpt renders inline marks and drops links, headings and later
  // paragraphs; no raw Markdown is left on the row.
  const excerpt = (title: string) =>
    page
      .locator("ul.memories > li.item-row", {
        has: page.locator("a.item-title", { hasText: title }),
      })
      .locator(".item-description");
  const insight = excerpt(longTitle);
  await expect(insight.locator("strong")).toHaveText("Conclusion.");
  await expect(insight.locator("code")).toHaveText("cached");
  await expect(insight).not.toContainText("**");
  await expect(insight).not.toContainText("Second paragraph");
  await expect(
    excerpt(`Row proof ${id} decision`).locator("strong"),
  ).toHaveText("The rule:");
  const reference = excerpt(`Row proof ${id} reference`);
  await expect(reference).toHaveText("See the runbook for resume.");
  await expect(reference.locator("a")).toHaveCount(0);
  await expect(excerpt(`Row proof ${id} fact`)).not.toContainText("#");

  // The excerpt still opens the memory (P13).
  // The title's cover lies over it, so the pointer lands on the cover there.
  await insight.click({ force: true, position: { x: 4, y: 4 } });
  await expect(page).toHaveURL(/[?&]open=memory/);
});
