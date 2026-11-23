import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";

const SCRIPT = path.resolve(
  __dirname,
  "../../clients/valise/scripts/valise-hook.mjs",
);

const CAPTURE_NUDGE_TEXT =
  "If this session produced a decision, insight, or dead end another session " +
  "would pay to rediscover, and Valise's save_memory tool is available, save " +
  "it following the capture-this skill. Leave unfinished work as a to-do " +
  "whose next step copies identifiers, paths and values exactly as the user " +
  "or a tool gave them; never invent a command. If nothing new came up or " +
  "it is already saved, saving nothing is fine: stop.";

const RECALL_REMINDER_TEXT =
  "Valise is connected. Before re-deriving prior work, search it for " +
  "decisions and skills. When a command fails with an error the message " +
  "itself does not explain how to fix, search Valise for the error text " +
  "before trying something else. When you leave work for another session, " +
  "name its next step with identifiers, file paths and values exactly as " +
  "the user or a tool gave them. Never invent a command nobody gave.";

const RECALL_ON_ERROR_TEXT =
  "This command failed. Unless the error is a typo in the command you just " +
  "ran, search Valise for the error text before trying something else; a " +
  "stored memory may explain it.";

/** What SessionStart adds when the directory names no project. */
const BRIEF_TEXT =
  "Call Valise's get_brief before starting work, for recent projects, " +
  "ready to-dos, claims and changed memories.";

const STARTUP_TEXT = `${RECALL_REMINDER_TEXT}\n\n${BRIEF_TEXT}`;

function projectLine(project: string) {
  return (
    `This directory is Valise project "${project}". Call get_brief with ` +
    `project "${project}" before starting work, for its ready to-dos, ` +
    "claims and changed memories. If it says nothing is filed under that " +
    "project, ask the user which project this is."
  );
}

type Run = { stdout: string; stderr: string; code: number };

function run(
  args: string[],
  stdin: string,
  env: NodeJS.ProcessEnv,
): Promise<Run> {
  return new Promise((resolve) => {
    const child = execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env },
      (error, stdout, stderr) => {
        const code = error
          ? typeof error.code === "number"
            ? error.code
            : 1
          : 0;
        resolve({ stdout, stderr, code });
      },
    );
    child.stdin?.end(stdin);
  });
}

function sessionStartPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/nonexistent/valise-hook-test/transcript.jsonl",
    cwd: "/tmp",
    hook_event_name: "SessionStart",
    source: "startup",
    ...overrides,
  });
}

function stopPayload(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    session_id: "sess-1",
    transcript_path: "/nonexistent/valise-hook-test/transcript.jsonl",
    cwd: "/tmp",
    hook_event_name: "Stop",
    stop_hook_active: false,
    ...overrides,
  });
}

const dirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "valise-hook-test-"));
  dirs.push(dir);
  return dir;
}

function writeConfig(dir: string, content: string): string {
  const file = path.join(dir, "config.json");
  writeFileSync(file, content, "utf8");
  return file;
}

function envFor(home: string, configPath?: string): NodeJS.ProcessEnv {
  // HOME too, so the real ~/.valise never reaches a test.
  const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: home, HOME: home };
  delete env.VALISE_TOKEN;
  delete env.VALISE_MCP_URL;
  if (configPath) env.VALISE_CONFIG = configPath;
  else env.VALISE_CONFIG = path.join(home, "missing-config.json");
  return env;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop();
    if (dir) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort cleanup only
      }
    }
  }
});

describe("SessionStart", () => {
  test("emits the recall reminder for source=startup", async () => {
    const home = makeTempDir();
    const result = await run(
      [],
      sessionStartPayload({ source: "startup" }),
      envFor(home),
    );
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: STARTUP_TEXT,
      },
    });
  });

  test("stays silent for source=compact", async () => {
    const home = makeTempDir();
    const result = await run(
      [],
      sessionStartPayload({ source: "compact" }),
      envFor(home),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("injects for a Codex-shaped payload with source absent", async () => {
    const home = makeTempDir();
    const result = await run(
      [],
      sessionStartPayload({ source: undefined }),
      envFor(home),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).hookSpecificOutput.additionalContext).toBe(
      STARTUP_TEXT,
    );
  });

  test("recall-reminder enabled:false silences the injection", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({ "recall-reminder": { enabled: false } }),
    );
    const result = await run(
      [],
      sessionStartPayload({ source: "startup" }),
      envFor(home, configPath),
    );
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });
});

