import { type ReactNode, useState } from "react";
import { Link } from "react-router";
import { Icon } from "~/components/icon";
import { Modal } from "~/components/modal";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { cn } from "~/lib/utils";

export type Version = {
  /** Stable key, e.g. the revision number. */
  id: string | number;
  /** How the version is named in the table, e.g. "v3". */
  label: string;
  /** Unix seconds. */
  savedAt: number;
  /** Who saved it: a client, an agent, a person. */
  by?: string | null;
  /** The version the record holds now. */
  current?: boolean;
  /** Fields that differ from the version before it, e.g. ["Title", "Notes"]. */
  changed: string[];
  /** The version as it read, shown when its row is selected. */
  content: ReactNode;
};

/**
 * A record's past versions, P14: one line in the pane (how many saves, when
 * the last was), itself the link, opening a modal with a table of versions,
 * newest first. Selecting a row shows that version below the table. Reading
 * changes nothing.
 *
 * `open`, `href` and `closeHref` keep the modal in the URL (P3): the line is a
 * link to `href`, which a page may load the versions behind.
 */
export function VersionHistory({
  title,
  count,
  lastSavedAt,
  versions,
  open,
  href,
  closeHref,
  onClose,
}: {
  /** The record, for the modal's title: "History of <title>". */
  title: string;
  /** Saved versions in all, when known before the versions load. */
  count: number;
  lastSavedAt?: number | null;
  /** Newest first; empty until loaded. */
  versions: Version[];
  open: boolean;
  href: string;
  closeHref: string;
  onClose: () => void;
}) {
  const [selected, setSelected] = useState<Version["id"] | null>(null);
  const shown =
    versions.find((version) => version.id === selected) ?? versions[0];
  if (count <= 1 && versions.length <= 1) return null;
  return (
    <>
      <Link
        className="version-history-link inline-flex items-center gap-2 text-sm text-muted-foreground no-underline hover:text-foreground"
        preventScrollReset
        to={href}
      >
        <Icon name="history" />
        <span>
          {count} saved versions
          {lastSavedAt ? ` · last ${day(lastSavedAt)}` : ""}
        </span>
      </Link>
      <Modal
        closeHref={closeHref}
        onClose={onClose}
        open={open}
        size="wide"
        title={`History of ${title}`}
      >
        {versions.length === 0 ? (
          <p className="muted">Loading versions…</p>
        ) : (
          <div className="grid gap-4">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Version</TableHead>
                  <TableHead>Saved</TableHead>
                  <TableHead className="max-sm:hidden">By</TableHead>
                  <TableHead>Changed</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {versions.map((version) => {
                  const on = version.id === shown?.id;
                  return (
                    <TableRow
                      aria-selected={on}
                      className={cn(
                        "cursor-pointer",
                        on && "bg-accent hover:bg-accent",
                      )}
                      key={version.id}
                      onClick={() => setSelected(version.id)}
                    >
                      <TableCell className="font-mono">
                        <button
                          aria-pressed={on}
                          className="contents"
                          data-slot="version-select"
                          onClick={() => setSelected(version.id)}
                          type="button"
                        >
                          {version.label}
                        </button>
                        {version.current ? (
                          <span className="ml-2 font-sans text-xs text-muted-foreground">
                            current
                          </span>
                        ) : null}
                      </TableCell>
                      <TableCell>{stamp(version.savedAt)}</TableCell>
                      <TableCell className="max-sm:hidden">
                        {version.by ?? "—"}
                      </TableCell>
                      <TableCell className="whitespace-normal text-muted-foreground">
                        {version.changed.length
                          ? version.changed.join(", ")
                          : "First version"}
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
            {shown ? (
              <section
                aria-label={`${shown.label} as saved`}
                className="grid gap-2 rounded-md bg-muted p-4"
              >
                <p className="eyebrow m-0">
                  {shown.label} · {stamp(shown.savedAt)}
                </p>
                <div className="version-content">{shown.content}</div>
              </section>
            ) : null}
          </div>
        )}
      </Modal>
    </>
  );
}

/** UTC, because a server-rendered local time mismatches on hydration. */
function stamp(seconds: number): string {
  return new Date(seconds * 1000).toISOString().replace("T", " ").slice(0, 16);
}

function day(seconds: number): string {
  return new Date(seconds * 1000).toISOString().slice(0, 10);
}
