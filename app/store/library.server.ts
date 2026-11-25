import {
  folderFiles,
  folderFill,
  groupFolders,
  joinableFolder,
  listAssetFolders,
  moveAssetToFolder,
  moveAssetToNewFolder,
  readAssetFolder,
  renameAssetFolder,
  setFolderDetails,
} from "~/concepts/asset-folders";
import {
  acceptAssetSuggestion,
  dismissAssetSuggestion,
  listAssetProcessing,
  type ProcessingEnv,
  queueAssetProcessing,
  readAssetProcessing,
  readAssetText,
  runQueuedAsset,
} from "~/concepts/asset-processing";
import {
  type Asset,
  type AssetPatch,
  type BeginAssetUpload,
  beginAssetUpload,
  issueArchiveView,
  issueAssetDownload,
  listAssetsPage,
  passageCitations,
  readAsset,
  readAssetExtraction,
  readAssetObject,
  readAssets,
  setAssetArchived,
  updateAsset,
} from "~/concepts/assets";
import {
  type AttachedFile,
  storeAttachedFile,
} from "~/concepts/attached-files";
import { listAuthors, readAuthor, sourcesByAuthor } from "~/concepts/authors";
import {
  deleteAsset,
  exportManifest,
  importAsset,
  importSources,
  linkedImportBackups,
  type ManifestAsset,
  type ManifestSource,
  uploadAssetFile,
} from "~/concepts/library";
import type { LibraryPageOptions } from "~/concepts/library-page";
import {
  type LibraryConcept,
  readRating,
  readRatings,
  recordUse,
  setRating,
  type UseKind,
  useSignals,
} from "~/concepts/library-use";
import type { Provenance } from "~/concepts/memories";
import { relatedLibraryItem } from "~/concepts/related-library";
import type { Fetcher } from "~/concepts/source-fetch";
import { rankedSearch } from "./search.server";

/** The arguments a concept takes after its environment and owner. */
type After2<F> = F extends (
  first: never,
  second: never,
  ...rest: infer R
) => unknown
  ? R
  : never;

/**
 * Library files and authors bound to one tenant. Ids are bare asset ids
 * (`ast_…`). Processing runs with the model binding captured when the store
 * was built.
 */