describe("Stop cadence", () => {
  test("nudges at turn 1, is silent through turn 9, nudges at turn 10, and is silent at turn 11", async () => {
    const home = makeTempDir();
    const env = envFor(home);
    const first = await run([], stopPayload(), env);
    expect(first.code).toBe(0);
    expect(JSON.parse(first.stdout)).toEqual({
      decision: "block",
      reason: CAPTURE_NUDGE_TEXT,
    });
    for (let turn = 2; turn <= 9; turn++) {
      const result = await run([], stopPayload(), env);
      expect(result.code).toBe(0);
      expect(result.stdout).toBe("");
    }
    const tenth = await run([], stopPayload(), env);
    expect(tenth.code).toBe(0);
    expect(JSON.parse(tenth.stdout)).toEqual({
      decision: "block",
      reason: CAPTURE_NUDGE_TEXT,
    });
    const eleventh = await run([], stopPayload(), env);
    expect(eleventh.code).toBe(0);
    expect(eleventh.stdout).toBe("");
  });

  test("capture-nudge enabled:false silences the nudge at the cadence turn", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({ "capture-nudge": { enabled: false, every_turns: 1 } }),
    );
    const env = envFor(home, configPath);
    const result = await run([], stopPayload(), env);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("custom text and every_turns are honored", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({
        "capture-nudge": { every_turns: 3, text: "Save it, friend." },
      }),
    );
    const env = envFor(home, configPath);
    const nudge = { decision: "block", reason: "Save it, friend." };
    const first = await run([], stopPayload(), env);
    expect(JSON.parse(first.stdout)).toEqual(nudge);
    const second = await run([], stopPayload(), env);
    expect(second.stdout).toBe("");
    const third = await run([], stopPayload(), env);
    expect(JSON.parse(third.stdout)).toEqual(nudge);
  });

  test("stop_hook_active true stays silent and does not advance the counter", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({ "capture-nudge": { every_turns: 3 } }),
    );
    const env = envFor(home, configPath);

    const replay = await run([], stopPayload({ stop_hook_active: true }), env);
    expect(replay.code).toBe(0);
    expect(replay.stdout).toBe("");
    expect(replay.stderr).toBe("");

    const turnOne = await run([], stopPayload(), env);
    expect(JSON.parse(turnOne.stdout).decision).toBe("block");

    const turnTwo = await run([], stopPayload(), env);
    expect(turnTwo.stdout).toBe("");

    const turnThree = await run([], stopPayload(), env);
    expect(JSON.parse(turnThree.stdout).decision).toBe("block");
  });

  test("asks only when the stretch since the last due turn used tools and saved nothing", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({ "capture-nudge": { every_turns: 1 } }),
    );
    const env = envFor(home, configPath);
    const transcript = path.join(home, "transcript.jsonl");
    const stop = () =>
      run([], stopPayload({ transcript_path: transcript }), env);
    const append = (...records: unknown[]) =>
      writeFileSync(
        transcript,
        records.map((r) => `${JSON.stringify(r)}\n`).join(""),
        { flag: "a" },
      );
    const toolUse = (name: string) => ({
      type: "assistant",
      message: { content: [{ type: "tool_use", id: "t", name, input: {} }] },
    });

    // Conversation only: nothing new to save.
    append({ type: "user", message: { content: "What is 17 times 23?" } });
    expect((await stop()).stdout).toBe("");

    // Work that already wrote back to Valise: asking again breeds noise.
    append(toolUse("Bash"), toolUse("mcp__plugin_valise_valise__save_memory"));
    expect((await stop()).stdout).toBe("");

    // The window moved on: new work since, and nothing saved in it.
    append(toolUse("Edit"));
    expect(JSON.parse((await stop()).stdout)).toEqual({
      decision: "block",
      reason: CAPTURE_NUDGE_TEXT,
    });

    // A Codex rollout names its calls function_call.
    append({
      type: "response_item",
      payload: { type: "function_call", name: "shell", arguments: "{}" },
    });
    expect(JSON.parse((await stop()).stdout).decision).toBe("block");
    append({
      type: "response_item",
      payload: { type: "function_call", name: "mcp__valise__update_todo" },
    });
    expect((await stop()).stdout).toBe("");
  });

  test("an unreadable transcript leaves the cadence alone", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({ "capture-nudge": { every_turns: 1 } }),
    );
    const result = await run(
      [],
      stopPayload({ transcript_path: path.join(home, "missing.jsonl") }),
      envFor(home, configPath),
    );
    expect(JSON.parse(result.stdout).decision).toBe("block");
  });

  test("an unwritable counter directory emits no block and one stderr line", async () => {
    const isRoot =
      typeof process.getuid === "function" && process.getuid() === 0;
    if (isRoot) return; // root bypasses directory permission bits; nothing to degrade

    const home = makeTempDir();
    const counterDir = path.join(home, "valise");
    mkdirSync(counterDir, { recursive: true });
    chmodSync(counterDir, 0o500);

    const result = await run([], stopPayload(), envFor(home));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);

    chmodSync(counterDir, 0o700);
  });
});

