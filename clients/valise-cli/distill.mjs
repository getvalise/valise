/**
 * Distillation: the turns Valise keeps out of what each client stores or
 * sends. Human messages, assistant text, tool calls with a one-line summary
 * of their arguments, tool errors with their text, API errors, thinking,
 * and what the client put in front of the model that nobody typed: the
 * system prompt, instruction files, hook context, skill bodies, reminders.
 * Successful tool results and tool definitions are dropped. Pure functions,
 * so the watcher, the importer and the tests share them.
 */

/**
 * Bumped when distillation changes what a session file yields, so the
 * importer re-sends sessions it already sent instead of trusting their mtime.
 */
export const DISTILL_VERSION = 4;

/** Characters of a tool's arguments kept on a `tool_call` turn. */
export const SUMMARY_LENGTH = 200;
/** Characters of a failed tool's output kept on a `tool_error` turn. */
export const ERROR_LENGTH = 4000;
/** Characters of a human or assistant message kept. */
export const TEXT_LENGTH = 60_000;

/** One line that says what a tool was asked, without the whole input. */
export function summarizeInput(input) {
  if (input === null || input === undefined) return "";
  if (typeof input === "string") return clip(oneLine(input), SUMMARY_LENGTH);
  if (typeof input !== "object") return clip(String(input), SUMMARY_LENGTH);
  for (const key of [
    "command",
    "description",
    "query",
    "file_path",
    "path",
    "pattern",
    "url",
    "prompt",
    "id",
    "name",
    "title",
  ]) {
    const value =
      Array.isArray(input[key]) &&
      input[key].every((v) => typeof v === "string")
        ? input[key].join(" ")
        : input[key];
    if (typeof value === "string" && value.trim()) {
      return clip(`${key}: ${oneLine(value)}`, SUMMARY_LENGTH);
    }
  }
  return clip(oneLine(JSON.stringify(input)), SUMMARY_LENGTH);
}

