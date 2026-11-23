export const UI_REVIEWS: Record<
  | "summary"
  | "consolidation"
  | "dismiss"
  | "stale"
  | "noscript"
  | "noop"
  | "failed"
  | "subject"
  | "subject-native"
  | "conflict"
  | `applied-${number}`
  | `volume-${number}`,
  {
    groupId: string;
    title: string;
    rollup: string;
    marker: string;
    sources: string[];
    bodies: string[];
    body: string;
  }
>;
export function installReviewFixtures(baseURL: string): Promise<void>;
export function removeReviewFixtures(baseURL: string): Promise<void>;
export function installLegacyReviewSettings(
  baseURL: string,
  model: string,
): Promise<void>;
export function installRankingStop(
  baseURL: string,
  requests: number,
): Promise<void>;
export function removeRankingStop(baseURL: string): Promise<void>;
export function installUpkeepRun(
  baseURL: string,
  run: {
    startedAt: number;
    finishedAt: number | null;
    passes: number;
    scanned: number;
    calls: number;
    applied: number;
    questions: number;
    failed: number;
    lessons?: number;
    lessonCalls?: number;
    ended: string | null;
  },
  nextRunAt: number,
): Promise<void>;
export function reviewFixtureState(baseURL: string): Promise<{
  settings: {
    model: string;
    enabled: number;
    overnight: number;
    auto_apply: number;
    manual_memories: number;
    upkeep_memories: number;
  } | null;
  budgets: { day: number; calls: number; reserved_microusd: number }[];
  groups: { group_id: string; model: string; state: string }[];
}>;
export const UI_PRINCIPLES: Record<
  "adopt" | "reject",
  { id: string; rule: string }
>;
export function installPrincipleCards(baseURL: string): Promise<void>;
export function removePrincipleFixtures(baseURL: string): Promise<void>;
export function principleFixtureState(baseURL: string): Promise<{
  principles: {
    principle_id: string;
    state: string;
    reason: string | null;
    memory_type: string | null;
    title: string | null;
    todo: string | null;
  }[];
  links: { from_memory_id: string; kind: string; asserted_by: string }[];
}>;