describe("config validation", () => {
  const cases: Array<[string, string]> = [
    [
      "unknown config key",
      JSON.stringify({ "capture-ndge": { enabled: false } }),
    ],
    [
      "non-boolean enabled",
      JSON.stringify({ "capture-nudge": { enabled: "yes" } }),
    ],
    [
      "over-length text",
      JSON.stringify({ "capture-nudge": { text: "x".repeat(2001) } }),
    ],
    ["malformed JSON", "{ not json"],
  ];

  for (const [name, content] of cases) {
    test(`${name} exits 1 with one stderr line and empty stdout`, async () => {
      const home = makeTempDir();
      const configPath = writeConfig(home, content);
      const result = await run(
        [],
        sessionStartPayload(),
        envFor(home, configPath),
      );
      expect(result.code).toBe(1);
      expect(result.stdout).toBe("");
      const lines = result.stderr.trim().split("\n").filter(Boolean);
      expect(lines).toHaveLength(1);
    });
  }
});

describe("custom entries", () => {
  test("a due Stop custom entry joins after capture-nudge on the first turn", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({
        "capture-nudge": { every_turns: 1 },
        custom: [{ event: "Stop", text: "Also check for lemons." }],
      }),
    );
    const result = await run([], stopPayload(), envFor(home, configPath));
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      decision: "block",
      reason: `${CAPTURE_NUDGE_TEXT}\n\nAlso check for lemons.`,
    });
  });

  test("a SessionStart custom entry joins after the recall reminder", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({
        custom: [{ event: "SessionStart", text: "Also check the backlog." }],
      }),
    );
    const result = await run(
      [],
      sessionStartPayload({ source: "startup" }),
      envFor(home, configPath),
    );
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `${STARTUP_TEXT}\n\nAlso check the backlog.`,
      },
    });
  });

  test("a disabled custom entry stays silent alongside a disabled shipped entry", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({
        "capture-nudge": { enabled: false },
        custom: [
          {
            event: "Stop",
            every_turns: 1,
            text: "Never fires.",
            enabled: false,
          },
        ],
      }),
    );
    const result = await run([], stopPayload(), envFor(home, configPath));
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("");
  });

  test("a custom entry missing text exits 1 with one stderr line", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({ custom: [{ event: "Stop" }] }),
    );
    const result = await run(
      [],
      sessionStartPayload(),
      envFor(home, configPath),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test("a custom entry with a bad-case event exits 1 with one stderr line", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({
        custom: [{ event: "sessionstart", text: "Lowercase event." }],
      }),
    );
    const result = await run(
      [],
      sessionStartPayload(),
      envFor(home, configPath),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test("every_turns on a SessionStart custom entry exits 1 with one stderr line", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({
        custom: [
          { event: "SessionStart", text: "Not allowed.", every_turns: 2 },
        ],
      }),
    );
    const result = await run(
      [],
      sessionStartPayload(),
      envFor(home, configPath),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  test("custom entries that push the combined Stop text over 8000 chars exit 1", async () => {
    const home = makeTempDir();
    // capture-nudge's default text (200 chars) plus four 2000-char custom
    // entries (each under the 2000-char per-entry cap) sums past 8000.
    const configPath = writeConfig(
      home,
      JSON.stringify({
        custom: [
          { event: "Stop", text: "x".repeat(2000) },
          { event: "Stop", text: "x".repeat(2000) },
          { event: "Stop", text: "x".repeat(2000) },
          { event: "Stop", text: "x".repeat(2000) },
        ],
      }),
    );
    const result = await run(
      [],
      sessionStartPayload(),
      envFor(home, configPath),
    );
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    const lines = result.stderr.trim().split("\n").filter(Boolean);
    expect(lines).toHaveLength(1);
  });
});

describe("--print", () => {
  test("writes the merged effective config without reading stdin", async () => {
    const home = makeTempDir();
    const configPath = path.join(home, "missing-config.json");
    const result = await run(["--print"], "", envFor(home, configPath));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.configPath).toBe(configPath);
    expect(parsed.entries).toEqual([
      {
        id: "capture-nudge",
        event: "Stop",
        enabled: true,
        text: CAPTURE_NUDGE_TEXT,
        every_turns: 10,
      },
      {
        id: "recall-reminder",
        event: "SessionStart",
        enabled: true,
        text: RECALL_REMINDER_TEXT,
      },
      {
        id: "recall-on-error",
        event: "PostToolUseFailure",
        enabled: true,
        text: RECALL_ON_ERROR_TEXT,
      },
    ]);
  });

  test("includes a custom entry's shape after the shipped entries", async () => {
    const home = makeTempDir();
    const configPath = writeConfig(
      home,
      JSON.stringify({
        custom: [{ event: "Stop", every_turns: 1, text: "Check for lemons." }],
      }),
    );
    const result = await run(["--print"], "", envFor(home, configPath));
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.entries).toContainEqual({
      event: "Stop",
      enabled: true,
      text: "Check for lemons.",
      every_turns: 1,
    });
  });
});

