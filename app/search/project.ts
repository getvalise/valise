import type { SearchConcept } from "~/db/schema";

/**
 * The semantic half of publish discipline, per ADR-0001. App code decides which
 * fields, which version, and how much. The triggers on `search_docs` own only
 * the mechanical index sync.
 *
 * Every concept exports one `project(row)` returning a projection row, or null
 * to unpublish. The five content columns are frozen: anything a future concept
 * wants searchable composes into title, body, or tags here.
 */

export const MAX_BODY_BYTES = 16 * 1024;

export type ProjectionRow = {
  docKey: string;
  /** The owner of the source row. Search filters on it. ADR-0016. */
  userId: string;
  concept: SearchConcept;
  conceptId: string;
  project: string | null;
  title: string;
  body: string;
  tags: string;
  updatedAt: number;
};

export function docKey(concept: SearchConcept, conceptId: string): string {
  return `${concept}:${conceptId}`;
}

/** Truncates on a UTF-8 byte budget without splitting a code point. */
export function capBody(body: string, maxBytes = MAX_BODY_BYTES): string {
  const encoded = new TextEncoder().encode(body);
  if (encoded.byteLength <= maxBytes) return body;
  let end = maxBytes;
  // Walk back off any continuation byte so the cut lands on a code point edge.
  while (end > 0 && (encoded[end] & 0b1100_0000) === 0b1000_0000) end--;
  return new TextDecoder().decode(encoded.subarray(0, end));
}

/** Tags are stored as a JSON array and searched as a space-joined string. */
export function joinTags(tagsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(tagsJson);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  return parsed.filter((t) => typeof t === "string").join(" ");
}

export type SkillSource = {
  skillId: string;
  userId: string;
  name: string;
  tagsJson: string;
  project: string | null;
  deletedAt: number | null;
  /** Off is unpublished: a disabled skill must not surface in agent search. */
  disabledAt: number | null;
  updatedAt: number;
  /** The head version body. Null when the skill has no version yet. */
  headBodyMd: string | null;
};

/** Head versions only. A superseded SKILL.md never enters the ranking. */
export function projectSkill(skill: SkillSource): ProjectionRow | null {
  if (skill.deletedAt !== null) return null;
  if (skill.disabledAt !== null) return null;
  if (skill.headBodyMd === null) return null;
  return {
    docKey: docKey("skill", skill.skillId),
    userId: skill.userId,
    concept: "skill",
    conceptId: skill.skillId,
    project: skill.project,
    title: skill.name,
    body: capBody(skill.headBodyMd),
    tags: joinTags(skill.tagsJson),
    updatedAt: skill.updatedAt,
  };
}

export type MemorySource = {
  memoryId: string;
  userId: string;
  memoryType: string;
  title: string | null;
  body: string;
  tagsJson: string;
  project: string | null;
  deletedAt: number | null;
  superseded?: boolean;
  updatedAt: number;
};

export function projectMemory(memory: MemorySource): ProjectionRow | null {
  if (memory.deletedAt !== null || memory.superseded) return null;
  const tags = joinTags(memory.tagsJson);
  return {
    docKey: docKey("memory", memory.memoryId),
    userId: memory.userId,
    concept: "memory",
    conceptId: memory.memoryId,
    project: memory.project,
    title: memory.title ?? "",
    body: capBody(memory.body),
    // The type is a filter column on `memories` and a search term here, so a
    // query for "feedback" finds feedback memories without a filter.
    tags: [tags, memory.memoryType].filter(Boolean).join(" "),
    updatedAt: memory.updatedAt,
  };
}

export type TodoSource = {
  todoId: string;
  userId: string;
  title: string;
  body: string;
  tagsJson: string;
  refsJson: string;
  project: string | null;
  updatedAt: number;
  /** Comment bodies, newline-joined. Absent means none. */
  comments?: string;
};

/** To-dos project in every state. A closed ticket stays findable. */
export function projectTodo(todo: TodoSource): ProjectionRow | null {
  const refs = joinRefValues(todo.refsJson);
  return {
    docKey: docKey("todo", todo.todoId),
    userId: todo.userId,
    concept: "todo",
    conceptId: todo.todoId,
    project: todo.project,
    title: todo.title,
    // Pointers ride in the body so a query for a path or a repo finds the
    // ticket about it. Appended, not prepended: the body's first words are
    // what a search snippet shows.
    // Comments ride after the pointers for the same reason: a question
    // asked on a to-do should find it, but the snippet stays the body.
    body: capBody([todo.body, refs, todo.comments].filter(Boolean).join("\n")),
    tags: joinTags(todo.tagsJson),
    updatedAt: todo.updatedAt,
  };
}

