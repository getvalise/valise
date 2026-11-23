import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * The Valise CLI's pure parts and its proxy, off the network: the distillers
 * over each client's record shapes, the resume handshake against a fake
 * server, the config file's mode, and the proxy forwarding a streamed
 * response while sending the session's turns on the side.
 */

const cli = (file: string) => import(`../../clients/valise-cli/${file}`);

describe("distillation", () => {
  it("keeps human, assistant, tool calls and tool errors from a Claude Code transcript", async () => {
    const { distillClaudeCode } = await cli("distill.mjs");
    const lines = [
      { type: "mode", sessionId: "s1" },
      {
        type: "user",
        sessionId: "s1",
        cwd: "/w/valise",
        gitBranch: "main",
        timestamp: "2026-11-05T10:00:00Z",
        message: {
          role: "user",
          content:
            "<system-reminder>Today is Thursday</system-reminder>\nFix the hedgerow flake",
        },
      },
      {
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-11-05T10:00:05Z",
        message: {
          role: "assistant",
          model: "claude-fable-5-1",
          content: [
            { type: "thinking", thinking: "Check the flaky spec first" },
            { type: "thinking", thinking: "", signature: "sig" },
            {
              type: "tool_use",
              id: "t1",
              name: "Bash",
              input: { command: "npm test", description: "Run tests" },
            },
          ],
        },
      },
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-11-05T10:00:09Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "FAIL\nexit 1",
              is_error: true,
            },
          ],
        },
      },
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-11-05T10:00:09Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t1",
              content: "FAIL\nexit 1",
              is_error: true,
            },
          ],
        },
      },
      {
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-11-05T10:00:12Z",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "t2",
              name: "Read",
              input: { file_path: "/w/valise/a.ts" },
            },
          ],
        },
      },
      {
        type: "user",
        sessionId: "s1",
        isSidechain: true,
        message: { role: "user", content: "subagent chatter" },
      },
      {
        type: "user",
        sessionId: "s1",
        timestamp: "2026-11-05T10:00:14Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "t2",
              content: "file text",
              is_error: false,
            },
          ],
        },
      },
      {
        type: "assistant",
        sessionId: "s1",
        timestamp: "2026-11-05T10:00:20Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "The brief straddles a second." }],
        },
      },
      "not json",
    ].map((r) => (typeof r === "string" ? r : JSON.stringify(r)));
    const result = distillClaudeCode(lines);
    expect(result).toMatchObject({
      sessionId: "s1",
      cwd: "/w/valise",
      gitBranch: "main",
      model: "claude-fable-5-1",
    });
    expect(
      result.turns.map(
        (t: { kind: string; tool_name: string | null; text: string }) => [
          t.kind,
          t.tool_name,
          t.text,
        ],
      ),
    ).toEqual([
      ["human", null, "Fix the hedgerow flake"],
      // The reminder leaves the prompt and follows it as system text.
      ["system", "Reminder", "Today is Thursday"],
      ["thinking", null, "Check the flaky spec first"],
      ["tool_call", "Bash", "command: npm test"],
      ["tool_error", "Bash", "FAIL\nexit 1"],
      ["tool_call", "Read", "file_path: /w/valise/a.ts"],
      ["assistant", null, "The brief straddles a second."],
    ]);
    expect(result.turns[0].at).toBe(Date.parse("2026-11-05T10:00:00Z") / 1000);
  });

  it("sends a blocking Stop hook as the feedback the model saw", async () => {
    const { distillClaudeCode } = await cli("distill.mjs");
    const result = distillClaudeCode(
      [
        {
          type: "assistant",
          timestamp: "2026-11-05T10:00:00Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Done." }],
          },
        },
        {
          type: "user",
          isMeta: true,
          timestamp: "2026-11-05T10:00:01Z",
          message: { role: "user", content: "Stop hook feedback:\nSave it" },
        },
        {
          type: "attachment",
          timestamp: "2026-11-05T10:00:01Z",
          attachment: {
            type: "hook_blocking_error",
            hookEvent: "Stop",
            hookName: "Stop",
            blockingError: { blockingError: "Save it", command: "hook.mjs" },
          },
        },
        {
          type: "attachment",
          attachment: {
            type: "hook_blocking_error",
            hookEvent: "PreToolUse",
            blockingError: { blockingError: "No" },
          },
        },
        {
          type: "assistant",
          timestamp: "2026-11-05T10:00:05Z",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Nothing to save." }],
          },
        },
      ].map((r) => JSON.stringify(r)),
    );
    expect(
      result.turns.map((t: { kind: string; text: string }) => [t.kind, t.text]),
    ).toEqual([
      ["assistant", "Done."],
      ["human", "Stop hook feedback:\nSave it"],
      ["assistant", "Nothing to save."],
    ]);
  });

  it("sends what the client put in front of the model as system turns, each text once", async () => {
    const { distillClaudeCode } = await cli("distill.mjs");
    const agents = {
      path: "/w/valise/AGENTS.md",
      type: "Project",
      content: "# Working in this repo",
    };
    const result = distillClaudeCode(
      [
        {
          type: "attachment",
          attachment: {
            type: "hook_additional_context",
            content: ["Valise is connected."],
          },
        },
        {
          type: "user",
          message: { role: "user", content: "Fix the hedgerow flake" },
        },
        {
          type: "attachment",
          attachment: { type: "instructions", files: [agents] },
        },
        {
          type: "attachment",
          attachment: {
            type: "prompt_snapshot",
            systemPrompt: [
              "You are an agent.",
              "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__",
              "# Environment",
            ],
            tools: [{ name: "Bash", description: "Runs a command" }],
          },
        },
        // Bookkeeping and tool definitions are not prompts.
        {
          type: "attachment",
          attachment: { type: "credential_org", organizationUuid: "o1" },
        },
        {
          type: "attachment",
          attachment: {
            type: "deferred_tools_record",
            entries: [{ name: "WebSearch" }],
          },
        },
        {
          type: "attachment",
          attachment: {
            type: "total_tokens_reminder",
            text: "<total_tokens>9</total_tokens>",
          },
        },
        // The client re-sends its instructions; Valise keeps them once.
        {
          type: "attachment",
          attachment: { type: "instructions", files: [agents] },
        },
        {
          type: "user",
          isMeta: true,
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: "Base directory for this skill: /s/tdd\n\n# TDD",
              },
            ],
          },
        },
        {
          type: "user",
          isMeta: true,
          message: { role: "user", content: "[Image: original 1280x3400]" },
        },
        {
          type: "user",
          message: {
            role: "user",
            content: [
              { type: "tool_result", tool_use_id: "t1", content: "ok" },
              {
                type: "text",
                text: "<system-reminder>\nThe date changed.\n</system-reminder>",
              },
            ],
          },
        },
        {
          type: "assistant",
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Fixed." }],
          },
        },
      ].map((r) => JSON.stringify(r)),
    );
    expect(
      result.turns.map(
        (t: { kind: string; tool_name: string | null; text: string }) => [
          t.kind,
          t.tool_name,
          t.text,
        ],
      ),
    ).toEqual([
      ["system", "Hook context", "Valise is connected."],
      ["human", null, "Fix the hedgerow flake"],
      ["system", "/w/valise/AGENTS.md", "# Working in this repo"],
      ["system", "System prompt", "You are an agent.\n\n# Environment"],
      ["system", "Skill", "Base directory for this skill: /s/tdd\n\n# TDD"],
      ["system", "Reminder", "The date changed."],
      ["assistant", null, "Fixed."],
    ]);
  });

  it("sends Codex instructions and developer messages as system turns", async () => {
    const { distillCodex } = await cli("distill.mjs");
    const codex = distillCodex(
      [
        {
          type: "session_meta",
          payload: { id: "c1", instructions: "You are Codex." },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "developer",
            content: [{ type: "input_text", text: "Sandbox: workspace-write" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<user_instructions>Use pnpm</user_instructions>",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "hello" }],
          },
        },
      ].map((r) => JSON.stringify(r)),
    );
    expect(
      codex.turns.map((t: { kind: string; tool_name: string | null }) => [
        t.kind,
        t.tool_name,
      ]),
    ).toEqual([
      ["system", "System prompt"],
      ["system", "Developer instructions"],
      ["system", "Instructions"],
      ["human", null],
    ]);
  });

  it("reads OpenCode rows and Codex items", async () => {
    const { distillOpenCode, distillCodex } = await cli("distill.mjs");
    const open = distillOpenCode([
      {
        type: "user",
        data: JSON.stringify({
          text: "set my model",
          time: { created: 1792595159383 },
        }),
      },
      {
        type: "assistant",
        data: JSON.stringify({
          model: { id: "gpt-6-luna" },
          time: { created: 1792595159399 },
          content: [
            { type: "reasoning", text: "Find the model setting" },
            { type: "reasoning", text: "  " },
            {
              type: "tool",
              name: "skill",
              state: { status: "completed", input: { id: "opencode" } },
            },
            {
              type: "tool",
              name: "bash",
              state: {
                status: "error",
                input: { command: "ls /nope" },
                error: "No such file",
              },
            },
            { type: "text", text: "Done." },
          ],
        }),
      },
      {
        // The older name for the same list still reads.
        type: "assistant",
        data: JSON.stringify({
          time: { created: 1792595159400 },
          parts: [{ type: "text", text: "Also done." }],
        }),
      },
      {
        type: "idle",
        data: JSON.stringify({
          outcome: "failed",
          error: { type: "provider.invalid-request", message: "model unknown" },
          time: { created: 1793096227716 },
        }),
      },
    ]);
    expect(open.model).toBe("gpt-6-luna");
    expect(
      open.turns.map(
        (t: { kind: string; tool_name: string | null; text: string }) => [
          t.kind,
          t.tool_name,
          t.text,
        ],
      ),
    ).toEqual([
      ["human", null, "set my model"],
      ["thinking", null, "Find the model setting"],
      ["tool_call", "skill", "id: opencode"],
      ["tool_call", "bash", "command: ls /nope"],
      ["tool_error", "bash", "No such file"],
      ["assistant", null, "Done."],
      ["assistant", null, "Also done."],
      ["api_error", null, "provider.invalid-request: model unknown"],
    ]);
    expect(open.turns[0].at).toBe(1792595159);

    const codex = distillCodex([
      JSON.stringify({
        type: "session_meta",
        payload: { id: "cx1", cwd: "/w/app", model: "gpt-6" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-11-05T10:00:00Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hello" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "reasoning",
          summary: [{ type: "summary_text", text: "List the files" }],
          encrypted_content: "opaque",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: { type: "reasoning", summary: [], encrypted_content: "x" },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "shell",
          arguments: '{"command":["ls"]}',
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "hi" }],
        },
      }),
    ]);
    expect(codex).toMatchObject({
      sessionId: "cx1",
      cwd: "/w/app",
      model: "gpt-6",
    });
    expect(
      codex.turns.map((t: { kind: string; text: string }) => [t.kind, t.text]),
    ).toEqual([
      ["human", "hello"],
      ["thinking", "List the files"],
      ["tool_call", "command: ls"],
      ["assistant", "hi"],
    ]);
  });
});