describe("SessionStart names the project, offline", () => {
  /** A checkout whose origin names the repository `valise`. */
  function checkout(home: string): string {
    const dir = path.join(home, "work", "valise-wt");
    mkdirSync(dir, { recursive: true });
    for (const args of [
      ["init", "-q"],
      ["remote", "add", "origin", "git@github.com:someone/valise.git"],
    ]) {
      execFileSync("git", ["-C", dir, ...args]);
    }
    return dir;
  }

  const context = (result: Run) =>
    result.stdout === ""
      ? ""
      : JSON.parse(result.stdout).hookSpecificOutput.additionalContext;

  test("a new session is told to call get_brief with the remote's repository name", async () => {
    const home = makeTempDir();
    const cwd = checkout(home);
    const result = await run([], sessionStartPayload({ cwd }), envFor(home));
    expect(result.stderr).toBe("");
    expect(context(result)).toBe(
      `${RECALL_REMINDER_TEXT}\n\n${projectLine("valise")}`,
    );
  });

  test("a committed .valise.json at the repository root wins over the remote, from any subdirectory", async () => {
    const home = makeTempDir();
    const cwd = checkout(home);
    writeFileSync(
      path.join(cwd, ".valise.json"),
      JSON.stringify({ project: "luggage" }),
    );
    const sub = path.join(cwd, "app");
    mkdirSync(sub);
    const result = await run(
      [],
      sessionStartPayload({ cwd: sub }),
      envFor(home),
    );
    expect(context(result)).toContain(projectLine("luggage"));

    // A file that names no project leaves the remote to decide.
    writeFileSync(path.join(cwd, ".valise.json"), "{ not json");
    expect(
      context(await run([], sessionStartPayload({ cwd }), envFor(home))),
    ).toContain(projectLine("valise"));
  });

  test("outside git, a .valise.json in the directory names the project", async () => {
    const home = makeTempDir();
    const cwd = path.join(home, "plain");
    mkdirSync(cwd);
    writeFileSync(
      path.join(cwd, ".valise.json"),
      JSON.stringify({ project: "notes" }),
    );
    expect(
      context(await run([], sessionStartPayload({ cwd }), envFor(home))),
    ).toContain(projectLine("notes"));
  });

  test("resume points at get_brief's claimed section and makes no call", async () => {
    const home = makeTempDir();
    const cwd = checkout(home);
    const result = await run(
      [],
      sessionStartPayload({ cwd, source: "resume" }),
      // An unroutable origin: a hook that tried the network would fail here.
      { ...envFor(home), VALISE_MCP_URL: "http://127.0.0.1:9/mcp" },
    );
    expect(context(result)).toBe(
      'This session resumed. If it held a Valise to-do, get_brief with project "valise" lists it under claimed; fetch it for its fencing token before continuing.',
    );
    const off = writeConfig(
      home,
      JSON.stringify({ "recall-reminder": { enabled: false } }),
    );
    expect(
      (
        await run(
          [],
          sessionStartPayload({ cwd, source: "resume" }),
          envFor(home, off),
        )
      ).stdout,
    ).toBe("");
  });

  test("a failed command is left to the mcp_tool hook", async () => {
    const home = makeTempDir();
    const result = await run(
      [],
      JSON.stringify({
        session_id: "sess-1",
        cwd: "/tmp",
        hook_event_name: "PostToolUseFailure",
        tool_name: "Bash",
        error: "Exit code 1\nX Pull request #91 is not mergeable",
      }),
      envFor(home),
    );
    expect(result).toEqual({ stdout: "", stderr: "", code: 0 });
  });

  test("projectFromRemote reads the repository name from either remote form", async () => {
    const { projectFromRemote } = await import(SCRIPT);
    expect(projectFromRemote("git@github.com:someone/valise.git\n")).toBe(
      "valise",
    );
    expect(projectFromRemote("https://github.com/someone/valise")).toBe(
      "valise",
    );
    expect(projectFromRemote("")).toBe(null);
  });

  test("projectFromFile reads a trimmed project and refuses anything else", async () => {
    const { projectFromFile } = await import(SCRIPT);
    expect(projectFromFile('{ "project": " valise " }')).toBe("valise");
    expect(projectFromFile('{ "project": "" }')).toBe(null);
    expect(projectFromFile('{ "project": 3 }')).toBe(null);
    expect(projectFromFile(`{ "project": "${"x".repeat(201)}" }`)).toBe(null);
    expect(projectFromFile("[]")).toBe(null);
    expect(projectFromFile("nope")).toBe(null);
  });
});
