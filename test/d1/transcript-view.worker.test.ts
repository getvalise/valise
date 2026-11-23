import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  sessionSummaries,
  transcriptContext,
  transcriptIdsLinkedTo,
  transcriptTagOptions,
} from "~/concepts/transcript-context";
import {
  answerIndexes,
  filesTouched,
  GAP_SECONDS,
  groupExchanges,
  harnessEvent,
  itemMentions,
  skillsUsed,
  toolLabel,
  toolSummary,
} from "~/concepts/transcript-view";
import {
  appendTranscript,
  listTranscripts,
  readTranscriptTurns,
  type TranscriptTurn,
  type TurnInput,
  transcriptFacets,
  transcriptText,
} from "~/concepts/transcripts";

const data = { DB: env.DB, BUNDLES: env.BUNDLES };
const provenance = {
  userId: "local",
  agent: "valise-cli",
  client: "oauth",
  session: null,
};

function turns(input: Partial<TranscriptTurn>[]): TranscriptTurn[] {
  return input.map((turn, position) => ({
    position,
    kind: "assistant",
    text: "",
    toolName: null,
    at: null,
    hash: `h${position}`,
    ...turn,
  }));
}

afterEach(async () => {
  for (const table of [
    "search_docs",
    "transcript_turns",
    "transcripts",
    "todos",
    "memory_subject_members",
    "memory_subjects",
    "memories",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

describe("reading a transcript", () => {
  it("opens an exchange at each prompt and folds each run of tool turns", () => {
    const exchanges = groupExchanges(
      turns([
        { kind: "assistant", text: "Resumed." },
        { kind: "human", text: "Fix the flake", at: 100 },
        {
          kind: "tool_call",
          toolName: "Bash",
          text: "command: npm test",
          at: 110,
        },
        {
          kind: "tool_call",
          toolName: "Read",
          text: "file_path: a.ts",
          at: 111,
        },
        { kind: "tool_error", toolName: "Bash", text: "exit 1", at: 112 },
        {
          kind: "tool_call",
          toolName: "Bash",
          text: "command: npm test",
          at: 113,
        },
        { kind: "assistant", text: "Fixed.", at: 120 },
        { kind: "human", text: "Ship it", at: 120 + GAP_SECONDS + 5 },
        { kind: "api_error", text: "529 overloaded", at: 130 + GAP_SECONDS },
      ]),
    );
    expect(exchanges.map((e) => e.prompt?.text ?? null)).toEqual([
      null,
      "Fix the flake",
      "Ship it",
    ]);
    const [, fix, ship] = exchanges;
    // The idle stretch closes the exchange it follows, right above the next prompt.
    expect(fix.blocks.map((b) => b.type)).toEqual(["tools", "text", "gap"]);
    const run = fix.blocks[0];
    if (run.type !== "tools") throw new Error("expected a run");
    expect(run.turns).toHaveLength(4);
    expect(run.errors).toBe(1);
    expect(toolSummary(run.counts)).toBe("Bash ×2, Read");
    expect(fix).toMatchObject({ errors: 1, tools: 3 });
    expect(ship.blocks.map((b) => b.type)).toEqual(["error"]);
    expect(ship.errors).toBe(1);
  });

  it("reads what a client wrote as a user message as an event, not a prompt", () => {
    const notification =
      '<task-notification> <task-id>b1cubygaz</task-id> <tool-use-id>toolu_01YZ</tool-use-id> <output-file>/tmp/tasks/b1cubygaz.output</output-file> <status>completed</status> <summary>Background command "Run the full verify gate on the head commit" completed (exit code 0)</summary> </task-notification>';
    expect(harnessEvent(notification)).toEqual({
      label:
        'Background task: Background command "Run the full verify gate on the head commit" completed (exit code 0)',
      detail:
        "Task: b1cubygaz\nTool call: toolu_01YZ\nOutput: /tmp/tasks/b1cubygaz.output",
      failed: false,
      continues: "task",
    });
    expect(
      harnessEvent(
        '<task-notification><status>completed</status><summary>Background command "verify" failed (exit code 1)</summary></task-notification>',
      )?.failed,
    ).toBe(true);
    expect(
      harnessEvent(
        "<command-message>simplify</command-message>\n<command-name>/simplify</command-name>\n<command-args>app/a.ts</command-args>",
      ),
    ).toEqual({ label: "Ran", code: "/simplify app/a.ts" });
    expect(harnessEvent("<bash-input>git status</bash-input>")).toEqual({
      label: "Ran",
      code: "! git status",
    });
    expect(
      harnessEvent(
        "<bash-stdout>clean</bash-stdout><bash-stderr></bash-stderr>",
      ),
    ).toEqual({ label: "Shell output", detail: "clean", failed: false });
    expect(
      harnessEvent("<local-command-stdout></local-command-stdout>"),
    ).toMatchObject({ label: "Command output (empty)" });
    expect(
      harnessEvent(
        "This session is being continued from a previous conversation that ran out of context. Summary:\n- one",
      ),
    ).toMatchObject({
      label: "Continued from an earlier session",
      markdown: true,
    });
    expect(harnessEvent("[Request interrupted by user for tool use]")).toEqual({
      label: "Interrupted during a tool call",
    });
    expect(
      harnessEvent(
        "Caveat: The messages below were generated by the user while running local commands. DO NOT respond.",
      )?.hidden,
    ).toBe(true);
    expect(harnessEvent("Stop hook feedback:\nSave what you learned")).toEqual({
      label: "Stop hook sent the agent back to work",
      detail: "Save what you learned",
      continues: "hook",
    });
    // Codex writes its environment and AGENTS.md as user messages.
    expect(
      harnessEvent(
        "<environment_context>\n  <cwd>/repo</cwd>\n</environment_context>",
      ),
    ).toEqual({ label: "Environment", detail: "<cwd>/repo</cwd>" });
    expect(
      harnessEvent("<user_instructions>Use pnpm.</user_instructions>"),
    ).toEqual({ label: "Instructions", detail: "Use pnpm." });
    // A prompt that only mentions a tag is still a prompt.
    expect(harnessEvent("Why does <task-notification> show as a prompt?")).toBe(
      null,
    );

    const exchanges = groupExchanges(
      turns([
        { kind: "human", text: "Run verify" },
        { kind: "tool_call", toolName: "Bash", text: "npm run verify" },
        { kind: "human", text: notification },
        {
          kind: "human",
          text: "Caveat: The messages below were generated by the user while running local commands.",
        },
        { kind: "assistant", text: "Verify passed." },
        { kind: "human", text: "Merge it" },
      ]),
    );
    expect(exchanges.map((e) => e.prompt?.text)).toEqual([
      "Run verify",
      "Merge it",
    ]);
    expect(exchanges[0].blocks.map((block) => block.type)).toEqual([
      "tools",
      "event",
      "text",
    ]);
  });

  it("answers a prompt with its last reply before a hook sent the agent back", () => {
    const [plain] = groupExchanges(
      turns([
        { kind: "human", text: "Fix it" },
        { kind: "assistant", text: "Looking." },
        { kind: "tool_call", toolName: "Bash", text: "npm test" },
        { kind: "assistant", text: "Fixed." },
      ]),
    );
    expect([...answerIndexes(plain)]).toEqual([2]);
    const [hooked] = groupExchanges(
      turns([
        { kind: "human", text: "Fix it" },
        { kind: "assistant", text: "Fixed." },
        { kind: "human", text: "Stop hook feedback:\nSave it" },
        { kind: "tool_call", toolName: "save_memory", text: "title: x" },
        { kind: "assistant", text: "Saved." },
      ]),
    );
    expect(hooked.blocks.map((block) => block.type)).toEqual([
      "text",
      "event",
      "tools",
      "text",
    ]);
    expect([...answerIndexes(hooked)]).toEqual([0]);
    // A background task's report is an answer of its own, and the long reply
    // before it stays the prompt's answer.
    const [tasked] = groupExchanges(
      turns([
        { kind: "human", text: "Ship it" },
        { kind: "assistant", text: "Starting verify." },
        { kind: "tool_call", toolName: "Bash", text: "npm run verify" },
        { kind: "assistant", text: "Here is the whole write-up." },
        {
          kind: "human",
          text: "<task-notification><status>completed</status><summary>verify passed</summary></task-notification>",
        },
        { kind: "assistant", text: "Verify passed." },
      ]),
    );
    expect([...answerIndexes(tasked)]).toEqual([2, 4]);
    const [silent] = groupExchanges(turns([{ kind: "human", text: "Hi" }]));
    expect(answerIndexes(silent).size).toBe(0);
  });

  it("splits a run of tool calls at an idle stretch", () => {
    const [only] = groupExchanges(
      turns([
        { kind: "human", text: "Go", at: 0 },
        { kind: "tool_call", toolName: "Bash", text: "a", at: 1 },
        { kind: "tool_call", toolName: "Bash", text: "b", at: 2 + GAP_SECONDS },
      ]),
    );
    expect(only.blocks.map((b) => b.type)).toEqual(["tools", "gap", "tools"]);
  });

  it("names MCP tools by server and tool", () => {
    expect(toolLabel("mcp__plugin_valise_valise__claim_todo")).toBe(
      "valise · claim_todo",
    );
    expect(toolLabel("mcp__claude_ai_Linear__get_issue")).toBe(
      "Linear · get_issue",
    );
    expect(toolLabel("Bash")).toBe("Bash");
  });

  it("finds the Valise ids, files and skills a session touched", () => {
    const sample = turns([
      { kind: "tool_call", toolName: "x", text: "id: todo:tdo_a1" },
      { kind: "assistant", text: "See memory:mem_b2 and todo:tdo_a1." },
      {
        kind: "tool_call",
        toolName: "Read",
        text: "file_path: /repo/app/a.ts",
      },
      {
        kind: "tool_call",
        toolName: "Edit",
        text: "file_path: /repo/app/a.ts",
      },
      { kind: "tool_call", toolName: "Read", text: "file_path: /etc/hosts" },
      {
        kind: "tool_call",
        toolName: "mcp__plugin_valise_valise__skill_tdd",
        text: "{}",
      },
      { kind: "tool_call", toolName: "Skill", text: '{"skill":"simplify"}' },
    ]);
    expect(itemMentions(sample)).toEqual([
      { id: "todo:tdo_a1", position: 0 },
      { id: "memory:mem_b2", position: 1 },
    ]);
    expect(filesTouched(sample, "/repo")).toEqual([
      { path: "app/a.ts", reads: 1, writes: 1 },
      { path: "/etc/hosts", reads: 1, writes: 0 },
    ]);
    expect(skillsUsed(sample)).toEqual(["simplify", "tdd"]);
  });
});

async function seedItems() {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO todos (todo_id, user_id, title, state, tags_json, project, source_agent, created_at, updated_at)
       VALUES ('tdo_mine', 'local', 'Fix the flake', 'done', '["ci","flaky"]', 'valise', 't', 1, 1),
              ('tdo_theirs', 'other', 'Their secret', 'pending', '["secret"]', NULL, 't', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO memories (memory_id, user_id, memory_type, title, body, tags_json, source_agent, source_client, created_at, updated_at)
       VALUES ('mem_mine', 'local', 'decision', 'Retry once', 'Retry flaky specs once.', '["ci"]', 't', 't', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO memory_subjects (subject_id, user_id, name, kind, created_at, updated_at)
       VALUES ('sub_ci', 'local', 'Test reliability', 'topic', 1, 1),
              ('sub_hedge', 'local', 'Hedgerow', 'topic', 1, 1)`,
    ),
    env.DB.prepare(
      `INSERT INTO memory_subject_members (subject_id, memory_id, asserted_by, confirmed_at, confirmed_by, created_at)
       VALUES ('sub_ci', 'mem_mine', 'person', 1, 'local', 1)`,
    ),
  ]);
}

async function append(sessionId: string, input: TurnInput[], extra = {}) {
  const result = await appendTranscript(
    data,
    {
      client: "claude-code",
      device: "laptop",
      sessionId,
      cwd: "/repo",
      project: "valise",
      from: 0,
      turns: input,
      ...extra,
    },
    provenance,
  );
  if (!result.ok) throw new Error("append refused");
  return result.transcript;
}

describe("a transcript's tags and subjects", () => {
  it("come from the to-dos, memories and subjects its turns named", async () => {
    await seedItems();
    const linked = await append("s1", [
      { kind: "human", text: "Why does the hedgerow test flake?", at: 1000 },
      {
        kind: "tool_call",
        toolName: "mcp__plugin_valise_valise__claim_todo",
        text: "id: todo:tdo_mine",
        at: 1010,
      },
      {
        kind: "tool_call",
        toolName: "mcp__plugin_valise_valise__fetch",
        text: "id: memory:mem_mine",
        at: 1020,
      },
      {
        kind: "tool_call",
        toolName: "mcp__plugin_valise_valise__fetch",
        text: "id: todo:tdo_theirs",
        at: 1030,
      },
      {
        kind: "tool_call",
        toolName: "Edit",
        text: "file_path: /repo/a.ts",
        at: 1040,
      },
      { kind: "tool_error", toolName: "Bash", text: "exit 1", at: 1050 },
      { kind: "assistant", text: "Done.", at: 5000 },
    ]);
    const plain = await append("s2", [
      { kind: "human", text: "Unrelated", at: 2000 },
    ]);
    const memoryOnly = await append("s3", [
      { kind: "human", text: "Read the retry decision", at: 3000 },
      {
        kind: "tool_call",
        toolName: "mcp__plugin_valise_valise__fetch",
        text: "id: memory:mem_mine",
        at: 3010,
      },
    ]);

    const context = await transcriptContext(env.DB, "local", linked);
    expect(context.todos.map((t) => [t.id, t.tags])).toEqual([
      ["tdo_mine", ["ci", "flaky"]],
    ]);
    expect(context.memories.map((m) => m.id)).toEqual(["mem_mine"]);
    expect(context.tags).toEqual([
      { tag: "ci", count: 2 },
      { tag: "flaky", count: 1 },
    ]);
    expect(context.subjects).toEqual([
      { id: "sub_ci", name: "Test reliability", via: "memory" },
      { id: "sub_hedge", name: "Hedgerow", via: "name" },
    ]);
    expect(context.files).toEqual([{ path: "a.ts", reads: 0, writes: 1 }]);
    expect(context.stats).toMatchObject({
      prompts: 1,
      toolCalls: 4,
      errors: 1,
      span: 4000,
      active: 50,
    });
    expect(context.outline.map((o) => o.position)).toEqual([0]);

    const summaries = await sessionSummaries(env.DB, "local", [
      linked.transcriptId,
      plain.transcriptId,
    ]);
    expect(summaries[linked.transcriptId]).toEqual({
      prompts: 1,
      toolCalls: 4,
      errors: 1,
      tags: ["ci", "flaky"],
    });
    expect(summaries[plain.transcriptId].tags).toEqual([]);

    const linkedTo = async (
      filter: Parameters<typeof transcriptIdsLinkedTo>[2],
    ) => (await transcriptIdsLinkedTo(env.DB, "local", filter)).sort();
    expect(await linkedTo({ tags: ["flaky"] })).toEqual([linked.transcriptId]);
    expect(await linkedTo({ tags: ["ci"] })).toEqual(
      [linked.transcriptId, memoryOnly.transcriptId].sort(),
    );
    // Every chosen tag has to match, as on the other lists.
    expect(await linkedTo({ tags: ["ci", "flaky"] })).toEqual([
      linked.transcriptId,
    ]);
    expect(await linkedTo({ subjectId: "sub_ci" })).toEqual(
      [linked.transcriptId, memoryOnly.transcriptId].sort(),
    );
    expect(await linkedTo({ tags: ["flaky"], subjectId: "sub_ci" })).toEqual([
      linked.transcriptId,
    ]);
    expect(await linkedTo({ tags: ["secret"] })).toEqual([]);
    // The tag menu offers what this account's to-dos and memories carry.
    expect(await transcriptTagOptions(env.DB, "local")).toEqual([
      "ci",
      "flaky",
    ]);
    // A row finds tags where the pane does: an id named in a reply counts.
    const named = await append("named", [
      { kind: "human", text: "Pick up the next to-do", at: 4000 },
      {
        kind: "assistant",
        text: "Continuing todo:tdo_mine from its handoff.",
        at: 4010,
      },
    ]);
    const namedSummary = await sessionSummaries(env.DB, "local", [
      named.transcriptId,
    ]);
    expect(namedSummary[named.transcriptId].tags).toEqual(
      (await transcriptContext(env.DB, "local", named)).tags.map((t) => t.tag),
    );
    expect(namedSummary[named.transcriptId].tags).toEqual(["ci", "flaky"]);
  });

  it("keeps thinking as its own turn, out of search", async () => {
    const session = await append("thinks", [
      { kind: "human", text: "Why is the deploy slow?", at: 1000 },
      { kind: "thinking", text: "Maybe the hedgerow cache misses", at: 1001 },
      { kind: "assistant", text: "The build cache is cold.", at: 1002 },
    ]);
    const held = await readTranscriptTurns(env.DB, session.transcriptId);
    expect(held.map((turn) => turn.kind)).toEqual([
      "human",
      "thinking",
      "assistant",
    ]);
    const doc = await env.DB.prepare(
      "SELECT body FROM search_docs WHERE doc_key = ?",
    )
      .bind(`transcript:${session.transcriptId}`)
      .first<{ body: string }>();
    expect(doc?.body).toContain("The build cache is cold.");
    expect(doc?.body).not.toContain("hedgerow");
    const [exchange] = groupExchanges(held);
    expect(exchange.blocks.map((block) => block.type)).toEqual([
      "thinking",
      "text",
    ]);
    // Thinking is never the answer.
    expect([...answerIndexes(exchange)]).toEqual([1]);
  });

  it("keeps system text as its own turn: out of search, folded, short in fetch", async () => {
    const prompt = `You are an agent. ${"Follow the hedgerow rules. ".repeat(20)}`;
    const session = await append("system", [
      { kind: "system", text: prompt, toolName: "System prompt", at: 1000 },
      {
        kind: "system",
        text: "# Working in this repo",
        toolName: "/w/AGENTS.md",
        at: 1000,
      },
      { kind: "human", text: "Why is the deploy slow?", at: 1001 },
      { kind: "tool_call", text: "command: ls", toolName: "Bash", at: 1002 },
      {
        kind: "system",
        text: "The date changed.",
        toolName: "Reminder",
        at: 1003,
      },
      {
        kind: "tool_call",
        text: "command: npm test",
        toolName: "Bash",
        at: 1004,
      },
      { kind: "assistant", text: "The build cache is cold.", at: 1005 },
    ]);
    const held = await readTranscriptTurns(env.DB, session.transcriptId);
    expect(held.filter((turn) => turn.kind === "system")).toHaveLength(3);
    expect(held[0].toolName).toBe("System prompt");
    const doc = await env.DB.prepare(
      "SELECT body FROM search_docs WHERE doc_key = ?",
    )
      .bind(`transcript:${session.transcriptId}`)
      .first<{ body: string }>();
    expect(doc?.body).toContain("The build cache is cold.");
    expect(doc?.body).not.toContain("hedgerow");
    expect(doc?.body).not.toContain("Working in this repo");
    // Before the prompt, one folded block; mid-run, the run stays whole and
    // the reminder folds in after it.
    const [lead, exchange] = groupExchanges(held);
    expect(lead.prompt).toBeNull();
    expect(lead.blocks.map((block) => block.type)).toEqual(["system"]);
    expect(exchange.blocks.map((block) => block.type)).toEqual([
      "tools",
      "system",
      "text",
    ]);
    expect([...answerIndexes(exchange)]).toEqual([2]);
    // fetch names the source and gives the opening, not the whole prompt.
    const text = transcriptText(held);
    expect(text).toContain("System System prompt: You are an agent.");
    expect(text).toContain(`(${prompt.length} characters)`);
    expect(text).not.toContain(prompt.trim());
    expect(text).toContain("System /w/AGENTS.md: # Working in this repo");
  });

  it("counts and lists only the prompts a person wrote", async () => {
    const session = await append("events", [
      {
        kind: "human",
        text: "<command-name>/clear</command-name>",
        at: 900,
      },
      { kind: "human", text: "Run verify", at: 1000 },
      {
        kind: "human",
        text: "<task-notification><status>completed</status><summary>done</summary></task-notification>",
        at: 1100,
      },
      { kind: "human", text: "Merge it", at: 1200 },
    ]);
    expect(session.title).toBe("Run verify");
    const context = await transcriptContext(env.DB, "local", session);
    expect(context.stats.prompts).toBe(2);
    expect(context.outline.map((entry) => entry.text)).toEqual([
      "Run verify",
      "Merge it",
    ]);
    const summaries = await sessionSummaries(env.DB, "local", [
      session.transcriptId,
    ]);
    expect(summaries[session.transcriptId].prompts).toBe(2);
  });

  it("orders by when a session started or by its latest turn", async () => {
    const long = await append("long", [
      { kind: "human", text: "Long running", at: 1000 },
      { kind: "assistant", text: "Still going", at: 9000 },
    ]);
    const short = await append("short", [
      { kind: "human", text: "Quick one", at: 5000 },
    ]);
    const order = async (sort: "first" | "last") =>
      (await listTranscripts(env.DB, "local", 0, 30, {}, sort)).map(
        (t) => t.transcriptId,
      );
    expect(await order("first")).toEqual([
      short.transcriptId,
      long.transcriptId,
    ]);
    expect(await order("last")).toEqual([
      long.transcriptId,
      short.transcriptId,
    ]);
  });

  it("narrows the list by column, title and errors", async () => {
    const failing = await append("s1", [
      { kind: "human", text: "Deploy fails", at: 1000 },
      { kind: "tool_error", toolName: "Bash", text: "exit 1", at: 1001 },
    ]);
    const quiet = await append(
      "s2",
      [{ kind: "human", text: "Write docs", at: 3000 }],
      { device: "desktop", project: "notes" },
    );
    const ids = async (
      filter: Parameters<typeof listTranscripts>[4],
      sort?: Parameters<typeof listTranscripts>[5],
    ) =>
      (await listTranscripts(env.DB, "local", 0, 30, filter, sort)).map(
        (t) => t.transcriptId,
      );
    // Newest start first, not newest write.
    expect(await ids({})).toEqual([quiet.transcriptId, failing.transcriptId]);
    expect(await ids({ errors: true })).toEqual([failing.transcriptId]);
    expect(await ids({ device: "desktop" })).toEqual([quiet.transcriptId]);
    expect(await ids({ query: "deploy" })).toEqual([failing.transcriptId]);
    expect(await ids({ query: "100%" })).toEqual([]);
    expect(await ids({ ids: [] })).toEqual([]);
    expect(await listTranscripts(env.DB, "other", 0)).toEqual([]);
    // A session that ran across the range's start still counts as active.
    expect(await ids({ from: 1001, to: 2000 })).toEqual([failing.transcriptId]);
    expect(await ids({ from: 1002, to: 2000 })).toEqual([]);
    expect(await ids({ from: 2000, to: 4000 })).toEqual([quiet.transcriptId]);
    expect(await ids({ to: 1000 })).toEqual([]);
    expect(await ids({ to: 1001 })).toEqual([failing.transcriptId]);
    expect(await transcriptFacets(env.DB, "local")).toEqual({
      client: [{ value: "claude-code", count: 2 }],
      device: [
        { value: "desktop", count: 1 },
        { value: "laptop", count: 1 },
      ],
      project: [
        { value: "notes", count: 1 },
        { value: "valise", count: 1 },
      ],
    });
  });
});