describe("resume handshake", () => {
  const turns = [
    { kind: "human", text: "a", tool_name: null, at: null },
    { kind: "assistant", text: "b", tool_name: null, at: null },
    { kind: "human", text: "c", tool_name: null, at: null },
  ];
  it("hashes like the server, finds the common prefix, and resends after a 409", async () => {
    const { turnHash, commonPrefix, pushTurns } = await cli("sync.mjs");
    const hashes = turns.map(turnHash);
    expect(hashes[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(commonPrefix(turns, hashes.slice(0, 2))).toBe(2);
    expect(commonPrefix(turns, [hashes[0], "x"])).toBe(1);

    const posts: { from: number; turns: unknown[] }[] = [];
    const api = {
      get: async () => ({ turn_count: 2, hashes: hashes.slice(0, 2) }),
      post: async (body: { from: number; turns: unknown[] }) => {
        posts.push(body);
        return posts.length === 1
          ? { status: 409, body: { turn_count: 1, hashes: hashes.slice(0, 1) } }
          : { status: 200, body: { appended: body.turns.length } };
      },
    };
    const result = await pushTurns(
      api,
      { client: "c", device: "d", session_id: "s" },
      turns,
    );
    expect(posts.map((p) => [p.from, p.turns.length])).toEqual([
      [2, 1],
      [1, 2],
    ]);
    expect(result.body.appended).toBe(2);

    const held = await pushTurns(
      {
        get: async () => ({ turn_count: 3, hashes }),
        post: async () => {
          throw new Error("must not post");
        },
      },
      { client: "c", device: "d", session_id: "s" },
      turns,
    );
    expect(held.skipped).toBe(true);
  });

  it("replaces Valise's tail when its history differs partway, as after a distiller update", async () => {
    const { turnHash, pushTurns } = await cli("sync.mjs");
    // Valise holds a, c: an older distiller dropped b.
    const old = [turns[0], turns[2]].map(turnHash);
    const posts: { from: number; replace?: boolean; turns: unknown[] }[] = [];
    const result = await pushTurns(
      {
        get: async () => ({ turn_count: 2, hashes: old }),
        post: async (body: { from: number; turns: unknown[] }) => {
          posts.push(body);
          return { status: 200, body: { appended: body.turns.length } };
        },
      },
      { client: "c", device: "d", session_id: "s" },
      turns,
    );
    expect(posts).toEqual([
      expect.objectContaining({ from: 1, replace: true }),
    ]);
    expect(posts[0].turns).toHaveLength(2);
    expect(result.body.appended).toBe(2);

    // Known position, no state read: the 409 says how far they agree.
    const after409: { from: number; replace?: boolean }[] = [];
    await pushTurns(
      {
        get: async () => {
          throw new Error("must not read");
        },
        post: async (body: { from: number; replace?: boolean }) => {
          after409.push(body);
          return after409.length === 1
            ? { status: 409, body: { turn_count: 2, hashes: old } }
            : { status: 200, body: { appended: 2 } };
        },
      },
      { client: "c", device: "d", session_id: "s" },
      turns,
      { from: 2 },
    );
    expect(after409.map((p) => [p.from, p.replace ?? false])).toEqual([
      [2, false],
      [1, true],
    ]);
  });
});

describe("config", () => {
  const previous = process.env.VALISE_HOME;
  afterEach(() => {
    if (previous === undefined) delete process.env.VALISE_HOME;
    else process.env.VALISE_HOME = previous;
  });
  it("writes a 0600 file", async () => {
    process.env.VALISE_HOME = mkdtempSync(path.join(tmpdir(), "valise-cli-"));
    const { readConfig, writeConfig, configPath } = await cli("config.mjs");
    writeConfig(readConfig());
    expect(statSync(configPath()).mode & 0o777).toBe(0o600);
  });
});

/** A Claude Code session file with `n` human turns, under `<root>/<dir>/`. */
function claudeSession(root: string, id: string, n: number, cwd = "/nowhere") {
  const dir = path.join(root, "-w-proj");
  mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  const lines = Array.from({ length: n }, (_, i) =>
    JSON.stringify({
      type: "user",
      sessionId: id,
      cwd,
      timestamp: `2026-11-06T10:00:0${i}Z`,
      message: { role: "user", content: `message ${i}` },
    }),
  );
  writeFileSync(file, `${lines.join("\n")}\n`);
  return file;
}

/** A fake Valise that holds whatever it is sent. */
function fakeValise() {
  const held = new Map<string, unknown[]>();
  const posts: Record<string, unknown>[] = [];
  const gets: string[] = [];
  return {
    held,
    posts,
    gets,
    api: {
      get: async (s: { session_id: string }) => {
        gets.push(s.session_id);
        const turns = held.get(s.session_id);
        if (!turns) return null;
        const { turnHash } = await cli("sync.mjs");
        return { turn_count: turns.length, hashes: turns.map(turnHash) };
      },
      post: async (body: Record<string, unknown>) => {
        posts.push(body);
        const turns = held.get(body.session_id as string) ?? [];
        if (body.from !== turns.length) {
          const { turnHash } = await cli("sync.mjs");
          return { status: 409, body: { hashes: turns.map(turnHash) } };
        }
        held.set(body.session_id as string, [
          ...turns,
          ...(body.turns as unknown[]),
        ]);
        return { status: 200, body: {} };
      },
    },
  };
}

const ID = "0b8f9a52-1c2d-4e5f-8a9b-0c1d2e3f4a5b";

describe("sender", () => {
  it("sends every session, skips an unchanged file without asking, and resends only what grew", async () => {
    const { createSender, runImport } = await cli("import.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "valise-send-"));
    const claude = path.join(dir, "projects");
    const file = claudeSession(claude, ID, 2);
    const valise = fakeValise();
    const sender = () =>
      createSender({
        config: { device: "laptop" },
        api: valise.api,
        stateFile: path.join(dir, "sent.json"),
        repo: () => null,
        log: () => {},
      });
    const roots = {
      claude,
      codex: path.join(dir, "none"),
      opencode: path.join(dir, "none.db"),
    };
    const clients = ["claude-code", "codex", "opencode"];

    const first = await runImport({ sender: sender(), clients, roots });
    expect(first).toMatchObject({ found: 1, sent: 1 });
    expect(valise.posts[0]).toMatchObject({
      project: null,
      from: 0,
      device: "laptop",
    });

    // A new sender reads sent.json: an untouched file needs no request.
    const again = await runImport({ sender: sender(), clients, roots });
    expect(again).toMatchObject({ unchanged: 1, sent: 0 });
    expect(valise.gets).toHaveLength(1);

    claudeSession(claude, ID, 3);
    const grown = await runImport({ sender: sender(), clients, roots });
    expect(grown.sent).toBe(1);
    expect(valise.gets).toHaveLength(1);
    expect(valise.posts.at(-1)).toMatchObject({ from: 2 });
    expect(valise.held.get(ID)).toHaveLength(3);
    expect(file.endsWith(`${ID}.jsonl`)).toBe(true);

    // An entry from an older distiller is not trusted: the session goes
    // through the handshake again, though its file has not changed.
    const stateFile = path.join(dir, "sent.json");
    const state = JSON.parse(readFileSync(stateFile, "utf8"));
    for (const entry of Object.values(state) as { v?: number }[])
      delete entry.v;
    writeFileSync(stateFile, JSON.stringify(state));
    const upgraded = await runImport({ sender: sender(), clients, roots });
    expect(upgraded.unchanged).toBe(0);
    expect(valise.gets).toHaveLength(2);
    const after = await runImport({ sender: sender(), clients, roots });
    expect(after).toMatchObject({ unchanged: 1, sent: 0 });
  });

  it("labels a session with its repository, and a worktree with the main one", async () => {
    const { repoName } = await cli("import.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "valise-repo-"));
    const main = path.join(dir, "hedgerow");
    mkdirSync(main);
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", main, ...args], { stdio: "ignore" });
    git("init", "-q");
    git(
      "-c",
      "user.email=a@b",
      "-c",
      "user.name=a",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    git("worktree", "add", "-q", path.join(dir, "elsewhere", "feature"));
    expect(repoName(main)).toBe("hedgerow");
    expect(repoName(path.join(dir, "elsewhere", "feature"))).toBe("hedgerow");
    expect(repoName(dir)).toBeNull();
    expect(repoName(path.join(dir, "gone"))).toBeNull();
  });
});

describe("watch", () => {
  it("maps a changed file to its session, ignoring subagent transcripts", async () => {
    const { sessionForFile } = await cli("watch.mjs");
    expect(sessionForFile("claude-code", "/r", `-w-proj/${ID}.jsonl`)).toEqual({
      client: "claude-code",
      file: `/r/-w-proj/${ID}.jsonl`,
      sessionId: ID,
    });
    expect(
      sessionForFile(
        "claude-code",
        "/r",
        `-w-proj/${ID}/subagents/agent-1.jsonl`,
      ),
    ).toBeNull();
    expect(sessionForFile("claude-code", "/r", "-w-proj/notes.txt")).toBeNull();
    expect(
      sessionForFile("codex", "/c", "2026/11/06/rollout-1.jsonl"),
    ).toMatchObject({
      client: "codex",
      sessionId: "rollout-1",
    });
  });

  it("sends existing sessions at start and a new one once its file is written", async () => {
    const { createSender } = await cli("import.mjs");
    const { watchSessions } = await cli("watch.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "valise-watch-"));
    const claude = path.join(dir, "projects");
    claudeSession(claude, ID, 1);
    const valise = fakeValise();
    const heartbeat = path.join(dir, "watch.json");
    const watcher = watchSessions({
      sender: createSender({
        config: { device: "laptop" },
        api: valise.api,
        stateFile: path.join(dir, "sent.json"),
        repo: () => null,
        log: () => {},
      }),
      roots: {
        claude,
        codex: path.join(dir, "none"),
        opencode: path.join(dir, "none.db"),
      },
      debounceMs: 50,
      // The pass that catches events the OS dropped. macOS drops or delays
      // file events under load, so the test leans on the same guarantee the
      // watcher gives in use, every sweepMs, instead of the event alone.
      sweepMs: 2000,
      heartbeat,
      log: () => {},
    });
    await watcher.ready;
    expect(valise.held.get(ID)).toHaveLength(1);

    const other = "1c2d3e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f";
    claudeSession(claude, other, 2);
    // An event sends it within the debounce; a dropped one, by the sweep.
    const deadline = Date.now() + 15_000;
    while (!valise.held.get(other) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 50));
    await watcher.flush();
    watcher.close();
    expect(valise.held.get(other)).toHaveLength(2);
    const beat = JSON.parse(readFileSync(heartbeat, "utf8"));
    expect(beat).toMatchObject({ pid: process.pid, sent: 2 });
  }, 30_000);
});

describe("login agent", () => {
  it("runs valise watch at login and restarts it", async () => {
    const { plist, LABEL } = await cli("service.mjs");
    const text = plist({
      node: "/opt/homebrew/bin/node",
      script: "/usr/local/lib/node_modules/valise-cli/valise.mjs",
      log: "/Users/a&b/watch.log",
      env: { VALISE_HOME: "/v", XDG_CONFIG_HOME: undefined },
    });
    expect(text).toContain(`<string>${LABEL}</string>`);
    expect(text).toMatch(/valise\.mjs<\/string>\s*<string>watch<\/string>/);
    expect(text).toMatch(/<key>RunAtLoad<\/key>\s*<true\/>/);
    expect(text).toMatch(/<key>KeepAlive<\/key>\s*<true\/>/);
    expect(text).toContain("<string>/Users/a&amp;b/watch.log</string>");
    expect(text).toContain("<key>VALISE_HOME</key>");
    expect(text).not.toContain("XDG_CONFIG_HOME");
  });

  it("reports the watcher started only once it writes a fresh heartbeat, and removes the agent", async () => {
    const { install, uninstall, paths } = await cli("service.mjs");
    const home = mkdtempSync(path.join(tmpdir(), "valise-agent-"));
    const heartbeat = path.join(home, "watch.json");
    writeFileSync(
      heartbeat,
      JSON.stringify({ pid: process.pid, started_at: 1 }),
    );
    const calls: string[][] = [];
    await expect(
      install({
        script: "/x/valise.mjs",
        platform: "darwin",
        home,
        heartbeat,
        startTimeoutMs: 300,
        run: (...args: string[]) => calls.push(args),
      }),
    ).rejects.toThrow(/did not start/);

    const started = install({
      script: "/x/valise.mjs",
      platform: "darwin",
      home,
      heartbeat,
      run: (...args: string[]) => {
        calls.push(args);
        if (args[0] === "bootstrap")
          writeFileSync(
            heartbeat,
            JSON.stringify({ pid: process.pid, started_at: Date.now() }),
          );
      },
    });
    await expect(started).resolves.toMatchObject({ pid: process.pid });
    expect(calls.map((c) => c[0])).toContain("bootstrap");
    expect(readFileSync(paths(home).plist, "utf8")).toContain(
      "<string>/x/valise.mjs</string>",
    );

    uninstall({ platform: "darwin", home, run: () => {} });
    expect(() => readFileSync(paths(home).plist)).toThrow();
  });

  it("retries bootstrap while the old watcher is still exiting", async () => {
    const { install } = await cli("service.mjs");
    const home = mkdtempSync(path.join(tmpdir(), "valise-agent-"));
    const heartbeat = path.join(home, "watch.json");
    let refusals = 2;
    const calls: string[] = [];
    const started = install({
      script: "/x/valise.mjs",
      platform: "darwin",
      home,
      heartbeat,
      run: (...args: string[]) => {
        calls.push(args[0]);
        if (args[0] !== "bootstrap") return;
        if (refusals-- > 0)
          throw new Error("Bootstrap failed: 5: Input/output error");
        writeFileSync(
          heartbeat,
          JSON.stringify({ pid: process.pid, started_at: Date.now() }),
        );
      },
    });
    await expect(started).resolves.toMatchObject({ pid: process.pid });
    expect(calls).toEqual(["bootout", "bootstrap", "bootstrap", "bootstrap"]);

    await expect(
      install({
        script: "/x/valise.mjs",
        platform: "darwin",
        home,
        heartbeat,
        startTimeoutMs: 300,
        run: (...args: string[]) => {
          if (args[0] === "bootstrap")
            throw new Error("Bootstrap failed: 5: Input/output error");
        },
      }),
    ).rejects.toThrow(/Input\/output error/);
  });

  it("refuses outside macOS", async () => {
    const { install } = await cli("service.mjs");
    await expect(install({ script: "x", platform: "linux" })).rejects.toThrow(
      /macOS/,
    );
  });
});

describe("sign-in", () => {
  /** A token endpoint that answers every refresh with `status` and `body`. */
  async function tokenServer(status: number, body: object) {
    const server = http.createServer((_req, res) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const { port } = server.address() as { port: number };
    return { origin: `http://127.0.0.1:${port}`, close: () => server.close() };
  }
  const expired = (origin: string) => ({
    origin,
    auth: {
      refresh_token: "r",
      client_id: "c",
      access_token: "old",
      expires_at: 0,
    },
  });

  it("needs a sign-in when there is none or Valise refuses it, and not when the server fails", async () => {
    process.env.VALISE_HOME = mkdtempSync(path.join(tmpdir(), "valise-auth-"));
    const { accessToken, SignInNeeded } = await cli("auth.mjs");

    await expect(accessToken({ origin: "http://127.0.0.1:1" })).rejects.toThrow(
      SignInNeeded,
    );

    for (const error of ["invalid_grant", "invalid_client"]) {
      const server = await tokenServer(400, { error });
      const refused = await accessToken(expired(server.origin)).catch(
        (e: Error) => e,
      );
      server.close();
      expect(refused).toBeInstanceOf(SignInNeeded);
      expect((refused as { reason: string }).reason).toContain(error);
    }

    const down = await tokenServer(503, { error: "unavailable" });
    const failed = await accessToken(expired(down.origin)).catch(
      (e: Error) => e,
    );
    down.close();
    expect(failed).toBeInstanceOf(Error);
    expect(failed).not.toBeInstanceOf(SignInNeeded);
  });
});

describe("import speed and output", () => {
  it("keeps the progress line on one terminal row", async () => {
    const { fitLine } = await cli("ui.mjs");
    const coloured =
      "  \x1b[33m…\x1b[0m Sending existing sessions  12/1094  \x1b[2mClaude Code\x1b[0m";
    expect(fitLine(coloured, 200)).toBe(coloured);
    const cut = fitLine(coloured, 30);
    expect(cut).toBe("  … Sending existing session…");
    expect(cut.length).toBeLessThan(30);
    expect(fitLine(coloured, undefined)).toBe(coloured);
  });

  it("sends several sessions at once, never more than the limit, and saves along the way", async () => {
    const { runImport } = await cli("import.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "valise-pool-"));
    const claude = path.join(dir, "projects");
    for (let i = 0; i < 20; i++)
      claudeSession(
        claude,
        `0b8f9a52-1c2d-4e5f-8a9b-0c1d2e3f4a${String(i).padStart(2, "0")}`,
        1,
      );
    let inFlight = 0;
    let most = 0;
    let saves = 0;
    const sender = {
      send: async () => {
        inFlight++;
        most = Math.max(most, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 10));
        inFlight--;
        return "sent";
      },
      save: () => saves++,
    };
    const report = await runImport({
      sender,
      clients: ["claude-code"],
      roots: { claude },
      concurrency: 4,
      saveEvery: 5,
    });
    expect(report).toMatchObject({ found: 20, done: 20, sent: 20 });
    expect(most).toBe(4);
    expect(saves).toBe(5);
  });
});

describe("archives and chat exports", () => {
  type Turn = { kind: string; text: string; tool_name: string | null };
  const shape = (turns: Turn[]) => turns.map((t) => [t.kind, t.tool_name]);

  it("reads Codex custom tool calls, the model, the branch, and harness parts of a user message", async () => {
    const { distillCodex } = await cli("distill.mjs");
    const codex = distillCodex(
      [
        {
          type: "session_meta",
          payload: { id: "c2", cwd: "/w", git: { branch: "me/x" } },
        },
        { type: "turn_context", payload: { model: "gpt-5.6-terra" } },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<recommended_plugins>\nlinear</recommended_plugins>",
              },
              {
                type: "input_text",
                text: "# AGENTS.md instructions\n\n<INSTRUCTIONS>Use uv</INSTRUCTIONS>",
              },
              {
                type: "input_text",
                text: "<environment_context><cwd>/w</cwd></environment_context>",
              },
            ],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "rebase onto main" }],
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "apply_patch",
            input: "*** Begin Patch\n*** Update File: a.ts",
          },
        },
      ].map((r) => JSON.stringify(r)),
    );
    expect(codex).toMatchObject({
      sessionId: "c2",
      gitBranch: "me/x",
      model: "gpt-5.6-terra",
    });
    expect(shape(codex.turns)).toEqual([
      ["system", "recommended_plugins"],
      ["system", "Instructions"],
      ["system", "Environment"],
      ["human", null],
      ["tool_call", "apply_patch"],
    ]);
  });

  it("follows a claude.ai conversation's current branch and keeps pasted files out of the prompt", async () => {
    const { distillClaudeAi } = await cli("distill.mjs");
    const root = "00000000-0000-4000-8000-000000000000";
    const message = (
      uuid: string,
      parent: string,
      sender: string,
      content: unknown[],
      attachments: unknown[] = [],
    ) => ({
      uuid,
      parent_message_uuid: parent,
      sender,
      content,
      attachments,
      created_at: "2025-12-09T14:21:27Z",
    });
    const result = distillClaudeAi({
      uuid: "conv-1",
      model: "claude-opus-4-6",
      current_leaf_message_uuid: "a2",
      chat_messages: [
        message(
          "h1",
          root,
          "human",
          [{ type: "text", text: "why does this crawler fail?" }],
          [{ file_name: "", file_type: "txt", extracted_content: "apiKey: k" }],
        ),
        message("a1-old", "h1", "assistant", [
          { type: "text", text: "an abandoned regeneration" },
        ]),
        message("a2", "h1", "assistant", [
          { type: "thinking", thinking: "Look at the config" },
          { type: "tool_use", name: "web_fetch", input: { url: "https://x" } },
          {
            type: "tool_result",
            name: "web_fetch",
            is_error: true,
            content: [{ type: "text", text: "403" }],
          },
          { type: "tool_result", name: "web_fetch", content: [] },
          { type: "token_budget" },
          { type: "text", text: "The key is read-only." },
        ]),
      ],
    });
    expect(result).toMatchObject({
      sessionId: "conv-1",
      model: "claude-opus-4-6",
    });
    expect(shape(result.turns)).toEqual([
      ["system", "Attachment: pasted txt"],
      ["human", null],
      ["thinking", null],
      ["tool_call", "web_fetch"],
      ["tool_error", "web_fetch"],
      ["assistant", null],
    ]);
    expect(result.turns.map((t: Turn) => t.text)).not.toContain(
      "an abandoned regeneration",
    );
  });

  it("follows a ChatGPT conversation from its current node and leaves hidden and tool messages out", async () => {
    const { distillChatGpt } = await cli("distill.mjs");
    const node = (
      id: string,
      parent: string | null,
      message: Record<string, unknown> | null,
    ) => ({ id, parent, message });
    const msg = (
      role: string,
      content: Record<string, unknown>,
      extra: Record<string, unknown> = {},
    ) => ({ author: { role }, content, create_time: 1706109009.4, ...extra });
    const result = distillChatGpt({
      conversation_id: "g1",
      default_model_slug: "gpt-4o",
      current_node: "a2",
      mapping: {
        root: node("root", null, null),
        sys: node(
          "sys",
          "root",
          msg(
            "system",
            { content_type: "text", parts: [""] },
            { metadata: { is_visually_hidden_from_conversation: true } },
          ),
        ),
        ctx: node(
          "ctx",
          "sys",
          msg("user", {
            content_type: "user_editable_context",
            user_instructions: "Answer in Dutch",
          }),
        ),
        u1: node(
          "u1",
          "ctx",
          msg("user", {
            content_type: "multimodal_text",
            parts: [{ asset_pointer: "file-service://x" }, "what is this?"],
          }),
        ),
        old: node(
          "old",
          "u1",
          msg("assistant", { content_type: "text", parts: ["old answer"] }),
        ),
        t1: node(
          "t1",
          "u1",
          msg("assistant", {
            content_type: "thoughts",
            thoughts: [{ summary: "Look", content: "at the image" }],
          }),
        ),
        c1: node(
          "c1",
          "t1",
          msg(
            "assistant",
            { content_type: "code", text: "search('brie')" },
            { recipient: "web" },
          ),
        ),
        r1: node(
          "r1",
          "c1",
          msg("tool", { content_type: "text", parts: ["results"] }),
        ),
        a2: node(
          "a2",
          "r1",
          msg("assistant", { content_type: "text", parts: ["A brie."] }),
        ),
      },
    });
    expect(result).toMatchObject({ sessionId: "g1", model: "gpt-4o" });
    expect(shape(result.turns)).toEqual([
      ["system", "Custom instructions"],
      ["human", null],
      ["thinking", null],
      ["tool_call", "web"],
      ["assistant", null],
    ]);
    expect(result.turns[1].text).toBe("what is this?");
  });

  it("finds each kind of session in an archive once, and sends only those Valise does not hold", async () => {
    const { archiveSessions, createSender, runImport } =
      await cli("import.mjs");
    const dir = mkdtempSync(path.join(tmpdir(), "valise-archive-"));
    const archive = path.join(dir, "archive");
    // The same session in a copy of ~/.claude/projects and a dated folder.
    claudeSession(path.join(archive, "raw"), ID, 3);
    claudeSession(path.join(archive, "daily", "2026-05-16"), ID, 1);
    const subagents = path.join(archive, "raw", "-w-proj", ID, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(path.join(subagents, `${ID}.jsonl`), "{}\n");
    const codexDir = path.join(archive, "codex", "2026", "07");
    mkdirSync(codexDir, { recursive: true });
    const rollout = "rollout-2026-07-13T14-16-45-019f5b68";
    writeFileSync(
      path.join(codexDir, `${rollout}.jsonl`),
      `${JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "hi" }],
        },
      })}\n`,
    );
    writeFileSync(path.join(codexDir, `${rollout}.jsonl.zst`), "zstd");
    const claudeAi = {
      uuid: "conv-1",
      current_leaf_message_uuid: "h1",
      chat_messages: [
        {
          uuid: "h1",
          sender: "human",
          content: [{ type: "text", text: "hello" }],
        },
      ],
    };
    // The account export and the single-chat file hold the same chat.
    writeFileSync(
      path.join(archive, "claude_export.json"),
      JSON.stringify([claudeAi]),
    );
    mkdirSync(path.join(archive, "desktop"));
    writeFileSync(
      path.join(archive, "desktop", "conversation.json"),
      JSON.stringify(claudeAi),
    );
    writeFileSync(
      path.join(archive, "conversations.json"),
      JSON.stringify([
        {
          conversation_id: "g1",
          current_node: "u1",
          mapping: {
            u1: {
              parent: null,
              message: {
                author: { role: "user" },
                content: { content_type: "text", parts: ["hej"] },
              },
            },
          },
        },
      ]),
    );
    writeFileSync(path.join(archive, "notes.json"), '{"not":"an export"}');

    const found = archiveSessions(archive);
    expect(
      found
        .map((s: { client: string; sessionId: string }) => [
          s.client,
          s.sessionId,
        ])
        .sort(),
    ).toEqual([
      ["chatgpt", "g1"],
      ["claude-ai", "conv-1"],
      ["claude-code", ID],
      ["codex", rollout],
    ]);
    expect(
      found.find((s: { client: string }) => s.client === "claude-code").file,
    ).toContain(`${path.sep}raw${path.sep}`);

    const valise = fakeValise();
    // Valise holds a longer history of this session than the archive does.
    valise.held.set(ID, [{ kind: "human", text: "newer", tool_name: null }]);
    const report = await runImport({
      sender: createSender({
        config: { device: "laptop" },
        api: valise.api,
        stateFile: path.join(dir, "sent.json"),
        repo: () => null,
        log: () => {},
        onlyNew: true,
      }),
      clients: ["claude-code", "codex", "claude-ai", "chatgpt"],
      roots: { archive },
    });
    expect(report).toMatchObject({ found: 4, sent: 3, held: 1, failed: 0 });
    expect(valise.held.get(ID)).toHaveLength(1);
    expect(
      Object.fromEntries(
        valise.posts.map((p) => [p.client as string, p.device]),
      ),
    ).toEqual({
      codex: "laptop",
      "claude-ai": "claude.ai",
      chatgpt: "chatgpt.com",
    });
  });
});

describe("Codex subagents and long imports", () => {
  it("names a subagent's rollout by its own session_meta, not the parent's it repeats", async () => {
    const { distillCodex } = await cli("distill.mjs");
    const child = distillCodex(
      [
        {
          type: "session_meta",
          payload: {
            id: "child",
            cwd: "/w/child",
            forked_from_id: "parent",
            git: { branch: "audit" },
          },
        },
        {
          type: "session_meta",
          payload: { id: "parent", cwd: "/w", git: { branch: "main" } },
        },
      ].map((r) => JSON.stringify(r)),
    );
    expect(child).toMatchObject({
      sessionId: "child",
      cwd: "/w/child",
      gitBranch: "audit",
    });
  });

  it("asks an async token function for a bearer on every request", async () => {
    const { transcriptsApi } = await cli("sync.mjs");
    const seen: string[] = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers.authorization ?? "");
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const { port } = server.address() as { port: number };
    let n = 0;
    const api = transcriptsApi(
      `http://127.0.0.1:${port}`,
      async () => `t${++n}`,
    );
    const session = { client: "c", device: "d", session_id: "s" };
    expect(await api.get(session)).toBeNull();
    expect(await api.get(session)).toBeNull();
    server.close();
    expect(seen).toEqual(["Bearer t1", "Bearer t2"]);
  });
});
