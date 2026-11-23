import {
  type ComponentProps,
  Fragment,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  data,
  Form,
  Link,
  redirect,
  useActionData,
  useFetcher,
  useNavigate,
  useNavigation,
  useSearchParams,
} from "react-router";
import { z } from "zod";
import {
  AssetProcessing,
  useProcessingRefresh,
} from "~/components/asset-processing";
import { AssetThumbnail } from "~/components/asset-thumbnail";
import { AsyncPicker } from "~/components/async-picker";
import { Combobox } from "~/components/combobox";
import {
  Editable,
  editKey,
  openField,
  useHydrated,
} from "~/components/editable";
import { FileDropzone } from "~/components/file-dropzone";
import { FilePreview } from "~/components/file-preview";
import { Icon } from "~/components/icon";
import { AddRow } from "~/components/item-list";
import { ListToolbar, SortMenu } from "~/components/list-toolbar";
import { Markdown } from "~/components/markdown";
import { Modal } from "~/components/modal";
import { TagFilter } from "~/components/tag-filter";
import { TagInput, TagSet } from "~/components/tag-input";
import {
  AddButton,
  ApplicationShell,
  Card,
  DetailSection,
  Empty,
  Field,
  ListControls,
  Pill,
  ProjectChip,
  Select,
  Tag,
} from "~/components/ui";
import { Button } from "~/components/ui/button";
import { VersionHistory } from "~/components/version-history";
import {
  AUTO_PROCESSING_BYTES,
  processingEligibility,
} from "~/concepts/asset-formats";
import { readAssetText } from "~/concepts/asset-processing";
import {
  type Asset,
  AssetRefused,
  assetIdOf,
  assetRef,
  MAX_ASSET_BYTES,
} from "~/concepts/assets";
import { attachmentKind } from "~/concepts/attachment-limits";
import { authorSlug } from "~/concepts/authors";
import { type ListFilters, listHref } from "~/concepts/list-filters";
import {
  describeArticle,
  joinNames,
  type SourceArticle,
} from "~/concepts/source-articles";
import {
  type EnrichmentStatus,
  formatUsd,
  type SourceEnrichment,
} from "~/concepts/source-enrichment";
import { FETCH_EXTRACTOR, type FetchStatus } from "~/concepts/source-fetch";
import {
  raindropSource,
  readingNotes,
  type SourceText,
  sourceText,
} from "~/concepts/source-text";
import {
  MAX_NOTES_LENGTH,
  SOURCE_KINDS,
  SOURCE_SORTS,
  type Source,
  type SourceKind,
  SourceRefused,
  type SourceRevision,
  sourceIdOf,
  sourceRef,
  sourceSort,
} from "~/concepts/sources";
import {
  consoleContext,
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { afterSave, tagsOf } from "~/console/forms.server";
import { ExtractedText } from "~/features/library/extracted-text";
import { LibraryNav } from "~/features/library/nav";
import {
  articleExcerpt,
  fileKind,
  importBackup,
  importedCollection,
  libraryTags,
  pageHost,
  publishedDate,
  readerHref,
  withLibraryTags,
  withoutRemoteImages,
  withReadingNotes,
} from "~/features/library/presentation";
import {
  postedStars,
  RatingControl,
  RatingStars,
} from "~/features/library/rating";
import { fileSize } from "~/r2/objects";
import type { Route } from "./+types/library";

/**
 * Files and sources, ADR-0015. A file is an asset any connected agent can
 * fetch by id; a source is a bookmark, document, image or reference with
 * notes, which may link files. Fields edit in place (P1, P2); a source's
 * field save is a revision, posted with the revision it was read at, so a
 * save that crossed an agent's is refused rather than lost.
 */

const COVERAGE =
  "Search covers metadata, source notes and authors, bookmark summaries and key concepts, article text captured by the Chrome extension or fetched once by Valise (robots.txt respected, paywalled pages not kept), and processed file text (up to 1 MiB, by passage). Unsupported or unprocessed files have metadata-only search.";

/** Seconds; the empty value keeps a file until it is deleted. */
const RETENTION = [
  { value: "", label: "Keep until deleted" },
  { value: String(24 * 60 * 60), label: "Delete after 1 day" },
  { value: String(7 * 24 * 60 * 60), label: "Delete after 7 days" },
  { value: String(30 * 24 * 60 * 60), label: "Delete after 30 days" },
];

function libraryHref(
  archived: boolean,
  edit?: string,
  project = "",
  tags: string[] = [],
  cursors: {
    filesAfter?: string;
    sourcesAfter?: string;
    linksAfter?: string;
    attach?: string;
    history?: string;
    processing?: string;
    review?: string;
    q?: string;
    details?: string;
    view?: string;
    sort?: string;
  } = {},
): string {
  const params = new URLSearchParams();
  if (archived) params.set("archived", "1");
  if (edit) params.set("edit", edit);
  if (project) params.set("project", project);
  for (const tag of tags) params.append("tag", tag);
  for (const [key, value] of Object.entries(cursors))
    if (value) params.set(key, value);
  const query = params.toString();
  return query ? `/library?${query}` : "/library";
}

function libraryEditHref(back: string, edit: string) {
  const url = new URL(back, "https://valise.invalid");
  url.searchParams.set("edit", edit);
  return `${url.pathname}${url.search}`;
}

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const params = new URL(request.url).searchParams;
  const archived = params.get("archived") === "1";
  const { library, sources: sourcesStore } = actor.store;
  const project = params.get("project") ?? "";
  const selectedTags = params.getAll("tag").filter(Boolean).slice(0, 20);
  const query = (params.get("q") ?? "").trim().slice(0, 200);
  const sort = sourceSort(params.get("sort") ?? undefined);
  const cursors = {
    filesAfter: params.get("filesAfter") ?? undefined,
    sourcesAfter: params.get("sourcesAfter") ?? undefined,
    linksAfter: params.get("linksAfter") ?? undefined,
    attach: params.get("attach") ?? undefined,
    history: params.get("history") ?? undefined,
    processing: params.get("processing") ?? undefined,
    review: params.get("review") ?? undefined,
    q: query,
    details: params.get("details") ?? undefined,
    view: params.get("view") === "documents" ? "documents" : undefined,
    sort: sort === "saved" ? undefined : sort,
  };
  const [folderPage, sourcePage, linkPage, vocabulary] = await Promise.all([
    library.folders(archived, {
      project,
      tags: selectedTags,
      after: cursors.filesAfter,
      query,
    }),
    sourcesStore.page(archived, {
      project,
      tags: selectedTags,
      after: cursors.sourcesAfter,
      query,
      sort,
      fullNotesFor:
        sourceIdOf(
          params.get("details") ??
            params.get("attach") ??
            params.get("history") ??
            (params.get("edit") ?? "").replace(/\.[^.]+$/, ""),
        ) ?? undefined,
    }),
    cursors.attach
      ? library.assetsPage(false, {
          durableOnly: true,
          after: cursors.linksAfter,
        })
      : Promise.resolve({ items: [], next: null }),
    actor.store.vocabulary(),
  ]);
  const representatives = await library.assets(
    folderPage.items.map((folder) => folder.assetId),
  );
  const assets = folderPage.items.flatMap((folder) =>
    representatives.filter((asset) => asset.assetId === folder.assetId),
  );
  const sources = sourcePage.items;
  const detailsSource = sourceIdOf(params.get("details") ?? "");
  const [openArticle, openEnrichment, enrichment, ratings] = await Promise.all([
    detailsSource ? sourcesStore.article(detailsSource) : null,
    detailsSource ? sourcesStore.enrichment(detailsSource) : null,
    sourcesStore.enrichmentStatus(),
    library.ratings(
      "source",
      sources.map((source) => source.sourceId),
    ),
  ]);
  const detailAssetId = assetIdOf(params.get("details") ?? "");
  // A deep link may name a non-representative member or a file on another
  // bounded page. Its owned pane must not depend on its row being mounted.
  const focusedId =
    assetIdOf(params.get("processing") ?? "") ??
    (detailAssetId && !assets.some((asset) => asset.assetId === detailAssetId)
      ? detailAssetId
      : null);
  const processingAsset = focusedId
    ? (assets.find((asset) => asset.assetId === focusedId) ??
      (await library.asset(focusedId)))
    : null;
  const selectedId = focusedId ?? assetIdOf(params.get("details") ?? "");
  const selectedAsset = selectedId ? await library.asset(selectedId) : null;
  const openFolder = selectedId ? await library.folderOf(selectedId) : null;
  const members = openFolder
    ? await library.folderFiles(openFolder.folderId)
    : [];
  const processing = await library.processingFor([
    ...new Set([
      ...assets.map((asset) => asset.assetId),
      ...(processingAsset ? [processingAsset.assetId] : []),
      ...members.map((asset) => asset.assetId),
    ]),
  ]);
  return {
    archived,
    editing: params.get("edit") ?? undefined,
    expanded: params.get("details"),
    view: params.get("view") === "documents" ? "documents" : "pages",
    adding: params.get("add"),
    openArticle,
    openEnrichment,
    enrichment,
    ratings,
    assets,
    folders: folderPage.items,
    openFolder,
    members,
    selectedAsset,
    extracted: selectedId ? await library.assetText(selectedId) : null,
    sources,
    nextFiles: folderPage.next,
    nextSources: sourcePage.next,
    nextLinks: linkPage.next,
    project,
    selectedTags,
    query,
    sort,
    back: libraryHref(archived, undefined, project, selectedTags, cursors),
    processing,
    processingAsset,
    processingUnavailable:
      Boolean(params.has("processing") || detailAssetId) && !selectedAsset,
    importBackupIds: await library.importBackups(
      sources.flatMap((source) =>
        source.assets
          .filter((asset) => asset.contentType === "application/json")
          .map((asset) => asset.assetId),
      ),
    ),
    vocabulary,
    tags: [
      ...new Set([
        ...vocabulary.tags,
        ...assets.flatMap((asset) => asset.tags),
        ...sources.flatMap((source) => source.tags),
      ]),
    ],
    // A source may cite only a file that will not expire under it.
    linkable: linkPage.items.map(({ assetId, title }) => ({ assetId, title })),
    maxBytes: MAX_ASSET_BYTES,
    attaching: cursors.attach,
    history: cursors.history
      ? {
          id: cursors.history,
          revisions: await sourcesStore.revisions(
            sourceIdOf(cursors.history) ?? "",
            10,
          ),
        }
      : null,
  };
}

type Answer = {
  error?: string;
  /** The record the error belongs to, so it shows beside it. */
  id?: string;
  /** The source an upload was attached to: the answer belongs to its modal. */
  attachTo?: string;
  /** That source's revision after the attach, for the next file in a batch. */
  revision?: number;
  folderId?: string;
  uploads?: {
    name: string;
    assetId?: string;
    error?: string;
    processingNote?: string;
  }[];
};

