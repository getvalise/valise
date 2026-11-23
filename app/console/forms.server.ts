import { redirect } from "react-router";
import { z } from "zod";
import { MCP_SCOPES } from "~/auth/scopes";
import {
  type ReservedKey,
  type RoutedTags,
  routeReservedTags,
} from "~/concepts/facets";
import { HOOK_EVENTS, type HookConfigEdit } from "~/concepts/hook-config";
import { MEMORY_LINK_KINDS } from "~/concepts/memory-links";
import { parseQuickAdd } from "~/concepts/quick-add";
import type { SkillChange } from "~/concepts/skills";
import type { TodoRef } from "~/concepts/todo-contracts";

/**
 * What a console write answers once it has landed. A form posted through a
 * fetcher carries `via=fetcher` and gets data back, so the page keeps its URL
 * (and `?open=`) and React Router revalidates in place. A form posted as a
 * document, with scripting off, gets the redirect, so a reload does not post
 * it twice. P11.
 */
export function afterSave(form: FormData, href: string) {
  return form.get("via") === "fetcher" ? { saved: true } : redirect(href);
}

const tags = z.array(z.string().trim().min(1).max(100)).max(20);

/**
 * A tag list as the MCP writes take it: `project:x` and `type:x` go to their
 * columns, and a reserved key with no column here is a 400 rather than a tag.
 * Without this a person could store `project:valise` as a tag that the
 * project filter never sees. ADR-0009.
 */
function routedTags<K extends ReservedKey>(
  list: string[],
  columns: Partial<Record<K, string | undefined>>,
): RoutedTags<K> {
  const routed = routeReservedTags(list, columns);
  if ("error" in routed) throw new Response(routed.error, { status: 400 });
  return routed;
}

const refs = z
  .array(
    z.object({
      kind: z.string().trim().min(1).max(32),
      value: z.string().trim().min(1).max(500),
    }),
  )
  .max(20);

/** The console-editable half of a to-do; a field patch is a slice of it. */
export type TodoEditForm = {
  id: string;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
  refs: TodoRef[];
};

/** The console-editable half of a memory; a field patch is a slice of it. */
export type MemoryEditForm = {
  id: string;
  type: string;
  title: string;
  body: string;
  project: string | null;
  tags: string[];
};

/**
 * The inline editor posts one field, so each one is parsed on its own rather
 * than as a hole in a whole-record form. A field the switch does not know is
 * a 400, not a silent no-op, because the alternative is a Save button that
 * appears to work.
 */
export function parseTodoFieldEdit(form: FormData): {
  id: string;
  patch: Partial<TodoEditForm>;
  /** Tags written in the title, added to the ones the to-do already has. */
  addTags?: string[];
} {
  const id = valid(
    z
      .string()
      .regex(/^todo:[^:\s]+$/)
      .safeParse(form.get("id")),
  );
  const field = valid(
    z
      .enum(["title", "body", "project", "tags", "refs"])
      .safeParse(form.get("field")),
  );
  const raw = form.get("value");
  switch (field) {
    case "title": {
      // The composer's grammar, so `Fix ranking project:valise #duckdb`
      // means the same in either place: the words are the title, facets and
      // #tags join the tags already there, and `project:` sets the column.
      const parsed = parseQuickAdd(String(raw ?? ""));
      if ("error" in parsed) throw new Response(parsed.error, { status: 400 });
      return {
        id,
        patch: {
          title: parsed.title,
          ...(parsed.project === null ? {} : { project: parsed.project }),
        },
        addTags: parsed.tags,
      };
    }
    case "body":
      return {
        id,
        patch: {
          body: valid(
            z
              .string()
              .trim()
              .max(16 * 1024)
              .safeParse(raw),
          ),
        },
      };
    case "project":
      return {
        id,
        patch: { project: valid(optionalText(200).safeParse(raw)) },
      };
    case "tags": {
      // The tag field's one commit may also set the project, because that
      // is where the person wrote it (P2 is about stale values, and this
      // one is fresh).
      const { tags: kept, routed } = routedTags<"project">(
        valid(tags.safeParse(parseTags(raw))),
        { project: undefined },
      );
      return { id, patch: { tags: kept, ...routed } };
    }
    case "refs":
      return {
        id,
        patch: {
          refs: valid(
            refs.safeParse(
              parseRefs(form.getAll("ref-kind"), form.getAll("ref-value")),
            ),
          ),
        },
      };
  }
}