/** `[{kind, value}]` searched as the values, space-joined. */
function joinRefValues(refsJson: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(refsJson);
  } catch {
    return "";
  }
  if (!Array.isArray(parsed)) return "";
  return parsed
    .map((ref) =>
      typeof ref === "object" && ref !== null && "value" in ref
        ? String((ref as { value: unknown }).value)
        : "",
    )
    .filter(Boolean)
    .join(" ");
}

export type AssetSource = {
  assetId: string;
  userId: string;
  state: string;
  title: string;
  fileName: string;
  description: string;
  tagsJson: string;
  project: string | null;
  archivedAt: number | null;
  updatedAt: number;
  /** Bounded derived text; never generated metadata awaiting acceptance. */
  extractedText?: string | null;
};

/**
 * Ready, unarchived assets, metadata and the bounded processing head's text.
 * ADR-0015. Expiry is a read-time rule, not a
 * projection one: search drops an expired asset before cleanup removes it.
 */
export function projectAsset(asset: AssetSource): ProjectionRow | null {
  if (asset.state !== "ready" || asset.archivedAt !== null) return null;
  return {
    docKey: docKey("asset", asset.assetId),
    userId: asset.userId,
    concept: "asset",
    conceptId: asset.assetId,
    project: asset.project,
    title: asset.title,
    body: [asset.fileName, asset.description, asset.extractedText ?? ""].join(
      "\n",
    ),
    tags: joinTags(asset.tagsJson),
    updatedAt: asset.updatedAt,
  };
}

export type SourceProjection = {
  sourceId: string;
  userId: string;
  title: string;
  url: string | null;
  notes: string;
  tagsJson: string;
  project: string | null;
  archivedAt: number | null;
  updatedAt: number;
  /** JSON array of author names; absent for rows written before authors. */
  authorsJson?: string;
  /** Plain text of the newest extracted article, when one was detected. */
  articleText?: string | null;
};

/**
 * The head revision of an unarchived source: title, URL, authors, notes,
 * tags, and the text of the article a client extracted at capture. Valise
 * never fetches the page and never reads a linked file. Notes and articles
 * past the 16KB cap stay whole in the source; only search stops there.
 */
export function projectSource(source: SourceProjection): ProjectionRow | null {
  if (source.archivedAt !== null) return null;
  return {
    docKey: docKey("source", source.sourceId),
    userId: source.userId,
    concept: "source",
    conceptId: source.sourceId,
    project: source.project,
    title: source.title,
    body: capBody(
      [
        source.url,
        joinTags(source.authorsJson ?? "[]"),
        source.notes,
        source.articleText,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
    tags: joinTags(source.tagsJson),
    updatedAt: source.updatedAt,
  };
}

/** The session as search sees it: its title, then the turns until the cap. */
export function projectTranscript(
  transcript: {
    transcriptId: string;
    userId: string;
    project: string | null;
    title: string;
    client: string;
    updatedAt: number;
  },
  turns: readonly {
    kind: string;
    toolName: string | null;
    text: string;
  }[],
): ProjectionRow {
  return {
    docKey: docKey("transcript", transcript.transcriptId),
    userId: transcript.userId,
    concept: "transcript",
    conceptId: transcript.transcriptId,
    project: transcript.project,
    title: transcript.title || `Session in ${transcript.client}`,
    body: capBody(
      turns
        // Thinking is the agent's working, not what the session said; a
        // search that matched it would surface a session for a guess it
        // discarded. System text is the same CLAUDE.md and system prompt in
        // every session, so it would match all of them. ADR-0022,
        // amendments of 2026-11-08.
        .filter((turn) => turn.kind !== "thinking" && turn.kind !== "system")
        .map((turn) =>
          turn.toolName ? `${turn.toolName}: ${turn.text}` : turn.text,
        )
        .join("\n"),
    ),
    tags: transcript.client,
    updatedAt: transcript.updatedAt,
  };
}
