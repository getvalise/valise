import { describe, expect, it } from "vitest";
import {
  BRIEF_MEMORIES,
  BRIEF_PROJECTS,
  BRIEF_TODOS,
  BRIEF_WINDOW_SECONDS,
  type BriefRows,
  briefWindow,
  coversUpTo,
  MAX_STARTUP_BRIEF_LENGTH,
  MAX_TITLE_LENGTH,
  renderStartupBrief,
  selectBrief,
  selectedRollupIds,
} from "~/concepts/startup-brief";

// Fixtures only: no database, no clock, no platform bindings.
const NOW = 1_800_000_000;

type Page = BriefRows["ready"];
type Todo = Page["todos"][number];

function todo(id: string, patch: Partial<Todo> = {}): Todo {
  return {
    id: `todo:${id}`,
    title: `To-do ${id}`,
    status: null,
    status_at: null,
    project: "valise",
    state: "pending",
    lease_holder: null,
    lease_expires_at: null,
    blocked_on: null,
    created_at: NOW - 100,
    updated_at: NOW - 50,
    completed_at: null,
    update_count: 0,
    last_update_at: null,
    last_update_kind: null,
    last_update_author: null,
    last_update_summary: null,
    tags: ["kept-out"],
    refs: [{ kind: "file", value: "kept-out" }],
    ...patch,
  } as Todo;
}

function page(todos: Todo[], hasMore = false): Page {
  return {
    generated_at: NOW,
    as_of: NOW,
    limit: BRIEF_TODOS,
    next_cursor: null,
    has_more: hasMore,
    todos,
  } as Page;
}

const empty: BriefRows = {
  projects: [],
  rollupTags: [],
  memories: [],
  ready: page([]),
  claimed: page([]),
  blocked: page([]),
  completed: page([]),
};

const window = briefWindow({}, NOW);

describe("briefWindow", () => {
  it("defaults to the preceding 24 hours across every project", () => {
    expect(briefWindow({}, NOW)).toEqual({
      now: NOW,
      since: NOW - BRIEF_WINDOW_SECONDS,
      project: null,
    });
  });

  it("keeps an explicit start and project", () => {
    expect(briefWindow({ since: NOW - 5, project: "valise" }, NOW)).toEqual({
      now: NOW,
      since: NOW - 5,
      project: "valise",
    });
  });
});

describe("selectBrief", () => {
  it("is empty, with nothing omitted, for an empty store, and renders no text", () => {
    const brief = selectBrief(empty, window);
    expect(brief.generated_at).toBe(NOW);
    expect(brief.window).toEqual({
      since: NOW - BRIEF_WINDOW_SECONDS,
      until: NOW,
    });
    for (const part of [
      brief.projects,
      brief.ready,
      brief.claimed,
      brief.blocked,
      brief.completed,
      brief.changed_memories,
    ]) {
      expect(part.items).toEqual([]);
      expect(part.has_more).toBe(false);
    }
    expect(renderStartupBrief(brief)).toBe("");
  });

  it("is deterministic: the same rows and window give the same brief", () => {
    const rows = { ...empty, ready: page([todo("a"), todo("b")]) };
    expect(selectBrief(rows, window)).toEqual(selectBrief(rows, window));
  });

  it("bounds projects and memories and says when more exist", () => {
    const projects = Array.from({ length: BRIEF_PROJECTS + 1 }, (_, i) => ({
      project: `p${i}`,
      active_at: NOW - i,
      rollup_id: null,
    }));
    const memories = Array.from({ length: BRIEF_MEMORIES + 1 }, (_, i) => ({
      memory_id: `mem_${i}`,
      title: `Memory ${i}`,
      project: null,
      updated_at: NOW - i,
      memory_type: "fact",
    }));
    const brief = selectBrief({ ...empty, projects, memories }, window);
    expect(brief.projects.items.map((p) => p.project)).toEqual([
      "p0",
      "p1",
      "p2",
    ]);
    expect(brief.projects.has_more).toBe(true);
    expect(brief.changed_memories.items.map((m) => m.id)).toEqual([
      "memory:mem_0",
      "memory:mem_1",
      "memory:mem_2",
    ]);
    expect(brief.changed_memories.has_more).toBe(true);
    expect(brief.changed_memories.items[0]).toMatchObject({ type: "fact" });
  });

  it("keeps each to-do section's own has_more and drops tags and refs", () => {
    const brief = selectBrief(
      { ...empty, claimed: page([todo("c", { state: "claimed" })], true) },
      window,
    );
    expect(brief.claimed.has_more).toBe(true);
    expect(brief.ready.has_more).toBe(false);
    expect(brief.claimed.items[0]).not.toHaveProperty("tags");
    expect(brief.claimed.items[0]).not.toHaveProperty("refs");
  });

  it("cuts long or multi-line text to one bounded line", () => {
    const long = `${"word ".repeat(80)}end`;
    const brief = selectBrief(
      {
        ...empty,
        blocked: page([
          todo("x", {
            title: "line one\n\n  line two",
            blocked_on: long,
            status: long,
            last_update_summary: long,
            state: "blocked",
          }),
        ]),
      },
      window,
    );
    const item = brief.blocked.items[0];
    expect(item.title).toBe("line one line two");
    for (const text of [
      item.blocked_on,
      item.status,
      item.last_update_summary,
    ]) {
      expect(text?.length).toBe(MAX_TITLE_LENGTH);
      expect(text?.endsWith("…")).toBe(true);
    }
  });

  it("names a selected project's rollup and its coverage, ignoring unselected ones", () => {
    const projects = [
      { project: "a", active_at: NOW, rollup_id: "mem_a" },
      { project: "b", active_at: NOW - 1, rollup_id: null },
      { project: "c", active_at: NOW - 2, rollup_id: "mem_c" },
      { project: "d", active_at: NOW - 3, rollup_id: "mem_d" },
    ];
    expect(selectedRollupIds(projects)).toEqual(["mem_a", "mem_c"]);
    const brief = selectBrief(
      {
        ...empty,
        projects,
        rollupTags: [
          {
            memory_id: "mem_a",
            tags_json: '["rollup","covers_up_to:2026-10-31"]',
          },
          { memory_id: "mem_c", tags_json: "not json" },
        ],
      },
      window,
    );
    expect(brief.projects.items).toEqual([
      {
        project: "a",
        active_at: NOW,
        rollup_id: "memory:mem_a",
        covers_up_to: "2026-10-31",
      },
      { project: "b", active_at: NOW - 1, rollup_id: null, covers_up_to: null },
      {
        project: "c",
        active_at: NOW - 2,
        rollup_id: "memory:mem_c",
        covers_up_to: null,
      },
    ]);
  });
});