export function parseMemoryFieldEdit(form: FormData): {
  id: string;
  patch: Partial<MemoryEditForm>;
} {
  const id = valid(
    z
      .string()
      .regex(/^memory:[^:\s]+$/)
      .safeParse(form.get("id")),
  );
  const field = valid(
    z
      .enum(["type", "title", "body", "project", "tags"])
      .safeParse(form.get("field")),
  );
  const raw = form.get("value");
  switch (field) {
    case "type":
      return {
        id,
        patch: {
          type: valid(z.string().trim().min(1).max(100).safeParse(raw)),
        },
      };
    case "title":
      return {
        id,
        patch: { title: valid(z.string().trim().max(500).safeParse(raw)) },
      };
    case "body":
      return {
        id,
        patch: {
          body: valid(
            z
              .string()
              .trim()
              .min(1)
              .max(16 * 1024)
              .safeParse(raw),
          ),
        },
      };
    case "project":
      return {
        id,
        patch: { project: valid(optionalText(200).safeParse(raw)) },
      };
    case "tags": {
      const { tags: kept, routed } = routedTags<"project" | "type">(
        valid(tags.safeParse(parseTags(raw))),
        { project: undefined, type: undefined },
      );
      return { id, patch: { tags: kept, ...routed } };
    }
  }
}

export type TaskToggleForm = { id: string; line: number; was: boolean };

/**
 * One submit button per checkbox, so the value carries both halves: the
 * source line to change and the state that line was rendered in. The second
 * half is the optimistic check — a card that has gone stale posts a `was`
 * the body no longer agrees with, and the write is refused.
 */
export function parseTaskToggle(form: FormData): TaskToggleForm {
  const parsed = z
    .object({
      id: z.string().regex(/^todo:[^:\s]+$/),
      task: z.string().regex(/^\d{1,6}:[01]$/),
    })
    .safeParse({ id: form.get("id"), task: form.get("task") });
  const value = valid(parsed);
  const [line, was] = value.task.split(":");
  return { id: value.id, line: Number(line), was: was === "1" };
}

export type TaskAddForm = { id: string; text: string };

export function parseTaskAdd(form: FormData): TaskAddForm {
  const parsed = z
    .object({
      id: z.string().regex(/^todo:[^:\s]+$/),
      // One line: a subtask that needs a paragraph is a to-do of its own.
      text: z
        .string()
        .trim()
        .min(1)
        .max(500)
        .transform((value) => value.replace(/\s*\n\s*/g, " ")),
    })
    .safeParse({ id: form.get("id"), text: form.get("text") });
  return valid(parsed);
}

export type TodoCommentForm = { id: string; body: string };

/** The same limits `comment_todo` puts on an agent's comment. */
export function parseTodoComment(form: FormData): TodoCommentForm {
  const parsed = z
    .object({
      id: z.string().regex(/^todo:[^:\s]+$/),
      body: z
        .string()
        .trim()
        .min(1)
        .max(16 * 1024),
    })
    .safeParse({ id: form.get("id"), body: form.get("body") });
  return valid(parsed);
}

export type TodoStateForm = {
  id: string;
  state: "pending" | "blocked" | "done";
  note: string;
};

export function parseTodoState(form: FormData): TodoStateForm {
  const parsed = z
    .object({
      id: z.string().regex(/^todo:[^:\s]+$/),
      state: z.enum(["pending", "blocked", "done"]),
      note: z.string().trim().max(500),
    })
    .safeParse({
      id: form.get("id"),
      state: form.get("state"),
      note: form.get("note") ?? "",
    });
  return valid(parsed);
}

export function parseMemoryId(form: FormData): string {
  const parsed = z
    .string()
    .regex(/^memory:[^:\s]+$/)
    .safeParse(form.get("id"));
  return valid(parsed).slice("memory:".length);
}

export function parseMemoryLinkEdit(form: FormData) {
  return valid(
    z
      .discriminatedUnion("action", [
        z.object({
          action: z.literal("add"),
          target: z.string().regex(/^memory:[^:\s]+$/),
          kind: z.enum(MEMORY_LINK_KINDS),
        }),
        z.object({
          action: z.enum(["confirm", "remove", "restore"]),
          link: z.string().regex(/^mln_[^:\s]+$/),
        }),
      ])
      .safeParse(Object.fromEntries(form)),
  );
}

