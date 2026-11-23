/**
 * The hook config document, one per user. The server is its only source; a
 * client's `~/.valise/config.json` is a cache of it, refreshed in the
 * background by `clients/valise/scripts/valise-hook.mjs`. ADR-0004, 2026-10-17.
 *
 * The console edits the document one field at a time (P2) through
 * `editHookConfig`, which rewrites only what differs from the shipped
 * defaults, so a default the plugin changes later still reaches a user who
 * never touched it. The rules mirror `parseConfig` in the hook script, and
 * `test/clients/hook-config-parity.test.ts` holds the two to the same answers.
 */

/** What a user who never saved a document gets: every shipped default. */
export const EMPTY_HOOK_CONFIG = "{}";

export const MAX_HOOK_TEXT_LENGTH = 2000;
export const MAX_HOOK_EVENT_TEXT_LENGTH = 8000;

export const HOOK_EVENTS = [
  "SessionStart",
  "Stop",
  "PostToolUseFailure",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

/** In the hook script's `CONTRACT` order. */
export const SHIPPED_HOOKS = {
  "capture-nudge": {
    event: "Stop",
    label: "Capture nudge",
    defaults: {
      enabled: true,
      every_turns: 10,
      text:
        "If this session produced a decision, insight, or dead end another session " +
        "would pay to rediscover, and Valise's save_memory tool is available, save " +
        "it following the capture-this skill. Leave unfinished work as a to-do " +
        "whose next step copies identifiers, paths and values exactly as the user " +
        "or a tool gave them; never invent a command. If nothing new came up or " +
        "it is already saved, saving nothing is fine: stop.",
    },
  },
  "recall-reminder": {
    event: "SessionStart",
    label: "Recall reminder",
    defaults: {
      enabled: true,
      text:
        "Valise is connected. Before re-deriving prior work, search it for " +
        "decisions and skills. When a command fails with an error the message " +
        "itself does not explain how to fix, search Valise for the error text " +
        "before trying something else. When you leave work for another session, " +
        "name its next step with identifiers, file paths and values exactly as " +
        "the user or a tool gave them. Never invent a command nobody gave.",
    },
  },
  "recall-on-error": {
    event: "PostToolUseFailure",
    label: "Recall on error",
    defaults: {
      enabled: true,
      text:
        "This command failed. Unless the error is a typo in the command you just " +
        "ran, search Valise for the error text before trying something else; a " +
        "stored memory may explain it.",
    },
  },
} as const;

export type ShippedHookId = keyof typeof SHIPPED_HOOKS;

/** One injection as the console shows it. Custom ids are `custom-<index>`. */
export type HookEntry = {
  id: string;
  label: string;
  shipped: boolean;
  event: HookEvent;
  text: string;
  enabled: boolean;
  /** Stop entries only. */
  everyTurns: number | null;
  /** The shipped text, when this entry has one to go back to. */
  defaultText: string | null;
};

type ShippedOverride = {
  enabled?: boolean;
  every_turns?: number;
  text?: string;
};
type CustomEntry = {
  event: HookEvent;
  text: string;
  enabled?: boolean;
  every_turns?: number;
};
type Document = {
  "recall-reminder"?: ShippedOverride;
  "capture-nudge"?: ShippedOverride;
  "recall-on-error"?: ShippedOverride;
  custom?: CustomEntry[];
};

export type HookConfigEdit =
  | { kind: "text"; id: string; text: string }
  | { kind: "enabled"; id: string; enabled: boolean }
  | { kind: "every-turns"; id: string; everyTurns: number }
  | { kind: "add"; event: HookEvent; text: string }
  | { kind: "remove"; id: string };

export async function readHookConfig(
  env: { DB: D1Database },
  userId: string,
): Promise<{ document: string; updatedAt: number | null }> {
  const row = await env.DB.prepare(
    "SELECT document, updated_at AS updatedAt FROM hook_configs WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ document: string; updatedAt: number }>();
  return row ?? { document: EMPTY_HOOK_CONFIG, updatedAt: null };
}

export async function writeHookConfig(
  env: { DB: D1Database },
  userId: string,
  document: string,
): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO hook_configs (user_id, document, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE
          SET document = excluded.document, updated_at = excluded.updated_at`,
  )
    .bind(userId, document, Math.floor(Date.now() / 1000))
    .run();
}

/** Every entry, shipped first, or the reason the hook script would refuse it. */
export function hookEntries(
  text: string,
): { entries: HookEntry[] } | { error: string } {
  const parsed = parseDocument(text);
  if ("error" in parsed) return parsed;
  const entries = entriesOf(parsed.document);
  const error = validateEntries(entries);
  return error ? { error } : { entries };
}

/**
 * The MCP `instructions` a client receives at `initialize` or
 * `server/discover`, built from the same document the hooks read, so one
 * edit reaches both channels. Every client gets the enabled SessionStart
 * entries: the plugin header says the plugin is installed, not that its hooks
 * ran (Codex skips untrusted ones). A client without the header has no hook
 * runtime, so the Stop and PostToolUseFailure entries reach it here as
 * standing rules instead. Null for a document the hooks would refuse, or when
 * every entry is off.
 */
export function serverInstructions(
  text: string,
  caller: { hooks: boolean },
): string | null {
  const read = hookEntries(text);
  if ("error" in read) return null;
  const enabled = (event: HookEvent) =>
    read.entries
      .filter((entry) => entry.enabled && entry.event === event)
      .map((entry) => entry.text);
  const sections = [enabled("SessionStart").join("\n\n")];
  if (!caller.hooks) {
    for (const [event, heading] of STANDING_RULE_HEADINGS) {
      const texts = enabled(event);
      if (texts.length) sections.push(`${heading}\n${texts.join("\n\n")}`);
    }
  }
  const joined = sections.filter(Boolean).join("\n\n");
  return joined === "" ? null : joined;
}

/** The moment each hook-only event stands for, when no hook can mark it. */
const STANDING_RULE_HEADINGS = [
  ["PostToolUseFailure", "Whenever a shell command fails:"],
  ["Stop", "Before you end a turn:"],
] as const;

/** Applies one field's change and returns the new document text. */
export function editHookConfig(
  text: string,
  edit: HookConfigEdit,
): { document: string } | { error: string } {
  const parsed = parseDocument(text);
  if ("error" in parsed) return parsed;
  const entries = entriesOf(parsed.document);

  if (edit.kind === "add") {
    entries.push({
      id: `custom-${entries.filter((entry) => !entry.shipped).length}`,
      label: "Custom",
      shipped: false,
      event: edit.event,
      text: edit.text.trim(),
      enabled: true,
      everyTurns: edit.event === "Stop" ? 1 : null,
      defaultText: null,
    });
  } else {
    const index = entries.findIndex((entry) => entry.id === edit.id);
    const entry = entries[index];
    if (entry === undefined) return { error: "That entry no longer exists." };
    if (edit.kind === "remove") {
      if (entry.shipped) return { error: "A shipped entry can only be off." };
      entries.splice(index, 1);
    } else if (edit.kind === "text") {
      entry.text = edit.text.trim();
    } else if (edit.kind === "enabled") {
      entry.enabled = edit.enabled;
    } else {
      if (entry.event !== "Stop") {
        return { error: "Only a Stop entry repeats every few turns." };
      }
      entry.everyTurns = edit.everyTurns;
    }
  }

  const error = validateEntries(entries);
  return error ? { error } : { document: serialize(entries) };
}

function parseDocument(
  text: string,
): { document: Document } | { error: string } {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { error: "config is not valid JSON" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { error: "config must be a JSON object" };
  }
  for (const [key, value] of Object.entries(data)) {
    if (key === "custom") {
      if (!Array.isArray(value)) return { error: '"custom" must be an array' };
      for (const [index, entry] of value.entries()) {
        const error = unknownField(`custom[${index}]`, entry, CUSTOM_FIELDS);
        if (error) return { error };
        if (entry.event !== "Stop" && "every_turns" in entry) {
          return {
            error: `"custom[${index}].every_turns" is only valid when event is "Stop"`,
          };
        }
      }
      continue;
    }
    if (!(key in SHIPPED_HOOKS)) {
      return { error: `unknown config key "${key}"` };
    }
    const fields = Object.keys(SHIPPED_HOOKS[key as ShippedHookId].defaults);
    const error = unknownField(key, value, fields);
    if (error) return { error };
  }
  return { document: data as Document };
}

const CUSTOM_FIELDS = ["event", "text", "enabled", "every_turns"];

function unknownField(
  label: string,
  value: unknown,
  fields: readonly string[],
): string | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return `"${label}" must be an object`;
  }
  const extra = Object.keys(value).find((field) => !fields.includes(field));
  return extra === undefined ? null : `unknown field "${extra}" on "${label}"`;
}

function entriesOf(document: Document): HookEntry[] {
  const entries: HookEntry[] = [];
  for (const id of Object.keys(SHIPPED_HOOKS) as ShippedHookId[]) {
    const shipped = SHIPPED_HOOKS[id];
    const override = document[id] ?? {};
    const defaults: ShippedOverride = shipped.defaults;
    entries.push({
      id,
      label: shipped.label,
      shipped: true,
      event: shipped.event,
      text: override.text ?? shipped.defaults.text,
      enabled: override.enabled ?? shipped.defaults.enabled,
      everyTurns:
        shipped.event === "Stop"
          ? (override.every_turns ?? defaults.every_turns ?? 1)
          : null,
      defaultText: shipped.defaults.text,
    });
  }
  (document.custom ?? []).forEach((custom, index) => {
    entries.push({
      id: `custom-${index}`,
      label: "Custom",
      shipped: false,
      event: custom.event,
      text: custom.text,
      enabled: custom.enabled ?? true,
      everyTurns: custom.event === "Stop" ? (custom.every_turns ?? 1) : null,
      defaultText: null,
    });
  });
  return entries;
}

function validateEntries(entries: HookEntry[]): string | null {
  for (const entry of entries) {
    if (!HOOK_EVENTS.includes(entry.event)) {
      return `"${entry.id}.event" must be "Stop", "SessionStart" or "PostToolUseFailure"`;
    }
    if (
      typeof entry.text !== "string" ||
      entry.text.length === 0 ||
      entry.text.length > MAX_HOOK_TEXT_LENGTH
    ) {
      return `"${entry.id}.text" must be a non-empty string of at most ${MAX_HOOK_TEXT_LENGTH} characters`;
    }
    if (typeof entry.enabled !== "boolean") {
      return `"${entry.id}.enabled" must be a boolean`;
    }
    if (
      entry.everyTurns !== null &&
      (!Number.isInteger(entry.everyTurns) || entry.everyTurns < 1)
    ) {
      return `"${entry.id}.every_turns" must be an integer >= 1`;
    }
  }
  for (const event of HOOK_EVENTS) {
    const total = entries
      .filter((entry) => entry.event === event && entry.enabled)
      .reduce((sum, entry) => sum + entry.text.length, 0);
    if (total > MAX_HOOK_EVENT_TEXT_LENGTH) {
      return `combined enabled "${event}" text exceeds ${MAX_HOOK_EVENT_TEXT_LENGTH} characters`;
    }
  }
  return null;
}

/** Shipped entries keep only what differs from their defaults. */
function serialize(entries: HookEntry[]): string {
  const document: Document = {};
  for (const entry of entries) {
    if (entry.shipped) {
      const id = entry.id as ShippedHookId;
      const defaults: ShippedOverride = SHIPPED_HOOKS[id].defaults;
      const override: ShippedOverride = {};
      if (entry.enabled !== defaults.enabled) override.enabled = entry.enabled;
      if (
        entry.everyTurns !== null &&
        entry.everyTurns !== defaults.every_turns
      )
        override.every_turns = entry.everyTurns;
      if (entry.text !== defaults.text) override.text = entry.text;
      if (Object.keys(override).length) document[id] = override;
      continue;
    }
    const custom: CustomEntry = { event: entry.event, text: entry.text };
    if (!entry.enabled) custom.enabled = false;
    if (entry.everyTurns !== null && entry.everyTurns !== 1)
      custom.every_turns = entry.everyTurns;
    document.custom ??= [];
    document.custom.push(custom);
  }
  return JSON.stringify(document, null, 2);
}