describe("coversUpTo", () => {
  it("reads the facet and tolerates absent or malformed tags", () => {
    expect(coversUpTo('["covers_up_to:2026-11-01"]')).toBe("2026-11-01");
    expect(coversUpTo('["rollup"]')).toBeNull();
    expect(coversUpTo("{}")).toBeNull();
    expect(coversUpTo("[1, null]")).toBeNull();
    expect(coversUpTo("")).toBeNull();
  });
});

describe("renderStartupBrief", () => {
  it("lists each state with its status, or its last update when it has none", () => {
    const text = renderStartupBrief(
      selectBrief(
        {
          ...empty,
          projects: [{ project: "valise", active_at: NOW, rollup_id: null }],
          ready: page([
            todo("r", { status: "Ready to start.", status_at: NOW - 9 }),
          ]),
          claimed: page([
            todo("c", {
              state: "claimed",
              last_update_summary: "Halfway.",
              last_update_at: NOW - 8,
              last_update_kind: "progress",
            }),
          ]),
          blocked: page([
            todo("b", { state: "blocked", blocked_on: "Waiting on review" }),
          ]),
          completed: page(
            [todo("d", { state: "done", completed_at: NOW - 1 })],
            true,
          ),
        },
        window,
      ),
    );
    expect(text).toContain("Projects worked on last (up to 3): valise.");
    expect(text).toContain("- todo:r [pending] To-do r · valise");
    expect(text).toContain(`  status ${NOW - 9}: Ready to start.`);
    expect(text).toContain("- todo:c [claimed] To-do c · valise");
    expect(text).toContain(`  last update ${NOW - 8}, progress: Halfway.`);
    expect(text).toContain("· blocker: Waiting on review");
    expect(text).toContain(
      "Completed (up to 5; more omitted, use list_todos):",
    );
  });

  it("stays within the hook budget and says what it left out", () => {
    const many = (prefix: string) =>
      page(
        Array.from({ length: BRIEF_TODOS }, (_, i) =>
          todo(`${prefix}${i}`, {
            title: "x".repeat(MAX_TITLE_LENGTH * 3),
            status: "y".repeat(MAX_TITLE_LENGTH * 3),
            status_at: NOW,
            blocked_on: "z".repeat(MAX_TITLE_LENGTH * 3),
          }),
        ),
      );
    const text = renderStartupBrief(
      selectBrief(
        {
          ...empty,
          projects: [{ project: "valise", active_at: NOW, rollup_id: null }],
          ready: many("r"),
          claimed: many("c"),
          blocked: many("b"),
          completed: many("d"),
        },
        window,
      ),
    );
    expect(text.length).toBeLessThanOrEqual(MAX_STARTUP_BRIEF_LENGTH);
    expect(
      text.endsWith(
        "\nAdditional items omitted to bound hook context; use get_brief for structured bounds and list_todos for task pages.",
      ),
    ).toBe(true);
    // The cut falls on a line boundary, never mid-line.
    expect(text.split("\n").at(-2)?.endsWith("…")).toBe(true);
  });
});