export function parseFileChange(form: FormData) {
  return valid(
    z
      .object({
        id: z.string().regex(/^(todo|memory):[^:\s]+$/),
        objectId: z.string().regex(/^obj_[a-zA-Z0-9-]+$/),
        intent: z.enum(["detach-file", "restore-file"]),
      })
      .safeParse({
        id: form.get("id"),
        objectId: form.get("objectId"),
        intent: form.get("intent"),
      }),
  );
}

/**
 * A written SKILL.md. Line endings go to LF, because a textarea posts CRLF
 * whatever it was given, and the stored body is what agents read and what
 * the digest is taken over.
 */
export function parseSkillDraft(form: FormData): string {
  return valid(
    z
      .string()
      .trim()
      .min(1)
      .max(256 * 1024)
      .transform((body) => body.replaceAll("\r\n", "\n"))
      .safeParse(form.get("body")),
  );
}

/** The project and tags an Add skill preview posts with its publish. */
export function parseSkillLabels(form: FormData): {
  project: string | undefined;
  tags: string[] | undefined;
} {
  const value = valid(
    z.object({ project: optionalText(200), tags }).safeParse({
      project: form.get("project") ?? "",
      tags: parseTags(form.get("tags")),
    }),
  );
  const { tags: kept, routed } = routedTags<"project">(value.tags, {
    project: value.project ?? undefined,
  });
  return {
    project: routed.project ?? value.project ?? undefined,
    tags: kept.length ? kept : undefined,
  };
}

export type SkillEditForm = { name: string; body: string };

/**
 * An edit of one skill's SKILL.md. Not trimmed, unlike a fresh publish: the
 * body is compared with the head's digest, and a trailing newline the head
 * has would otherwise count as a change.
 */
export function parseSkillEdit(form: FormData): SkillEditForm {
  const parsed = z
    .object({
      name: z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/),
      body: z
        .string()
        .min(1)
        .max(256 * 1024),
    })
    .safeParse({ name: form.get("skill"), body: form.get("body") });
  return valid(parsed);
}

/** One of a skill's labels, the way a memory's field pen posts it. P2. */
export function parseSkillFieldEdit(form: FormData): {
  name: string;
  patch: { project?: string | null; tags?: string[] };
} {
  const name = valid(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
      .safeParse(form.get("skill")),
  );
  const field = valid(z.enum(["project", "tags"]).safeParse(form.get("field")));
  const raw = form.get("value");
  if (field === "project") {
    return {
      name,
      patch: { project: valid(optionalText(200).safeParse(raw)) ?? null },
    };
  }
  const { tags: kept, routed } = routedTags<"project">(
    valid(tags.safeParse(parseTags(raw))),
    { project: undefined },
  );
  return {
    name,
    patch: routed.project
      ? { tags: kept, project: routed.project }
      : { tags: kept },
  };
}

/** The skill a dialog action names, under `skill`. */
export function parseSkillName(form: FormData): string {
  return valid(
    z
      .string()
      .regex(/^[a-z0-9][a-z0-9-]{0,99}$/)
      .safeParse(form.get("skill")),
  );
}

export type GithubBatchForm = {
  owner: string;
  repo: string;
  sha: string;
  paths: string[];
};

/**
 * The ticked folders of one repository listing, pinned to the commit the
 * listing was read at, so what publishes is what was listed. `""` is a
 * skill at the repository root.
 */
export function parseGithubBatch(form: FormData): GithubBatchForm {
  const name = z.string().regex(/^[\w.-]{1,100}$/);
  return valid(
    z
      .object({
        owner: name,
        repo: name,
        sha: z.string().regex(/^[0-9a-f]{40}$/),
        paths: z
          .array(
            z
              .string()
              .max(500)
              .refine((path) => !path.split("/").includes(".."), {
                message: "A path cannot climb out of the repository.",
              }),
          )
          .min(1, { message: "Tick at least one skill to import." })
          .max(100),
      })
      .safeParse({
        owner: form.get("owner"),
        repo: form.get("repo"),
        sha: form.get("sha"),
        paths: form.getAll("path"),
      }),
  );
}

