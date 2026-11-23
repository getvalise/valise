import { describe, expect, it } from "vitest";
// @ts-expect-error: a plain .mjs script with no declarations.
import { cases, score } from "../../evals/outcomes/fixtures.mjs";

const ids = {
  partial: "todo:partial",
  new: "memory:new",
  first: "todo:first",
  second: "todo:second",
};
const fixtures = cases(ids);
function episode(answer: unknown, route: unknown[] = []) {
  return { answer: JSON.stringify(answer), route, capped: false, error: null };
}

describe("handoff outcome scoring", () => {
  it("scores the recovered answer separately from authoritative fetching", () => {
    const testCase = fixtures[0];
    const answer = { ...testCase.expected, needs_user_context: false };
    expect(score(testCase, episode(answer)).missingEvidence).toEqual([
      ids.partial,
    ]);
    expect(score(testCase, episode(answer))).toMatchObject({
      pass: true,
      authoritativeFetch: false,
    });
    expect(
      score(
        testCase,
        episode(answer, [{ name: "fetch", args: { id: ids.partial } }]),
      ).pass,
    ).toBe(true);
  });

  it("fails a missing blocker and reconstruction request even after a fetch", () => {
    const result = score(
      fixtures[0],
      episode(
        { ...fixtures[0].expected, blockers: [], needs_user_context: true },
        [{ name: "fetch", args: { id: ids.partial } }],
      ),
    );
    expect(result.missedBlockers).toEqual(["vendor-signoff"]);
    expect(result.needsUserContext).toBe(true);
    expect(result.pass).toBe(false);
  });

  it("requires the exact completion set, independent of order", () => {
    const testCase = fixtures[2];
    expect(
      score(
        testCase,
        episode({
          completed_ids: [ids.second, ids.first],
          needs_user_context: false,
        }),
      ).pass,
    ).toBe(true);
    for (const completed_ids of [
      [ids.first],
      [ids.first, ids.second, "todo:after"],
      [ids.first, ids.first, ids.second],
    ]) {
      expect(
        score(testCase, episode({ completed_ids, needs_user_context: false }))
          .pass,
      ).toBe(false);
    }
  });

  it("separates waste from correctness but fails writes and no-recall overfire", () => {
    const testCase = fixtures[3];
    const answer = { ...testCase.expected, needs_user_context: false };
    const route = [
      { name: "search", args: {} },
      { name: "fetch", args: { id: ids.partial } },
    ];
    expect(score(testCase, episode(answer, route))).toMatchObject({
      pass: true,
      needlessSearches: 1,
    });
    expect(
      score(
        testCase,
        episode(answer, [
          ...route,
          { name: "save_memory", writeAttempt: true },
        ]),
      ),
    ).toMatchObject({ pass: false, needlessWrites: 1 });
    expect(
      score(
        fixtures[4],
        episode({ answer: 42, needs_user_context: false }, [
          { name: "search" },
        ]),
      ).pass,
    ).toBe(false);
  });

  it("does not pass provider errors, caps, or invalid JSON", () => {
    const good = episode(
      { ...fixtures[1].expected, needs_user_context: false },
      [{ name: "fetch", args: { id: ids.new } }],
    );
    for (const bad of [
      { ...good, error: "timeout" },
      { ...good, capped: true },
      { ...good, answer: "not json" },
      { ...good, answer: null },
    ]) {
      expect(score(fixtures[1], bad).pass).toBe(false);
    }
    expect(
      score(fixtures[1], {
        ...good,
        route: [{ name: "fetch", args: { id: ids.new }, error: "not found" }],
      }).authoritativeFetch,
    ).toBe(false);
  });

  it("retains malformed blocker fields as a miss instead of crashing the report", () => {
    expect(
      score(
        fixtures[0],
        episode({
          ...fixtures[0].expected,
          blockers: {},
          needs_user_context: false,
        }),
      ),
    ).toMatchObject({ pass: false, missedBlockers: ["vendor-signoff"] });
  });
});
