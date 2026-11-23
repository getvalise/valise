import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
// @ts-expect-error: a plain .mjs script with no declarations.
import { buildIndex, writeNotes } from "../../evals/index.mjs";

const SUITE = {
  cases: [
    { id: "memory-preference", tool: "save_memory", prompt: "Remember this." },
    { id: "todo-claim", tool: "claim_todo", prompt: "Claim it." },
  ],
};

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true });
});

function row(model: string, testCase: string, pass: boolean) {
  const expected = testCase === "todo-claim" ? "claim_todo" : "save_memory";
  return {
    model,
    case: testCase,
    expected,
    chose: pass ? expected : "search",
    route: [pass ? expected : "search"],
    toolMatch: pass,
    pass,
    error: null,
  };
}

/** Run files named by stamp, as the runner writes them. */
function runs(
  entries: Record<
    string,
    { rows: ReturnType<typeof row>[]; extra?: Record<string, unknown> }
  >,
) {
  const dir = mkdtempSync(path.join(tmpdir(), "valise-evals-"));
  dirs.push(dir);
  for (const [stamp, { rows, extra }] of Object.entries(entries)) {
    writeFileSync(
      path.join(dir, `${stamp}.json`),
      JSON.stringify({
        at: stamp,
        endpoint: "http://localhost/mcp",
        models: [...new Set(rows.map((each) => each.model))],
        toolNames: ["save_memory", "claim_todo", "search"],
        cases: SUITE.cases.filter((c) => rows.some((r) => r.case === c.id)),
        rows,
        ...extra,
      }),
    );
  }
  return dir;
}

describe("the evals index", () => {
  test("OpenCode and Claude Code keep distinct condition keys and labels", () => {
    const dir = runs({
      "2026-10-21T07-00-00": {
        rows: [
          row(
            "opencode+mcp/openrouter/openai/gpt-5.4-mini",
            "todo-claim",
            true,
          ),
        ],
        extra: { harness: { name: "opencode", version: "2.1.0" } },
      },
      "2026-10-21T07-01-00": {
        rows: [row("claude-code+mcp/haiku", "todo-claim", true)],
        extra: { harness: { name: "claude-code", version: "2.1.302" } },
      },
    });
    expect(
      buildIndex(dir, SUITE).conditions.map(
        ({ key, label }: { key: string; label: string }) => ({ key, label }),
      ),
    ).toEqual([
      { key: "opencode", label: "OpenCode" },
      { key: "claude-code", label: "Claude Code" },
    ]);
  });
  test("a case's newest result skips a dropped run and keeps models a focused rerun left out", () => {
    const dir = runs({
      "2026-10-18T10-00-00": {
        rows: [
          row("a/one", "memory-preference", true),
          row("b/two", "memory-preference", true),
          row("a/one", "todo-claim", false),
          row("b/two", "todo-claim", true),
        ],
      },
      // A trial that broke a cell and did not ship.
      "2026-10-18T11-00-00": {
        rows: [row("a/one", "memory-preference", false)],
      },
      // A focused rerun of one model on one case.
      "2026-10-18T12-00-00": { rows: [row("a/one", "todo-claim", true)] },
    });
    writeNotes(
      {
        "2026-10-18T11-00-00": { note: "trial wording", verdict: "dropped" },
        "2026-10-18T12-00-00": { note: "claim clause", verdict: "kept" },
      },
      dir,
    );

    const index = buildIndex(dir, SUITE);
    const plain = index.conditions.find(
      (each: { key: string }) => each.key === "plain",
    );

    expect(plain.cells["memory-preference"]["a/one"]).toMatchObject({
      pass: true,
      stamp: "2026-10-18T10-00-00",
    });
    expect(plain.cells["todo-claim"]["a/one"]).toMatchObject({
      pass: true,
      stamp: "2026-10-18T12-00-00",
      was: { stamp: "2026-10-18T10-00-00", passes: 0, n: 1 },
    });
    expect(plain.cells["todo-claim"]["b/two"].stamp).toBe(
      "2026-10-18T10-00-00",
    );
    // The summary is over those newest cells, one row each.
    expect(
      plain.summary.find((r: { model: string }) => r.model === "a/one"),
    ).toMatchObject({ total: 2, argsValid: 2 });

    // The dropped run stays in the case's history, with its verdict.
    const trail = index.history["memory-preference"];
    expect(
      trail.entries.map((entry: { stamp: string }) => entry.stamp),
    ).toEqual(["2026-10-18T11-00-00", "2026-10-18T10-00-00"]);
    expect(index.runs[1]).toMatchObject({
      stamp: "2026-10-18T11-00-00",
      verdict: "dropped",
      note: "trial wording",
    });
  });

  test("rival tools are a condition of their own and never overwrite a plain cell", () => {
    const dir = runs({
      "2026-10-18T10-00-00": {
        rows: [row("a/one", "memory-preference", true)],
      },
      "2026-10-18T11-00-00": {
        rows: [row("a/one", "memory-preference", false)],
        extra: { distractors: { count: 20, hash: "x", names: [] } },
      },
    });
    const index = buildIndex(dir, SUITE);
    const byKey = Object.fromEntries(
      index.conditions.map((each: { key: string }) => [each.key, each]),
    );
    expect(byKey.plain.cells["memory-preference"]["a/one"].pass).toBe(true);
    expect(byKey["rivals-20"].cells["memory-preference"]["a/one"].pass).toBe(
      false,
    );
  });

  test("a history entry names the tool whose description changed", () => {
    const dir = runs({
      "2026-10-18T10-00-00": {
        rows: [row("a/one", "memory-preference", false)],
        extra: { toolHashes: { save_memory: "aaa", search: "sss" } },
      },
      "2026-10-18T11-00-00": {
        rows: [row("a/one", "memory-preference", true)],
        extra: { toolHashes: { save_memory: "bbb", search: "sss" } },
      },
    });
    const [newest, oldest] = buildIndex(dir, SUITE).history["memory-preference"]
      .entries;
    expect(newest).toMatchObject({
      changedTools: ["save_memory"],
      otherTools: 0,
      marks: [[1, 1]],
    });
    expect(oldest.changedTools).toEqual([]);
  });
});
