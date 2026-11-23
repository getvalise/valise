/**
 * GFM task list items inside a Markdown body, addressed by source line.
 *
 * A subtask is `- [ ] text` in the body, which is where an agent already
 * writes one and where `fetch` already returns it. Nothing new is stored.
 *
 * The line number is the address because it is the one thing both halves
 * agree on for free: remark gives every rendered `<li>` its source position,
 * and the scanner below reads the same lines with the same rules. Matching on
 * the item's text instead breaks on the two identical subtasks every checklist
 * eventually grows; counting rendered checkboxes breaks on a fenced block that
 * contains one.
 */

export type TaskItem = {
  /** 1-based, the same number remark puts on the rendered list item. */
  line: number;
  checked: boolean;
  text: string;
};

/**
 * A list bullet (`-`, `*`, `+`, `1.`, `1)`), then a checkbox, then a space.
 * Leading block-quote markers are allowed because GFM makes a task item of a
 * quoted list too, and remark will have numbered that line like any other.
 */
const TASK =
  /^([ \t]*(?:>[ \t]?)*[ \t]*)([-*+]|\d{1,9}[.)])([ \t]+)\[([ xX])\](?=[ \t]|$)/;

/** An opening or closing fence, with the quote prefix a fence may carry. */
const FENCE = /^[ \t]*(?:>[ \t]?)*[ \t]*(`{3,}|~{3,})/;

export function listTaskItems(body: string): TaskItem[] {
  const items: TaskItem[] = [];
  eachLine(body, (line, index, inFence) => {
    if (inFence) return;
    const match = TASK.exec(line);
    if (match === null) return;
    items.push({
      line: index + 1,
      checked: match[4] !== " ",
      text: line.slice(match[0].length).trim(),
    });
  });
  return items;
}

export type TaskProgress = { done: number; total: number };

export function taskProgress(body: string): TaskProgress {
  const items = listTaskItems(body);
  return {
    done: items.filter((item) => item.checked).length,
    total: items.length,
  };
}

/**
 * Flips one item. `was` is the state the page rendered: a second click on a
 * stale card, or a click landing after an agent edited the same body, finds a
 * different state here and is refused rather than silently reversing someone.
 */
export function setTaskItem(
  body: string,
  line: number,
  was: boolean,
): string | null {
  const lines = body.split("\n");
  const source = lines[line - 1];
  if (source === undefined) return null;
  if (listTaskItems(body).every((item) => item.line !== line)) return null;
  const match = TASK.exec(source);
  if (match === null) return null;
  if ((match[4] !== " ") !== was) return null;
  const marker = was ? "[ ]" : "[x]";
  lines[line - 1] =
    `${match[1]}${match[2]}${match[3]}${marker}${source.slice(match[0].length)}`;
  return lines.join("\n");
}

/**
 * Adds one unchecked item. It joins the existing checklist, copying that
 * list's indent and bullet, so a body that writes `* [ ]` does not grow a
 * stray `-`. A body with no checklist yet gets one as its own block.
 */
export function appendTaskItem(body: string, text: string): string {
  const items = listTaskItems(body);
  const last = items.at(-1);
  if (last === undefined) {
    const trimmed = body.replace(/\s+$/, "");
    return trimmed === "" ? `- [ ] ${text}` : `${trimmed}\n\n- [ ] ${text}`;
  }
  const lines = body.split("\n");
  const match = TASK.exec(lines[last.line - 1] ?? "");
  const bullet = match === null ? "- " : `${match[1]}${match[2]}${match[3]}`;
  lines.splice(last.line, 0, `${bullet}[ ] ${text}`);
  return lines.join("\n");
}

/**
 * Walks the body, tracking fenced code so its contents are never mistaken for
 * markup. A fence closes on the same character at the same length or longer,
 * which is CommonMark's rule and the reason the opener is carried.
 */
function eachLine(
  body: string,
  visit: (line: string, index: number, inFence: boolean) => void,
): void {
  let fence: string | null = null;
  body.split("\n").forEach((line, index) => {
    const opener = FENCE.exec(line)?.[1];
    if (fence === null) {
      visit(line, index, false);
      if (opener !== undefined) fence = opener;
      return;
    }
    // Inside a fence, including the closing line itself.
    visit(line, index, true);
    if (
      opener !== undefined &&
      opener[0] === fence[0] &&
      opener.length >= fence.length
    ) {
      fence = null;
    }
  });
}
