import type { Provenance } from "~/concepts/memories";
import { lessonCoverage } from "~/concepts/memory-lessons";
import {
  adoptPrinciple,
  countPrinciples,
  getPrinciple,
  latestReflection,
  listPrinciples,
  PRINCIPLE_CARDS,
  reflectionLines,
  rejectPrinciple,
} from "~/concepts/memory-reflection";
import {
  acceptMemoryReview,
  countReviewGroups,
  countWaitingQuestions,
  dismissReview,
  editReviewDraft,
  getReviewGroup,
  listReviewEvents,
  listReviewGroups,
  overnightReady,
  patchReviewSetting,
  type ReviewAcceptance,
  readReviewSettings,
  readUpkeepStatus,
  reflectNow,
  reviewBudget,
  runMemoryReview,
  setNightlyUpkeep,
  undoAutoApplied,
} from "~/concepts/memory-review";
import { reviewSourceHistory } from "~/concepts/memory-review-history";
import { readReviewCaps } from "~/concepts/memory-review-limits";
import {
  rankingBudget,
  readRankingSettings,
  setRankingEnabled,
} from "~/concepts/memory-review-ranking";
import {
  briefSubjects,
  changeSubjectMember,
  createSubject,
  createSubjectSummary,
  editSubject,
  findSubjectByName,
  getSubject,
  listMemorySubjects,
  listSubjectChoices,
  listSubjectMembers,
  listSubjectSuggestions,
  listSubjects,
  matchSubjects,
  setSubjectDeleted,
  setSubjectSummary,
} from "~/concepts/memory-subjects";

/** The arguments a concept takes after its database and owner. */
type After2<F> = F extends (
  first: never,
  second: never,
  ...rest: infer R
) => unknown
  ? R
  : never;

export type ReviewStoreData = Parameters<typeof runMemoryReview>[0] & {
  BUNDLES: R2Bucket;
};

/**
 * Memory review bound to one tenant: settings, budgets, groups and their
 * decisions, and the model pass itself. The provider bindings a pass needs
 * were captured when the store was built, never taken from a caller.
 */
export function reviewStore(
  data: ReviewStoreData,
  userId: string,
  provenance: Provenance,
) {
  const db = data.DB;
  return Object.freeze({
    settings: () => readReviewSettings(db, userId),
    patchSetting: (...args: After2<typeof patchReviewSetting>) =>
      patchReviewSetting(db, userId, ...args),
    /** Nightly upkeep's one switch, bound to the model the form displayed. */
    upkeep: (...args: After2<typeof setNightlyUpkeep>) =>
      setNightlyUpkeep(db, userId, ...args),
    upkeepStatus: () => readUpkeepStatus(db, userId),
    /** How many live memories have a lesson line for their current revision (J-E). */
    lessons: () => lessonCoverage(db, userId),
    /**
     * This week's lessons (J-E): open principle cards, counts, the latest
     * reflection and, for the "nothing generalises yet" state, the lines it read.
     */
    principles: async () => {
      const latest = await latestReflection(db, userId);
      return {
        cards: await listPrinciples(db, userId, "proposal", PRINCIPLE_CARDS),
        adopted: await listPrinciples(db, userId, "adopted", 5),
        counts: await countPrinciples(db, userId),
        latest,
        lines: latest
          ? await reflectionLines(db, userId, latest.since, 30)
          : [],
      };
    },
    principle: (id: string) => getPrinciple(db, userId, id),
    reflect: () => reflectNow(db, userId),
    adopt: (id: string, input: { rule: string; fileTodo: boolean }) =>
      adoptPrinciple(data, id, input, provenance),
    reject: (id: string, reason: string) =>
      rejectPrinciple(db, userId, id, reason),
    /** Archive what nightly upkeep added; only for an automatic application. */
    undo: (id: string) => undoAutoApplied(data, userId, id),
    budget: () => reviewBudget(db, userId),
    /** Today's money caps, as an admin set them; read-only here. */
    caps: () => readReviewCaps(db, userId),
    overnightReady: (model: string) => overnightReady(db, userId, model),
    ranking: () => readRankingSettings(db, userId),
    rankingBudget: () => rankingBudget(db, userId),
    setRanking: (...args: After2<typeof setRankingEnabled>) =>
      setRankingEnabled(db, userId, ...args),
    groups: (...args: After2<typeof listReviewGroups>) =>
      listReviewGroups(db, userId, ...args),
    count: (memoryId?: string) => countReviewGroups(db, userId, memoryId),
    /** Questions waiting on the person, for the Memories sections. */
    waiting: () => countWaitingQuestions(db, userId),
    group: (id: string) => getReviewGroup(db, userId, id),
    events: (groupId: string) => listReviewEvents(db, userId, groupId),
    sourceHistory: (memoryId: string, excludeGroup: string) =>
      reviewSourceHistory(db, userId, memoryId, excludeGroup),
    editDraft: (...args: After2<typeof editReviewDraft>) =>
      editReviewDraft(db, userId, ...args),
    dismiss: (id: string, reopen: boolean) =>
      dismissReview(db, userId, id, reopen),
    /** A manual pass; `anchor` narrows it to one memory's suggestions. */
    run: (anchor?: string) =>
      runMemoryReview(data, userId, undefined, false, anchor),
    accept: (id: string, input: ReviewAcceptance) =>
      acceptMemoryReview(data, id, input, provenance),
  });
}

/** Memory subjects bound to one tenant. */
export function subjectStore(
  data: { DB: D1Database; VALISE_VECTOR_NAMESPACE?: string },
  userId: string,
  provenance: Provenance,
) {
  const db = data.DB;
  return Object.freeze({
    list: (page?: number, name?: string) =>
      listSubjects(db, userId, page, name),
    choices: () => listSubjectChoices(db, userId),
    /** Live subjects a search query names (ADR-0003, 2026-11-05). */
    matching: (query: string) => matchSubjects(db, userId, query),
    /** Tag matches and unconfirmed members, for a person or agent to confirm or dismiss. */
    suggestions: (id: string) => listSubjectSuggestions(db, userId, id),
    /** The brief's bounded subjects section. */
    brief: (project: string | null) => briefSubjects(db, userId, project),
    get: (id: string, options?: { includeDeleted?: boolean }) =>
      getSubject(db, userId, id, options),
    findByName: (name: string) => findSubjectByName(db, userId, name),
    /** The live subjects a memory is a confirmed member of. */
    ofMemory: (memoryId: string) => listMemorySubjects(db, userId, memoryId),
    setDeleted: (id: string, deleted: boolean) =>
      setSubjectDeleted(db, userId, id, deleted),
    members: (id: string, page?: number) =>
      listSubjectMembers(db, userId, id, page),
    create: (input: Parameters<typeof createSubject>[2]) =>
      createSubject(db, userId, input),
    edit: (...args: After2<typeof editSubject>) =>
      editSubject(db, userId, ...args),
    setSummary: (id: string, memoryId: string | null) =>
      setSubjectSummary(db, userId, id, memoryId),
    changeMember: (
      id: string,
      memoryId: string,
      action: "add" | "remove",
      assertedBy?: "person" | "model",
    ) => changeSubjectMember(db, id, memoryId, action, userId, assertedBy),
    /** Writes a new summary memory; refused unless the subject is this tenant's. */
    createSummary: async (id: string, body: string) => {
      const subject = await getSubject(db, userId, id);
      if (subject === null) return null;
      return createSubjectSummary(data, subject, body, provenance);
    },
  });
}
