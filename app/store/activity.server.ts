import {
  type ActivityFilters,
  completedTodoInSession,
  type RunSort,
  readActivity,
  readCall,
  readClientSessions,
  readRuns,
} from "~/concepts/activity";
import {
  type AttachmentTarget,
  readAttachedObject,
} from "~/concepts/attachments";
import { readHookConfig, writeHookConfig } from "~/concepts/hook-config";
import {
  isRunnableName,
  listRunnables,
  type ProposeRunnableInput,
  proposeRunnable,
  readRunnableVersion,
} from "~/concepts/hook-runnables";
import type { Provenance } from "~/concepts/memories";
import { readTrail, type TrailWindow } from "~/concepts/trail";
import { serveObject } from "~/r2/objects";

type Data = { DB: D1Database; BUNDLES: R2Bucket };

/** The tenant's own call log and write trail. Never another tenant's calls. */
export function activityStore(data: Data, userId: string) {
  return Object.freeze({
    calls: (filters: ActivityFilters) => readActivity(data, userId, filters),
    runs: (filters: ActivityFilters, sort: RunSort) =>
      readRuns(data, userId, filters, sort),
    call: (callId: string) => readCall(data, userId, callId),
    trail: (window: TrailWindow) => readTrail(data.DB, userId, window),
    clientSessions: () => readClientSessions(data, userId),
    completedTodoInSession: (session: string) =>
      completedTodoInSession(data.DB, userId, session),
  });
}

/** The tenant's hook configuration, one document per tenant. */
export function hookStore(data: Data, userId: string, provenance: Provenance) {
  return Object.freeze({
    read: () => readHookConfig(data, userId),
    write: (document: string) => writeHookConfig(data, userId, document),
    /** Runnable entries, ADR-0023. Proposing never makes anything run. */
    runnables: Object.freeze({
      list: () => listRunnables(data.DB, userId),
      isName: (name: string) => isRunnableName(data.DB, userId, name),
      version: (versionHash: string) =>
        readRunnableVersion(data.DB, userId, versionHash),
      propose: (input: ProposeRunnableInput) =>
        proposeRunnable(data, input, provenance),
    }),
  });
}

/** Stored files, served only when the tenant owns the object. ADR-0011. */
export function fileStore(data: Data, userId: string) {
  return Object.freeze({
    serve: (objectId: string) => serveObject(data, userId, objectId),
    /** A file attached to a live, owned to-do or memory. */
    attached: (target: AttachmentTarget, objectId: string) =>
      readAttachedObject(data, userId, target, objectId),
  });
}
