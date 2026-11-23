import { describe, expect, it } from "vitest";
import {
  PASSAGE_TARGET_CHARS,
  passageCitation,
  passageIndex,
} from "~/concepts/asset-passages";

/** What SQLite's substr() returns: offsets count code points. */
function cut(text: string, start: number, length: number) {
  return Array.from(text)
    .slice(start, start + length)
    .join("");
}

describe("passageIndex", () => {
  it("labels PDF pages by the number printed on them, and packs short pages", () => {
    // The shape Workers AI toMarkdown returned for a ReportLab PDF on 2026-10-29.
    const text = [
      "# book.pdf\n## Metadata\n- Author=Ada Synthetic\n- Title=Orchard Notes\n\n## Contents",
      "### Page 1\nTitle page",
      "### Page 2\nDrip irrigation reduces evaporation.\n1",
      "### Page 3\nMulch keeps soil moisture.\n2",
      `### Page 4\n${"Pruning in late winter. ".repeat(200)}\n3`,
    ].join("\n");
    const index = passageIndex(text);
    expect(index.kind).toBe("page");
    expect(index.author).toBe("Ada Synthetic");
    const labels = index.passages.map((p) => p.label);
    // Metadata before the first page carries no locator; page 1 has no
    // printed number, so it cites its position in the file.
    expect(labels.slice(0, 3)).toEqual([null, "PDF p. 1", "pp. 1–2"]);
    expect(labels.at(-1)).toBe("p. 3");
    const pruning = index.passages.at(-2);
    expect(cut(text, pruning?.start ?? 0, pruning?.length ?? 0)).toMatch(
      /^### Page 4\nPruning/,
    );
  });

  it("reads printed numbers glued to the first word, and is not fooled by a year", () => {
    // toMarkdown's shape for On Liberty laid out with two front-matter pages.
    const page = (n: number, body: string) =>
      `### Page ${n}\n${body} ${"text ".repeat(700)}\n`;
    const text = [
      page(1, "On LibertyJohn Stuart Mill"),
      page(2, "ContentsChapter 1. Introductory"),
      page(3, "1CHAPTER I.INTRODUCTORY."),
      page(4, "2their temporal masters"),
      page(5, "31848 was a year of revolutions"),
      page(6, "4meaning to many of them"),
    ].join("");
    expect(passageIndex(text).passages.map((p) => p.label)).toEqual([
      "PDF p. 1",
      "PDF p. 2",
      "p. 1",
      "p. 2",
      "p. 3",
      "p. 4",
    ]);
  });

  it("falls back to the file position when a page has no printed number", () => {
    const index = passageIndex(
      `### Page 7\n${"a".repeat(3000)}\n### Page 8\n${"b".repeat(3000)}`,
    );
    expect(index.passages.map((p) => p.label)).toEqual([
      "PDF p. 7",
      "PDF p. 8",
    ]);
  });

  it("splits a long chapter at paragraph boundaries without merging chapters", () => {
    const paragraph = `${"Energy transitions take decades. ".repeat(20)}\n\n`;
    const text = `§ author: Vaclav Example\n\n§ chapter 1: Fuels\n${paragraph.repeat(20)}§ chapter 2: Food\nShort.`;
    const index = passageIndex(text);
    expect(index.author).toBe("Vaclav Example");
    const chapterOne = index.passages.filter((p) => p.label === "ch. 1: Fuels");
    expect(chapterOne.length).toBeGreaterThan(2);
    for (const passage of chapterOne)
      expect(passage.length).toBeLessThanOrEqual(PASSAGE_TARGET_CHARS);
    expect(index.passages.at(-1)?.label).toBe("ch. 2: Food");
    // Contiguous cover: nothing between passages is lost.
    const joined = index.passages
      .map((p) => cut(text, p.start, p.length))
      .join("");
    expect(text.endsWith(joined)).toBe(true);
  });

  it("counts code points so D1 substr() cuts astral characters intact", () => {
    const text = `§ slide 1\n${"🌳 tree ".repeat(10)}\n§ slide 2\nSecond 🌍 slide`;
    const index = passageIndex(text);
    const second = index.passages[1];
    expect(second.label).toBe("slide 2");
    expect(cut(text, second.start, second.length)).toBe(
      "§ slide 2\nSecond 🌍 slide",
    );
  });

  it("cites author, title and locator in the order an agent pastes them", () => {
    expect(passageCitation("Ada Synthetic", "Orchard Notes", "p. 3")).toBe(
      "Ada Synthetic, Orchard Notes, p. 3",
    );
    expect(passageCitation(null, "Orchard Notes", null)).toBe("Orchard Notes");
  });
});