export function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) => {
      if (typeof block === "string") return block;
      if (block && typeof block === "object") {
        if (block.type === "text" && typeof block.text === "string")
          return block.text;
        if (
          (block.type === "input_text" || block.type === "output_text") &&
          typeof block.text === "string"
        )
          return block.text;
      }
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

const REMINDER =
  /<system-reminder>([\s\S]*?)<\/system-reminder>|<system_instruction>([\s\S]*?)<\/system_instruction>/g;

/** Hidden harness text a human never typed. */
export function stripReminders(text) {
  return text.replace(REMINDER, "").trim();
}

/** The harness text `stripReminders` takes out, one entry per block. */
export function remindersIn(text) {
  return [...text.matchAll(REMINDER)]
    .map((match) => (match[1] ?? match[2]).trim())
    .filter(Boolean);
}

/** What a reminder is, in a word or two, from how it opens. */
function reminderLabel(text) {
  if (/^(Codebase and user instructions|Contents of )/.test(text))
    return "Instructions";
  if (text.startsWith("As you answer the user's questions")) return "Context";
  if (/^Called the \w+ tool/.test(text)) return "Attached file";
  if (text.startsWith("Attribution for git commits")) return "Attribution";
  return "Reminder";
}

/**
 * One `system` turn per distinct text in a session: a CLAUDE.md the client
 * re-sends on every request, or an unchanged system prompt after a resume,
 * is kept the first time only. `label` says where the text came from and
 * travels as the turn's `tool_name`.
 */
function pushSystem(turns, seen, label, text, at) {
  const body = typeof text === "string" ? text.trim() : "";
  if (!body || seen.has(body)) return;
  seen.add(body);
  const name = label.length > 200 ? `…${label.slice(-199)}` : label;
  turns.push(turn("system", body, name, at));
}

const BOUNDARY = "__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__";

/**
 * The text a Claude Code attachment put in front of the model, as
 * [label, text] pairs. An allowlist: bookkeeping (credentials, mode flags,
 * token counts, file edits) and tool definitions are not prompts.
 */
export function attachmentTexts(attachment) {
  const a = attachment ?? {};
  const strings = (value) =>
    Array.isArray(value)
      ? value.filter((v) => typeof v === "string").join("\n\n")
      : typeof value === "string"
        ? value
        : "";
  switch (a.type) {
    case "prompt_snapshot":
      return [
        [
          "System prompt",
          (Array.isArray(a.systemPrompt) ? a.systemPrompt : [])
            .filter(
              (part) => typeof part === "string" && part.trim() !== BOUNDARY,
            )
            .map((part) => part.trim())
            .join("\n\n"),
        ],
      ];
    case "instructions":
      return (a.files ?? []).map((file) => [
        file?.path ?? "Instructions",
        strings(file?.content),
      ]);
    case "nested_memory":
      return [
        [
          a.content?.path ?? a.path ?? "Instructions",
          strings(a.content?.content),
        ],
      ];
    case "hook_additional_context":
      return [["Hook context", strings(a.content)]];
    case "skill_listing":
      return [["Skill list", strings(a.content)]];
    case "invoked_skills":
      return (a.skills ?? []).map((skill) => [
        `Skill ${skill?.name ?? ""}`.trim(),
        strings(skill?.content),
      ]);
    case "mcp_instructions_delta":
      return [["MCP server instructions", strings(a.addedBlocks)]];
    case "agent_listing_delta":
      return [["Agent list", strings(a.addedLines)]];
    case "session_context":
      return [
        [
          "Session context",
          Object.values(a.context ?? {})
            .filter((v) => typeof v === "string")
            .join("\n\n"),
        ],
      ];
    case "environment":
      return [
        [
          "Environment",
          Object.entries(a.snapshot ?? {})
            .filter(([, v]) => v !== null && v !== "" && typeof v !== "object")
            .map(([k, v]) => `${k}: ${v}`)
            .join("\n"),
        ],
      ];
    case "model":
    case "silent_turn_reminder":
    case "batching_reminder_sent":
      return [[a.type === "model" ? "Model" : "Reminder", strings(a.text)]];
    case "date":
      return [["Date", strings(a.date)]];
    default:
      return [];
  }
}

/**
 * Turns from an Anthropic Messages API `messages` array, as a request carries
 * them or a Claude Code transcript stores them. `tools` names the tool of a
 * `tool_result` by its `tool_use_id`, across calls.
 */
export function distillMessages(
  messages,
  { at = null, tools = new Map(), seen = new Set() } = {},
) {
  const turns = [];
  for (const message of messages ?? []) {
    if (!message || typeof message !== "object") continue;
    const content = message.content;
    if (message.role === "user") {
      if (typeof content === "string") {
        const text = stripReminders(content);
        if (text) turns.push(turn("human", text, null, at));
        for (const reminder of remindersIn(content))
          pushSystem(turns, seen, reminderLabel(reminder), reminder, at);
        continue;
      }
      if (!Array.isArray(content)) continue;
      const texts = [];
      const reminders = [];
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (block.type === "text" && typeof block.text === "string") {
          const text = stripReminders(block.text);
          if (text) texts.push(text);
          reminders.push(...remindersIn(block.text));
        } else if (block.type === "tool_result") {
          if (block.is_error === true) {
            turns.push(
              turn(
                "tool_error",
                clip(textOf(block.content) || "(no output)", ERROR_LENGTH),
                tools.get(block.tool_use_id) ?? "unknown",
                at,
              ),
            );
          }
        }
      }
      if (texts.length) turns.push(turn("human", texts.join("\n"), null, at));
      for (const reminder of reminders)
        pushSystem(turns, seen, reminderLabel(reminder), reminder, at);
    } else if (message.role === "assistant") {
      if (typeof content === "string") {
        if (content.trim())
          turns.push(turn("assistant", content.trim(), null, at));
        continue;
      }
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || typeof block !== "object") continue;
        if (
          block.type === "text" &&
          typeof block.text === "string" &&
          block.text.trim()
        ) {
          turns.push(turn("assistant", block.text.trim(), null, at));
        } else if (
          block.type === "thinking" &&
          typeof block.thinking === "string" &&
          block.thinking.trim()
        ) {
          // Most blocks carry only a signature and no text; those are skipped.
          turns.push(turn("thinking", block.thinking.trim(), null, at));
        } else if (block.type === "tool_use") {
          if (typeof block.id === "string") tools.set(block.id, block.name);
          turns.push(
            turn(
              "tool_call",
              summarizeInput(block.input),
              String(block.name ?? "unknown"),
              at,
            ),
          );
        }
      }
    }
  }
  return turns;
}

