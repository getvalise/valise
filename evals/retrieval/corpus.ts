/**
 * A memory store of any size, the same every time, for asking whether
 * `search` still puts the right memory in the top five as memories pile up.
 *
 * Imported by the D1 test, which seeds it into a test database, and by
 * `evals/run.mjs --memories N`, which seeds it into the eval store. Node runs
 * this file with its types stripped, so it uses no syntax that needs a
 * compiler: no enums, no parameter properties.
 *
 * What a store of N holds, in order:
 * - the targets from `fixtures/retrieval-memories.json`, each with labelled
 *   queries;
 * - the ten memories of the contradiction cluster, for the model-half cases;
 * - then a fixed sequence of generated memories, cut at N. Mostly
 *   distractors written from `fixtures/retrieval-pool.json`, sentences from
 *   this repo's docs about the same product; some near-duplicates and
 *   superseded versions of the targets, at most three of each per target.
 *
 * The sequence does not depend on N, so the store of 500 is the first 500 of
 * the store of 5000, and seeding a larger size over a smaller one gives the
 * larger store exactly.
 */

export type CorpusMemory = {
  id: string;
  type: string;
  title: string;
  body: string;
  tags: string[];
  project: string;
  /** Unix seconds, as `memories.updated_at` stores it. */
  updatedAt: number;
};

export type QueryKind =
  | "exact-title"
  | "paraphrase"
  | "id-fragment"
  | "project-question";

export type LabelledQuery = {
  kind: QueryKind;
  query: string;
  project?: string;
  /** The memory id, without the `memory:` prefix, that should come back. */
  expect: string;
};

type FixtureMemory = {
  id: string;
  at: string;
  type: string;
  project: string;
  tags: string[];
  title: string;
  body: string;
};

type Target = FixtureMemory & { paraphrase: string; question: string };

export type RetrievalFixture = {
  targets: Target[];
  contradictions: {
    topic: string;
    newest: string;
    memories: FixtureMemory[];
  };
};

export const QUERY_KINDS: QueryKind[] = [
  "exact-title",
  "paraphrase",
  "id-fragment",
  "project-question",
];

/** Near-duplicates and superseded versions each, per target. */
const MAX_RELATIVES = 3;
const DAY = 86_400;
const DISTRACTOR_START = Date.parse("2026-08-01T00:00:00Z") / 1000;
// Weighted the way the real store is: most memories are Valise's own.
const PROJECTS = [
  "valise",
  "valise",
  "valise",
  "valise",
  "valise",
  "valise",
  "acme-docs",
  "acme-docs",
  "blog",
  "homelab",
];
const TYPES = [
  "decision",
  "insight",
  "fact",
  "preference",
  "reference",
  "episode",
];

export function buildCorpus(
  size: number,
  fixture: RetrievalFixture,
  pool: string[],
): { memories: CorpusMemory[]; queries: LabelledQuery[] } {
  const fixed = [...fixture.targets, ...fixture.contradictions.memories].map(
    fromFixture,
  );
  if (size < fixed.length) {
    throw new Error(`a store holds at least ${fixed.length} memories`);
  }
  const memories = [...fixed];
  const random = mulberry32(20261018);
  const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
  const tagVocabulary = [...new Set(fixed.flatMap((memory) => memory.tags))];
  const relatives = new Map<string, { near: number; stale: number }>();

  for (let index = 0; memories.length < size; index++) {
    const roll = random();
    const target = fixed[index % fixture.targets.length];
    const count = relatives.get(target.id) ?? { near: 0, stale: 0 };
    relatives.set(target.id, count);
    const id = `mem_${uuid(random)}`;

    if (roll < 0.1 && count.near < MAX_RELATIVES) {
      count.near++;
      memories.push(nearDuplicate(target, id, random, pick, pool));
    } else if (roll < 0.2 && count.stale < MAX_RELATIVES) {
      count.stale++;
      memories.push(superseded(target, id, random));
    } else {
      memories.push({
        id,
        type: pick(TYPES),
        title: titleFrom(pick(pool)),
        body: Array.from({ length: 2 + Math.floor(random() * 3) }, () =>
          pick(pool),
        ).join(" "),
        tags: [...new Set([pick(tagVocabulary), pick(tagVocabulary)])],
        project: pick(PROJECTS),
        updatedAt: DISTRACTOR_START + Math.floor(random() * 78 * DAY),
      });
    }
  }

  const queries = fixture.targets.flatMap((target): LabelledQuery[] => [
    { kind: "exact-title", query: target.title, expect: target.id },
    { kind: "paraphrase", query: target.paraphrase, expect: target.id },
    // The first block of the uuid, the part a person copies out of a log line.
    { kind: "id-fragment", query: target.id.slice(4, 12), expect: target.id },
    {
      kind: "project-question",
      query: target.question,
      project: target.project,
      expect: target.id,
    },
  ]);
  return { memories, queries };
}

function fromFixture(memory: FixtureMemory): CorpusMemory {
  return {
    id: memory.id,
    type: memory.type,
    title: memory.title,
    body: memory.body,
    tags: memory.tags,
    project: memory.project,
    updatedAt: Date.parse(`${memory.at}T12:00:00Z`) / 1000,
  };
}

/**
 * The same claim saved again by another session: a word or two gone from the
 * title, the sentences in another order, one unrelated sentence added.
 */
function nearDuplicate(
  target: CorpusMemory,
  id: string,
  random: () => number,
  pick: <T>(items: T[]) => T,
  pool: string[],
): CorpusMemory {
  const words = target.title.split(" ");
  for (let drop = 1 + Math.floor(random() * 2); drop > 0; drop--) {
    words.splice(1 + Math.floor(random() * (words.length - 1)), 1);
  }
  const sentences = splitSentences(target.body);
  shuffle(sentences, random);
  return {
    ...target,
    id,
    title: words.join(" "),
    body: [...sentences, pick(pool)].join(" "),
    updatedAt: target.updatedAt - (1 + Math.floor(random() * 20)) * DAY,
  };
}

/**
 * An earlier version of the same claim under the same title: every number
 * moved, the last sentence not yet written, saved days before the target.
 */
function superseded(
  target: CorpusMemory,
  id: string,
  random: () => number,
): CorpusMemory {
  const sentences = splitSentences(target.body);
  const kept = sentences.length > 2 ? sentences.slice(0, -1) : sentences;
  return {
    ...target,
    id,
    body: kept
      .join(" ")
      .replace(/\d+/g, (digits) => String(Number(digits) + 1)),
    updatedAt: target.updatedAt - (3 + Math.floor(random() * 38)) * DAY,
  };
}

function titleFrom(sentence: string): string {
  return sentence
    .split(/\s+/)
    .slice(0, 12)
    .join(" ")
    .replace(/[.,:;!?]+$/, "");
}

function splitSentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+/).filter(Boolean);
}

function shuffle<T>(items: T[], random: () => number): void {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [items[i], items[j]] = [items[j], items[i]];
  }
}

function uuid(random: () => number): string {
  const hex = Array.from({ length: 32 }, () =>
    Math.floor(random() * 16).toString(16),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** A seeded generator, so every run builds the same store. */
function mulberry32(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
