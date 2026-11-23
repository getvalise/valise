import { describe, expect, it } from "vitest";
// @ts-expect-error: plain .mjs script has no declarations.
import { functionTool, wrongArguments } from "../../evals/arguments.mjs";

describe("eval argument expectations", () => {
  it("preserves the live schema and explicitly opts out of forced fields", () => {
    const schema = {
      type: "object",
      properties: {
        query: { type: "string" },
        type: { type: "string", enum: ["asset", "memory"] },
      },
      required: ["query"],
    };
    const tool = functionTool("search", "Search Valise", schema);
    expect(tool.function.strict).toBe(false);
    expect(tool.function.parameters).toBe(schema);
    expect(tool.function.parameters.required).toEqual(["query"]);
  });

  it("requires a genuinely broad opt-in, not a narrowed library query", () => {
    const testCase = {
      expectArgs: { include_library: true },
      absentArgs: ["type", "project", "tags"],
    };
    expect(wrongArguments(testCase, { include_library: true })).toEqual([]);
    expect(
      wrongArguments(testCase, {
        include_library: true,
        type: "memory",
        project: "*",
        tags: [],
      }),
    ).toEqual(["type", "project", "tags"]);
    expect(wrongArguments(testCase, { include_library: false })).toEqual([
      "include_library",
    ]);
  });

  it("treats even an explicit null as present and preserves existing cases", () => {
    expect(wrongArguments({ absentArgs: ["type"] }, { type: null })).toEqual([
      "type",
    ]);
    expect(wrongArguments({ expectArgs: { type: "asset" } }, {})).toEqual([
      "type",
    ]);
    expect(wrongArguments({}, { query: "Smil" })).toEqual([]);
  });
});