/** A Claude Code transcript file (`~/.claude/projects/<dir>/<session>.jsonl`). */
export function distillClaudeCode(lines) {
  const tools = new Map();
  const seen = new Set();
  const turns = [];
  const meta = { sessionId: null, cwd: null, gitBranch: null, model: null };
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    if (record.sessionId && !meta.sessionId) meta.sessionId = record.sessionId;
    if (record.cwd && !meta.cwd) meta.cwd = record.cwd;
    if (record.gitBranch && !meta.gitBranch) meta.gitBranch = record.gitBranch;
    if (record.isSidechain === true) continue;
    const at = seconds(record.timestamp);
    /*
     * A Stop hook that blocks sends the model a message and the session goes
     * on: whatever the agent does next answers the hook, not the prompt.
     * Claude Code keeps the message as an attachment (and an isMeta copy,
     * skipped below); it goes out as a human turn in the wording the model
     * saw, which the console reads as an event. Other hooks' blocking errors
     * land on the tool result they stopped.
     */
    const hook = record.type === "attachment" ? record.attachment : null;
    if (
      hook?.type === "hook_blocking_error" &&
      (hook.hookEvent === "Stop" || hook.hookEvent === "SubagentStop")
    ) {
      const message = String(hook.blockingError?.blockingError ?? "").trim();
      turns.push(
        turn("human", `${hook.hookEvent} hook feedback:\n${message}`, null, at),
      );
      continue;
    }
    if (record.type === "attachment") {
      for (const [label, text] of attachmentTexts(record.attachment))
        pushSystem(turns, seen, label, text, at);
      continue;
    }
    /*
     * An isMeta record is a user message the client wrote: a skill's body, a
     * slash command's expansion, a message from another session. The Stop
     * hook's copy went out above, an image's size note says nothing, and the
     * local-command caveat only instructs the model.
     */
    if (record.isMeta === true) {
      const content = record.message?.content;
      const text = (
        typeof content === "string" ? content : textOf(content)
      ).trim();
      if (
        text &&
        !/^(Stop hook feedback:|SubagentStop hook feedback:|\[Image|<local-command-caveat>|Caveat: )/.test(
          text,
        )
      ) {
        const label = text.startsWith("Base directory for this skill:")
          ? "Skill"
          : text.startsWith("Another Claude session sent a message")
            ? "Message from another session"
            : "Injected message";
        pushSystem(turns, seen, label, stripReminders(text) || text, at);
      }
      continue;
    }
    if (record.type === "user" || record.type === "assistant") {
      const message = record.message;
      if (!message || typeof message !== "object") continue;
      if (
        record.type === "assistant" &&
        typeof message.model === "string" &&
        !meta.model
      )
        meta.model = message.model;
      turns.push(
        ...distillMessages([{ role: record.type, content: message.content }], {
          at,
          tools,
          seen,
        }),
      );
    } else if (record.type === "system" && record.subtype === "api_error") {
      turns.push(
        turn(
          "api_error",
          clip(String(record.content ?? "API error"), ERROR_LENGTH),
          null,
          at,
        ),
      );
    }
  }
  return { ...meta, turns: dedupe(turns) };
}

const TAGGED_BLOCK = /<([A-Za-z][\w-]*)>[\s\S]*?<\/\1>/g;

/**
 * Where a part of a Codex user message came from, when Codex wrote it: a
 * part made only of tagged blocks (`<recommended_plugins>`,
 * `<environment_context>`) or the AGENTS.md preamble. Null for typed text.
 */
