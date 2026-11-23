import { useRef } from "react";
import { Icon } from "~/components/icon";

type Placeable = {
  id: string;
  state: string;
  createdAt: number;
  blockedOn: string | null;
};
type Placement = { blocked: boolean; order: number };

/**
 * Splits the list into blocked rows, shown first, and the rest.
 *
 * A row's section is fixed the first time this list shows it, and holds until
 * the list is reopened: a reload, or a filter that changes `listKey`. Blocking
 * a row from its pane, or pressing Unblock on it, repaints its state where it
 * is rather than moving it to the other section under the reader's pointer, so
 * the control that reverses the change is still there (P4, P12). The next
 * time the list opens, it sorts the row where it belongs, as Apple Reminders
 * does with a completed sub-task.
 *
 * Unblocking can sort a row past the loaded window, and the server then stops
 * sending it. Blocked rows always lead, so a held blocked row that goes
 * missing is one that is no longer blocked: it stays, from its last copy, read
 * as pending, or from `fresh` (the open pane's copy) when that is the same
 * to-do. `rescue` is off while a live search narrows the rows on the client,
 * when a missing row is only filtered out, and on the blocked-only list,
 * which an unblocked row leaves by definition.
 *
 * Done rows are out of the list by default, so completing one also stops the
 * server sending it. `completing` names the rows this page has posted as done;
 * one that then goes missing stays where it was, read as done, so its circle
 * is still under the pointer to reopen it (P5, P12).
 */
export function useSections<T extends Placeable>(
  rows: T[],
  listKey: string,
  {
    fresh = null,
    rescue = true,
    completing = [],
  }: {
    fresh?: T | null;
    rescue?: boolean;
    completing?: readonly string[];
  } = {},
) {
  const placed = useRef({
    key: listKey,
    seen: new Map<string, Placement>(),
    last: new Map<string, T>(),
    completed: new Set<string>(),
  });
  if (placed.current.key !== listKey)
    placed.current = {
      key: listKey,
      seen: new Map(),
      last: new Map(),
      completed: new Set(),
    };
  const { seen, last, completed } = placed.current;
  for (const id of completing) completed.add(id);
  // A row seen for the first time takes the server's place for it, between
  // the seen rows around it: a new to-do lands ahead of an older one created
  // in the same second, and a loaded page lands behind (rowid DESC).
  rows.forEach((row, index) => {
    last.set(row.id, row);
    if (seen.has(row.id)) return;
    const before = rows
      .slice(0, index)
      .reverse()
      .find((one) => seen.has(one.id));
    const after = rows.slice(index + 1).find((one) => seen.has(one.id));
    const low = before ? (seen.get(before.id) as Placement).order : undefined;
    const high = after ? (seen.get(after.id) as Placement).order : undefined;
    const order =
      low === undefined
        ? high === undefined
          ? 0
          : high - 1
        : high === undefined
          ? low + 1
          : (low + high) / 2;
    seen.set(row.id, { blocked: row.state === "blocked", order });
  });
  const listed = new Set(rows.map((row) => row.id));
  const kept = rescue
    ? [...seen]
        .filter(
          ([id, place]) =>
            !listed.has(id) && (place.blocked || completed.has(id)),
        )
        .flatMap(([id]) => {
          if (fresh?.id === id) return [fresh];
          const copy = last.get(id);
          if (!copy) return [];
          if (completed.has(id))
            return [{ ...copy, state: "done", blockedOn: null }];
          return [
            copy.state === "blocked"
              ? { ...copy, state: "pending", blockedOn: null }
              : copy,
          ];
        })
    : [];
  const shown = [...rows, ...kept];
  const at = (row: T) => seen.get(row.id) as Placement;
  // Newest created first, as the server sends each part. Rows created in the
  // same second keep the order they first took, so a row held in its section
  // does not trade places with a twin.
  const newest = (a: T, b: T) =>
    b.createdAt - a.createdAt || at(a).order - at(b).order;
  return {
    blocked: shown.filter((row) => at(row).blocked).sort(newest),
    rest: shown.filter((row) => !at(row).blocked).sort(newest),
  };
}

/**
 * The header over the blocked rows: what they are and why they are first.
 * Once the last of them is unblocked the section stays in place until the
 * list reopens (P4), so the header stays too, out of the alert's red, and
 * says why those rows are still on top.
 */
export function BlockedHeader({ count }: { count: number }) {
  if (count === 0) {
    return (
      <li className="todo-blocked-head is-clear">
        <Icon name="check" size={16} />
        <p>
          <strong>None blocked now</strong>{" "}
          <span>
            These rows were blocked when the list opened. They sort back in next
            time it loads.
          </span>
        </p>
      </li>
    );
  }
  return (
    <li className="todo-blocked-head">
      <Icon name="alert" size={16} />
      <p>
        <strong>{count} blocked</strong>{" "}
        <span>
          Agents skip these until the blocker clears. Unblock one to put it back
          in the queue.
        </span>
      </p>
    </li>
  );
}
