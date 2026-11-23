import { describe, expect, it } from "vitest";
import {
  MAX_PROCESSING_BYTES,
  processingEligibility,
  processingFormat,
} from "~/concepts/asset-formats";
import {
  readingNotes,
  SHORT_TEXT_CHARS,
  sourceText,
} from "~/concepts/source-text";
import {
  articleExcerpt,
  importBackup,
  importedCollection,
  libraryTags,
  pageHost,
  referenceGroup,
  withLibraryTags,
  withReadingNotes,
} from "~/features/library/presentation";

describe("library jobs, not storage bookkeeping", () => {
  it("recognizes a supported PDF from MIME when its long saved name has no extension", () => {
    const name = `${"A long saved book name -- ".repeat(12)}`;
    expect(processingFormat(name, "application/pdf")).toBe("pdf");
    expect(processingFormat(name, " Application/PDF; charset=binary ")).toBe(
      "pdf",
    );
    expect(
      processingEligibility(name, "application/pdf", 2_964_186),
    ).toBeNull();
    expect(processingFormat("fallback.PDF", "application/octet-stream")).toBe(
      "pdf",
    );
    expect(processingFormat("a name", "application/epub+zip")).toBe("epub");
  });
  it("explains unsupported and oversized originals before an actionable processing button", () => {
    expect(
      processingEligibility("legacy.ppt", "application/vnd.ms-powerpoint", 100),
    ).toContain("not available for this file type");
    expect(
      processingEligibility(
        "book.pdf",
        "application/pdf",
        MAX_PROCESSING_BYTES + 1,
      ),
    ).toContain("25 MiB");
    expect(
      processingEligibility(
        "book.pdf",
        "application/pdf",
        MAX_PROCESSING_BYTES,
      ),
    ).toBeNull();
  });
  it("hides only known import bookkeeping, preserving authored notes and literal similar text", () => {
    const notes =
      "My quote.\n\nImported from Raindrop.io bookmark 7.\n\nA literal quote, not provenance.\n\nImported from Raindrop.io bookmark 42.\n\nCollection: Unsorted\n\nPage and file contents are not indexed.";
    const imported = {
      notes,
      sourceAgent: "raindrop-import",
      sourceClient: "raindrop.io",
    };
    expect(readingNotes(imported)).toBe(
      "My quote.\n\nImported from Raindrop.io bookmark 7.\n\nA literal quote, not provenance.",
    );
    expect(readingNotes({ ...imported, sourceAgent: "console" })).toBe(notes);
    expect(imported.notes).toBe(notes);
    expect(withReadingNotes(imported, "Revised human note.")).toBe(
      "Revised human note.\n\nImported from Raindrop.io bookmark 42.\n\nCollection: Unsorted\n\nPage and file contents are not indexed.",
    );
    expect(
      withReadingNotes({ ...imported, sourceAgent: "console" }, "Replacement"),
    ).toBe("Replacement");
    expect(
      libraryTags(["SQL", "raindrop", "collection:Unsorted"], true),
    ).toEqual(["SQL"]);
    expect(libraryTags(["collection:Unsorted"])).toEqual([
      "collection:Unsorted",
    ]);
    expect(
      withLibraryTags(
        ["old", "raindrop", "collection:Unsorted"],
        ["new"],
        true,
      ),
    ).toEqual(["new", "raindrop", "collection:Unsorted"]);
    expect(
      importedCollection({ ...imported, tags: ["collection:Unsorted"] }),
    ).toBeNull();
    expect(
      importedCollection({ ...imported, tags: ["collection:Data / SQL"] }),
    ).toBe("Data / SQL");
  });
  it("groups explicit reference images without inferring relationships or hiding unrelated documents", () => {
    const image = {
      project: "valise",
      tags: ["reference", "iconography"],
      contentType: "image/png",
    };
    expect(referenceGroup(image)).toBe("valise");
    expect(referenceGroup({ ...image, project: null })).toBeNull();
    expect(referenceGroup({ ...image, tags: [] })).toBeNull();
    expect(
      referenceGroup({ ...image, contentType: "application/pdf" }),
    ).toBeNull();
    expect(
      importBackup({
        tags: ["import-snapshot"],
        sourceAgent: "raindrop-import",
      }),
    ).toBe(true);
    expect(
      importBackup({ tags: ["import-snapshot"], sourceAgent: "console" }),
    ).toBe(false);
    expect(pageHost("https://www.example.org/article")).toBe("example.org");
  });

  it("reads a bookmark's text from the detected article, else its notes, and marks it short", () => {
    const own = { notes: "", sourceAgent: "x-capture", sourceClient: "oauth" };
    expect(sourceText(own, null)).toEqual({ from: null });
    expect(sourceText({ ...own, notes: " My Saturday! " }, null)).toEqual({
      from: "notes",
      text: "My Saturday!",
      short: true,
    });
    const long = "a".repeat(SHORT_TEXT_CHARS);
    expect(
      sourceText({ ...own, notes: "n" }, { detected: true, text: long }),
    ).toEqual({ from: "article", text: long, short: false });
    expect(
      sourceText({ ...own, notes: "n" }, { detected: false, text: long }),
    ).toEqual({ from: "notes", text: "n", short: true });
  });
});

describe("an article's opening and the rest behind Read more", () => {
  const para = (n: number, word = "hedge") =>
    Array.from({ length: n }, () => word).join(" ");

  it("keeps a short article whole", () => {
    const short = `${para(20)}\n\n${para(20)}`;
    expect(articleExcerpt(short)).toEqual({ opening: short, rest: "" });
  });

  it("splits a long article between blocks once the opening is long enough", () => {
    const blocks = Array.from({ length: 8 }, () => para(30));
    const { opening, rest } = articleExcerpt(blocks.join("\n\n"));
    expect(opening).toBe(blocks.slice(0, 3).join("\n\n"));
    expect(rest).toBe(blocks.slice(3).join("\n\n"));
  });

  it("counts a link's words, not its URL", () => {
    const link = `[Image: a hedge](https://example.com/${"x".repeat(600)})`;
    const { opening } = articleExcerpt(
      [link, para(30), para(30), para(30), para(30), para(30)].join("\n\n"),
    );
    expect(opening.startsWith(link)).toBe(true);
    expect(opening).not.toBe(link);
  });

  it("never splits inside a fenced block", () => {
    const fence = ["```", para(90), "", para(90), "```"].join("\n");
    const tail = Array.from({ length: 4 }, () => para(30)).join("\n\n");
    const { opening, rest } = articleExcerpt(`${fence}\n\n${tail}`);
    expect(opening).toBe(fence);
    expect(rest).toBe(tail);
  });

  it("keeps a remainder too short to be worth hiding", () => {
    const text = `${para(90)}\n\n${para(5)}`;
    expect(articleExcerpt(text).rest).toBe("");
  });
});