const fieldEdit = z.object({
  id: z.string(),
  field: z.enum([
    "title",
    "description",
    "url",
    "notes",
    "tags",
    "project",
    "authors",
  ]),
  value: z.string().max(64 * 1024),
  revision: z.coerce.number().int().positive().optional(),
});

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  if (Number(request.headers.get("content-length")) > MAX_ASSET_BYTES + 65536) {
    return data<Answer>(
      {
        error: `Uploads are limited to ${fileSize(MAX_ASSET_BYTES)} per request. With scripting off, choose files within that combined size.`,
      },
      { status: 413 },
    );
  }
  const form = await request.formData();
  const archived = new URL(request.url).searchParams.get("archived") === "1";
  const params = new URL(request.url).searchParams;
  const back = libraryHref(
    archived,
    undefined,
    params.get("project") ?? "",
    params.getAll("tag"),
    {
      filesAfter: params.get("filesAfter") ?? undefined,
      sourcesAfter: params.get("sourcesAfter") ?? undefined,
      linksAfter: params.get("linksAfter") ?? undefined,
      attach: params.get("attach") ?? undefined,
      history: params.get("history") ?? undefined,
      processing: params.get("processing") ?? undefined,
      review: params.get("review") ?? undefined,
      q: (params.get("q") ?? "").trim().slice(0, 200),
      details: params.get("details") ?? undefined,
      // A write lands back on the tab it was made from.
      view: params.get("view") === "documents" ? "documents" : undefined,
      sort: params.get("sort") === "published" ? "published" : undefined,
    },
  );
  const { library, sources } = actor.store;
  const intent = String(form.get("intent") ?? "");
  const id = String(form.get("id") ?? "");
  const refuse = (error: string, status = 400) =>
    data<Answer>({ error, id }, { status });

  try {
    switch (intent) {
      case "upload": {
        const files = form
          .getAll("file")
          .filter(
            (value): value is File => value instanceof File && !!value.name,
          );
        // Upload and attach in one request: the source is checked before any
        // byte is stored, so a stale revision leaves no orphaned document.
        const attachTo = String(form.get("attachTo") ?? "") || undefined;
        const attachRefuse = (error: string, status = 400) =>
          data<Answer>({ error, id: attachTo, attachTo }, { status });
        if (!files.length)
          return attachTo
            ? attachRefuse("Pick a file first.")
            : refuse("Pick a file first.");
        const sourceId = attachTo ? sourceIdOf(attachTo) : null;
        const target = sourceId === null ? null : await sources.get(sourceId);
        if (attachTo && target === null)
          return attachRefuse("This page no longer exists.", 404);
        if (target && Number(form.get("revision")) !== target.revision)
          return attachRefuse(
            `“${target.title}” changed since this dialog opened. Nothing was uploaded. Reload the page and attach again.`,
            409,
          );
        // A linked document must be durable, so an attached upload never expires.
        const keep = target ? 0 : Number(form.get("expires") || 0);
        let folderId = String(form.get("folderId") ?? "");
        const folderTitle = String(form.get("folderTitle") ?? "").trim();
        if (folderTitle.length > 200)
          return refuse("Folder names are limited to 200 characters.");
        const existingCount = folderId ? await library.folderFill(folderId) : 0;
        if (existingCount === null)
          return refuse("This folder is unavailable.", 404);
        if (files.length + existingCount > 100)
          return refuse(
            "A folder holds up to 100 files. Choose fewer files or create another folder.",
          );
        const uploads: NonNullable<Answer["uploads"]> = [];
        for (const file of files) {
          try {
            const uploaded = await library.uploadFile(file, {
              // A batch keeps each filename, not one title repeated on every file.
              title:
                files.length === 1
                  ? String(form.get("title") ?? "").trim() || undefined
                  : undefined,
              expiresInSeconds: keep > 0 ? keep : undefined,
            });
            const processing = await library
              .processing(uploaded.assetId)
              .catch(() => null);
            let groupingNote = "";
            try {
              if (folderId)
                await library.moveToFolder(uploaded.assetId, folderId);
              else {
                folderId = uploaded.assetId;
                if (folderTitle)
                  await library.renameFolder(folderId, folderTitle);
              }
            } catch {
              // A concurrent move/fill can invalidate admission after the bytes
              // were saved. Never call that successful original a failed upload.
              groupingNote =
                "Saved in its own folder; the destination changed or filled up. Check Library before retrying. ";
            }
            if (processing?.state === "queued" && processing.processingId)
              context
                .get(consoleContext)
                .ctx.waitUntil(library.runQueued(processing.processingId));
            uploads.push({
              name: file.name,
              assetId: uploaded.assetId,
              processingNote:
                groupingNote +
                (processing?.processingId
                  ? "Processing queued. Suggestions will appear here for review; nothing is applied automatically."
                  : file.size > AUTO_PROCESSING_BYTES &&
                      !processingEligibility(file.name, file.type, file.size)
                    ? "Files over 8 MiB wait for you. Open its processing details to see the cost estimate, then start processing."
                    : "Metadata-only search. Processing supports standard files up to 25 MiB, with 2 pending files and 20 requests per rolling day; retry from its card."),
            });
          } catch (error) {
            if (!(error instanceof AssetRefused))
              console.error("Library upload failed", file.name, error);
            uploads.push({
              name: file.name,
              error:
                error instanceof AssetRefused
                  ? error.message
                  : "Upload failed. Try this file again.",
            });
          }
        }
        if (target) {
          const stored = uploads.flatMap((upload) =>
            upload.assetId ? [upload.assetId] : [],
          );
          let revision = target.revision;
          if (stored.length) {
            try {
              revision = (
                await sources.save({
                  sourceId: target.sourceId,
                  expectedRevision: target.revision,
                  assetIds: [
                    ...target.assets.map((asset) => asset.assetId),
                    ...stored,
                  ],
                })
              ).revision;
            } catch (error) {
              if (!(error instanceof SourceRefused)) throw error;
              return attachRefuse(
                `Uploaded ${uploads
                  .filter((upload) => upload.assetId)
                  .map((upload) => upload.name)
                  .join(
                    ", ",
                  )} to Documents, but did not attach: the page changed meanwhile. Reload the page and attach it from your library.`,
                409,
              );
            }
          }
          if (
            form.get("via") === "fetcher" ||
            uploads.some((upload) => upload.error)
          )
            return data<Answer>({
              uploads,
              id: attachTo,
              attachTo,
              revision,
              folderId,
            });
          return redirect(libraryWithout(back, "attach", "linksAfter"));
        }
        if (
          form.get("via") === "fetcher" ||
          uploads.some((upload) => upload.error)
        )
          return data<Answer>({ uploads, folderId });
        return redirect(back);
      }
      case "folder-name": {
        const folder = await library.folderOf(assetIdOf(id) ?? "");
        if (!folder) return refuse("Folder unavailable.", 404);
        await library.renameFolder(
          folder.folderId,
          String(form.get("value") ?? ""),
        );
        return afterSave(form, back);
      }
      case "folder-field": {
        const folder = await library.folderOf(assetIdOf(id) ?? "");
        const field = form.get("field");
        if (!folder || (field !== "tags" && field !== "notes"))
          return refuse("Folder unavailable.", 404);
        const value = String(form.get("value") ?? "");
        await library.setFolderDetails(
          folder.folderId,
          field === "tags" ? { tags: tagsOf(value) } : { notes: value },
        );
        return afterSave(form, back);
      }
      case "folder-group": {
        const files = form
          .getAll("file")
          .map((value) => assetIdOf(String(value)))
          .filter((value): value is string => value !== null);
        const grouped = await library.groupFolders(
          files,
          String(form.get("name") ?? ""),
        );
        // Open the folder that now holds them, so the result is in view.
        const member =
          files.find((file) => file === grouped.folderId) ?? files[0];
        return redirect(libraryParam(back, "details", assetRef(member)));
      }
      case "folder-new": {
        const assetId = assetIdOf(id);
        if (!assetId) return refuse("Choose a file to move.");
        await library.moveToNewFolder(assetId, String(form.get("name") ?? ""));
        return redirect(
          libraryParam(libraryWithout(back, "move"), "processing", assetId),
        );
      }
      case "folder-move": {
        const assetId = assetIdOf(id);
        const destination = await library.folderOf(
          assetIdOf(String(form.get("destination") ?? "")) ?? "",
        );
        if (!assetId || !destination)
          return refuse("Choose an existing folder.");
        await library.moveToFolder(assetId, destination.folderId);
        return redirect(
          libraryParam(libraryWithout(back, "move"), "processing", assetId),
        );
      }
      case "asset-field": {
        const edit = fieldEdit.parse(Object.fromEntries(form));
        const assetId = assetIdOf(edit.id);
        if (
          assetId === null ||
          !["title", "description", "tags", "project"].includes(edit.field)
        )
          throw new Response("Invalid asset edit.", { status: 400 });
        const tagAsset =
          edit.field === "tags" ? await library.asset(assetId) : null;
        const updated = await library.update(assetId, {
          [edit.field]:
            edit.field === "tags"
              ? withLibraryTags(
                  tagAsset?.tags ?? [],
                  tagsOf(edit.value),
                  tagAsset?.sourceAgent === "raindrop-import",
                )
              : edit.field === "project"
                ? edit.value.trim() || null
                : edit.value,
        });
        if (updated === null) throw new Response("Not found.", { status: 404 });
        return afterSave(form, back);
      }
      case "asset-expiry": {
        const assetId = assetIdOf(id);
        if (assetId === null)
          throw new Response("Invalid id.", { status: 400 });
        if (form.get("expires") === "current") return redirect(back);
        const keep = Number(form.get("expires") || 0);
        await library.update(assetId, {
          expiresInSeconds: keep > 0 ? keep : null,
        });
        return redirect(back);
      }
      case "asset-archive":
      case "asset-restore": {
        const assetId = assetIdOf(id);
        if (
          assetId === null ||
          !(await library.setArchived(assetId, intent === "asset-archive"))
        )
          throw new Response("Not found.", { status: 404 });
        return redirect(back);
      }
      case "asset-delete": {
        const assetId = assetIdOf(id);
        if (assetId === null)
          throw new Response("Invalid id.", { status: 400 });
        const outcome = await library.deleteAsset(assetId);
        if (outcome === null) throw new Response("Not found.", { status: 404 });
        if ("refusedBy" in outcome) {
          const names = await Promise.all(
            outcome.refusedBy.slice(0, 5).map(async (ref) => {
              const sourceId = sourceIdOf(ref);
              return sourceId
                ? ((await sources.get(sourceId))?.title ?? "a saved page")
                : "a saved note or task";
            }),
          );
          return refuse(
            `This original is retained by ${[...new Set(names)].join(", ")}${outcome.refusedBy.length > 5 ? " and other items" : ""}, including saved history. Archive it to hide it, or remove those saved items before deleting it permanently.`,
            409,
          );
        }
        return redirect(back);
      }
      case "source-create": {
        const kind = z
          .enum(
            SOURCE_KINDS.map(([name]) => name) as [SourceKind, ...SourceKind[]],
          )
          .parse(form.get("kind"));
        await sources.save({
          kind,
          title: String(form.get("title") ?? ""),
          url: String(form.get("url") ?? "").trim() || null,
          notes: String(form.get("notes") ?? ""),
          tags: tagsOf(String(form.get("tags") ?? "")),
          assetIds: form
            .getAll("asset")
            .map((value) => assetIdOf(String(value)))
            .filter((value): value is string => value !== null),
        });
        return redirect(back);
      }
      case "source-field": {
        const edit = fieldEdit.parse(Object.fromEntries(form));
        const sourceId = sourceIdOf(edit.id);
        if (sourceId === null || edit.field === "description")
          throw new Response("Invalid source edit.", { status: 400 });
        if (edit.field === "authors") {
          await sources.save({
            sourceId,
            expectedRevision: edit.revision,
            authors: authorsOf(edit.value),
          });
          return afterSave(form, back);
        }
        const noteSource =
          edit.field === "notes" || edit.field === "tags"
            ? await sources.get(sourceId)
            : null;
        const notesValue =
          edit.field === "notes" && noteSource
            ? withReadingNotes(noteSource, edit.value)
            : edit.value;
        if (edit.field === "notes" && notesValue.length > MAX_NOTES_LENGTH)
          throw new SourceRefused(
            "Notes must fit within 65,536 characters, including the retained import receipt. Shorten the notes and save again.",
          );
        await sources.save({
          sourceId,
          expectedRevision: edit.revision,
          [edit.field]:
            edit.field === "tags"
              ? withLibraryTags(
                  noteSource?.tags ?? [],
                  tagsOf(edit.value),
                  !!noteSource && raindropSource(noteSource),
                )
              : edit.field === "url" || edit.field === "project"
                ? edit.value.trim() || null
                : edit.field === "notes" && noteSource
                  ? notesValue
                  : edit.value,
        });
        return afterSave(form, back);
      }
      case "source-link":
      case "source-unlink": {
        const sourceId = sourceIdOf(id);
        const assetId = assetIdOf(String(form.get("asset") ?? ""));
        const source = sourceId === null ? null : await sources.get(sourceId);
        if (source === null || assetId === null)
          throw new Response("Not found.", { status: 404 });
        const current = source.assets.map((asset) => asset.assetId);
        await sources.save({
          sourceId: source.sourceId,
          expectedRevision: Number(form.get("revision")),
          assetIds:
            intent === "source-link"
              ? [...current, assetId]
              : current.filter((linked) => linked !== assetId),
        });
        // The attach modal posts to its own URL so a refusal shows inside it.
        return redirect(libraryWithout(back, "attach", "linksAfter"));
      }
      case "source-tag-accept": {
        const sourceId = sourceIdOf(id);
        const tag = String(form.get("tag") ?? "").trim();
        const source = sourceId === null ? null : await sources.get(sourceId);
        if (source === null || !tag)
          throw new Response("Not found.", { status: 404 });
        if (!source.tags.includes(tag) && source.tags.length >= 20)
          throw new SourceRefused(
            "Remove a tag before adding another (limit 20).",
          );
        if (!source.tags.includes(tag))
          await sources.save({
            sourceId: source.sourceId,
            expectedRevision: Number(form.get("revision")),
            tags: [...source.tags, tag],
          });
        return afterSave(form, back);
      }
      case "rate": {
        // The reader's own action, from the pane: the same stars (P7, P12).
        const sourceId = sourceIdOf(id);
        const stars = postedStars(form);
        const source = sourceId === null ? null : await sources.get(sourceId);
        if (source === null) throw new Response("Not found.", { status: 404 });
        if (stars === null)
          throw new Response("A rating is 1 to 3 stars, or 0 to clear.", {
            status: 400,
          });
        await library.setRating("source", source.sourceId, stars || null);
        return afterSave(form, back);
      }
      case "source-tag-dismiss": {
        const sourceId = sourceIdOf(id);
        if (
          sourceId === null ||
          !(await sources.dismissTag(
            sourceId,
            String(form.get("enrichment") ?? ""),
            String(form.get("tag") ?? ""),
          ))
        )
          throw new Response("Not found.", { status: 404 });
        return redirect(back);
      }
      case "source-archive":
      case "source-restore": {
        const sourceId = sourceIdOf(id);
        if (
          sourceId === null ||
          !(await sources.setArchived(sourceId, intent === "source-archive"))
        )
          throw new Response("Not found.", { status: 404 });
        return redirect(back);
      }
      case "source-delete": {
        const sourceId = sourceIdOf(id);
        if (sourceId === null || !(await sources.delete(sourceId)))
          throw new Response("Not found.", { status: 404 });
        return redirect(back);
      }
      default:
        throw new Response("Unknown intent.", { status: 400 });
    }
  } catch (error) {
    if (error instanceof SourceRefused && intent === "source-link")
      return data<Answer>(
        { error: error.message, id, attachTo: id },
        { status: 409 },
      );
    if (error instanceof AssetRefused || error instanceof SourceRefused)
      return refuse(error.message, 409);
    throw error;
  }
}

