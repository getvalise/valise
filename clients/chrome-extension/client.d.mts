import type {
  ExtractedArticle,
  SelectionCapture,
  Snapshot,
} from "./capture.mjs";
export const CAPTURE_SCOPES: string[];
export const TODO_SCOPE: string;
export const REQUESTED_SCOPES: string[];
export const MAX_BYTES: number;
export function normalizeTags(tags: string[]): string[];
/**
 * What a capture is labelled with: tags, a project or none, and the page
 * note. A note left `undefined` is not sent, so the saved one inherits.
 */
export type CaptureLabels = {
  tags?: string[];
  project?: string;
  notes?: string;
};
export function captureLabels(labels?: CaptureLabels): {
  tags: string[];
  project?: string;
};
/** A stored connection: a pasted token, or OAuth tokens with their grant. */
export type Connection =
  | { endpoint: string; token: string }
  | { endpoint: string; oauth: { accessToken: string; scopes?: string[] } };
export function captureNote(labels?: CaptureLabels): { notes?: string };
export function canAddTodos(connection: Connection | null | undefined): boolean;
/** Thrown on a 403 insufficient_scope: the scope Valise asked for, if named. */
export type InsufficientScopeError = Error & {
  insufficientScope: string | null;
};
export class ValiseClient {
  constructor(
    connection: Connection,
    fetcher?: typeof fetch,
    refresh?: () => Promise<string>,
  );
  tool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<Record<string, any>>;
  upload(file: {
    fileName: string;
    contentType: string;
    bytes: Uint8Array;
    folder?: string;
    title?: string;
    description?: string;
    tags?: string[];
    project?: string;
  }): Promise<string>;
  saveArchive(
    snapshot: Snapshot,
    labels?: CaptureLabels,
    onProgress?: (message: string) => void,
  ): Promise<SavedArchive>;
  checkSaved(
    url: string,
  ): Promise<{ saved: SavedSource[]; vocabulary: Vocabulary }>;
  saveBookmark(
    page: { title: string; url: string },
    article: ExtractedArticle | null,
    labels?: CaptureLabels,
  ): Promise<SavedBookmark>;
  updateLabels(
    sourceId: string,
    revision: number,
    labels: CaptureLabels,
  ): Promise<number>;
  createTodo(todo: {
    title?: string;
    url: string;
    description?: string;
    project: string;
    tags?: string[];
  }): Promise<CreatedTodo>;
  saveHighlight(
    selection: SelectionCapture,
    labels?: CaptureLabels,
  ): Promise<{ sourceId: string; libraryUrl: string }>;
}
export type SavedArchive = {
  assetId: string;
  sourceId: string;
  /** The source's revision, the `expected_revision` for its next edit. */
  revision: number;
  article: { detected: boolean; word_count: number } | null;
  authors: string[];
  libraryUrl: string;
  /** Resources uploaded into the archive's folder. */
  stored: number;
  /** Resources the page used that are not in the folder. */
  missed: number;
};
/** A bookmark save: a source without an archived page. */
export type SavedBookmark = Omit<
  SavedArchive,
  "assetId" | "stored" | "missed"
> & { assetId: null };
/** A created to-do and where it opens in the console. */
export type CreatedTodo = { id: string; title: string; url: string };
/** A source Valise holds at a URL, from save_source's check. */
export type SavedSource = {
  id: string;
  kind: string;
  title: string;
  revision: number;
  updated_at: number;
  /** The head revision's note, whole; empty when it has none. */
  notes: string;
  archive_asset_id: string | null;
};
/** The owner's most used projects and tags, from save_source's check. */
export type Vocabulary = { projects: string[]; tags: string[] };
export function articleArguments(
  article: ExtractedArticle | null | undefined,
): Record<string, unknown>;
export function savedMessage(
  result: Pick<SavedArchive | SavedBookmark, "article" | "authors"> & {
    assetId?: string | null;
    stored?: number;
    missed?: number;
  },
): string;
