import type { Provenance } from "~/concepts/memories";
import {
  sessionSummaries,
  transcriptContext,
  transcriptIdsLinkedTo,
  transcriptTagOptions,
} from "~/concepts/transcript-context";
import {
  type AppendTranscript,
  appendTranscript,
  countTranscripts,
  listTranscripts,
  readTranscript,
  readTranscriptBySession,
  readTranscriptTurnPage,
  readTranscriptTurns,
  type TranscriptFilter,
  type TranscriptSort,
  transcriptFacets,
  transcriptState,
} from "~/concepts/transcripts";

type Data = { DB: D1Database; BUNDLES: R2Bucket };

/** One tenant's session transcripts; the writer is the Valise CLI. ADR-0022. */
export function transcriptStore(
  data: Data,
  userId: string,
  provenance: Provenance,
) {
  const db = data.DB;
  return Object.freeze({
    append: (input: AppendTranscript) =>
      appendTranscript(data, input, provenance),
    get: (transcriptId: string) => readTranscript(db, userId, transcriptId),
    list: (
      offset: number,
      limit?: number,
      filter?: TranscriptFilter,
      sort?: TranscriptSort,
    ) => listTranscripts(db, userId, offset, limit, filter, sort),
    count: (filter?: TranscriptFilter) => countTranscripts(db, userId, filter),
    facets: () => transcriptFacets(db, userId),
    tagOptions: () => transcriptTagOptions(db, userId),
    summaries: (transcriptIds: readonly string[]) =>
      sessionSummaries(db, userId, transcriptIds),
    linkedTo: (filter: { tags?: readonly string[]; subjectId?: string }) =>
      transcriptIdsLinkedTo(db, userId, filter),
    /** Stats, outline and linked items for one session the reader owns. */
    context: async (transcriptId: string) => {
      const transcript = await readTranscript(db, userId, transcriptId);
      return transcript === null
        ? null
        : transcriptContext(db, userId, transcript);
    },
    turnPage: (transcriptId: string, offset: number, limit?: number) =>
      readTranscriptTurnPage(db, userId, transcriptId, offset, limit),
    turns: async (transcriptId: string) =>
      (await readTranscript(db, userId, transcriptId)) === null
        ? null
        : readTranscriptTurns(db, transcriptId),
    /** What the server holds for a session, or null before its first write. */
    state: async (client: string, device: string, sessionId: string) => {
      const transcript = await readTranscriptBySession(
        db,
        userId,
        client,
        device,
        sessionId,
      );
      return transcript === null ? null : transcriptState(db, transcript);
    },
  });
}
