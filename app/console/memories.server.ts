import { data } from "react-router";
import { editTarget } from "~/components/editable";
import type { Attachment } from "~/concepts/attachments";
import { filtersFromRequest, listHref } from "~/concepts/list-filters";
import { MemoryLinkError } from "~/concepts/memory-links";
import { listMemorySubjects } from "~/concepts/memory-subjects";
import { MEMORY_TYPES } from "~/concepts/memory-types";
import { infiniteWindow } from "~/concepts/pagination";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import {
  afterSave,
  parseFileChange,
  parseMemoryFieldEdit,
  parseMemoryId,
  parseMemoryLinkEdit,
} from "~/console/forms.server";
import { waitingQuestions } from "~/console/memory-sections.server";
import { fileSize, MAX_OBJECT_BYTES, ObjectRefused } from "~/r2/objects";
import type { Route } from "../routes/+types/memories";

/**
 * The six types the tool description teaches, then whatever else has been
 * written. Drift is offered back rather than hidden. ADR-0009.
 */
function memoryTypes(written: { type: string }[]): string[] {
  const taught: string[] = MEMORY_TYPES.map(([name]) => name);
  return [
    ...taught,
    ...written.map((row) => row.type).filter((type) => !taught.includes(type)),
  ];
}

/**
 * One row per memory, the body behind a click. A memory's title is its claim
 * — the thing `search` shows an agent — so the table reads as a list of
 * claims, and the modal holds the rendered evidence. Type, project, and tag
 * cells are links that set the matching filter.
 *
 * Which memory is open is in the URL, so a link to a memory is a link to
 * that memory. Its fields use the pen-in-place pattern the to-dos use, inside
 * the dialog: a click opens one in place, and `?edit=` opens one with
 * scripting off or from a link (P3).
 */

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const filters = filtersFromRequest(request);

  const params = new URL(request.url).searchParams;
  const editing = params.get("edit") ?? undefined;
  const opened = params.get("open") ?? editTarget(editing) ?? undefined;
  const memoriesStore = actor.store.memories;
  const types = await memoriesStore.types();
  const usage = await memoriesStore.usage();
  const window = infiniteWindow(
    await memoriesStore.count(filters),
    filters.page,
  );
  filters.page = window.page > 1 ? window.page : undefined;
  const memories = (await memoriesStore.list(filters, window)).map(
    (memory) => ({
      ...memory,
      usage: usage.get(memory.id) ?? {
        fetches: 0,
        appearances: 0,
        lastFetched: null,
      },
    }),
  );
  const selected = opened
    ? await memoriesStore.get(opened.slice("memory:".length))
    : null;
  return {
    filters,
    editing,
    opened,
    waiting: await waitingQuestions(actor.store),
    links: opened
      ? await memoriesStore.links(opened.slice("memory:".length), true)
      : [],
    subjects: selected
      ? await listMemorySubjects(
          actor.env.DB,
          actor.user.userId,
          selected.id.slice("memory:".length),
        )
      : [],
    // One indexed count for the pane's review line (J-B).
    reviewCount: selected
      ? ((
          await actor.env.DB.prepare(
            "SELECT COUNT(*) AS n FROM memory_review_sources WHERE user_id = ? AND memory_id = ?",
          )
            .bind(actor.user.userId, selected.id.slice("memory:".length))
            .first<{ n: number }>()
        )?.n ?? 0)
      : 0,
    linkTargets: opened
      ? (await memoriesStore.linkTargets(opened.slice("memory:".length)))
          .targets
      : [],
    files: opened?.startsWith("memory:")
      ? ((
          await memoriesStore.attachments([opened.slice("memory:".length)])
        ).get(opened.slice("memory:".length)) ?? [])
      : [],
    memories,
    window,
    detail: selected
      ? {
          ...selected,
          usage: usage.get(selected.id) ?? {
            fetches: 0,
            appearances: 0,
            lastFetched: null,
          },
        }
      : null,
    types,
    typeOptions: memoryTypes(types),
    vocabulary: await actor.store.vocabulary(),
    facets: await actor.store.facets("memory"),
    revisions:
      opened === undefined
        ? []
        : await memoriesStore.revisions(opened.slice("memory:".length)),
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  if (
    Number(request.headers.get("content-length")) >
    MAX_OBJECT_BYTES + 64 * 1024
  ) {
    return data(
      {
        attachError: `Selected files must total at most ${fileSize(MAX_OBJECT_BYTES)} per upload. No files were attached.`,
        id: new URL(request.url).searchParams.get("open") ?? undefined,
      },
      { status: 413 },
    );
  }
  const form = await request.formData();
  const filters = filtersFromRequest(request);

  if (
    form.get("intent") === "detach-file" ||
    form.get("intent") === "restore-file"
  ) {
    const change = parseFileChange(form);
    if (!change.id.startsWith("memory:"))
      throw new Response("Invalid memory id.", { status: 400 });
    const target = {
      concept: "memory",
      id: change.id.slice("memory:".length),
    } as const;
    const file = (await actor.store.memories.attachments([target.id]))
      .get(target.id)
      ?.find((file) => file.objectId === change.objectId);
    if (
      !(await actor.store.memories.setFileAttached(
        target.id,
        change.objectId,
        change.intent === "restore-file",
      ))
    ) {
      throw new Response("File not found.", { status: 404 });
    }
    if (
      change.intent === "detach-file" &&
      form.get("via") !== "fetcher" &&
      file
    ) {
      return { removed: { id: change.id, file } };
    }
    return afterSave(form, listHref("/memories", filters, { open: change.id }));
  }

  if (form.get("intent") === "attach") {
    const memoryId = parseMemoryId(form);
    const id = `memory:${memoryId}`;
    const files = form
      .getAll("file")
      .filter((file): file is File => file instanceof File && !!file.name);
    if (files.length === 0) {
      return data({ attachError: "Pick a file first.", id }, { status: 400 });
    }
    // Bound the whole batch even without Content-Length, before any R2 writes.
    if (
      files.reduce((total, file) => total + file.size, 0) > MAX_OBJECT_BYTES
    ) {
      return data(
        {
          attachError: `Selected files must total at most ${fileSize(MAX_OBJECT_BYTES)} per upload. No files were attached.`,
          id,
        },
        { status: 413 },
      );
    }
    const attached: Attachment[] = [];
    const failures: string[] = [];
    for (const file of files) {
      let one: Attachment | null;
      try {
        one = await actor.store.memories.attach(memoryId, file);
      } catch (error) {
        if (!(error instanceof ObjectRefused))
          console.error("Memory attachment failed", file.name, error);
        failures.push(
          `${file.name}: ${error instanceof ObjectRefused ? error.message : "Could not attach this file. Try it again."}`,
        );
        continue;
      }
      if (one === null)
        throw new Response("Memory not found.", { status: 404 });
      attached.push(one);
    }
    if (failures.length) {
      return data(
        {
          attachError: `Attached ${attached.length} of ${files.length} files. ${failures.join(" ")}`,
          id,
          attached,
        },
        // Successful members changed the list. A partial success must revalidate
        // the fetcher's loader too; 4xx action results deliberately skip it.
        { status: attached.length > 0 ? 200 : 400 },
      );
    }
    return form.get("via") === "fetcher"
      ? { attached }
      : afterSave(form, listHref("/memories", filters, { open: id }));
  }

  if (form.get("intent") === "archive") {
    const archived = await actor.store.memories.archive(parseMemoryId(form));
    if (!archived)
      return data(
        { archiveError: "Memory not found. No memory was archived." },
        { status: 404 },
      );
    return afterSave(form, listHref("/memories", filters));
  }

  if (form.get("intent") === "memory-link") {
    const id = parseMemoryId(form);
    const edit = parseMemoryLinkEdit(form);
    try {
      if (edit.action === "add") {
        await actor.store.personMemoryLinks.assert(id, {
          id: edit.target,
          kind: edit.kind,
        });
      } else {
        const changed = await actor.store.personMemoryLinks.change(
          id,
          edit.link,
          edit.action,
        );
        if (!changed)
          throw new Response("Link not found on this memory.", { status: 404 });
      }
    } catch (error) {
      if (error instanceof MemoryLinkError)
        throw new Response(error.message, {
          status: 400,
          statusText: "Memory link conflict",
        });
      throw error;
    }
    return afterSave(
      form,
      listHref("/memories", filters, { open: `memory:${id}` }),
    );
  }

  const edit = parseMemoryFieldEdit(form);
  const memory = await actor.store.memories.edit(
    edit.id.slice("memory:".length),
    edit.patch,
  );
  if (memory === null) throw new Response("Memory not found.", { status: 404 });
  return afterSave(form, listHref("/memories", filters, { open: edit.id }));
}