function codexHarnessLabel(text) {
  const trimmed = text.trim();
  if (/^# AGENTS\.md instructions/.test(trimmed)) return "Instructions";
  const tags = [...trimmed.matchAll(TAGGED_BLOCK)].map((match) => match[1]);
  if (tags.length === 0 || trimmed.replace(TAGGED_BLOCK, "").trim())
    return null;
  return tags.map((tag) => CODEX_TAG_LABELS[tag] ?? tag).join(", ");
}

const CODEX_TAG_LABELS = {
  user_instructions: "Instructions",
  environment_context: "Environment",
};

/**
 * A Codex session file (`~/.codex/sessions/**\/*.jsonl`). Checked against
 * 1,874 rollouts from 2026-03 to 2026-11: tool calls are `function_call` or
 * `custom_tool_call` (exec, apply_patch), the model is on `turn_context`,
 * and the branch on `session_meta.git`.
 */
export function distillCodex(lines) {
  const turns = [];
  const seen = new Set();
  const meta = { sessionId: null, cwd: null, gitBranch: null, model: null };
  for (const line of lines) {
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object") continue;
    const payload = record.payload ?? {};
    const at = seconds(record.timestamp ?? payload.timestamp);
    if (record.type === "turn_context") {
      if (!meta.model && typeof payload.model === "string")
        meta.model = payload.model;
      continue;
    }
    if (record.type === "session_meta") {
      // A subagent's rollout opens with its own session_meta and then
      // repeats its parent's; the first one names the file's session.
      // Letting the last win filed 97 subagents under 36 parents' ids.
      if (meta.sessionId === null) {
        meta.sessionId = payload.id ?? null;
        meta.cwd = payload.cwd ?? null;
        meta.gitBranch = payload.git?.branch ?? null;
      }
      meta.model = meta.model ?? payload.model ?? null;
      const instructions =
        typeof payload.instructions === "string"
          ? payload.instructions
          : payload.base_instructions?.text;
      pushSystem(turns, seen, "System prompt", instructions, at);
      continue;
    }
    if (record.type !== "response_item") continue;
    if (payload.type === "message") {
      const raw = textOf(payload.content);
      // The developer role carries Codex's instructions; AGENTS.md and the
      // environment arrive as tagged user messages nobody typed.
      if (payload.role === "developer" || payload.role === "system") {
        pushSystem(turns, seen, "Developer instructions", raw, at);
        continue;
      }
      // One user message can hold several parts, harness text and typed
      // text side by side; each part is judged on its own.
      const parts = Array.isArray(payload.content)
        ? payload.content.map((part) => textOf([part]))
        : [raw];
      const typed = [];
      for (const part of parts) {
        const label = payload.role === "user" ? codexHarnessLabel(part) : null;
        if (label) pushSystem(turns, seen, label, part, at);
        else typed.push(part);
      }
      const rest = typed.join("\n");
      const text = stripReminders(rest);
      for (const reminder of remindersIn(rest))
        pushSystem(turns, seen, reminderLabel(reminder), reminder, at);
      if (!text) continue;
      if (payload.role === "user") turns.push(turn("human", text, null, at));
      else if (payload.role === "assistant")
        turns.push(turn("assistant", text, null, at));
    } else if (payload.type === "reasoning") {
      // The readable part is the summary; `content` is often absent or
      // encrypted.
      const text = [
        ...(payload.summary ?? []),
        ...(Array.isArray(payload.content) ? payload.content : []),
      ]
        .map((part) => (typeof part?.text === "string" ? part.text : ""))
        .join("\n\n")
        .trim();
      if (text) turns.push(turn("thinking", text, null, at));
    } else if (
      payload.type === "function_call" ||
      payload.type === "custom_tool_call"
    ) {
      let input = payload.arguments ?? payload.input;
      try {
        input = JSON.parse(input);
      } catch {}
      turns.push(
        turn(
          "tool_call",
          summarizeInput(input),
          String(payload.name ?? "unknown"),
          at,
        ),
      );
    }
  }
  return { ...meta, turns: dedupe(turns) };
}

/** OpenCode `session_message` rows (`{ type, data }`), in `seq` order. */
export function distillOpenCode(rows) {
  const turns = [];
  let model = null;
  for (const row of rows) {
    let data = row.data;
    if (typeof data === "string") {
      try {
        data = JSON.parse(data);
      } catch {
        continue;
      }
    }
    if (!data || typeof data !== "object") continue;
    const at = seconds(data.time?.created);
    if (row.type === "user") {
      const text = stripReminders(
        typeof data.text === "string"
          ? data.text
          : textOf(data.parts ?? data.content),
      );
      if (text) turns.push(turn("human", text, null, at));
    } else if (row.type === "assistant") {
      if (!model && data.model?.id) model = String(data.model.id);
      /*
       * OpenCode's session_message keeps an assistant turn's text, reasoning
       * and tool calls in `content`; `parts` is the older name. Reading only
       * `parts` sent every OpenCode session as prompts alone: 599 human
       * turns and no reply or tool call across 117 sessions (2026-11-08).
       */
      for (const part of data.content ?? data.parts ?? []) {
        if (!part || typeof part !== "object") continue;
        if (
          part.type === "text" &&
          typeof part.text === "string" &&
          part.text.trim()
        ) {
          turns.push(turn("assistant", part.text.trim(), null, at));
        } else if (
          part.type === "reasoning" &&
          typeof part.text === "string" &&
          part.text.trim()
        ) {
          turns.push(turn("thinking", part.text.trim(), null, at));
        } else if (part.type === "tool") {
          const name = String(part.name ?? part.tool ?? "unknown");
          turns.push(
            turn("tool_call", summarizeInput(part.state?.input), name, at),
          );
          if (part.state?.status === "error") {
            turns.push(
              turn(
                "tool_error",
                clip(
                  String(
                    part.state.error ??
                      part.state.output ??
                      (textOf(part.state.content) || "(no output)"),
                  ),
                  ERROR_LENGTH,
                ),
                name,
                at,
              ),
            );
          }
        }
      }
    } else if (row.type === "idle" && data.outcome === "failed" && data.error) {
      const error = data.error;
      turns.push(
        turn(
          "api_error",
          clip(
            typeof error === "string"
              ? error
              : `${error.type ?? "error"}: ${error.message ?? ""}`,
            ERROR_LENGTH,
          ),
          null,
          at,
        ),
      );
    }
  }
  return { model, turns: dedupe(turns) };
}

/**
 * The messages on a conversation's current branch, oldest first. Editing a
 * message or regenerating a reply forks the tree; the export keeps every
 * fork, and the branch the person last saw is the one walked back from the
 * leaf. `parentOf` returns a message's parent id, or nothing at the root.
 */
function activeBranch(byId, leaf, parentOf) {
  const out = [];
  const visited = new Set();
  for (let id = leaf; id && byId.has(id) && !visited.has(id); ) {
    visited.add(id);
    const message = byId.get(id);
    out.push(message);
    id = parentOf(message);
  }
  return out.reverse();
}

/**
 * One claude.ai conversation, as the account export (`conversations.json`)
 * or a single `conversation.json` holds it. Claude Desktop chats are
 * claude.ai chats. Pasted files go as system turns labelled with their
 * name, so a pasted key or log is readable in fetch and kept out of search.
 */
export function distillClaudeAi(conversation) {
  const messages = Array.isArray(conversation?.chat_messages)
    ? conversation.chat_messages
    : [];
  const byId = new Map(messages.map((m) => [m.uuid, m]));
  const leaf = conversation.current_leaf_message_uuid;
  const branch = byId.has(leaf)
    ? activeBranch(byId, leaf, (m) => m.parent_message_uuid)
    : [...messages].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const turns = [];
  const seen = new Set();
  for (const message of branch) {
    const at = seconds(message.created_at);
    const human = message.sender === "human";
    for (const file of message.attachments ?? []) {
      const name = file.file_name || `pasted ${file.file_type || "text"}`;
      pushSystem(
        turns,
        seen,
        `Attachment: ${name}`,
        file.extracted_content,
        at,
      );
    }
    const blocks = Array.isArray(message.content) ? message.content : [];
    if (blocks.length === 0 && typeof message.text === "string") {
      blocks.push({ type: "text", text: message.text });
    }
    for (const block of blocks) {
      if (!block || typeof block !== "object") continue;
      if (block.type === "text" && typeof block.text === "string") {
        const text = block.text.trim();
        if (text)
          turns.push(turn(human ? "human" : "assistant", text, null, at));
      } else if (
        block.type === "thinking" &&
        typeof block.thinking === "string"
      ) {
        const text = block.thinking.trim();
        if (text) turns.push(turn("thinking", text, null, at));
      } else if (block.type === "tool_use") {
        turns.push(
          turn(
            "tool_call",
            summarizeInput(block.input),
            String(block.name ?? "unknown"),
            at,
          ),
        );
      } else if (block.type === "tool_result" && block.is_error === true) {
        turns.push(
          turn(
            "tool_error",
            clip(textOf(block.content) || "(no output)", ERROR_LENGTH),
            String(block.name ?? "unknown"),
            at,
          ),
        );
      }
    }
  }
  return {
    sessionId: conversation.uuid ?? null,
    model: conversation.model ?? null,
    turns: dedupe(turns),
  };
}

/**
 * One ChatGPT conversation from the account export's `conversations.json`.
 * Tool output (browsing, code runs) stays out, as successful tool results
 * do for the coding clients; a call to a tool is kept with its recipient.
 */
export function distillChatGpt(conversation) {
  const mapping = conversation?.mapping ?? {};
  const byId = new Map(Object.entries(mapping));
  const branch = activeBranch(
    byId,
    conversation.current_node,
    (node) => node.parent,
  );
  const turns = [];
  const seen = new Set();
  for (const node of branch) {
    const message = node.message;
    if (!message) continue;
    const role = message.author?.role;
    const content = message.content ?? {};
    const at = seconds(message.create_time);
    const hidden = message.metadata?.is_visually_hidden_from_conversation;
    const strings = (parts) =>
      (Array.isArray(parts) ? parts : [])
        .filter((part) => typeof part === "string")
        .join("\n")
        .trim();
    if (content.content_type === "user_editable_context") {
      pushSystem(
        turns,
        seen,
        "Custom instructions",
        [content.user_profile, content.user_instructions]
          .filter((s) => typeof s === "string" && s.trim())
          .join("\n\n"),
        at,
      );
      continue;
    }
    if (role === "system") {
      pushSystem(turns, seen, "System", strings(content.parts), at);
      continue;
    }
    if (hidden || role === "tool") continue;
    if (role === "assistant" && content.content_type === "thoughts") {
      const text = (content.thoughts ?? [])
        .map((t) => [t.summary, t.content].filter(Boolean).join("\n"))
        .join("\n\n")
        .trim();
      if (text) turns.push(turn("thinking", text, null, at));
      continue;
    }
    if (
      role === "assistant" &&
      message.recipient &&
      message.recipient !== "all"
    ) {
      turns.push(
        turn(
          "tool_call",
          summarizeInput(content.text ?? strings(content.parts)),
          String(message.recipient),
          at,
        ),
      );
      continue;
    }
    if (
      content.content_type !== "text" &&
      content.content_type !== "multimodal_text"
    )
      continue;
    const text = strings(content.parts);
    if (!text) continue;
    if (role === "user") turns.push(turn("human", text, null, at));
    else if (role === "assistant")
      turns.push(turn("assistant", text, null, at));
  }
  return {
    sessionId: conversation.conversation_id ?? conversation.id ?? null,
    model: conversation.default_model_slug ?? null,
    turns: dedupe(turns),
  };
}

function turn(kind, text, toolName, at) {
  return { kind, text: clip(text, TEXT_LENGTH), tool_name: toolName, at };
}

/** Claude Code stores a tool_result's user record twice when a hook fires. */
function dedupe(turns) {
  return turns.filter((current, index) => {
    const previous = turns[index - 1];
    return !(
      previous &&
      previous.kind === current.kind &&
      previous.text === current.text &&
      previous.tool_name === current.tool_name
    );
  });
}

function seconds(value) {
  if (typeof value === "number")
    return Math.floor(value > 10_000_000_000 ? value / 1000 : value);
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
  }
  return null;
}

function oneLine(text) {
  return text.replace(/\s+/g, " ").trim();
}

function clip(text, max) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
