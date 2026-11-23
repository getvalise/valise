import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import { unified } from "unified";
import { describe, expect, it } from "vitest";
import {
  appendTaskItem,
  listTaskItems,
  setTaskItem,
  taskProgress,
} from "~/concepts/task-list";

/**
 * The scanner and the renderer have to agree on what a task item is, because
 * the console addresses a checkbox by the source line remark gave the item it
 * drew. They are two different implementations — a regex here, a parser there
 * — so the agreement is asserted rather than assumed, over the cases that
 * break naive versions: `*` and `+` bullets, ordered items, nesting, a quoted
 * list, a fence holding something that looks exactly like a task, and two
 * items whose text is identical.
 */

const NASTY = `Intro, with a [link](https://example.com).

- [ ] first task
- [x] second task
  - [ ] nested under a checked parent
* [X] a star bullet, capital X
+ [ ] a plus bullet

\`\`\`sh
- [ ] not a task: this is inside a fence
\`\`\`

1. [ ] an ordered task
2) [x] an ordered task with a paren

> - [ ] quoted task

- [ ] duplicate text
- [ ] duplicate text
- a plain list item, no checkbox
`;

/** Where remark itself puts a checkbox, read out of the rendered tree. */
function renderedTaskLines(markdown: string): number[] {
  const file = unified().use(remarkParse).use(remarkGfm);
  const tree = unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype)
    .runSync(file.parse(markdown)) as HastNode;

  const lines: number[] = [];
  const walk = (node: HastNode): void => {
    const hasCheckbox = (node.children ?? []).some(
      (child) => child.tagName === "input",
    );
    if (node.tagName === "li" && hasCheckbox && node.position) {
      lines.push(node.position.start.line);
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(tree);
  return lines.sort((a, b) => a - b);
}

type HastNode = {
  tagName?: string;
  children?: HastNode[];
  position?: { start: { line: number } };
};

describe("task list scanner", () => {
  it("finds exactly the items remark renders a checkbox for", () => {
    expect(listTaskItems(NASTY).map((item) => item.line)).toEqual(
      renderedTaskLines(NASTY),
    );
  });

  it("reads each item's state and text", () => {
    const items = listTaskItems(NASTY);
    expect(items[0]).toMatchObject({ checked: false, text: "first task" });
    expect(items[1]).toMatchObject({ checked: true, text: "second task" });
    expect(items[3]).toMatchObject({
      checked: true,
      text: "a star bullet, capital X",
    });
    expect(items.at(-1)).toMatchObject({ text: "duplicate text" });
  });

  it("ignores a checkbox inside a fenced block", () => {
    expect(listTaskItems(NASTY).map((item) => item.text)).not.toContain(
      "not a task: this is inside a fence",
    );
  });

  it("counts progress", () => {
    expect(taskProgress(NASTY)).toEqual({ done: 3, total: 10 });
    expect(taskProgress("no checklist here")).toEqual({ done: 0, total: 0 });
  });

  it("ticks one line and leaves its twin alone", () => {
    const items = listTaskItems(NASTY);
    const [first, second] = items.filter(
      (item) => item.text === "duplicate text",
    );
    const next = setTaskItem(NASTY, first.line, false);
    expect(next).not.toBeNull();
    const after = listTaskItems(next ?? "");
    expect(after.find((item) => item.line === first.line)?.checked).toBe(true);
    expect(after.find((item) => item.line === second.line)?.checked).toBe(
      false,
    );
  });

  it("keeps the bullet and the indent the body already used", () => {
    const next = setTaskItem("  * [ ] indented star", 1, false);
    expect(next).toBe("  * [x] indented star");
  });

  it("refuses a line whose state is not the one the page rendered", () => {
    // The card said unchecked; the body says checked. Someone else moved it.
    expect(setTaskItem("- [x] already done", 1, false)).toBeNull();
  });

  it("refuses a line that is not a task item", () => {
    expect(setTaskItem(NASTY, 1, false)).toBeNull();
    expect(setTaskItem(NASTY, 9999, false)).toBeNull();
    // Line 10 is inside the fence, which renders no checkbox to click.
    expect(setTaskItem(NASTY, 10, false)).toBeNull();
  });

  it("adds an item to the existing checklist, in its style", () => {
    const body = "Lead in.\n\n* [ ] one\n* [x] two\n\nTrailing prose.";
    const next = appendTaskItem(body, "three");
    expect(next).toContain("* [x] two\n* [ ] three\n");
    expect(next).toContain("Trailing prose.");
    expect(listTaskItems(next)).toHaveLength(3);
  });

  it("starts a checklist in a body that has none", () => {
    expect(appendTaskItem("Just prose.", "one")).toBe(
      "Just prose.\n\n- [ ] one",
    );
    expect(appendTaskItem("", "one")).toBe("- [ ] one");
  });
});