export function libraryStore(
  data: ProcessingEnv,
  userId: string,
  provenance: Provenance,
) {
  const db = data.DB;
  /** Credentials and bytes only for an asset this tenant can read now. */
  const owned = async (asset: Asset) =>
    (await readAsset(db, userId, asset.assetId)) !== null;
  return Object.freeze({
    asset: (assetId: string) => readAsset(db, userId, assetId),
    assets: (ids: string[]) => readAssets(db, userId, ids),
    assetsPage: (archived: boolean, options?: LibraryPageOptions) =>
      listAssetsPage(db, userId, archived, options),
    folders: (archived: boolean, options?: LibraryPageOptions) =>
      listAssetFolders(db, userId, archived, options),
    assetText: (assetId: string) => readAssetText(db, userId, assetId),
    /** The folder an asset belongs to, if it is one of this tenant's. */
    folderOf: (assetId: string) => readAssetFolder(db, userId, assetId),
    folderFiles: (folderId: string) => folderFiles(db, userId, folderId),
    /** File count, or null when the folder is not this tenant's. */
    folderFill: (folderId: string) => folderFill(db, userId, folderId),
    moveToFolder: (assetId: string, folderId: string) =>
      moveAssetToFolder(db, userId, assetId, folderId),
    renameFolder: (folderId: string, title: string) =>
      renameAssetFolder(db, userId, folderId, title),
    /** Several folders' files into one; refused whole or done whole. */
    groupFolders: (assetIds: string[], name?: string) =>
      groupFolders(db, userId, assetIds, name),
    /** One file out into a new folder of its own. */
    moveToNewFolder: (assetId: string, name: string) =>
      moveAssetToNewFolder(db, userId, assetId, name),
    /** The folder's own tags or notes. */
    setFolderDetails: (
      folderId: string,
      patch: { tags?: string[]; notes?: string },
    ) => setFolderDetails(db, userId, folderId, patch),
    setArchived: (assetId: string, archived: boolean) =>
      setAssetArchived(db, userId, assetId, archived),
    /** A console upload: bytes stored, processing queued when eligible. */
    uploadFile: (file: File, details: Parameters<typeof uploadAssetFile>[2]) =>
      uploadAssetFile(data, file, details, provenance),
    processingFor: (assetIds: string[]) =>
      listAssetProcessing(db, userId, assetIds),
    /** Which of these linked files are Raindrop import receipts. */
    importBackups: (assetIds: string[]) =>
      linkedImportBackups(db, userId, assetIds),
    extraction: (assetId: string) => readAssetExtraction(db, userId, assetId),
    beginUpload: (input: BeginAssetUpload) =>
      beginAssetUpload(data, input, provenance),
    /** A file the MCP client attached: downloaded here and stored ready. */
    storeAttached: (
      file: AttachedFile,
      details: Parameters<typeof storeAttachedFile>[2],
      fetcher?: Fetcher,
    ) => storeAttachedFile(data, file, details, provenance, fetcher),
    update: (assetId: string, patch: AssetPatch) =>
      updateAsset(data, userId, assetId, patch),
    /** The folder an upload may join beside this asset; refuses others'. */
    joinableFolder: (assetId: string) => joinableFolder(db, userId, assetId),
    /** The portable library manifest: every owned file and source. */
    exportManifest: () => exportManifest(db, userId),
    importAsset: (entry: ManifestAsset, bytes: ArrayBuffer) =>
      importAsset(data, userId, entry, bytes),
    importSources: (sources: ManifestSource[]) =>
      importSources(db, userId, sources),
    /** Deletes a file unless a source, to-do or memory still refers to it. */
    deleteAsset: (assetId: string) => deleteAsset(data, userId, assetId),
    issueDownload: async (asset: Asset, origin: string) =>
      (await owned(asset)) ? issueAssetDownload(data, asset, origin) : null,
    readObject: async (asset: Asset) =>
      (await owned(asset)) ? readAssetObject(data, asset) : null,
    processing: (assetId: string) => readAssetProcessing(db, userId, assetId),
    queueProcessing: (assetId: string, reprocess = false) =>
      queueAssetProcessing(data, userId, assetId, reprocess),
    /** Runs a job queued above; for `waitUntil`, after the response. */
    runQueued: (processingId: string) =>
      runQueuedAsset(data, userId, processingId),
    acceptSuggestion: (...args: After2<typeof acceptAssetSuggestion>) =>
      acceptAssetSuggestion(data, userId, ...args),
    dismissSuggestion: (...args: After2<typeof dismissAssetSuggestion>) =>
      dismissAssetSuggestion(data, userId, ...args),
    /** Ratings, highlights, notes and reads, for ordering search by use. */
    useSignals: (items: { concept: LibraryConcept; conceptId: string }[]) =>
      useSignals(db, userId, items),
    /** Records one use, such as an agent fetching a file or a bookmark. */
    recordUse: (concept: LibraryConcept, conceptId: string, kind: UseKind) =>
      recordUse(db, userId, concept, conceptId, kind),
    /** At most one strongly related, not recently used item, or null. */
    related: (about: string) =>
      relatedLibraryItem(
        db,
        userId,
        (filters) => rankedSearch(data, userId, filters),
        about,
      ),
    rating: (concept: LibraryConcept, conceptId: string) =>
      readRating(db, userId, concept, conceptId),
    /** Ratings for a page of rows, one query. */
    ratings: (concept: LibraryConcept, conceptIds: string[]) =>
      readRatings(db, userId, concept, conceptIds),
    setRating: (
      concept: LibraryConcept,
      conceptId: string,
      stars: 1 | 2 | 3 | null,
    ) => setRating(db, userId, concept, conceptId, stars),
    /** A signed view of an archived page; only for this tenant's folder. */
    archiveView: async (folderId: string, fileName: string, origin: string) =>
      (await folderFill(db, userId, folderId)) === null
        ? null
        : issueArchiveView(data, folderId, fileName, origin),
    /** Where in a file each passage hit comes from. */
    passages: (keys: string[]) => passageCitations(db, userId, keys),
    authors: () => listAuthors(db, userId),
    /** The author a typed name means, and that author's source ids. */
    sourcesByAuthor: (name: string) => sourcesByAuthor(db, userId, name),
    author: (slug: string) => readAuthor(db, userId, slug),
  });
}

export type LibraryStore = ReturnType<typeof libraryStore>;
