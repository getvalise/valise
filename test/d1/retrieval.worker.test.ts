import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { similarMemories } from "~/concepts/memories";
import { search } from "~/search/query";
import { seedMemories } from "~/search/seed";
import fixture from "../../evals/fixtures/retrieval-memories.json";
import pool from "../../evals/fixtures/retrieval-pool.json";
import {
  buildCorpus,
  QUERY_KINDS,
  type QueryKind,
  type RetrievalFixture,
} from "../../evals/retrieval/corpus";

/**
 * Does `search` put the labelled memory in the top five as the store grows?
 * No model: the FTS query alone, against a store built the same way every
 * time. The number gates embeddings (if FTS holds on paraphrases at 5000,
 * they are not worth adding) and the similar-memories line on save.
 *
 * `verify` runs the 50 store and holds it to the floors below, so a ranking
 * change that loses a memory fails the pull request. Larger stores print
 * their table and assert nothing, because they are a measurement:
 *
 *   RETRIEVAL_SIZES=50,500,5000 npm run test:d1 -- retrieval --reporter=verbose
 */

/**
 * Hits in the top five, out of 25 targets, at 50 memories. `id-fragment` is
 * zero by construction: the projection indexes title, body, and tags, never
 * the id, so an id is a `fetch` and not a search.
 */
const FLOORS_AT_50: Record<QueryKind, number> = {
  "exact-title": 25,
  paraphrase: 20,
  "id-fragment": 0,
  "project-question": 21,
};

/**
 * Targets whose paraphrase, saved as a new memory's title, lists the target
 * among the three similar memories `save_memory` returns, at 50 memories.
 */
const RESTATED_FLOOR_AT_50 = 22;

/** The title `save-similar-duplicate` in evals/cases.json saves. */
const DUPLICATE_TITLE =
  "Only commit full eval runs: the workbench matrix UI test fails when the newest committed run is a single case";
const DUPLICATED = "mem_b2f1dc65-5b7f-4054-ac02-5c4d0625ba58";

const db = env.DB;
const sizes = env.RETRIEVAL_SIZES.split(",").map(Number);

async function reset() {
  for (const table of ["search_docs", "memory_revisions", "memories"]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
}

describe("retrieval at scale", () => {
  for (const size of sizes) {
    it(`keeps the labelled memory in the top five at ${size} memories`, {
      timeout: 600_000,
    }, async () => {
      await reset();
      const { memories, queries } = buildCorpus(
        size,
        fixture as RetrievalFixture,
        pool,
      );
      await seedMemories(env, memories);

      const tally = Object.fromEntries(
        QUERY_KINDS.map((kind) => [kind, { top1: 0, top5: 0, total: 0 }]),
      ) as Record<QueryKind, { top1: number; top5: number; total: number }>;
      const misses: string[] = [];
      for (const labelled of queries) {
        const hits = await search(env, {
          userId: "local",
          query: labelled.query,
          project: labelled.project,
          limit: 5,
        });
        const rank = hits.findIndex(
          (hit) => hit.docKey === `memory:${labelled.expect}`,
        );
        const row = tally[labelled.kind];
        row.total++;
        if (rank === 0) row.top1++;
        if (rank >= 0) row.top5++;
        else if (labelled.kind !== "id-fragment") {
          misses.push(`${labelled.kind}: ${labelled.query}`);
        }
      }

      console.log(
        [
          `retrieval at ${size} memories`,
          "| Query kind | In top five | First |",
          "| --- | --- | --- |",
          ...QUERY_KINDS.map(
            (kind) =>
              `| ${kind} | ${tally[kind].top5}/${tally[kind].total} | ${tally[kind].top1}/${tally[kind].total} |`,
          ),
          ...misses.map((miss) => `- missed ${miss}`),
        ].join("\n"),
      );

      // The check-on-save list: a later session restating a target in its own
      // words, taken as the paraphrase saved as a title in the same project.
      const { targets } = fixture as RetrievalFixture;
      let restated = 0;
      for (const target of targets) {
        const similar = await similarMemories(
          env,
          "local",
          target.paraphrase,
          target.project,
        );
        if (similar.some((hit) => hit.id === `memory:${target.id}`)) {
          restated++;
        }
      }
      const copyTitle = memories.find((m) => m.id === DUPLICATED)?.title;
      const duplicate = await similarMemories(
        env,
        "local",
        DUPLICATE_TITLE,
        "valise",
      );
      const copies = duplicate.filter((hit) => hit.title === copyTitle).length;
      console.log(
        `similar on save at ${size}: a paraphrase lists its target ${restated}/${targets.length}; save-similar-duplicate lists ${copies}/3 copies`,
      );
      // The eval case's similar list came from this store, so it holds here.
      expect(copies).toBeGreaterThan(0);

      if (size === 50) {
        expect(restated).toBeGreaterThanOrEqual(RESTATED_FLOOR_AT_50);
        for (const kind of QUERY_KINDS) {
          expect(tally[kind].top5, kind).toBeGreaterThanOrEqual(
            FLOORS_AT_50[kind],
          );
        }
      }
    });
  }
});
