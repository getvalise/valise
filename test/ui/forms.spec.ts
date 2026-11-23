import { expect, goto, mcp, seed, test } from "./fixtures/session";

/*
 * No button touches a field. Controls in a form sit three units apart
 * (11.25px at the 15px root, docs/design/principles.md), so a button stacked
 * under a field, in a form, a dialog or a pane, keeps at least that gap. The
 * check measures the page as drawn rather than trusting each form's classes:
 * a form without a layout of its own is how a button ended up flush against
 * the field above it. A file drop well counts as a field: Archive memory sat
 * flush under the pane's.
 */
const THREE_UNITS = 11;

test("no button sits closer than three units under a field, on any form", async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  await seed(request);
  const memory = await mcp<{ id: string }>(request, "save_memory", {
    title: `Form spacing ${crypto.randomUUID().slice(0, 8)}`,
    body: "A memory to open, so its pane's forms are drawn.",
    type: "fact",
    tags: ["forms"],
  });
  const routes = [
    "/todos",
    "/todos?edit=new",
    "/memories",
    `/memories?open=${encodeURIComponent(memory.id)}`,
    `/memories?edit=${encodeURIComponent(`${memory.id}.links`)}`,
    "/memories/subjects",
    "/memories?tab=review",
    "/skills",
    "/skills?add=search",
    "/skills?add=url",
    "/library",
    "/library?add=bookmark",
    "/library?add=upload",
    "/connections",
    "/hooks",
    "/account",
    "/people",
    "/workbench?tab=components",
  ];
  const touching: string[] = [];
  for (const path of routes) {
    await goto(page, path);
    // A string, not a closure: this repo compiles without the DOM lib.
    const hits = await page.evaluate<string[]>(`(() => {
      const drawn = (el) => el.getClientRects().length > 0;
      const fields = [...document.querySelectorAll(
        'input:not([type=hidden]):not([type=checkbox]):not([type=radio]), textarea, select, [role=combobox], .file-dropzone'
      )].filter(drawn);
      const buttons = [...document.querySelectorAll('button, a.button, [data-slot=button]')]
        .filter((b) => drawn(b) && b.getBoundingClientRect().height > 0);
      const out = [];
      for (const button of buttons) {
        const b = button.getBoundingClientRect();
        for (const field of fields) {
          if (field.contains(button) || button.contains(field)) continue;
          const f = field.getBoundingClientRect();
          const overlap = Math.min(b.right, f.right) - Math.max(b.left, f.left);
          const gap = b.top - f.bottom;
          if (overlap > 0 && gap >= -1 && gap < ${THREE_UNITS}) {
            out.push((button.textContent || button.getAttribute("aria-label") || "").trim()
              + " is " + gap.toFixed(1) + "px under "
              + (field.getAttribute("name") || field.getAttribute("aria-label") || field.tagName));
          }
        }
      }
      return [...new Set(out)];
    })()`);
    touching.push(...hits.map((hit) => `${path}: ${hit}`));
  }
  expect(touching).toEqual([]);
});
