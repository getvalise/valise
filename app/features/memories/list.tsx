import { Link, useNavigate } from "react-router";
import { Editable, editKey, openField } from "~/components/editable";
import { InfiniteList, useLiveList } from "~/components/infinite-list";
import { ItemList, ItemRow } from "~/components/item-list";
import { ListToolbar, SortMenu } from "~/components/list-toolbar";
import { MarkdownExcerpt } from "~/components/markdown";
import { Modal } from "~/components/modal";
import { Empty, ListControls, ProjectChip, TagLinks } from "~/components/ui";
import { listHref, withTag } from "~/concepts/list-filters";
import {
  type MemorySort,
  type MemoryUsage,
  memorySort,
} from "~/concepts/memories";
import { MEMORY_TYPES } from "~/concepts/memory-types";
import type { loader } from "~/console/memories.server";
import { MemoryDetail } from "~/features/memories/detail";

export function MemoryList({
  loaderData,
}: {
  loaderData: Awaited<ReturnType<typeof loader>>;
}) {
  const { filters, editing } = loaderData;
  const live = useLiveList(
    loaderData.memories,
    (memory) => `${memory.title}\n${memory.body}`,
    filters,
  );
  const navigate = useNavigate();
  const memory = loaderData.detail;
  const closed = listHref("/memories", filters);
  const sort = memorySort(filters.sort) ?? "updated";

  const pane =
    memory === null ? null : (
      <Modal
        closeHref={closed}
        heading={
          <Editable
            action={listHref("/memories", filters, { open: memory.id })}
            cancelHref={listHref("/memories", filters, { open: memory.id })}
            defaultValue={memory.title}
            editHref={listHref("/memories", filters, {
              edit: editKey(memory.id, "title"),
            })}
            editing={openField(editing, memory.id) === "title"}
            hidden={{ id: memory.id, field: "title" }}
            label="Title"
            save="fetch"
          >
            <h2>{memory.title || "Untitled memory"}</h2>
          </Editable>
        }
        mobileSheet
        // Archiving closes this pane through loader data. That native close
        // event is not a request to navigate and erase the retained URL. P11.
        onClose={() =>
          navigate(closed, { replace: true, preventScrollReset: true })
        }
        open
        size="pane"
        title={memory.title || "Memory"}
      >
        <MemoryDetail
          key={memory.id}
          files={loaderData.files}
          editing={editing}
          filters={filters}
          memory={memory}
          revisions={loaderData.revisions}
          usage={memory.usage}
          types={loaderData.typeOptions}
          vocabulary={loaderData.vocabulary}
          links={loaderData.links}
          subjects={loaderData.subjects}
          reviewCount={loaderData.reviewCount}
          linkTargets={loaderData.linkTargets}
        />
      </Modal>
    );
  const paneInList = live.rows.some((row) => row.id === memory?.id);

  return (
    <>
      <ListControls>
        <ListToolbar
          filters={filters}
          live={live}
          path="/memories"
          tagCounts={loaderData.facets}
          types={loaderData.types}
          vocabulary={loaderData.vocabulary}
        >
          <SortMenu
            label="Sort memories"
            options={MEMORY_SORTS.map(([value, label]) => ({
              label,
              current: sort === value,
              href: listHref("/memories", {
                ...filters,
                page: undefined,
                sort: value === "updated" ? undefined : value,
              }),
            }))}
          />
        </ListToolbar>
      </ListControls>
      {live.rows.length === 0 ? (
        <Empty>
          {live.pending
            ? "Searching all memories…"
            : "No active memories match those filters."}
        </Empty>
      ) : (
        <ItemList className="memories" label="Memories">
          {live.rows.map((row) => (
            <ItemRow
              className={`memory-row memory-type-${ruled(row.type)}`}
              description={
                row.body ? <MarkdownExcerpt>{row.body}</MarkdownExcerpt> : null
              }
              href={listHref("/memories", filters, { open: row.id })}
              key={row.id}
              meta={
                <>
                  <Link
                    className="facet"
                    preventScrollReset
                    to={listHref("/memories", {
                      ...filters,
                      page: undefined,
                      type: row.type,
                    })}
                  >
                    {row.type}
                  </Link>
                  {row.project ? (
                    <ProjectChip
                      href={listHref("/memories", {
                        ...filters,
                        page: undefined,
                        project: row.project,
                      })}
                      project={row.project}
                    />
                  ) : null}
                  {row.tags.length > 0 ? (
                    <TagLinks
                      href={(tag) =>
                        listHref("/memories", withTag(filters, tag))
                      }
                      tags={row.tags}
                    />
                  ) : null}
                  <span className="ml-auto flex items-center gap-x-3">
                    <Fetched usage={row.usage} />
                    <time
                      className="font-mono"
                      dateTime={new Date(row.updatedAt * 1000).toISOString()}
                    >
                      {stamp(row.updatedAt).slice(0, 10)}
                    </time>
                  </span>
                </>
              }
              open={row.id === memory?.id}
              stacked
              title={row.title || "Untitled memory"}
            >
              {row.id === memory?.id ? pane : null}
            </ItemRow>
          ))}
        </ItemList>
      )}
      {paneInList ? null : pane}
      <InfiniteList
        paused={live.pending}
        filters={filters}
        path="/memories"
        window={loaderData.window}
      />
    </>
  );
}

const RULED_TYPES: ReadonlySet<string> = new Set(
  MEMORY_TYPES.map(([type]) => type),
);

/**
 * The type a row's left rule is coloured by: one of the recommended types,
 * or `other` for a coined one, so a free-text type never becomes a class.
 */
function ruled(type: string): string {
  return RULED_TYPES.has(type) ? type : "other";
}

/** UTC, because a server-rendered local time mismatches on hydration. */
function stamp(seconds: number): string {
  return stampMs(seconds * 1000);
}

/** The call log keeps milliseconds; the memory rows keep seconds. */
function stampMs(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 16);
}

const MEMORY_SORTS: readonly (readonly ["updated" | MemorySort, string])[] = [
  ["updated", "Recently updated"],
  ["last-fetched", "Last fetched"],
  ["fetched", "Most fetched"],
  ["in-results", "Most in results"],
];

/** How often agents fetched it, with the last time in the tooltip. */
function Fetched({ usage }: { usage: MemoryUsage }) {
  if (usage.fetches === 0 && usage.appearances === 0) return null;
  return (
    <span
      className="fetched font-mono"
      title={`${usage.fetches} fetches and ${usage.appearances} appearances in the top ten search results in the call log's thirty days${usage.lastFetched ? `; last fetched ${stampMs(usage.lastFetched).slice(0, 10)}` : ""}`}
    >
      {usage.fetches}↓ {usage.appearances}◎
    </span>
  );
}