export type SkillChangeForm = {
  change: SkillChange | "update";
  names: string[];
};

/**
 * One change over every `skill` the form carries: the dialog's one name, or
 * the rows ticked in the list. An empty list is valid; nothing was ticked.
 */
export function parseSkillChange(form: FormData): SkillChangeForm {
  return valid(
    z
      .object({
        change: z.enum([
          "enable",
          "disable",
          "delete",
          "restore",
          "auto-on",
          "auto-off",
          "update",
        ]),
        names: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{0,99}$/)).max(500),
      })
      .safeParse({ change: form.get("change"), names: form.getAll("skill") }),
  );
}

export type TokenMintForm = { label: string; scopes: string[] };

export function parseTokenMint(form: FormData): TokenMintForm {
  const parsed = z
    .object({
      label: z.string().trim().min(1).max(120),
      scopes: z.array(z.enum(MCP_SCOPES)).min(1),
    })
    .safeParse({ label: form.get("label"), scopes: form.getAll("scope") });
  return valid(parsed);
}

export function parseTokenId(form: FormData): string {
  const parsed = z
    .string()
    .regex(/^btk_[^:\s]+$/)
    .safeParse(form.get("id"));
  return valid(parsed);
}

/**
 * One field of one hook entry, or an entry added or removed. Length and the
 * per-event total are `editHookConfig`'s to judge, so the person sees the
 * same sentence the hook script would print.
 */
export function parseHookConfigEdit(form: FormData): HookConfigEdit {
  const id = z.string().regex(/^[a-z0-9-]{1,40}$/);
  const parsed = z
    .discriminatedUnion("intent", [
      z.object({ intent: z.literal("text"), id, value: z.string() }),
      z.object({
        intent: z.literal("enabled"),
        id,
        enable: z.enum(["on", "off"]),
      }),
      z.object({
        intent: z.literal("every-turns"),
        id,
        value: z.coerce.number(),
      }),
      z.object({
        intent: z.literal("add"),
        event: z.enum(HOOK_EVENTS),
        value: z.string(),
      }),
      z.object({ intent: z.literal("remove"), id }),
    ])
    .safeParse(Object.fromEntries(form));
  const value = valid(parsed);
  switch (value.intent) {
    case "text":
      return { kind: "text", id: value.id, text: value.value };
    case "enabled":
      return { kind: "enabled", id: value.id, enabled: value.enable === "on" };
    case "every-turns":
      return { kind: "every-turns", id: value.id, everyTurns: value.value };
    case "add":
      return { kind: "add", event: value.event, text: value.value };
    case "remove":
      return { kind: "remove", id: value.id };
  }
}

export function parseOAuthClientId(form: FormData): string {
  const parsed = z.string().trim().min(1).max(2_000).safeParse(form.get("id"));
  return valid(parsed);
}

function optionalText(maximum: number) {
  return z
    .string()
    .trim()
    .max(maximum)
    .transform((value) => value || null);
}

/**
 * One pointer per `ref-kind`/`ref-value` pair, in row order. A row with no
 * value is the editor's blank one and is dropped. A row with no kind is a
 * bare pointer: a link if it looks like one, a file path otherwise. Typing
 * `url` is not the point of the form. Any other kind is kept as written,
 * because `create_todo` accepts a coined one too.
 */
function parseRefs(
  kinds: readonly unknown[],
  values: readonly unknown[],
): TodoRef[] {
  return values.flatMap((raw, index) => {
    const value = String(raw).trim();
    if (value === "") return [];
    const kind = String(kinds[index] ?? "").trim();
    return [
      { kind: kind || (/^https?:\/\//.test(value) ? "url" : "file"), value },
    ];
  });
}

function parseTags(value: unknown): string[] {
  if (typeof value !== "string" || !value.trim()) return [];
  return value
    .split(",")
    .map((tag) => tag.trim())
    .filter(Boolean);
}

function valid<T>(result: z.ZodSafeParseResult<T>): T {
  if (result.success) return result.data;
  throw new Response(
    result.error.issues.map((issue) => issue.message).join(" "),
    {
      status: 400,
    },
  );
}

/** A comma-separated tag field: trimmed, blanks dropped, first spelling kept. */
export function tagsOf(value: string): string[] {
  return [
    ...new Set(
      value
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
    ),
  ];
}
