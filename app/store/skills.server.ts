import type { ListFilters } from "~/concepts/list-filters";
import type { Provenance } from "~/concepts/memories";
import type { ListWindow } from "~/concepts/pagination";
import {
  changeSkills,
  countSkills,
  editSkill,
  getSkill,
  getSkillDocument,
  listImportedSources,
  listSkillHeads,
  listSkills,
  listSkillVersions,
  previewSkillAdd,
  publishSkill,
  rankSkillTools,
  readSkillUsage,
  reviewSkillEdit,
  type SkillChange,
  type SkillDraft,
  type SkillOrigin,
  type SkillReach,
  setSkillLabels,
  skillNameForId,
} from "~/concepts/skills";
import {
  classifyGithubSkills,
  importGithubSkills,
} from "~/concepts/skills-github";
import {
  checkUpstream,
  readUpstream,
  updateSkills,
} from "~/concepts/skills-upstream";

export type SkillStoreData = {
  DB: D1Database;
  BUNDLES: R2Bucket;
  SKILLS_REGISTRY_URL?: string;
};

/**
 * Skill operations bound to one tenant. Registry and GitHub reads that fetch
 * a public listing and touch no row stay with their callers; anything that
 * reads or writes the tenant's skills is here.
 */
export function skillStore(
  data: SkillStoreData,
  userId: string,
  provenance: Provenance,
) {
  const db = data.DB;
  return Object.freeze({
    list: (
      filters: ListFilters = {},
      reach?: SkillReach,
      window?: ListWindow,
    ) => listSkills(db, userId, filters, reach, window),
    count: (filters: ListFilters = {}) => countSkills(db, userId, filters),
    get: (name: string, version?: number, reach?: SkillReach) =>
      getSkill(db, userId, name, version, reach),
    /** The head version behind a `skill:<id>`, enabled and live only. */
    document: (skillId: string) => getSkillDocument(db, userId, skillId),
    /** The name behind a `skill:<id>`, as search and the logs carry it. */
    nameForId: (id: string) => skillNameForId(db, userId, id),
    versions: (name: string) => listSkillVersions(db, userId, name),
    heads: (names: string[]) => listSkillHeads(db, userId, names),
    importedSources: () => listImportedSources(db, userId),
    usage: (names: string[]) => readSkillUsage(db, userId, names),
    /** The skills `tools/list` serves as their own tool, most loaded first. */
    toolNames: () => rankSkillTools(db, userId),
    upstream: (names: string[]) => readUpstream(db, userId, names),
    previewAdd: (body: string) => previewSkillAdd(db, userId, body),
    reviewEdit: (name: string, body: string) =>
      reviewSkillEdit(db, userId, name, body),
    classifyGithub: (
      owner: string,
      repo: string,
      skills: { name: string; path: string }[],
    ) => classifyGithubSkills(db, userId, owner, repo, skills),
    publish: (draft: SkillDraft, origin?: SkillOrigin) =>
      publishSkill(data, draft, provenance, origin),
    edit: (name: string, body: string) =>
      editSkill(data, name, body, provenance),
    change: (names: string[], change: SkillChange) =>
      changeSkills(data, userId, names, change),
    setLabels: (
      name: string,
      patch: { project?: string | null; tags?: string[] },
    ) => setSkillLabels(data, userId, name, patch),
    checkUpstream: (name: string) => checkUpstream(data, userId, name),
    update: (names: string[]) => updateSkills(data, names, provenance),
    importGithub: (
      pinned: { owner: string; repo: string; sha: string; paths: string[] },
      labels: { project?: string; tags?: string[] },
    ) => importGithubSkills(data, pinned, labels, provenance),
  });
}

export type SkillStore = ReturnType<typeof skillStore>;
