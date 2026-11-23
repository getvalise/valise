import type { Page } from "@playwright/test";
import { expect, goto, mcp, seed, test } from "./fixtures/session";

test.beforeEach(async ({ request }) => seed(request));

/** The list's one create control opens a dialog holding the whole form. */
async function createSubject(
  page: Page,
  name: string,
  description = "",
): Promise<void> {
  await page.getByRole("link", { name: "Create subject" }).click();
  const dialog = page.getByRole("dialog", { name: "Create subject" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(name);
  if (description)
    await dialog
      .getByRole("textbox", { name: "Description" })
      .fill(description);
  await dialog.getByRole("button", { name: "Create subject" }).click();
  await expect(page.getByRole("heading", { name, level: 1 })).toBeVisible();
}

/** Opens one detail's editor from its pen, types, and saves in place. */
async function editDetail(page: Page, label: string, value: string) {
  const details = page.getByRole("region", { name: "Subject details" });
  await details
    .getByRole("link", { name: `Edit ${label.toLowerCase()}` })
    .click();
  await details.getByRole("textbox", { name: label }).fill(value);
  await details.getByRole("button", { name: "Save" }).click();
  await expect(details.getByRole("button", { name: "Save" })).toHaveCount(0);
}

/** "Add supporting memory" opens one modal: search, pick, close. */
async function addSupportingMemory(page: Page, find: string, name: string) {
  await page.getByRole("link", { name: "Add supporting memory" }).click();
  const dialog = page.getByRole("dialog", { name: "Add supporting memory" });
  await dialog
    .getByRole("textbox", { name: "Find memories by title or text" })
    .fill(find);
  await dialog.getByRole("button", { name: "Find memories" }).click();
  await expect(page).toHaveURL(/[?&]add=memory/);
  await dialog
    .getByRole("button", { name: `Add to ${name}` })
    .first()
    .click();
  await expect(
    page
      .getByRole("list", { name: "Supporting memories" })
      .locator(".item-row"),
  ).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/add=|find=/);
}

/** The summary's one control opens a modal; saving closes it. */
async function writeSummary(page: Page, body: string) {
  const section = page.getByRole("region", { name: "Current understanding" });
  await section
    .getByRole("link", { name: /^(Add a|Replace) summary$/ })
    .click();
  const dialog = page.getByRole("dialog", { name: /summary$/ });
  await dialog.getByRole("textbox", { name: "Write a new summary" }).fill(body);
  await dialog.getByRole("button", { name: "Create summary" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(section.getByText(body)).toBeVisible();
}

test("subjects preserve original memories, summary provenance and the existing Review view", async ({
  page,
}) => {
  await goto(page, "/memories");
  await page
    .getByRole("navigation", { name: "Memories sections" })
    .getByRole("link", { name: "Subjects" })
    .click();
  await createSubject(page, "Test subject", "Current understanding");
  await editDetail(page, "Name", "Renamed subject");
  await expect(
    page.getByRole("heading", { name: "Renamed subject" }),
  ).toBeVisible();
  await addSupportingMemory(page, "warehouse", "Renamed subject");
  await expect(
    page.getByRole("heading", { name: "Supporting memories (1 confirmed)" }),
  ).toBeVisible();
  await writeSummary(page, "Test synthesis supported by an original memory.");
  await page
    .getByRole("navigation", { name: "Memories sections" })
    .getByRole("link", { name: "Review" })
    .click();
  await expect(page).toHaveURL(/tab=review/);
  await expect(
    page.getByText("Nightly upkeep adds summaries that only add", {
      exact: false,
    }),
  ).toBeVisible();
});

test("mobile subject actions remain reachable", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goto(page, "/memories/subjects");
  await createSubject(page, "Mobile profile");
  await expect(page.getByRole("link", { name: "Add a summary" })).toBeVisible();
  await expect(
    page.getByRole("link", { name: "Add supporting memory" }),
  ).toBeVisible();
  await page.setViewportSize({ width: 320, height: 700 });
  await expect(page.getByRole("link", { name: "Edit name" })).toBeVisible();
});

for (const width of [1280, 390]) {
  test(`summary and members read as text and add through a modal at ${width}px`, async ({
    page,
  }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, "/memories/subjects");
    await createSubject(page, `Modal subject ${width}`);
    const understanding = page.getByRole("region", {
      name: "Current understanding",
    });
    const supporting = page.getByRole("region", {
      name: "Supporting memories",
    });
    // Text and one control each: no field and no commit button on the page.
    for (const section of [understanding, supporting]) {
      await expect(section.getByRole("textbox")).toHaveCount(0);
      await expect(section.getByRole("button")).toHaveCount(0);
    }
    await expect(understanding.getByText("No current summary.")).toBeVisible();
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`subject-empty-${width}.png`),
    });

    // The add row is the list's first item and the whole of the add form.
    await page.getByRole("link", { name: "Add supporting memory" }).click();
    const adding = page.getByRole("dialog", { name: "Add supporting memory" });
    await adding
      .getByRole("textbox", { name: "Find memories by title or text" })
      .fill("warehouse");
    await adding.getByRole("button", { name: "Find memories" }).click();
    await expect(
      adding.getByRole("button", { name: `Add to Modal subject ${width}` }),
    ).not.toHaveCount(0);
    await page.screenshot({
      path: testInfo.outputPath(`subject-add-memory-${width}.png`),
    });
    await adding
      .getByRole("button", { name: `Add to Modal subject ${width}` })
      .first()
      .click();
    const members = supporting
      .getByRole("list", { name: "Supporting memories" })
      .locator(".item-row");
    await expect(members).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(adding).toHaveCount(0);

    const member = members.locator("a.item-title");
    const memberTitle = (await member.textContent()) ?? "";

    // The summary's one control opens one modal with both choices.
    await understanding.getByRole("link", { name: "Add a summary" }).click();
    const choosing = page.getByRole("dialog", { name: "Add a summary" });
    await expect(
      choosing.getByRole("textbox", { name: /Or use an existing memory/ }),
    ).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath(`subject-summary-modal-${width}.png`),
    });
    await page.keyboard.press("Escape");
    await expect(choosing).toHaveCount(0);
    await writeSummary(page, `Summary written at ${width}px.`);
    const summaryId = decodeURIComponent(
      (
        (await understanding
          .locator('a[href*="open=memory"]')
          .first()
          .getAttribute("href")) ?? ""
      ).split("open=")[1] ?? "",
    );
    expect(summaryId).toMatch(/^memory:/);
    await page.screenshot({
      fullPage: true,
      path: testInfo.outputPath(`subject-with-summary-${width}.png`),
    });

    // Clearing is one small button; an existing memory comes back through
    // the same modal.
    await understanding.getByRole("button", { name: "Clear summary" }).click();
    await expect(understanding.getByText("No current summary.")).toBeVisible();
    await understanding.getByRole("link", { name: "Add a summary" }).click();
    await choosing
      .getByRole("textbox", { name: /Or use an existing memory/ })
      .fill(summaryId);
    await choosing.getByRole("button", { name: "Use as summary" }).click();
    await expect(choosing).toHaveCount(0);
    await expect(
      understanding.getByText(`Summary written at ${width}px.`),
    ).toBeVisible();

    // Removing a member is a small control on its row.
    await supporting
      .getByRole("button", { name: `Remove ${memberTitle} from subject` })
      .click();
    await expect(members).toHaveCount(0);
  });
}

