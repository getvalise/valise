import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  EMPTY_HOOK_CONFIG,
  editHookConfig,
  type HookConfigEdit,
  hookEntries,
} from "../../app/concepts/hook-config";

/**
 * The console validates and writes the hook document in TypeScript; the hook
 * script parses it in plain Node. These run each document through both, so a
 * rule changed on one side and not the other fails here rather than as a hook
 * error on someone's machine.
 */

const SCRIPT = path.resolve(
  __dirname,
  "../../clients/valise/scripts/valise-hook.mjs",
);
const home = mkdtempSync(path.join(tmpdir(), "valise-parity-"));

afterAll(() => rmSync(home, { recursive: true, force: true }));

type PrintedEntry = {
  event: string;
  enabled: boolean;
  text: string;
  every_turns?: number;
};
type Printed = { entries: (PrintedEntry & { id?: string })[] };

function hookPrint(document: string): Promise<Printed | { error: string }> {
  const configPath = path.join(home, `${crypto.randomUUID()}.json`);
  writeFileSync(configPath, document, "utf8");
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [SCRIPT, "--print"],
      { env: { ...process.env, HOME: home, VALISE_CONFIG: configPath } },
      (error, stdout, stderr) => {
        resolve(error ? { error: stderr.trim() } : JSON.parse(stdout));
      },
    );
  });
}

function asPrinted(document: string): PrintedEntry[] {
  const read = hookEntries(document);
  if ("error" in read) throw new Error(read.error);
  return read.entries.map((entry) => ({
    event: entry.event,
    enabled: entry.enabled,
    text: entry.text,
    ...(entry.everyTurns === null ? {} : { every_turns: entry.everyTurns }),
  }));
}

function applyAll(edits: HookConfigEdit[]): string {
  let document = EMPTY_HOOK_CONFIG;
  for (const edit of edits) {
    const edited = editHookConfig(document, edit);
    if ("error" in edited) throw new Error(edited.error);
    document = edited.document;
  }
  return document;
}

describe("a document the console writes", () => {
  test.each([
    ["the empty document", []],
    [
      "edited shipped entries",
      [
        { kind: "text", id: "recall-reminder", text: "Search Valise first." },
        { kind: "enabled", id: "capture-nudge", enabled: false },
        { kind: "every-turns", id: "capture-nudge", everyTurns: 25 },
      ],
    ],
    [
      "custom entries on both events",
      [
        {
          kind: "add",
          event: "SessionStart",
          text: "Tag with priority:today.",
        },
        { kind: "add", event: "Stop", text: "Prefer plain words." },
        { kind: "every-turns", id: "custom-1", everyTurns: 4 },
        { kind: "enabled", id: "custom-0", enabled: false },
      ],
    ],
    [
      "the failed-command hook, shipped and custom",
      [
        { kind: "text", id: "recall-on-error", text: "Search on failure." },
        { kind: "enabled", id: "recall-on-error", enabled: false },
        {
          kind: "add",
          event: "PostToolUseFailure",
          text: "Name the command in the query.",
        },
        { kind: "enabled", id: "custom-0", enabled: false },
      ],
    ],
    [
      "a removal",
      [
        { kind: "add", event: "Stop", text: "First." },
        { kind: "add", event: "Stop", text: "Second." },
        { kind: "remove", id: "custom-0" },
      ],
    ],
  ] as [string, HookConfigEdit[]][])(
    "%s reads the same in the hook script",
    async (_, edits) => {
      const document = applyAll(edits);
      const printed = await hookPrint(document);
      expect("error" in printed ? printed.error : null).toBeNull();
      // --print names the shipped entries; the comparison is on what they inject.
      const injected = (printed as Printed).entries.map(
        ({ id: _id, ...entry }) => entry,
      );
      expect(injected).toEqual(asPrinted(document));
    },
  );

  test("going back to the shipped text drops the override", () => {
    const edited = applyAll([
      { kind: "text", id: "recall-reminder", text: "Custom." },
    ]);
    const read = hookEntries(edited);
    if ("error" in read) throw new Error(read.error);
    const shipped = read.entries[1]?.defaultText ?? "";
    expect(
      applyAll([
        { kind: "text", id: "recall-reminder", text: "Custom." },
        { kind: "text", id: "recall-reminder", text: shipped },
      ]),
    ).toBe("{}");
  });
});

describe("a document both sides refuse", () => {
  test.each([
    ["not JSON", "{"],
    ["an unknown key", '{"recal-reminder":{}}'],
    ["an unknown field", '{"capture-nudge":{"every":3}}'],
    ["empty text", '{"recall-reminder":{"text":""}}'],
    ["a zero cadence", '{"capture-nudge":{"every_turns":0}}'],
    [
      "a cadence on SessionStart",
      '{"custom":[{"event":"SessionStart","text":"x","every_turns":2}]}',
    ],
    [
      "a cadence on PostToolUseFailure",
      '{"custom":[{"event":"PostToolUseFailure","text":"x","every_turns":2}]}',
    ],
    [
      "too much PostToolUseFailure text",
      JSON.stringify({
        custom: Array.from({ length: 5 }, () => ({
          event: "PostToolUseFailure",
          text: "x".repeat(2000),
        })),
      }),
    ],
    [
      "too much Stop text",
      JSON.stringify({
        custom: Array.from({ length: 5 }, () => ({
          event: "Stop",
          text: "x".repeat(2000),
        })),
      }),
    ],
  ])("%s", async (_, document) => {
    const printed = await hookPrint(document);
    expect(printed).toHaveProperty("error");
    expect(hookEntries(document)).toHaveProperty("error");
  });

  test("an edit past the limits is refused before it is stored", () => {
    expect(
      editHookConfig(EMPTY_HOOK_CONFIG, {
        kind: "text",
        id: "recall-reminder",
        text: "x".repeat(2001),
      }),
    ).toHaveProperty("error");
    expect(
      editHookConfig(EMPTY_HOOK_CONFIG, {
        kind: "every-turns",
        id: "recall-reminder",
        everyTurns: 3,
      }),
    ).toHaveProperty("error");
    expect(
      editHookConfig(EMPTY_HOOK_CONFIG, {
        kind: "remove",
        id: "capture-nudge",
      }),
    ).toHaveProperty("error");
  });
});