export default function Library({ loaderData }: Route.ComponentProps) {
  const { archived, assets, sources, linkable, editing } = loaderData;
  const answer = useActionData<Answer>();
  useProcessingRefresh(
    Object.values(loaderData.processing).some(
      (view) => view.state === "queued" || view.state === "running",
    ),
  );
  const [previewing, setPreviewing] = useState<Asset | null>(null);
  // Folder rows ticked for grouping. Without scripting the boxes post
  // through the always-present bar instead. P11.
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const back = loaderData.back;
  // A saved bookmark empties the form, so a second click cannot save it twice.
  const navigation = useNavigation();
  const savingBookmark = navigation.formData?.get("intent") === "source-create";
  const bookmarkPending = useRef(false);
  const [bookmarksSaved, setBookmarksSaved] = useState(0);
  useEffect(() => {
    if (savingBookmark) bookmarkPending.current = true;
    else if (bookmarkPending.current && navigation.state === "idle") {
      bookmarkPending.current = false;
      if (!answer?.error) setBookmarksSaved((saved) => saved + 1);
    }
  }, [savingBookmark, navigation.state, answer]);
  const backups = assets.filter(importBackup);
  const focused = loaderData.processingAsset;
  const processingPane = focused ? (
    <Modal
      open
      size="pane"
      mobileSheet
      title={
        params.get("review") === "1"
          ? `Review suggestions for ${focused.title}`
          : `Processing ${focused.title}`
      }
      onClose={() => {
        const next = new URLSearchParams(params);
        if (!next.has("processing")) next.delete("details");
        next.delete("processing");
        next.delete("review");
        setParams(next, { replace: true, preventScrollReset: true });
      }}
    >
      <div className="stack">
        <FolderContents data={loaderData} back={back} answer={answer} />
        <ExtractedText asset={focused} extracted={loaderData.extracted} />
        <AssetProcessing
          assetId={focused.assetId}
          title={focused.title}
          description={focused.description}
          tags={focused.tags}
          project={focused.project}
          fileName={focused.fileName}
          contentType={focused.contentType}
          size={focused.size ?? focused.declaredSize}
          processing={loaderData.processing[focused.assetId]}
          vocabulary={loaderData.vocabulary}
          inPane
        />
        <a
          className="button small gap-1.5"
          download={focused.fileName}
          href={`/files/${focused.objectId}`}
        >
          <Icon name="download" />
          Download original
        </a>
      </div>
    </Modal>
  ) : null;
  const paneInCard =
    !!focused &&
    assets.some((asset) => asset.assetId === focused.assetId) &&
    !importBackup(focused);
  const card = (asset: Asset) => (
    <AssetCard
      answer={answer}
      archived={archived}
      asset={asset}
      folder={loaderData.folders.find(
        (folder) => folder.assetId === asset.assetId,
      )}
      selectedFolder={loaderData.openFolder?.folderId}
      selectable={!archived}
      ticked={ticked.has(asset.assetId)}
      onTick={(on) => {
        const next = new Set(ticked);
        if (on) next.add(asset.assetId);
        else next.delete(asset.assetId);
        setTicked(next);
      }}
      folderContents={
        <FolderContents data={loaderData} back={back} answer={answer} />
      }
      extracted={
        loaderData.selectedAsset?.assetId === asset.assetId
          ? loaderData.extracted
          : null
      }
      back={back}
      editing={editing}
      key={asset.assetId}
      onPreview={() => setPreviewing(asset)}
      tags={loaderData.tags}
      processing={loaderData.processing[asset.assetId]}
      vocabulary={loaderData.vocabulary}
      expanded={loaderData.expanded === assetRef(asset.assetId)}
      processingPane={
        focused?.assetId === asset.assetId ? processingPane : null
      }
    />
  );
  const filters: ListFilters = {
    query: loaderData.query || undefined,
    project: loaderData.project || undefined,
    tags: loaderData.selectedTags.length ? loaderData.selectedTags : undefined,
    sort: loaderData.sort === "saved" ? undefined : loaderData.sort,
  };
  const keep = {
    archived: archived ? "1" : undefined,
    view: loaderData.view === "documents" ? "documents" : undefined,
  };
  const viewHref = (view: "pages" | "documents") =>
    listHref("/library", filters, {
      ...keep,
      view: view === "documents" ? "documents" : undefined,
    });
  const addHref = (what: "bookmark" | "upload" | null) => {
    const next = new URLSearchParams(params);
    next.delete("add");
    next.delete("attach");
    if (what) next.set("add", what);
    const search = next.toString();
    return search ? `/library?${search}` : "/library";
  };
  const addingBookmark =
    !archived &&
    (loaderData.adding === "bookmark" || loaderData.attaching === "new");
  const uploading =
    !archived &&
    (loaderData.adding === "upload" ||
      Boolean(
        answer?.uploads?.length &&
          !answer.attachTo &&
          !params.has("folderUpload"),
      ));
  const showDocuments = loaderData.view === "documents";
  return (
    <ApplicationShell
      lede="Your saved pages, highlights and documents. Open an item's details to read and organize it."
      sections={
        <LibraryNav
          current={archived ? "archived" : "library"}
          view={loaderData.view === "documents" ? "documents" : "pages"}
        />
      }
      title="Library"
    >
      {answer?.error && !answer.id ? (
        <p className="empty" role="alert">
          {answer.error}
        </p>
      ) : null}
      {loaderData.processingUnavailable ? (
        <p role="alert">
          That document is unavailable. You can still browse your Library below.
        </p>
      ) : null}

      <ListControls>
        <ListToolbar
          extra={keep}
          filters={filters}
          path="/library"
          vocabulary={{
            ...loaderData.vocabulary,
            tags: loaderData.tags,
          }}
        >
          <nav
            aria-label="Library view"
            className="inline-flex h-8 items-center rounded-lg bg-muted p-[3px]"
          >
            {(
              [
                [
                  "pages",
                  `Bookmarks (${sources.length}${loaderData.nextSources ? "+" : ""})`,
                ],
                [
                  "documents",
                  `Documents (${assets.length}${loaderData.nextFiles ? "+" : ""})`,
                ],
              ] as const
            ).map(([view, label]) => (
              <Link
                aria-current={
                  (view === "documents") === showDocuments ? "page" : undefined
                }
                className="inline-flex h-full items-center rounded-md px-3 text-sm font-medium text-muted-foreground no-underline aria-[current=page]:bg-background aria-[current=page]:text-foreground aria-[current=page]:shadow-sm"
                key={view}
                preventScrollReset
                to={viewHref(view)}
              >
                {label}
              </Link>
            ))}
          </nav>
          {showDocuments ? null : (
            <SortMenu
              label="Sort bookmarks"
              options={SOURCE_SORTS.map(([value, label]) => ({
                label,
                current: loaderData.sort === value,
                href: listHref("/library", filters, {
                  ...keep,
                  sort: value === "saved" ? undefined : value,
                }),
              }))}
            />
          )}
        </ListToolbar>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <details className="library-help">
            <summary>What can I search?</summary>
            <p className="muted">{COVERAGE}</p>
          </details>
          <EnrichmentBudget status={loaderData.enrichment} />
        </div>
      </ListControls>

      <Modal
        closeHref={addHref(null)}
        onClose={() =>
          navigate(addHref(null), { replace: true, preventScrollReset: true })
        }
        open={uploading}
        title="Upload documents"
      >
        <LibraryUpload
          answer={answer}
          back={back}
          maxBytes={loaderData.maxBytes}
        />
      </Modal>

      {showDocuments ? (
        <section aria-label="Documents">
          {assets.length === 0 ? (
            <>
              <ul className="card-list library-grid">
                {archived ? null : (
                  <AddRow label="Upload documents" to={addHref("upload")} />
                )}
              </ul>
              <Empty>
                {archived
                  ? "No archived files in this view."
                  : "No files in this view. Upload one, change the filters, or open the newest page."}
              </Empty>
            </>
          ) : (
            <>
              {!archived &&
              assets.length > 1 &&
              (!hydrated ||
                ticked.size > 0 ||
                answer?.id === "folder-group") ? (
                <Form
                  aria-label="Group folders"
                  className="library-group-bar"
                  id="folder-group"
                  method="post"
                  preventScrollReset
                >
                  <input name="intent" type="hidden" value="folder-group" />
                  <input name="id" type="hidden" value="folder-group" />
                  <p className="muted">
                    {hydrated
                      ? `${ticked.size} ${ticked.size === 1 ? "folder" : "folders"} selected`
                      : "Tick two or more folders to group them."}
                  </p>
                  {answer?.id === "folder-group" && answer.error ? (
                    <p role="alert">{answer.error}</p>
                  ) : null}
                  <Field label="New folder name (optional)" name="name" />
                  <div className="row">
                    <Button
                      type="submit"
                      disabled={hydrated && ticked.size < 2}
                    >
                      Group into one folder
                    </Button>
                    {hydrated ? (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => setTicked(new Set())}
                      >
                        Clear selection
                      </Button>
                    ) : null}
                  </div>
                </Form>
              ) : null}
              <ul className="card-list library-grid">
                {archived ? null : (
                  <AddRow label="Upload documents" to={addHref("upload")} />
                )}
                {assets.filter((asset) => !importBackup(asset)).map(card)}
              </ul>
            </>
          )}
          <LibraryPaging
            back={back}
            param="filesAfter"
            next={loaderData.nextFiles}
            label="folders"
          />
          {backups.length ? (
            <details className="library-import-backups">
              <summary>Import backups ({backups.length})</summary>
              <p className="muted">
                These JSON receipts preserve the original import. They are not
                separate articles or books.
              </p>
              <ul>
                {backups.map((asset) => (
                  <li key={asset.assetId}>
                    <a
                      download={asset.fileName}
                      href={`/files/${asset.objectId}`}
                    >
                      Download {asset.title}
                    </a>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}

      <Modal
        closeHref={addHref(null)}
        onClose={() =>
          navigate(addHref(null), { replace: true, preventScrollReset: true })
        }
        open={addingBookmark}
        title="Add a bookmark"
      >
        <div className="library-source">
          <Form
            className="stack"
            key={bookmarksSaved}
            method="post"
            preventScrollReset
          >
            <input name="intent" type="hidden" value="source-create" />
            <input name="kind" type="hidden" value="bookmark" />
            <Field label="Title" name="title" required />
            <Field label="URL" name="url" placeholder="https://" type="url" />
            <Field
              label="Notes"
              name="notes"
              placeholder="Why you saved it, or a passage you want to remember."
              rows={4}
            />
            <TagInput defaultValue={[]} name="tags" options={loaderData.tags} />
            {hydrated || loaderData.attaching === "new" ? (
              <AsyncPicker
                emptyLabel="No document"
                endpoint="/library/documents"
                fallback={linkable.map((asset) => ({
                  value: assetRef(asset.assetId),
                  label: asset.title,
                }))}
                label="Attach a saved document (optional)"
                name="asset"
                placeholder="Search saved documents"
              />
            ) : (
              <Link to={libraryParam(back, "attach", "new")} preventScrollReset>
                Attach a saved document (optional)
              </Link>
            )}
            <div className="row">
              <button type="submit">Save bookmark</button>
            </div>
          </Form>
        </div>
      </Modal>

      {showDocuments ? null : (
        <section aria-label="Saved pages">
          {sources.length === 0 ? (
            <>
              <ul className="card-list library-grid">
                {archived ? null : (
                  <AddRow label="Add bookmark" to={addHref("bookmark")} />
                )}
              </ul>
              <Empty>
                {archived
                  ? "No archived sources in this view."
                  : "No sources in this view. Save one, change the filters, or open the newest page."}
              </Empty>
            </>
          ) : (
            <ul className="card-list library-grid">
              {archived ? null : (
                <AddRow label="Add bookmark" to={addHref("bookmark")} />
              )}
              {sources.map((source) => (
                <SourceCard
                  answer={answer}
                  archived={archived}
                  back={back}
                  editing={editing}
                  key={source.sourceId}
                  linkable={linkable}
                  maxBytes={loaderData.maxBytes}
                  source={source}
                  tags={loaderData.tags}
                  projects={loaderData.vocabulary.projects}
                  attaching={
                    loaderData.attaching === sourceRef(source.sourceId)
                  }
                  history={
                    loaderData.history?.id === sourceRef(source.sourceId)
                      ? loaderData.history.revisions
                      : null
                  }
                  nextLinks={loaderData.nextLinks}
                  expanded={loaderData.expanded === sourceRef(source.sourceId)}
                  article={
                    loaderData.expanded === sourceRef(source.sourceId)
                      ? loaderData.openArticle
                      : null
                  }
                  enrichment={
                    loaderData.expanded === sourceRef(source.sourceId)
                      ? loaderData.openEnrichment
                      : null
                  }
                  importBackupIds={loaderData.importBackupIds}
                  stars={loaderData.ratings[source.sourceId] ?? null}
                />
              ))}
            </ul>
          )}
          <LibraryPaging
            back={back}
            param="sourcesAfter"
            next={loaderData.nextSources}
            label="sources"
          />
        </section>
      )}

      {previewing?.objectId ? (
        <FilePreview
          file={{
            objectId: previewing.objectId,
            name: previewing.fileName,
            contentType: previewing.contentType,
            size: previewing.size ?? 0,
          }}
          onClose={() => setPreviewing(null)}
        />
      ) : null}
      {!paneInCard ? processingPane : null}
    </ApplicationShell>
  );
}

/** P3/P11: bounded pages are ordinary URLs, including without hydration. */
function LibraryPaging({
  back,
  param,
  next,
  label,
}: {
  back: string;
  param: "filesAfter" | "sourcesAfter" | "linksAfter";
  next: string | null;
  label: string;
}) {
  const url = new URL(back, "https://valise.invalid");
  const current = url.searchParams.has(param);
  function href(cursor: string | null) {
    const target = new URL(url);
    target.searchParams.delete("edit");
    if (cursor) target.searchParams.set(param, cursor);
    else target.searchParams.delete(param);
    return `${target.pathname}${target.search}`;
  }
  if (!current && !next) return null;
  return (
    <nav className="row" aria-label={`${label} pages`}>
      <p className="muted">Up to 30 {label} per page.</p>
      {current ? (
        <a className="button ghost small" href={href(null)}>
          Newest {label}
        </a>
      ) : null}
      {next ? (
        <a className="button ghost small" href={href(next)}>
          Older {label}
        </a>
      ) : null}
    </nav>
  );
}

function FolderContents({
  data,
  back,
  answer,
}: {
  data: Route.ComponentProps["loaderData"];
  back: string;
  answer: Answer | undefined;
}) {
  const [params, setParams] = useSearchParams();
  const folder = data.openFolder;
  if (!folder) return null;
  const asset = data.selectedAsset;
  const close = libraryWithout(back, "folderUpload", "move");
  const folderRef = assetRef(asset?.assetId ?? "");
  // The folder's own tags and notes: one field, one commit (P2).
  const folderField = (name: "tags" | "notes") => ({
    action: back,
    cancelHref: back,
    editHref: libraryEditHref(back, editKey(folderRef, `folder-${name}`)),
    editing: openField(data.editing, folderRef) === `folder-${name}`,
    hidden: { intent: "folder-field", id: folderRef, field: name },
    save: "fetch" as const,
  });
  return (
    <section aria-label="Folder files" className="grid gap-3">
      <Editable
        action={back}
        cancelHref={back}
        editHref={libraryEditHref(
          back,
          editKey(assetRef(asset?.assetId ?? ""), "folder"),
        )}
        editing={
          openField(data.editing, assetRef(asset?.assetId ?? "")) === "folder"
        }
        hidden={{ intent: "folder-name", id: assetRef(asset?.assetId ?? "") }}
        save="fetch"
        label="Folder name"
        defaultValue={folder.title ?? data.members[0]?.title ?? "Documents"}
      >
        <p className="font-medium">
          Folder: {folder.title ?? data.members[0]?.title ?? "Documents"}
        </p>
      </Editable>
      <Editable
        {...folderField("tags")}
        defaultValue={folder.tags.join(", ")}
        editor={
          <TagInput
            autoFocus
            defaultValue={folder.tags}
            name="value"
            options={data.tags}
          />
        }
        label="Folder tags"
        noPen
      >
        <TagSet
          action={back}
          editHref={folderField("tags").editHref}
          hidden={folderField("tags").hidden}
          options={data.tags}
          tags={folder.tags}
          addLabel="Add folder tags"
          addOneLabel="Add folder tag"
          spelled
        />
      </Editable>
      <Editable
        {...folderField("notes")}
        defaultValue={folder.notes}
        empty={folder.notes ? undefined : "Add folder notes"}
        label="Folder notes"
        multiline
        rows={3}
      >
        <p className="whitespace-pre-line">{folder.notes}</p>
      </Editable>
      <ul className="grid gap-2" aria-label="Files in this folder">
        {data.members.map((member) => (
          <li key={member.assetId}>
            <Link
              className="aria-[current=page]:font-semibold"
              aria-current={
                member.assetId === asset?.assetId ? "page" : undefined
              }
              preventScrollReset
              to={libraryParam(
                libraryWithout(back, "details", "edit", "review"),
                "processing",
                member.assetId,
              )}
            >
              {member.fileName}
            </Link>
            <span className="muted"> · {fileSize(member.size ?? 0)}</span>
          </li>
        ))}
      </ul>
      <Link
        className="add-value"
        preventScrollReset
        to={libraryParam(back, "folderUpload", "1")}
      >
        + Add files to this folder
      </Link>
      {asset ? (
        <Link
          className="add-value"
          preventScrollReset
          to={libraryParam(back, "move", "1")}
        >
          Move this file to another folder
        </Link>
      ) : null}
      <Modal
        open={params.has("folderUpload")}
        closeHref={close}
        title="Add files to this folder"
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete("folderUpload");
          setParams(next, { replace: true, preventScrollReset: true });
        }}
      >
        <LibraryUpload
          back={libraryParam(back, "folderUpload", "1")}
          maxBytes={data.maxBytes}
          answer={answer}
          folderId={folder.folderId}
        />
      </Modal>
      <Modal
        open={params.has("move")}
        closeHref={close}
        title="Move file to a folder"
        onClose={() => {
          const next = new URLSearchParams(params);
          next.delete("move");
          setParams(next, { replace: true, preventScrollReset: true });
        }}
      >
        <Form
          action={libraryParam(back, "move", "1")}
          method="post"
          className="stack"
          preventScrollReset
        >
          {answer?.error ? <p role="alert">{answer.error}</p> : null}
          <input type="hidden" name="intent" value="folder-move" />
          <input
            type="hidden"
            name="id"
            value={assetRef(asset?.assetId ?? "")}
          />
          <AsyncPicker
            endpoint="/library/documents?folders=1"
            name="destination"
            label="Destination folder"
            placeholder="Search folders"
            fallback={data.assets
              .filter((a) => a.assetId !== asset?.assetId)
              .map((a) => ({
                value: assetRef(a.assetId),
                label:
                  data.folders.find((f) => f.assetId === a.assetId)?.title ??
                  a.title,
              }))}
          />
          <Button type="submit">Move file</Button>
        </Form>
        <Form
          action={libraryParam(back, "move", "1")}
          method="post"
          className="stack"
          preventScrollReset
        >
          <input type="hidden" name="intent" value="folder-new" />
          <input
            type="hidden"
            name="id"
            value={assetRef(asset?.assetId ?? "")}
          />
          <Field
            label="Or move it to a new folder named"
            name="name"
            required
          />
          <Button type="submit" variant="outline">
            Move to a new folder
          </Button>
        </Form>
      </Modal>
    </section>
  );
}

function libraryParam(back: string, key: string, value: string): string {
  const url = new URL(back, "https://valise.invalid");
  url.searchParams.set(key, value);
  return `${url.pathname}${url.search}`;
}

function libraryBrowseHref(back: string): string {
  const url = new URL(back, "https://valise.invalid");
  for (const key of ["details", "attach", "linksAfter", "history", "edit"])
    url.searchParams.delete(key);
  return `${url.pathname}${url.search}`;
}

function LibraryLabels({
  project,
  tags,
  imported = false,
}: {
  project: string | null;
  tags: string[];
  imported?: boolean;
}) {
  const visible = libraryTags(tags, imported);
  return (
    <div className="library-organization">
      {project && !(project === "raindrop" && imported) ? (
        <ProjectChip project={project} />
      ) : null}
      {visible.length ? (
        <ul className="tags">
          {visible.map((tag) => (
            <li key={tag}>
              <Tag>{tag}</Tag>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/** One bounded multipart request per file, each using the existing upload path. */
function LibraryUpload({
  answer,
  back,
  maxBytes,
  folderId,
}: {
  answer: Answer | undefined;
  back: string;
  maxBytes: number;
  folderId?: string;
}) {
  const fetcher = useFetcher<Answer>();
  const selected = useRef<File[]>([]);
  const queue = useRef<{
    files: File[];
    title: string;
    expires: string;
    index: number;
    folderId?: string;
    folderTitle: string;
  } | null>(null);
  const handled = useRef<Answer | undefined>(undefined);
  const [count, setCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const [results, setResults] = useState<NonNullable<Answer["uploads"]>>([]);
  function sendNext() {
    const batch = queue.current;
    if (!batch) return;
    const file = batch.files[batch.index];
    if (!file) {
      queue.current = null;
      selected.current = [];
      setCount(0);
      setBusy(false);
      setRound((value) => value + 1);
      return;
    }
    const body = new FormData();
    body.set("intent", "upload");
    body.set("via", "fetcher");
    body.set("file", file);
    body.set("title", batch.files.length === 1 ? batch.title : "");
    body.set("expires", batch.expires);
    body.set("folderId", batch.folderId ?? "");
    body.set("folderTitle", batch.folderTitle);
    fetcher.submit(body, {
      action: back,
      method: "post",
      encType: "multipart/form-data",
      preventScrollReset: true,
    });
  }
  useEffect(() => {
    if (
      fetcher.state !== "idle" ||
      !fetcher.data ||
      handled.current === fetcher.data ||
      !queue.current
    )
      return;
    handled.current = fetcher.data;
    const batch = queue.current;
    if (fetcher.data.folderId) batch.folderId = fetcher.data.folderId;
    const result = fetcher.data.uploads?.[0] ?? {
      name: batch.files[batch.index].name,
      error: fetcher.data.error ?? "Upload failed. Try this file again.",
    };
    setResults((previous) => [...previous, result]);
    batch.index += 1;
    sendNext();
  });
  const shown = results.length ? results : (answer?.uploads ?? []);
  return (
    // The Upload dialog is the disclosure; the form is open inside it.
    <div className="library-upload">
      {answer?.error ? <p role="alert">{answer.error}</p> : null}
      <fetcher.Form
        aria-busy={busy}
        className="stack"
        encType="multipart/form-data"
        method="post"
        onSubmit={(event) => {
          event.preventDefault();
          const fields = event.currentTarget.elements;
          // A native selection made before hydration still belongs to this form.
          const native = fields.namedItem("file") as unknown as {
            files?: ArrayLike<File>;
          } | null;
          const files = selected.current.length
            ? selected.current
            : Array.from(native?.files ?? []);
          if (queue.current || !files.length) return;
          queue.current = {
            files,
            title: fields.namedItem("title")?.value ?? "",
            expires: fields.namedItem("expires")?.value ?? "",
            index: 0,
            folderId,
            folderTitle: fields.namedItem("folderTitle")?.value ?? "",
          };
          handled.current = fetcher.data;
          setResults([]);
          setBusy(true);
          sendNext();
        }}
        preventScrollReset
      >
        <input name="intent" type="hidden" value="upload" />
        {folderId ? (
          <input name="folderId" type="hidden" value={folderId} />
        ) : (
          <Field
            label="Folder name"
            name="folderTitle"
            placeholder="Defaults to the first file name"
          />
        )}
        <FileDropzone
          disabled={busy}
          hint={`Up to ${fileSize(maxBytes)} per file, 100 files per folder. Selected files stay together in one folder and keep their own names.`}
          key={round}
          label={`File, up to ${fileSize(maxBytes)}`}
          multiple
          onFiles={(files) => {
            selected.current = files;
            setCount(files.length);
          }}
        />
        <label>
          Title
          <input
            disabled={busy || count > 1}
            name="title"
            placeholder="Defaults to the file name"
          />
        </label>
        <p className="muted">
          The folder name applies to the whole batch. Title applies to a single
          file; each original keeps its filename.
        </p>
        <noscript>
          <p className="muted">
            With scripting off, the combined upload must be under{" "}
            {fileSize(maxBytes)}.
          </p>
        </noscript>
        <Select label="Retention" name="expires" options={RETENTION} />
        <div className="row">
          <button disabled={busy} type="submit">
            {busy ? "Uploading…" : "Upload"}
          </button>
        </div>
        {busy ? (
          <p role="status">
            Uploading files one at a time. Keep this page open.
          </p>
        ) : null}
      </fetcher.Form>
      {shown.length ? (
        <ul
          aria-label="Upload results"
          className="library-upload-results"
          aria-live="polite"
        >
          {shown.map((result, index) => (
            <li key={`${index}-${result.name}`}>
              {result.name}:{" "}
              {result.error ? `Not uploaded — ${result.error}` : "Uploaded"}
              {result.processingNote ? (
                <p className="muted">{result.processingNote}</p>
              ) : null}
              {result.assetId ? (
                <Link
                  to={libraryParam(
                    "/library?view=documents",
                    "processing",
                    result.assetId,
                  )}
                  preventScrollReset
                >
                  Review processing and suggestions
                </Link>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function AssetCard({
  asset,
  archived,
  back: listBack,
  editing,
  answer,
  onPreview,
  tags,
  processing,
  vocabulary,
  expanded,
  processingPane,
  folder,
  folderContents,
  extracted,
  selectedFolder,
  selectable = false,
  ticked = false,
  onTick,
}: {
  asset: Asset;
  archived: boolean;
  back: string;
  editing: string | undefined;
  answer: Answer | undefined;
  onPreview: () => void;
  tags: string[];
  processing:
    | import("~/concepts/asset-processing").AssetProcessingView
    | undefined;
  vocabulary: import("~/concepts/vocabulary").Vocabulary;
  expanded: boolean;
  processingPane: React.ReactNode;
  folder?: import("~/concepts/asset-folders").AssetFolder;
  folderContents: React.ReactNode;
  extracted: Awaited<ReturnType<typeof readAssetText>>;
  selectedFolder?: string;
  /** A box that posts this folder through the group bar's form. */
  selectable?: boolean;
  ticked?: boolean;
  onTick?: (on: boolean) => void;
}) {
  const id = assetRef(asset.assetId);
  const back = libraryParam(listBack, "details", id);
  const semantics = useId();
  const retention = useId();
  const field = (name: "title" | "description" | "tags") => ({
    action: back,
    cancelHref: back,
    editHref: libraryEditHref(back, editKey(id, name)),
    editing: openField(editing, id) === name,
    hidden: { intent: "asset-field", id, field: name },
    save: "fetch" as const,
  });
  const href = `/files/${asset.objectId}`;
  const writtenTags = libraryTags(
    asset.tags,
    asset.sourceAgent === "raindrop-import",
  );
  const disclosed = expanded || !!openField(editing, id) || answer?.id === id;
  const preview = (event: React.MouseEvent<HTMLAnchorElement>) => {
    if (
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey
    )
      return;
    event.preventDefault();
    onPreview();
  };
  return (
    <Card
      as="li"
      className={`todo-card library-item library-document${folder?.folderId === selectedFolder ? " is-selected" : ""}`}
    >
      <input name="id" type="hidden" value={id} />
      {selectable ? (
        <label className="library-select">
          <input
            aria-label={`Select ${folder?.title ?? asset.title}`}
            checked={ticked}
            className="size-4 accent-[var(--primary)]"
            form="folder-group"
            name="file"
            onChange={(event) =>
              onTick?.((event.target as { checked?: boolean }).checked === true)
            }
            type="checkbox"
            value={id}
          />
        </label>
      ) : null}
      <div className="library-file-heading">
        {asset.objectId ? (
          <a
            className="library-thumbnail-link"
            href={href}
            onClick={preview}
            aria-label={`Preview ${asset.title}`}
          >
            <AssetThumbnail
              filename={asset.fileName}
              mime={asset.contentType}
              objectId={asset.objectId}
              title={asset.title}
            />
          </a>
        ) : null}
        <div className="library-file-caption">
          <Editable
            {...(folder?.title
              ? {
                  ...field("title"),
                  hidden: { intent: "folder-name", id },
                  editHref: libraryEditHref(back, editKey(id, "folder")),
                  editing: openField(editing, id) === "folder",
                }
              : field("title"))}
            defaultValue={folder?.title ?? asset.title}
            label={folder?.title ? "Folder name" : "Title"}
          >
            <h3>{folder?.title ?? asset.title}</h3>
          </Editable>
          <p className="muted library-file-meta">
            Folder · {folder?.count ?? 1}{" "}
            {(folder?.count ?? 1) === 1 ? "file" : "files"} ·{" "}
            {(folder?.count ?? 1) === 1
              ? `${fileKind(asset.contentType)} · `
              : ""}
            {fileSize(folder?.size ?? asset.size ?? 0)}
            {(folder?.count ?? 1) > 1 ? " total" : ""}
          </p>
        </div>
      </div>
      {/* The row reads the same with its details open in the pane, so
          opening one moves nothing below it (P4). */}
      <LibraryLabels
        project={asset.project}
        tags={asset.tags}
        imported={asset.sourceAgent === "raindrop-import"}
      />
      {asset.description ? (
        <p className="library-excerpt">{asset.description}</p>
      ) : null}
      <AssetProcessing
        assetId={asset.assetId}
        title={asset.title}
        description={asset.description}
        tags={asset.tags}
        project={asset.project}
        processing={processing}
        vocabulary={vocabulary}
        fileName={asset.fileName}
        contentType={asset.contentType}
        size={asset.size ?? asset.declaredSize}
        fileLabel={(folder?.count ?? 1) > 1 ? asset.fileName : undefined}
        compact
      />
      {processingPane}
      <section
        className="library-item-details"
        data-expanded={disclosed ? "true" : "false"}
      >
        <Link
          className="library-details-link"
          aria-expanded={disclosed}
          to={disclosed ? libraryBrowseHref(back) : back}
          preventScrollReset
        >
          <span className="sr-only">
            {disclosed ? `Close ${asset.title}` : `Open ${asset.title}`}
          </span>
        </Link>
        {/* One pane at a time: the processing pane, when open, has the floor. */}
        {disclosed && !processingPane ? (
          <DetailPane closeHref={libraryBrowseHref(back)} title={asset.title}>
            <div className="stack">
              {folderContents}
              <ExtractedText asset={asset} extracted={extracted} />
              <AssetProcessing
                assetId={asset.assetId}
                title={asset.title}
                description={asset.description}
                tags={asset.tags}
                project={asset.project}
                processing={processing}
                vocabulary={vocabulary}
                fileName={asset.fileName}
                contentType={asset.contentType}
                size={asset.size ?? asset.declaredSize}
                inPane
              />
              <Editable
                {...field("description")}
                defaultValue={asset.description}
                empty={asset.description ? undefined : "Add a description"}
                label="Description"
                multiline
                rows={3}
              >
                <p>{asset.description}</p>
              </Editable>
              <Editable
                {...field("tags")}
                defaultValue={writtenTags.join(", ")}
                editor={
                  <TagInput
                    autoFocus
                    defaultValue={writtenTags}
                    name="value"
                    options={libraryTags(
                      tags,
                      asset.sourceAgent === "raindrop-import",
                    )}
                  />
                }
                label="Tags"
                noPen
              >
                <TagSet
                  action={back}
                  editHref={field("tags").editHref}
                  hidden={field("tags").hidden}
                  options={libraryTags(
                    tags,
                    asset.sourceAgent === "raindrop-import",
                  )}
                  tags={writtenTags}
                  spelled
                />
              </Editable>
              <Editable
                action={back}
                cancelHref={back}
                editHref={libraryEditHref(back, editKey(id, "project"))}
                editing={openField(editing, id) === "project"}
                hidden={{ intent: "asset-field", id, field: "project" }}
                save="fetch"
                defaultValue={asset.project ?? ""}
                label="Project"
                empty={asset.project ? undefined : "Add a project"}
                editor={
                  <Combobox
                    label="Project"
                    name="value"
                    defaultValue={asset.project ?? ""}
                    creatable
                    autoFocus
                    options={vocabulary.projects.map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                }
              >
                {asset.project ? <ProjectChip project={asset.project} /> : null}
              </Editable>
              <Form
                action={back}
                className="row library-retention"
                id={retention}
                method="post"
                preventScrollReset
              >
                <input name="intent" type="hidden" value="asset-expiry" />
                <input name="id" type="hidden" value={id} />
                <Select
                  defaultValue={asset.expiresAt === null ? "" : "current"}
                  key={asset.expiresAt ?? "durable"}
                  label="Retention"
                  name="expires"
                  options={
                    asset.expiresAt === null
                      ? RETENTION
                      : [
                          {
                            value: "current",
                            label: `Deleted after ${new Date(asset.expiresAt * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`,
                          },
                          ...RETENTION,
                        ]
                  }
                />
              </Form>
              {answer?.id === id && answer.error ? (
                <p className="empty" role="alert">
                  {answer.error}
                </p>
              ) : null}
              <div className="row library-actions">
                {asset.contentType === "text/html" ? (
                  <a
                    className="button small"
                    href={`/library/archive/${asset.assetId}`}
                  >
                    Open archived page
                  </a>
                ) : null}
                <a
                  className="button small gap-1.5"
                  download={asset.fileName}
                  href={href}
                >
                  <Icon name="download" />
                  Download
                </a>
                <button className="ghost small" form={retention} type="submit">
                  Set
                </button>
                <Form action={back} method="post" preventScrollReset>
                  <input name="id" type="hidden" value={id} />
                  <button
                    aria-describedby={semantics}
                    aria-label={`${archived ? "Restore" : "Archive"} ${asset.title}`}
                    className="ghost small gap-1.5"
                    name="intent"
                    type="submit"
                    value={archived ? "asset-restore" : "asset-archive"}
                  >
                    <Icon name={archived ? "restore" : "archive"} />
                    {archived ? "Restore" : "Archive"}
                  </button>
                </Form>
                <Form action={back} method="post" preventScrollReset>
                  <input name="id" type="hidden" value={id} />
                  <button
                    aria-describedby={semantics}
                    aria-label={`Delete permanently: ${asset.title}`}
                    className="danger small gap-1.5"
                    name="intent"
                    type="submit"
                    value="asset-delete"
                  >
                    <Icon name="delete" />
                    Delete permanently
                  </button>
                </Form>
              </div>
              <p className="sr-only" id={semantics}>
                Archive hides the file; its original and links stay available.
                Delete permanently removes the original when nothing refers to
                it.
              </p>
              <p className="muted">Original filename: {asset.fileName}</p>
            </div>
          </DetailPane>
        ) : null}
      </section>
    </Card>
  );
}

function SourceCard({
  source,
  linkable,
  archived,
  back: listBack,
  editing,
  answer,
  tags,
  projects,
  attaching,
  history,
  nextLinks,
  expanded,
  importBackupIds,
  article,
  enrichment,
  maxBytes,
  stars,
}: {
  /** The owner's 1 to 3 stars, or null when unrated. */
  stars: 1 | 2 | 3 | null;
  article: SourceArticle | null;
  enrichment: SourceEnrichment | null;
  source: Source;
  linkable: Pick<Asset, "assetId" | "title">[];
  archived: boolean;
  back: string;
  editing: string | undefined;
  answer: Answer | undefined;
  tags: string[];
  projects: string[];
  attaching: boolean;
  history: SourceRevision[] | null;
  nextLinks: string | null;
  expanded: boolean;
  importBackupIds: string[];
  maxBytes: number;
}) {
  const id = sourceRef(source.sourceId);
  const back = libraryParam(listBack, "details", id);
  const semantics = useId();
  const field = (name: "title" | "url" | "notes" | "tags" | "authors") => ({
    action: back,
    cancelHref: back,
    editHref: libraryEditHref(back, editKey(id, name)),
    editing: openField(editing, id) === name,
    hidden: {
      intent: "source-field",
      id,
      field: name,
      revision: String(source.revision),
    },
    save: "fetch" as const,
  });
  const linked = new Set(source.assets.map((asset) => asset.assetId));
  const offered = linkable.filter((asset) => !linked.has(asset.assetId));
  const notes = readingNotes(source);
  const text = sourceText(source, article);
  const writtenTags = libraryTags(source.tags, raindropSource(source));
  const collection = importedCollection(source);
  const supporting = raindropSource(source)
    ? source.assets.filter((asset) => importBackupIds.includes(asset.assetId))
    : [];
  const documents = source.assets.filter(
    (asset) => !supporting.includes(asset),
  );
  const disclosed =
    expanded ||
    !!openField(editing, id) ||
    attaching ||
    !!history ||
    answer?.id === id;
  return (
    <Card as="li" className="todo-card library-item">
      <input name="id" type="hidden" value={id} />
      <input name="revision" type="hidden" value={source.revision} />
      <p className="row">
        <Pill tone="label">
          {source.kind === "reference"
            ? "Highlight / note"
            : source.kind === "document"
              ? "Document"
              : "Saved page"}
        </Pill>
        {source.url ? (
          <a
            aria-label={`Visit ${pageHost(source.url)}`}
            className="library-host-link muted"
            href={source.url}
            rel="noreferrer noopener"
            target="_blank"
          >
            {pageHost(source.url)}
            <Icon name="external" size={12} />
          </a>
        ) : null}
      </p>
      <Editable {...field("title")} defaultValue={source.title} label="Title">
        <h3>{source.title}</h3>
      </Editable>
      <SourceByline source={source} stars={stars} />
      <LibraryLabels
        project={source.project}
        tags={source.tags}
        imported={raindropSource(source)}
      />
      {raindropSource(source) ? (
        <p className="muted library-collection">
          From Raindrop{collection ? ` / ${collection}` : ""}
        </p>
      ) : null}
      {notes ? (
        <p className="library-excerpt">
          {notes.replace(/^(Notes|Description)\n/, "").slice(0, 240)}
          {notes.length > 240 ? "…" : ""}
        </p>
      ) : null}
      <section
        className="library-item-details"
        data-expanded={disclosed ? "true" : "false"}
      >
        <Link
          className="library-details-link"
          aria-expanded={disclosed}
          to={disclosed ? libraryBrowseHref(back) : back}
          preventScrollReset
        >
          <span className="sr-only">
            {disclosed ? `Close ${source.title}` : `Open ${source.title}`}
          </span>
        </Link>
        {disclosed ? (
          <DetailPane
            closeHref={libraryBrowseHref(back)}
            heading={
              <SourceHeading
                article={article}
                back={back}
                field={field}
                source={source}
                stars={stars}
              />
            }
            title={source.title}
          >
            <div className="stack">
              <SummarySection enrichment={enrichment} text={text} />
              {article ? (
                <ArticleSection
                  article={article}
                  sourceId={source.sourceId}
                  archived={source.assets.length > 0}
                />
              ) : null}
              {text.from === "article" ? (
                <ShownWholeNote enrichment={enrichment} text={text} />
              ) : null}
              <Editable
                {...field("notes")}
                defaultValue={notes}
                empty={notes ? undefined : "Add notes"}
                label="Notes"
                multiline
                rows={8}
              >
                <Markdown>{notes}</Markdown>
              </Editable>
              {text.from === "notes" ? (
                <ShownWholeNote enrichment={enrichment} text={text} />
              ) : null}
              {/* A set and its suggestions read as one group. */}
              <div className="grid gap-2">
                <Editable
                  {...field("tags")}
                  defaultValue={writtenTags.join(", ")}
                  editor={
                    <TagInput
                      autoFocus
                      defaultValue={writtenTags}
                      name="value"
                      options={libraryTags(tags, raindropSource(source))}
                    />
                  }
                  label="Tags"
                  noPen
                >
                  <TagSet
                    action={back}
                    editHref={field("tags").editHref}
                    hidden={field("tags").hidden}
                    options={libraryTags(tags, raindropSource(source))}
                    tags={writtenTags}
                    spelled
                  />
                </Editable>
                <SuggestedTags
                  back={back}
                  enrichment={enrichment}
                  source={source}
                />
              </div>
              <Editable
                action={back}
                cancelHref={back}
                editHref={libraryEditHref(back, editKey(id, "project"))}
                editing={openField(editing, id) === "project"}
                hidden={{
                  intent: "source-field",
                  id,
                  field: "project",
                  revision: String(source.revision),
                }}
                save="fetch"
                defaultValue={source.project ?? ""}
                label="Project"
                empty={source.project ? undefined : "Add a project"}
                editor={
                  <Combobox
                    label="Project"
                    name="value"
                    defaultValue={source.project ?? ""}
                    creatable
                    autoFocus
                    options={projects.map((value) => ({ value, label: value }))}
                  />
                }
              >
                {source.project ? (
                  <ProjectChip project={source.project} />
                ) : null}
              </Editable>
              <SourceAttachments
                answer={answer?.attachTo === id ? answer : undefined}
                attaching={attaching}
                back={back}
                documents={documents}
                maxBytes={maxBytes}
                nextLinks={nextLinks}
                offered={offered}
                source={source}
              />
              {raindropSource(source) ? (
                <details className="library-import">
                  <summary className="eyebrow">Import details</summary>
                  <p className="muted">
                    Imported from Raindrop
                    {collection ? `, collection ${collection}` : ""}. The
                    original import receipt is retained for export and recovery.
                  </p>
                  {supporting.map((asset) => (
                    <p key={asset.assetId}>
                      {asset.title} · retained import backup
                    </p>
                  ))}
                </details>
              ) : null}
              <SourceHistory back={back} revisions={history} source={source} />
              {answer?.id === id && answer.error && !answer.attachTo ? (
                <p className="empty" role="alert">
                  {answer.error}
                </p>
              ) : null}
              <div className="row library-actions">
                <Form action={back} method="post" preventScrollReset>
                  <input name="id" type="hidden" value={id} />
                  <button
                    aria-describedby={semantics}
                    aria-label={`${archived ? "Restore" : "Archive"} ${source.title}`}
                    className="ghost small gap-1.5"
                    name="intent"
                    type="submit"
                    value={archived ? "source-restore" : "source-archive"}
                  >
                    <Icon name={archived ? "restore" : "archive"} />
                    {archived ? "Restore" : "Archive"}
                  </button>
                </Form>
                <Form action={back} method="post" preventScrollReset>
                  <input name="id" type="hidden" value={id} />
                  <button
                    aria-describedby={semantics}
                    aria-label={`Delete permanently: ${source.title}`}
                    className="danger small gap-1.5"
                    name="intent"
                    type="submit"
                    value="source-delete"
                  >
                    <Icon name="delete" />
                    Delete permanently
                  </button>
                </Form>
              </div>
              <p className="sr-only" id={semantics}>
                Archive hides this saved page and keeps its notes and history.
                Delete permanently removes the saved page, its history and
                connections; original documents remain.
              </p>
            </div>
          </DetailPane>
        ) : null}
      </section>
    </Card>
  );
}

/** A day, with the full UTC time on hover and in the markup. */
function Day({ label, seconds }: { label: string; seconds: number }) {
  const iso = new Date(seconds * 1000).toISOString();
  return (
    <time
      className="whitespace-nowrap"
      dateTime={iso}
      title={`${iso.slice(0, 16).replace("T", " ")} UTC`}
    >
      {label} {publishedDate(iso)}
    </time>
  );
}

/** Who wrote it, where, when it was published and saved, then what capture found. */
function SourceByline({
  source,
  stars,
}: {
  source: Source;
  stars: 1 | 2 | 3 | null;
}) {
  const article = source.article;
  const rest = [
    article?.siteName ?? null,
    source.published === null ? null : (
      <Day key="published" label="Published" seconds={source.published} />
    ),
    <Day key="saved" label="Saved" seconds={source.createdAt} />,
    stars ? <RatingStars key="stars" stars={stars} /> : null,
  ].filter(Boolean);
  const names = source.authors;
  return (
    <p className="muted library-byline">
      {names.length ? "By " : null}
      {names.map((name, index) => (
        <span key={name}>
          {index === 0 ? "" : index === names.length - 1 ? " and " : ", "}
          <Link to={`/library/authors/${authorSlug(name)}`}>{name}</Link>
        </span>
      ))}
      {names.length && rest.length ? " · " : null}
      {rest.map((part, index) => (
        <Fragment key={typeof part === "string" ? part : index}>
          {index ? " · " : null}
          {part}
        </Fragment>
      ))}
      {article ? (
        <>
          {names.length || rest.length ? <br /> : null}
          {describeArticle(article, [])}
          {article.detected ? (
            <>
              {" · "}
              <Link to={readerHref(source.sourceId)}>Read the article</Link>
            </>
          ) : null}
        </>
      ) : null}
    </p>
  );
}

/**
 * Tags the summary call suggested, as ghosts of the tag chip on the tags'
 * own left edge: the chip's words add it, its × dismisses it, both in one
 * click where the tags live (P7, P15). Nothing is written until the person
 * chooses. Each is a form button, so both work with scripting off (P11).
 */
function SuggestedTags({
  back,
  enrichment,
  source,
}: {
  back: string;
  enrichment: SourceEnrichment | null;
  source: Source;
}) {
  const held = new Set(source.tags.map((tag) => tag.toLowerCase()));
  const pending =
    enrichment?.suggestedTags.filter((tag) => !held.has(tag.toLowerCase())) ??
    [];
  if (!enrichment || !pending.length) return null;
  const id = sourceRef(source.sourceId);
  return (
    <div className="tag-input tag-suggestions">
      <ul aria-label="Suggested tags" className="tags">
        {pending.map((tag) => (
          <li className="chip chip-ghost" key={tag}>
            <Form action={back} method="post" preventScrollReset>
              <input name="id" type="hidden" value={id} />
              <input name="revision" type="hidden" value={source.revision} />
              <input name="tag" type="hidden" value={tag} />
              <button
                aria-label={`Add tag ${tag}`}
                className="chip-ghost-add"
                name="intent"
                title="Suggested from the summary: add this tag"
                type="submit"
                value="source-tag-accept"
              >
                <Icon name="add" size={12} />
                {tag}
              </button>
            </Form>
            <Form action={back} method="post" preventScrollReset>
              <input name="id" type="hidden" value={id} />
              <input
                name="enrichment"
                type="hidden"
                value={enrichment.enrichmentId}
              />
              <input name="tag" type="hidden" value={tag} />
              <button
                aria-label={`Dismiss suggested tag ${tag}`}
                className="chip-remove"
                name="intent"
                type="submit"
                value="source-tag-dismiss"
              >
                <Icon name="close" size={12} />
              </button>
            </Form>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Today's bookmark spend against the budget, so cost is visible before it accrues. */
function EnrichmentBudget({ status }: { status: EnrichmentStatus }) {
  if (!status.budgetMicrousd)
    return (
      <p className="muted" role="status">
        Bookmark summaries are off: the daily budget is zero.
      </p>
    );
  return (
    <p className="muted" role="status">
      Bookmark summaries: {formatUsd(status.spentMicrousd)} of $
      {(status.budgetMicrousd / 1e6).toFixed(2)} spent in the last 24 hours ·{" "}
      {status.done.toLocaleString("en-US")} summarised ·{" "}
      {status.waiting.toLocaleString("en-US")} waiting, newest first, two a
      minute while the budget lasts.
    </p>
  );
}

/** What Valise's one fetch did, alone or beside text saved with the bookmark. */
const FETCH_NOTES: Record<FetchStatus, { alone: string; saved: string }> = {
  fetched: {
    alone: "Valise fetched the page once and kept its article text.",
    saved: "Valise fetched the page once and kept its article text.",
  },
  not_article: {
    alone:
      "Valise fetched the page once and found no article; title and notes only.",
    saved:
      "Valise fetched the page once and found no article, so the text here is what was saved with the bookmark.",
  },
  paywalled: {
    alone:
      "The page is paywalled, so nothing was kept. Save it with the extension while signed in to keep the article.",
    saved:
      "The page is paywalled, so Valise kept nothing from it. The text here is what was saved with the bookmark.",
  },
  robots_disallowed: {
    alone:
      "The site's robots.txt asks not to be fetched, so Valise did not fetch it.",
    saved:
      "Valise did not fetch the page, as its robots.txt asks. The text here is what was saved with the bookmark.",
  },
  fetch_failed: {
    alone: "Valise could not fetch the page; title and notes only.",
    saved:
      "Valise could not fetch the page. The text here is what was saved with the bookmark.",
  },
};

function fetchNoteFor(enrichment: SourceEnrichment | null, text: SourceText) {
  return enrichment?.fetchStatus
    ? (FETCH_NOTES[enrichment.fetchStatus]?.[text.from ? "saved" : "alone"] ??
        null)
    : null;
}

/** Short text with no summary is read as itself; no attempt is needed. */
function shownWhole(enrichment: SourceEnrichment | null, text: SourceText) {
  return text.from !== null && text.short && !enrichment?.summary;
}

/** Below short text: why there is no summary, and where the text came from. */
function ShownWholeNote({
  enrichment,
  text,
}: {
  enrichment: SourceEnrichment | null;
  text: SourceText;
}) {
  if (!text.from || !shownWhole(enrichment, text)) return null;
  return (
    <p className="muted">
      Shown whole rather than summarised:{" "}
      {text.text.length.toLocaleString("en-US")} characters.{" "}
      {fetchNoteFor(enrichment, text)}
    </p>
  );
}

/** " and 2 images", or which of the linked images the model could not be shown. */
function imagesNote(enrichment: SourceEnrichment): string {
  const { imagesRead: read, imagesLinked: linked } = enrichment;
  const images = (n: number) => `${n} ${n === 1 ? "image" : "images"}`;
  if (read === 0) return linked ? ` (${images(linked)} too large to read)` : "";
  return ` and ${images(read)}${read < linked ? ` of ${linked}, the rest too large` : ""}`;
}

function passagesNote(enrichment: SourceEnrichment): string {
  return enrichment.passages
    ? ` Searchable in ${enrichment.passages} ${enrichment.passages === 1 ? "passage" : "passages"}.`
    : "";
}

/** A summary, or why there is none. Short text has ShownWholeNote instead. */
function SummarySection({
  enrichment,
  text,
}: {
  enrichment: SourceEnrichment | null;
  text: SourceText;
}) {
  if (!enrichment || shownWhole(enrichment, text)) return null;
  const fetchNote = fetchNoteFor(enrichment, text);
  const date = new Date(enrichment.createdAt * 1000).toISOString().slice(0, 10);
  return (
    <DetailSection title="Summary">
      {enrichment.summary ? <p>{enrichment.summary}</p> : null}
      {enrichment.concepts.length ? (
        <p>
          <span className="muted">Key concepts: </span>
          {enrichment.concepts.join(" · ")}
        </p>
      ) : null}
      {enrichment.state === "ready" && enrichment.model ? (
        // How it was made is detail, not content: one line, opened on request.
        <details className="library-provenance">
          <summary>How this summary was made</summary>
          <p>
            {`Generated on ${date} by ${enrichment.model} from ${enrichment.articleRevision ? "the article" : enrichment.imagesRead && !text.from ? "its images" : "the notes"}${text.from ? imagesNote(enrichment) : ""}: ${formatUsd(enrichment.costMicrousd)} (${enrichment.inputTokens.toLocaleString("en-US")} tokens in, ${enrichment.outputTokens.toLocaleString("en-US")} out).`}
            {passagesNote(enrichment)}
          </p>
          {fetchNote ? <p>{fetchNote}</p> : null}
        </details>
      ) : (
        <>
          <p className="muted">
            {enrichment.state === "failed"
              ? `Summary failed on ${date}; it will be retried after a day, at most three times. Counted cost: ${formatUsd(enrichment.costMicrousd)}.`
              : enrichment.state === "skipped" && !text.from
                ? "Nothing to summarise: no article text and no notes."
                : `Processed on ${date}.`}
            {passagesNote(enrichment)}
          </p>
          {fetchNote ? <p className="muted">{fetchNote}</p> : null}
        </>
      )}
    </DetailSection>
  );
}

function ArticleSection({
  article,
  archived,
}: {
  article: SourceArticle;
  sourceId: string;
  /** Whether a page archive is attached; an article-only save has none. */
  archived: boolean;
}) {
  if (!article.detected)
    return (
      <p className="muted">
        No article was detected on this page ({article.wordCount} words found of{" "}
        {article.pageWordCount}), so the full page is kept as the attached
        original. To keep a passage as readable text, select it on the page and
        save it with the extension as a highlight.
      </p>
    );
  const { opening, rest } = articleExcerpt(
    withoutRemoteImages(article.markdown),
  );
  // The page's own words, under a heading of their own, so Valise's text
  // above (summary, concepts) and the captured text never run together.
  // The opening shows; the rest is a native disclosure, so it opens with
  // scripting off (P11).
  return (
    <section aria-label="Saved article" className="library-saved-text">
      <h3 className="eyebrow">Saved article</h3>
      <div className="library-article">
        <Markdown>{opening}</Markdown>
        {rest ? (
          <details className="library-article-more">
            <summary>
              <span className="library-more-closed">Read more</span>
              <span className="library-more-open">Show less</span>
            </summary>
            <Markdown>{rest}</Markdown>
          </details>
        ) : null}
      </div>
      <p className="muted m-0 text-xs">
        {article.extractor === FETCH_EXTRACTOR
          ? `Fetched from the page by Valise on ${new Date(article.createdAt * 1000).toISOString().slice(0, 10)}: `
          : `Extracted at capture by ${article.extractor}: `}
        {article.wordCount.toLocaleString("en-US")} of{" "}
        {article.pageWordCount.toLocaleString("en-US")} words on the page.
        {article.truncated ? " Cut at 200,000 characters." : ""}
        {archived
          ? " The full page is kept as the attached original."
          : " Only this text is kept, not the page."}
      </p>
    </section>
  );
}

/**
 * A saved page's heading in its pane: what it is above the title, then who
 * wrote it and where it lives, smaller, with the way into the reader.
 */
function SourceHeading({
  source,
  article,
  field,
  back,
  stars,
}: {
  source: Source;
  article: SourceArticle | null;
  /** The pane's URL, where the stars post and land. */
  back: string;
  stars: 1 | 2 | 3 | null;
  /** The card's editors, so the title, author and URL edit where shown. */
  field: (
    name: "title" | "url" | "authors",
  ) => Pick<
    ComponentProps<typeof Editable>,
    "action" | "cancelHref" | "editHref" | "editing" | "hidden" | "save"
  >;
}) {
  const kind =
    source.kind === "reference"
      ? "Highlight / note"
      : source.kind === "document"
        ? "Document"
        : article?.detected
          ? "Article"
          : "Saved page";
  return (
    <div className="pane-heading grid min-w-0 gap-1">
      <p className="eyebrow m-0">{kind}</p>
      <Editable {...field("title")} defaultValue={source.title} label="Title">
        <h2>{source.title}</h2>
      </Editable>
      <div className="pane-byline flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
        <Editable
          {...field("authors")}
          defaultValue={source.authors.join(", ")}
          empty={source.authors.length ? undefined : "Add an author"}
          label="Authors"
        >
          {source.authors.length ? (
            <span>By {joinNames(source.authors)}</span>
          ) : null}
        </Editable>
        <Editable
          {...field("url")}
          defaultValue={source.url ?? ""}
          empty={source.url ? undefined : "Add a URL"}
          label="URL"
        >
          {source.url ? (
            <a
              className="library-host-link"
              href={source.url}
              rel="noreferrer noopener"
              target="_blank"
              title={source.url}
            >
              {pageHost(source.url)}
              <Icon name="external" size={12} />
            </a>
          ) : null}
        </Editable>
        {article?.detected ? (
          <Button asChild className="h-7" size="sm" variant="outline">
            <Link to={readerHref(source.sourceId)}>
              <Icon name="file" />
              Open in the reader
            </Link>
          </Button>
        ) : null}
      </div>
      <RatingControl
        action={back}
        compact
        hidden={{ id: sourceRef(source.sourceId) }}
        stars={stars}
      />
    </div>
  );
}

function authorsOf(value: string): string[] {
  return value
    .split(/[,\n;]/)
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, 20);
}

function libraryWithout(href: string, ...keys: string[]): string {
  const url = new URL(href, "https://valise.invalid");
  for (const key of keys) url.searchParams.delete(key);
  return `${url.pathname}${url.search}`;
}

/**
 * A source's attached documents, each with its unlink, and one control that
 * opens the attach modal (P15). `?attach=` names the source, so the modal
 * opens without scripting (P3, P11). The modal picks from the library or
 * uploads new files; both post to the modal's own URL, so a refusal renders
 * inside it, and a success redirects without it onto the updated list.
 */
function SourceAttachments({
  source,
  documents,
  offered,
  back,
  attaching,
  nextLinks,
  answer,
  maxBytes,
}: {
  source: Source;
  documents: Source["assets"];
  offered: Pick<Asset, "assetId" | "title">[];
  back: string;
  attaching: boolean;
  nextLinks: string | null;
  /** An action answer that belongs to this source's attach modal. */
  answer: Answer | undefined;
  maxBytes: number;
}) {
  const navigate = useNavigate();
  const hydrated = useHydrated();
  const id = sourceRef(source.sourceId);
  const closed = libraryWithout(back, "attach", "linksAfter");
  const close = () =>
    navigate(closed, { replace: true, preventScrollReset: true });
  return (
    <DetailSection title="Attached documents">
      {documents.length ? (
        <ul className="attachments">
          {documents.map((asset) => (
            <li key={asset.assetId}>
              {asset.available &&
              asset.objectId &&
              attachmentKind(asset.contentType) === "image" ? (
                <AssetThumbnail
                  filename={asset.fileName}
                  mime={asset.contentType}
                  objectId={asset.objectId}
                  title={asset.title}
                />
              ) : null}
              <span className="min-w-0 flex-1">
                {asset.available ? asset.title : "Document unavailable"}
              </span>
              <Form action={back} method="post" preventScrollReset>
                <input name="intent" type="hidden" value="source-unlink" />
                <input name="id" type="hidden" value={id} />
                <input name="revision" type="hidden" value={source.revision} />
                <input
                  name="asset"
                  type="hidden"
                  value={assetRef(asset.assetId)}
                />
                <button
                  aria-label={`Unlink ${asset.title || "document"}`}
                  className="ghost small gap-1.5"
                  type="submit"
                >
                  <Icon name="close" />
                  Unlink
                </button>
              </Form>
            </li>
          ))}
        </ul>
      ) : null}
      <Button
        asChild
        className="justify-self-start"
        size="sm"
        variant="outline"
      >
        <Link
          preventScrollReset
          to={libraryParam(libraryWithout(back, "history"), "attach", id)}
        >
          <Icon name="attach" />
          Attach a document
        </Link>
      </Button>
      <Modal
        closeHref={closed}
        onClose={close}
        open={attaching}
        title={`Attach a document to ${source.title}`}
      >
        <div className="stack attach-choices">
          <p className="muted m-0">
            An attachment keeps an original with this page. Unlinking
            disconnects the current version only; the document and earlier saved
            versions remain available.
          </p>
          {answer?.error ? (
            <p className="empty" role="alert">
              {answer.error}
            </p>
          ) : null}
          <DetailSection title="From your library">
            <Form
              action={back}
              className="stack"
              method="post"
              preventScrollReset
            >
              <input name="intent" type="hidden" value="source-link" />
              <input name="id" type="hidden" value={id} />
              <input name="revision" type="hidden" value={source.revision} />
              <AsyncPicker
                endpoint="/library/documents"
                exclude={source.assets.map((asset) => assetRef(asset.assetId))}
                fallback={offered.map((asset) => ({
                  value: assetRef(asset.assetId),
                  label: asset.title,
                }))}
                label="Document"
                name="asset"
                placeholder="Search saved documents"
              />
              <Button className="justify-self-start" type="submit">
                <Icon name="attach" />
                Attach
              </Button>
            </Form>
            {hydrated ? null : (
              <LibraryPaging
                back={back}
                param="linksAfter"
                next={nextLinks}
                label="files to link"
              />
            )}
          </DetailSection>
          <DetailSection title="Upload new">
            <AttachUpload
              action={back}
              answer={answer}
              id={id}
              maxBytes={maxBytes}
              onDone={close}
              revision={source.revision}
            />
          </DetailSection>
        </div>
      </Modal>
    </DetailSection>
  );
}

/**
 * New files uploaded and linked to one source. Scripted, each file is its own
 * request carrying the revision the last one left, so a batch is not capped
 * by one request's size; without scripting the form posts every file at once
 * and the server links them in one revision. Either way the server checks the
 * revision before storing a byte, and an attached document never expires.
 */
function AttachUpload({
  action,
  answer,
  id,
  maxBytes,
  onDone,
  revision,
}: {
  action: string;
  answer: Answer | undefined;
  id: string;
  maxBytes: number;
  onDone: () => void;
  revision: number;
}) {
  const fetcher = useFetcher<Answer>();
  const selected = useRef<File[]>([]);
  const queue = useRef<{
    files: File[];
    index: number;
    revision: number;
    failed: boolean;
    folderId?: string;
  } | null>(null);
  const handled = useRef<Answer | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [round, setRound] = useState(0);
  const [error, setError] = useState("");
  const [results, setResults] = useState<NonNullable<Answer["uploads"]>>([]);
  function finish(failed: boolean) {
    queue.current = null;
    selected.current = [];
    setBusy(false);
    setRound((value) => value + 1);
    if (!failed) onDone();
  }
  function sendNext() {
    const batch = queue.current;
    if (!batch) return;
    const file = batch.files[batch.index];
    if (!file) return finish(batch.failed);
    const body = new FormData();
    body.set("intent", "upload");
    body.set("via", "fetcher");
    body.set("attachTo", id);
    body.set("revision", String(batch.revision));
    body.set("folderId", batch.folderId ?? "");
    body.set("file", file);
    fetcher.submit(body, {
      action,
      method: "post",
      encType: "multipart/form-data",
      preventScrollReset: true,
    });
  }
  useEffect(() => {
    if (
      fetcher.state !== "idle" ||
      !fetcher.data ||
      handled.current === fetcher.data ||
      !queue.current
    )
      return;
    handled.current = fetcher.data;
    const batch = queue.current;
    const result = fetcher.data.uploads?.[0];
    if (fetcher.data.folderId) batch.folderId = fetcher.data.folderId;
    if (result) setResults((previous) => [...previous, result]);
    if (fetcher.data.error) {
      // A refused revision stops the batch: later files would be refused too.
      setError(fetcher.data.error);
      return finish(true);
    }
    if (result?.error) batch.failed = true;
    if (fetcher.data.revision) batch.revision = fetcher.data.revision;
    batch.index += 1;
    sendNext();
  });
  const shown = results.length ? results : (answer?.uploads ?? []);
  const failures = shown.filter((result) => result.error);
  return (
    <fetcher.Form
      action={action}
      aria-busy={busy}
      className="stack"
      encType="multipart/form-data"
      method="post"
      onSubmit={(event) => {
        event.preventDefault();
        // A native selection made before hydration still belongs to this form.
        const native = event.currentTarget.elements.namedItem(
          "file",
        ) as unknown as { files?: ArrayLike<File> } | null;
        const files = selected.current.length
          ? selected.current
          : Array.from(native?.files ?? []);
        if (queue.current || !files.length) return;
        queue.current = { files, index: 0, revision, failed: false };
        handled.current = fetcher.data;
        setResults([]);
        setError("");
        setBusy(true);
        sendNext();
      }}
      preventScrollReset
    >
      <input name="intent" type="hidden" value="upload" />
      <input name="attachTo" type="hidden" value={id} />
      <input name="revision" type="hidden" value={revision} />
      <FileDropzone
        disabled={busy}
        hint={`Up to ${fileSize(maxBytes)} per file. Each file is added to Documents under its own name and kept until you delete it.`}
        key={round}
        label={`File, up to ${fileSize(maxBytes)}`}
        multiple
        onFiles={(files) => {
          selected.current = files;
        }}
      />
      <Button className="justify-self-start" disabled={busy} type="submit">
        <Icon name="upload" />
        {busy ? "Uploading…" : "Upload and attach"}
      </Button>
      {busy ? (
        <p role="status">Uploading files one at a time. Keep this page open.</p>
      ) : null}
      {error ? (
        <p className="empty" role="alert">
          {error}
        </p>
      ) : null}
      {failures.length ? (
        <ul aria-label="Upload results" className="library-upload-results">
          {shown.map((result, index) => (
            <li key={`${index}-${result.name}`}>
              {result.name}:{" "}
              {result.error ? `Not uploaded — ${result.error}` : "Attached"}
            </li>
          ))}
        </ul>
      ) : null}
    </fetcher.Form>
  );
}

const REVISION_FIELDS: [string, (revision: SourceRevision) => string][] = [
  ["Title", (revision) => revision.title],
  ["URL", (revision) => revision.url ?? ""],
  ["Notes", (revision) => revision.notes],
  ["Tags", (revision) => revision.tags.join("\n")],
  ["Project", (revision) => revision.project ?? ""],
  ["Attachments", (revision) => revision.assetIds.join("\n")],
];

/**
 * P14: the saved versions as one line, opening a table. `?history=` names
 * the source and makes the loader read its ten most recent revisions.
 */
function SourceHistory({
  source,
  revisions,
  back,
}: {
  source: Source;
  /** Newest first, when `?history=` names this source. */
  revisions: SourceRevision[] | null;
  back: string;
}) {
  const navigate = useNavigate();
  const closed = libraryWithout(back, "history");
  const loaded = revisions ?? [];
  return (
    <VersionHistory
      closeHref={closed}
      count={source.revision}
      href={libraryParam(
        libraryWithout(back, "attach", "linksAfter"),
        "history",
        sourceRef(source.sourceId),
      )}
      lastSavedAt={source.updatedAt}
      onClose={() =>
        navigate(closed, { replace: true, preventScrollReset: true })
      }
      open={revisions !== null}
      title={source.title}
      versions={loaded.map((revision, index) => {
        const older = loaded[index + 1];
        return {
          id: revision.revision,
          label: `v${revision.revision}`,
          savedAt: revision.createdAt,
          by: revision.sourceAgent || revision.sourceClient || null,
          current: revision.revision === source.revision,
          changed: older
            ? REVISION_FIELDS.filter(
                ([, read]) => read(revision) !== read(older),
              ).map(([name]) => name)
            : revision.revision === 1
              ? []
              : ["Earlier versions not loaded"],
          content: (
            <>
              <p className="m-0 font-medium">{revision.title}</p>
              <Markdown>
                {readingNotes({ ...source, notes: revision.notes })}
              </Markdown>
            </>
          ),
        };
      })}
    />
  );
}

/**
 * An item's details and organization, in the right-hand pane like every
 * other list's open item. `?details=` names it (P3); closing drops it.
 */
function DetailPane({
  title,
  heading,
  closeHref,
  children,
}: {
  title: string;
  /** Replaces the plain title: kind, title, subtitle. */
  heading?: React.ReactNode;
  closeHref: string;
  children: React.ReactNode;
}) {
  const navigate = useNavigate();
  return (
    <Modal
      closeHref={closeHref}
      mobileSheet
      onClose={() =>
        navigate(closeHref, { replace: true, preventScrollReset: true })
      }
      heading={heading}
      open
      size="pane"
      title={title}
    >
      {children}
    </Modal>
  );
}