test("the subject list comes first and creating one is a dialog", async ({
  page,
}) => {
  await goto(page, "/memories/subjects");
  await createSubject(page, "Listed first", "Shown as the row's excerpt");
  await goto(page, "/memories/subjects");
  // No form sits above the list: the page shows the list and one control.
  await expect(page.getByRole("textbox", { name: "Name" })).toHaveCount(0);
  const list = page.getByRole("list", { name: "Subjects" });
  await expect(list.locator("li").first()).toHaveText(/Create subject/);
  const row = list.locator(".item-row", { hasText: "Listed first" });
  await expect(row).toContainText("Shown as the row's excerpt");
  await expect(row).toContainText("profile");
  await expect(row).toContainText("0 memories");
  await expect(row).toContainText("no summary");
  await page.getByRole("link", { name: "Create subject" }).click();
  await expect(page).toHaveURL(/[?&]create=subject/);
  const dialog = page.getByRole("dialog", { name: "Create subject" });
  await expect(dialog.getByRole("textbox", { name: "Name" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(page).not.toHaveURL(/create=/);
  await row.locator("a.item-title").click();
  await expect(
    page.getByRole("heading", { name: "Listed first", level: 1 }),
  ).toBeVisible();
});

test("a second subject with a taken name is refused with a link to the first", async ({
  page,
}) => {
  await goto(page, "/memories/subjects");
  await createSubject(page, "vineyard");
  const first = page.url();
  await goto(page, "/memories/subjects");
  await page.getByRole("link", { name: "Create subject" }).click();
  const dialog = page.getByRole("dialog", { name: "Create subject" });
  await dialog.getByRole("textbox", { name: "Name" }).fill(" VineYard ");
  await dialog.getByRole("button", { name: "Create subject" }).click();
  await expect(dialog.getByRole("alert")).toContainText("already exists");
  // The typed name survives the refusal.
  await expect(dialog.getByRole("textbox", { name: "Name" })).toHaveValue(
    /VineYard/,
  );
  await dialog.getByRole("link", { name: "Open the existing subject" }).click();
  await expect(page).toHaveURL(first);
  await goto(page, "/memories/subjects");
  await expect(
    page
      .getByRole("list", { name: "Subjects" })
      .locator(".item-row", { hasText: /vineyard/i }),
  ).toHaveCount(1);
});

test("Delete subject hides it and the same control restores it", async ({
  page,
}) => {
  await goto(page, "/memories/subjects");
  await createSubject(page, "Short lived");
  const url = page.url();
  await page.getByRole("button", { name: "Delete subject" }).click();
  await expect(page.getByRole("status")).toContainText("Deleted");
  await expect(
    page.getByRole("region", { name: "Subject details" }),
  ).toHaveCount(0);
  await goto(page, "/memories/subjects");
  await expect(page.getByText("Short lived")).toHaveCount(0);
  await goto(page, url);
  await page.getByRole("button", { name: "Restore subject" }).click();
  await expect(
    page.getByRole("region", { name: "Subject details" }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Delete subject" }),
  ).toBeVisible();
  await goto(page, "/memories/subjects");
  await expect(
    page.getByRole("list", { name: "Subjects" }).getByText("Short lived"),
  ).toBeVisible();
});

test("subject details read as text and each edits in its own place", async ({
  page,
}) => {
  await goto(page, "/memories/subjects");
  await createSubject(page, "Inline subject");
  const details = page.getByRole("region", { name: "Subject details" });
  // Text, not a form: no field and no per-field commit button until asked.
  await expect(details.getByRole("textbox")).toHaveCount(0);
  await expect(details.getByRole("button")).toHaveCount(0);
  await expect(details.getByText("Inline subject")).toBeVisible();

  await details.getByRole("link", { name: "Add a description" }).click();
  await details
    .getByRole("textbox", { name: "Description" })
    .fill("Edited where it reads");
  await details.getByRole("button", { name: "Save" }).click();
  // While the save is in flight the held copy and the textarea both carry
  // the text; wait for the editor to close so the check reads one value.
  await expect(details.getByRole("textbox")).toHaveCount(0);
  await expect(details.getByText("Edited where it reads")).toBeVisible();

  await details.getByRole("link", { name: "Edit kind" }).click();
  const kind = details.getByRole("combobox", { name: "Kind" });
  await kind.fill("topic");
  await page.getByRole("option", { name: "topic" }).click();
  await details.getByRole("button", { name: "Save" }).click();
  await expect(details.getByRole("button", { name: "Save" })).toHaveCount(0);
  await expect(details.locator("dd").nth(1)).toHaveText("topic");

  // Cancel closes without a write, and the URL never named the editor.
  await details.getByRole("link", { name: "Edit name" }).click();
  await details.getByRole("textbox", { name: "Name" }).fill("Not saved");
  await details.getByRole("link", { name: "Cancel" }).click();
  await expect(details.getByText("Inline subject")).toBeVisible();
  await page.reload();
  await expect(details.getByText("Edited where it reads")).toBeVisible();
  await expect(details.locator("dd").nth(1)).toHaveText("topic");
  await expect(details.getByText("Inline subject")).toBeVisible();

  // The details are separated by the section rhythm, not packed flush.
  // A string, not a closure: this repo compiles without the DOM lib.
  const boxes = await page.evaluate<
    { top: number; bottom: number; left: number; right: number }[]
  >(
    `[...document.querySelectorAll('[aria-label="Subject details"] dl.facts > div')].map((row) => { const r = row.getBoundingClientRect(); return { top: r.top, bottom: r.bottom, left: r.left, right: r.right }; })`,
  );
  expect(boxes).toHaveLength(3);
  for (let i = 1; i < boxes.length; i += 1) {
    const [a, b] = [boxes[i - 1], boxes[i]];
    const apart = Math.max(b.top - a.bottom, b.left - a.right);
    expect(apart, `detail ${i} and the one before it`).toBeGreaterThanOrEqual(
      8,
    );
  }
});

test.describe("without scripting", () => {
  test.use({ javaScriptEnabled: false });
  test("creates and renames a subject with document forms", async ({
    page,
  }) => {
    await goto(page, "/memories/subjects", false);
    await page.getByRole("link", { name: "Create subject" }).click();
    await expect(page).toHaveURL(/[?&]create=subject/);
    await page.getByRole("textbox", { name: "Name" }).fill("Scriptless area");
    await page.getByRole("button", { name: "Create subject" }).click();
    await expect(
      page.getByRole("heading", { name: "Scriptless area" }),
    ).toBeVisible();
    await page.getByRole("link", { name: "Edit name" }).click();
    await expect(page).toHaveURL(/[?&]edit=name/);
    await page
      .getByRole("textbox", { name: "Name" })
      .fill("Renamed without scripts");
    await page.getByRole("button", { name: "Save" }).click();
    await expect(
      page.getByRole("heading", { name: "Renamed without scripts" }),
    ).toBeVisible();
    await expect(page).not.toHaveURL(/edit=/);
  });

  test("adds a member and a summary through the modals as document forms", async ({
    page,
  }) => {
    await goto(page, "/memories/subjects", false);
    await page.getByRole("link", { name: "Create subject" }).click();
    await page.getByRole("textbox", { name: "Name" }).fill("Scriptless modal");
    await page.getByRole("button", { name: "Create subject" }).click();
    await expect(
      page.getByRole("heading", { name: "Scriptless modal", level: 1 }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Add supporting memory" }).click();
    await expect(page).toHaveURL(/[?&]add=memory/);
    await page
      .getByRole("textbox", { name: "Find memories by title or text" })
      .fill("warehouse");
    await page.getByRole("button", { name: "Find memories" }).click();
    await expect(page).toHaveURL(/[?&]add=memory.*find=warehouse/);
    await page
      .getByRole("button", { name: "Add to Scriptless modal" })
      .first()
      .click();
    await expect(page).not.toHaveURL(/add=/);
    await expect(
      page.getByRole("heading", { name: "Supporting memories (1 confirmed)" }),
    ).toBeVisible();

    await page.getByRole("link", { name: "Add a summary" }).click();
    await expect(page).toHaveURL(/[?&]edit=summary/);
    await page
      .getByRole("textbox", { name: "Write a new summary" })
      .fill("Written with scripting off.");
    await page.getByRole("button", { name: "Create summary" }).click();
    await expect(page).not.toHaveURL(/edit=/);
    await expect(page.getByText("Written with scripting off.")).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Replace summary" }),
    ).toBeVisible();
  });
});

for (const width of [1280, 320]) {
  test(`suggests memories tagged with the subject's name; Add confirms one and Dismiss drops one at ${width}px`, async ({
    page,
    request,
  }) => {
    await page.setViewportSize({ width, height: 900 });
    const name = `Tagged ${width} ${crypto.randomUUID().slice(0, 8)}`;
    const tag = name.toLowerCase().replaceAll(" ", "-");
    const subject = await mcp<{ id: string }>(request, "save_subject", {
      name,
      kind: "topic",
    });
    for (const title of ["Keep this one", "Not this one"])
      await mcp(request, "save_memory", {
        title: `${title} ${width}`,
        body: `${title}, tagged for the subject.`,
        type: "fact",
        tags: [tag],
      });
    await goto(
      page,
      `/memories/subjects/${subject.id.slice("subject:".length)}`,
    );

    // The default view: members first, then suggestions with their reason.
    const supporting = page.getByRole("region", {
      name: "Supporting memories",
    });
    const suggested = page.getByRole("region", { name: "Suggested memories" });
    await expect(
      supporting.getByText("No supporting memories yet."),
    ).toBeVisible();
    await expect(suggested.locator(".item-row")).toHaveCount(2);
    await expect(suggested.getByText(`tagged ${tag}`).first()).toBeVisible();

    await suggested
      .getByRole("button", { name: `Add Keep this one ${width} to ${name}` })
      .click();
    await expect(
      supporting
        .getByRole("list", { name: "Supporting memories" })
        .locator(".item-row"),
    ).toHaveCount(1);
    await expect(suggested.locator(".item-row")).toHaveCount(1);

    await suggested
      .getByRole("button", { name: `Dismiss Not this one ${width}` })
      .click();
    await expect(suggested).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole("region", { name: "Suggested memories" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Supporting memories (1 confirmed)" }),
    ).toBeVisible();

    // Nothing on the page scrolls sideways at this width.
    const overflow = await page.evaluate<number>(
      "document.documentElement.scrollWidth - document.documentElement.clientWidth",
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}
