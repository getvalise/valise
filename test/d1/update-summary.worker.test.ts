import { describe, expect, it } from "vitest";
import {
  clamp,
  SUMMARY_LENGTH,
  summarize,
  updateSummary,
} from "~/concepts/update-summary";

describe("summarize", () => {
  it("keeps whole sentences of the first line while they fit in 160 characters", () => {
    expect(
      summarize(
        "Slice 2 landed on feat/assets-finalize. Verify is green apart from Playwright.",
      ),
    ).toBe(
      "Slice 2 landed on feat/assets-finalize. Verify is green apart from Playwright.",
    );
  });

  it("carries a saved next step that follows the first sentence", () => {
    // The handoff outcome fixture: the step lives in the second sentence.
    expect(
      summarize(
        "Parser already implemented at commit abc1234; unit tests 18/18. Remaining step: integration-check. Do not redo parser. Evidence: fixtures/checksum.spec.ts. Deployment is a separate blocked task.",
      ),
    ).toBe(
      "Parser already implemented at commit abc1234; unit tests 18/18. Remaining step: integration-check. Do not redo parser. Evidence: fixtures/checksum.spec.ts.",
    );
  });

  it("stops at the first sentence that would not fit whole", () => {
    const first = `${"a".repeat(100)}.`;
    expect(summarize(`${first} B${"b".repeat(69)}. Short.`)).toBe(first);
  });

  it("keeps abbreviations and versions inside the sentence", () => {
    expect(
      summarize("Bumped wrangler to v4.2 e.g. for the R2 fix. Done."),
    ).toBe("Bumped wrangler to v4.2 e.g. for the R2 fix. Done.");
  });

  it("takes the first line when it has no sentence end", () => {
    expect(
      summarize("Merge blocked on PR #153 review\n\nDetails follow."),
    ).toBe("Merge blocked on PR #153 review");
  });

  it("strips Markdown", () => {
    expect(
      summarize(
        "- [x] **Schema** done: see [the ADR](docs/adr/0015.md) and `app/concepts/assets.ts`",
      ),
    ).toBe("Schema done: see the ADR and app/concepts/assets.ts");
    expect(summarize("> quoted _emphasis_ line")).toBe("quoted emphasis line");
  });

  it("keeps snake_case identifiers intact", () => {
    expect(summarize("Renamed list_ready_todos to list_ready")).toBe(
      "Renamed list_ready_todos to list_ready",
    );
  });

  it("joins a heading to the line under it", () => {
    expect(summarize("## Slice 3\n\nUpload finalize is retry-safe now.")).toBe(
      "Slice 3: Upload finalize is retry-safe now.",
    );
  });

  it("skips code blocks", () => {
    expect(
      summarize("```sh\nnpm run verify\n```\nVerify passed at abc123."),
    ).toBe("Verify passed at abc123.");
  });

  it("cuts at a word boundary, never mid-word, at most 160 characters", () => {
    const body = `${"word ".repeat(60)}end.`;
    const cut = summarize(body);
    expect(cut.length).toBeLessThanOrEqual(SUMMARY_LENGTH);
    expect(cut.endsWith("word…")).toBe(true);
  });

  it("returns empty for an empty or code-only body", () => {
    expect(summarize("")).toBe("");
    expect(summarize("```\nonly code\n```")).toBe("");
  });
});

describe("clamp", () => {
  it("cuts inside a single word only when there is no other boundary", () => {
    const url = `https://example.com/${"a".repeat(300)}`;
    expect(clamp(url)).toHaveLength(SUMMARY_LENGTH);
  });

  it("drops trailing punctuation before the ellipsis", () => {
    expect(clamp(`${"abc, ".repeat(40)}`, 12)).toBe("abc, abc…");
  });
});

describe("updateSummary", () => {
  it("prefers the author's summary, cleaned and clamped", () => {
    expect(updateSummary("Long body. More.", "  **Blocked** on review ")).toBe(
      "Blocked on review",
    );
    expect(updateSummary("x", "y ".repeat(200))?.length).toBeLessThanOrEqual(
      SUMMARY_LENGTH,
    );
  });

  it("falls back to the body's cut, and to null for an empty body", () => {
    expect(updateSummary("First. Second.", null)).toBe("First. Second.");
    expect(updateSummary("", undefined)).toBeNull();
  });
});
