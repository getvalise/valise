import type { ReviewSnapshot } from "./memory-review";
import type { ReviewModel } from "./memory-review-model";

export const reviewPairKey = (a: string, b: string) =>
  JSON.stringify([a, b].sort());
export async function sourceWasReviewed(
  db: D1Database,
  userId: string,
  source: ReviewSnapshot,
  model: ReviewModel,
) {
  return !!(await db
    .prepare(`SELECT 1 FROM memory_review_sources s JOIN memory_review_groups g ON g.group_id=s.group_id AND g.user_id=s.user_id
    WHERE s.user_id=? AND s.memory_id=? AND s.fingerprint=? AND g.model=? AND g.state IN ('proposal','noop','dismissed','accepted') LIMIT 1`)
    .bind(userId, source.source.id, source.fingerprint, model)
    .first());
}
export async function reviewedPairs(
  db: D1Database,
  userId: string,
  sources: ReviewSnapshot[],
  model: ReviewModel,
) {
  const heads = JSON.stringify(
    sources.map((s) => ({ id: s.source.id, fingerprint: s.fingerprint })),
  );
  const { results } = await db
    .prepare(`SELECT DISTINCT a.memory_id AS a,b.memory_id AS b FROM memory_review_sources a
    JOIN json_each(?) ha ON a.memory_id=json_extract(ha.value,'$.id') AND a.fingerprint=json_extract(ha.value,'$.fingerprint')
    JOIN memory_review_sources b ON b.group_id=a.group_id AND b.user_id=a.user_id AND a.memory_id<b.memory_id
    JOIN json_each(?) hb ON b.memory_id=json_extract(hb.value,'$.id') AND b.fingerprint=json_extract(hb.value,'$.fingerprint')
    JOIN memory_review_groups g ON g.group_id=a.group_id AND g.user_id=a.user_id
    WHERE a.user_id=? AND g.model=? AND g.state IN ('proposal','noop','dismissed','accepted')`)
    .bind(heads, heads, userId, model)
    .all<{ a: string; b: string }>();
  return new Set(results.map((r) => reviewPairKey(r.a, r.b)));
}

export async function reviewSourceHistory(
  db: D1Database,
  userId: string,
  memoryId: string,
  excludeGroup: string,
) {
  return (
    await db
      .prepare(`SELECT g.group_id,g.state,g.draft_title,g.result_memory_id,s.revision,s.fingerprint,g.created_at,
    EXISTS(SELECT 1 FROM memory_review_events e WHERE e.group_id=g.group_id AND e.user_id=g.user_id AND e.kind='accept' AND json_extract(e.value,'$.supersede')=1) AS superseded,
    EXISTS(SELECT 1 FROM json_each(COALESCE(g.proposal_json,'{}'),'$.evidence') e WHERE json_extract(e.value,'$.id')=s.memory_id) AS cited
    FROM memory_review_sources s JOIN memory_review_groups g ON g.group_id=s.group_id AND g.user_id=s.user_id
    WHERE s.user_id=? AND s.memory_id=? AND g.group_id<>? ORDER BY s.created_at DESC,s.group_id DESC LIMIT 11`)
      .bind(userId, memoryId, excludeGroup)
      .all<{
        group_id: string;
        state: string;
        draft_title: string | null;
        result_memory_id: string | null;
        revision: number;
        fingerprint: string;
        created_at: number;
        cited: number;
        superseded: number;
      }>()
  ).results;
}
