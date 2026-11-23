import { localSql } from "./asset-processing";

/**
 * Synthetic sessions shaped like the real ones: three quarters tool calls in
 * runs of one to a dozen, a failed call now and then, idle stretches, and
 * tool calls that name Valise items. No private content; every prompt is made
 * up. docs/design/transcripts.md, "Evidence".
 */

type Turn = {
  kind:
    | "human"
    | "assistant"
    | "thinking"
    | "system"
    | "tool_call"
    | "tool_error"
    | "api_error";
  text: string;
  tool?: string;
  at: number;
};

const PROMPTS = [
  "Why does the hedgerow spec flake on the second run?",
  "Add a retry around the deploy-head check and cover it with a test.",
  "Look at the sidebar on a phone and tell me what overlaps.",
  "Rename the summary model constant and update the ADR.",
  "Run verify:ci and fix whatever fails.",
  "Draft the release note for the transcripts page.",
];

const RUN = [
  ["Bash", "command: npm run test:d1 -- transcripts"],
  ["Read", "file_path: /repo/app/concepts/transcripts.ts"],
  ["Grep", "pattern: turnPage"],
  ["Edit", "file_path: /repo/app/routes/activity.transcripts.tsx"],
  ["Bash", "command: npx tsc --noEmit"],
  [
    "Read",
    "file_path: /repo/docs/adr/0022-transcripts-concept-and-cli-grant.md",
  ],
  ["Write", "file_path: /repo/docs/design/transcripts.md"],
  ["mcp__plugin_valise_valise__search", "query: transcript console contract"],
] as const;

function quote(text: string) {
  return `'${text.replaceAll("'", "''")}'`;
}

/** One session's turns, deterministic from its seed. */
export function syntheticTurns(
  seed: number,
  start: number,
  prompts: number,
  mention: string[] = [],
): Turn[] {
  const turns: Turn[] = [];
  let at = start;
  let n = seed;
  const next = () => {
    n = (n * 1103515245 + 12345) % 2147483648;
    return n / 2147483648;
  };
  for (let p = 0; p < prompts; p++) {
    if (p > 0 && next() < 0.3) at += 45 * 60;
    turns.push({
      kind: "human",
      text: PROMPTS[(seed + p) % PROMPTS.length],
      at,
    });
    if (p === 0) {
      // What the client put in front of the model with the first prompt.
      turns.push(
        {
          kind: "system",
          tool: "System prompt",
          text: "You are an agent working with the user toward their goals.\n\n# Environment\n - Platform: darwin",
          at,
        },
        {
          kind: "system",
          tool: "/w/valise/AGENTS.md",
          text: "# Working in this repo\n\nValise is one Cloudflare Worker.",
          at,
        },
      );
    }
    at += 3;
    turns.push({
      kind: "thinking",
      text: "The second run reuses the clock from the first; check the fixture.",
      at,
    });
    at += 2;
    turns.push({
      kind: "assistant",
      text: "I'll start by reading the code and running the failing spec.",
      at,
    });
    const run = 2 + Math.floor(next() * 10);
    for (let r = 0; r < run; r++) {
      at += 3 + Math.floor(next() * 20);
      const [tool, text] = RUN[Math.floor(next() * RUN.length)];
      turns.push({ kind: "tool_call", tool, text, at });
      if (tool === "Bash" && next() < 0.15) {
        turns.push({
          kind: "tool_error",
          tool,
          text: "Exit code 1\nFAIL test/d1/transcripts.worker.test.ts > appends turns\nAssertionError: expected 3 to be 4",
          at: at + 1,
        });
      }
    }
    if (p === 0) {
      // A client writes a finished background task as a user message.
      at += 30;
      turns.push({
        kind: "human",
        text: '<task-notification> <task-id>b1cubygaz</task-id> <output-file>/tmp/tasks/b1cubygaz.output</output-file> <status>completed</status> <summary>Background command "Run the full verify gate" completed (exit code 0)</summary> </task-notification>',
        at,
      });
      for (const id of mention) {
        at += 4;
        turns.push({
          kind: "tool_call",
          tool: "mcp__plugin_valise_valise__claim_todo",
          text: `id: ${id}`,
          at,
        });
      }
    }
    at += 20;
    turns.push({
      kind: "assistant",
      text:
        p === 0
          ? [
              "## What changed",
              "",
              "The spec reads the clock twice; the second read can cross a second boundary.",
              "",
              "| Run | Result |",
              "| --- | --- |",
              "| before | flaky |",
              "| after | green |",
              "",
              "```ts",
              "const now = pinClock(fixture);",
              "```",
            ].join("\n")
          : p === 1
            ? "1. Pin the clock in the fixture\n2. Rerun the spec twice"
            : "The spec reads the clock twice; the second read can cross a second boundary. I pinned the clock in the fixture and the run is green.",
      at,
    });
  }
  return turns;
}

export type SyntheticSession = {
  id: string;
  title: string;
  client?: string;
  device?: string;
  project?: string | null;
  start: number;
  prompts: number;
  mention?: string[];
};

export async function seedTranscripts(
  baseURL: string,
  user: string,
  sessions: SyntheticSession[],
) {
  const sql: string[] = [];
  sessions.forEach((session, index) => {
    const turns = syntheticTurns(
      index + 7,
      session.start,
      session.prompts,
      session.mention,
    );
    sql.push(
      `INSERT INTO transcripts (transcript_id,user_id,client,device,session_id,cwd,git_branch,project,model,title,turn_count,chain_hash,first_at,last_at,source_agent,source_client,created_at,updated_at)
       VALUES (${quote(session.id)},${quote(user)},${quote(session.client ?? "claude-code")},${quote(session.device ?? "laptop")},${quote(`session-${session.id}`)},'/repo','main',${session.project === null ? "NULL" : quote(session.project ?? "valise")},'claude-fable-5-1',${quote(session.title)},${turns.length},'',${turns[0].at},${turns.at(-1)?.at ?? session.start},'cli','cli',${session.start},${session.start});`,
    );
    turns.forEach((turn, position) => {
      sql.push(
        `INSERT INTO transcript_turns (transcript_id,position,kind,text,tool_name,at,hash)
         VALUES (${quote(session.id)},${position},'${turn.kind}',${quote(turn.text)},${turn.tool ? quote(turn.tool) : "NULL"},${turn.at},'h${position}');`,
      );
    });
  });
  await localSql(baseURL, sql.join("\n"));
}
