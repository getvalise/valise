import { describe, expect, it } from "vitest";
import { parseQuickAdd } from "~/concepts/quick-add";
import { capBody, joinTags, projectTodo } from "~/search/project";

// The parsing and projection transforms run in plain Node: no D1, no Worker
// pool, no bindings. Their database behaviour is covered in test/d1.

describe("projection transforms", () => {
  it("caps a body on a UTF-8 byte budget without splitting a code point", () => {
    expect(capBody("abc", 10)).toBe("abc");
    // "é" is two bytes; a 3-byte cap keeps "a" and one whole "é".
    expect(capBody("aéé", 3)).toBe("aé");
    expect(new TextEncoder().encode(capBody("ü".repeat(100), 51)).length).toBe(
      50,
    );
  });

  it("joins stored tags and tolerates malformed JSON", () => {
    expect(joinTags('["duckdb","priority:1",3]')).toBe("duckdb priority:1");
    expect(joinTags("{}")).toBe("");
    expect(joinTags("not json")).toBe("");
  });

  it("projects a to-do with its pointers and comments after the body", () => {
    expect(
      projectTodo({
        todoId: "tdo_1",
        userId: "usr_1",
        title: "Fix ranking",
        body: "Body first.",
        tagsJson: '["area:search"]',
        refsJson:
          '[{"kind":"file","value":"app/search/query.ts"},{"kind":"x"}]',
        project: "valise",
        updatedAt: 42,
        comments: "A question.",
      }),
    ).toEqual({
      docKey: "todo:tdo_1",
      userId: "usr_1",
      concept: "todo",
      conceptId: "tdo_1",
      project: "valise",
      title: "Fix ranking",
      body: "Body first.\napp/search/query.ts\nA question.",
      tags: "area:search",
      updatedAt: 42,
    });
  });
});

describe("quick-add parsing", () => {
  it("reads facets, #tags and project: out of a title", () => {
    expect(parseQuickAdd("Ship it project:valise #release priority:2")).toEqual(
      {
        title: "Ship it",
        project: "valise",
        tags: ["release", "priority:2"],
      },
    );
  });
});
