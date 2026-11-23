import type { APIRequestContext, Locator } from "@playwright/test";
import { expect, goto, mcp, seed, test } from "./fixtures/session";

async function create(request: APIRequestContext, project: string) {
  const todo = await mcp(request, "create_todo", {
    title: `Recording feedback ${crypto.randomUUID().slice(0, 8)}`,
    project,
    body: "The description already opens its own editor.\n\n- [ ] Existing step",
  });
  return { id: String(todo.id), title: String(todo.title) };
}

function fact(dialog: Locator, name: string) {
  return dialog.locator(".facts > div").filter({
    has: dialog.page().getByText(name, { exact: true }),
  });
}

test.beforeEach(async ({ request }) => {
  await seed(request);
});

test("names the small subtask control and keeps editors in their boxes (P1/P4/P6/P8/P10)", async ({
  page,
  request,
}) => {
  const todo = await create(request, "recording-editors");
  await goto(page, `/todos?open=${encodeURIComponent(todo.id)}`);
  const dialog = page.getByRole("dialog");
  const add = dialog.getByRole("link", { name: "Add sub-task", exact: true });
  await expect(add).toHaveText("Add sub-task");
  await expect(add).not.toHaveClass(/add-item/);
  const addBox = await add.boundingBox();
  const detailBox = await dialog.locator(".todo-detail").boundingBox();
  expect(addBox!.height).toBeGreaterThanOrEqual(24);
  expect(addBox!.width).toBeLessThan(detailBox!.width / 2);

  const refs = dialog.locator(".todo-refs");
  const before = await refs.boundingBox();
  await dialog
    .getByText("The description already opens its own editor.")
    .click();
  await expect(
    dialog.getByRole("textbox", { name: "Body", exact: true }),
  ).toBeVisible();
  expect(
    Math.abs((await refs.boundingBox())!.y - before!.y),
  ).toBeLessThanOrEqual(1);
  await dialog.getByRole("link", { name: "Cancel", exact: true }).click();

  await add.focus();
  await page.keyboard.press("Enter");
  const step = dialog.getByRole("textbox", { name: "Sub-task", exact: true });
  await expect(step).toBeFocused();
  expect(
    Math.abs((await refs.boundingBox())!.y - before!.y),
  ).toBeLessThanOrEqual(1);
  await page.keyboard.press("Escape");
  await expect(add).toBeFocused();
  await expect(dialog).toBeVisible();
  await add.click();
  await step.fill("A clearly named new step");
  const posted = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      response.url().includes("/todos.data"),
  );
  await dialog.getByRole("button", { name: "Add", exact: true }).click();
  expect((await posted).ok()).toBe(true);
  await expect(
    dialog.getByText("A clearly named new step", { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(new RegExp(encodeURIComponent(todo.id)));
});

test("lays the metadata out as the memory pane's facts and wraps long values on mobile", async ({
  page,
  request,
}) => {
  const todo = await create(request, "recording-metadata");
  const claim = await mcp(request, "claim_todo", {
    id: todo.id,
    ttl_seconds: 3600,
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  const dialog = page.getByRole("dialog");
  await expect(async () => {
    await goto(page, `/todos?open=${encodeURIComponent(todo.id)}`);
    await expect(fact(dialog, "Claim holder").locator("dd")).not.toHaveText(
      "Unclaimed",
      { timeout: 500 },
    );
  }).toPass();
  const facts = dialog.locator(".facts");
  await expect(facts.locator("dt")).toHaveText([
    "Project",
    "Opened by",
    "Claim holder",
    "Lease",
    "Fencing token",
  ]);
  await expect(fact(dialog, "Project").locator("dd")).toContainText(
    "recording-metadata",
  );
  await expect(fact(dialog, "Claim holder").locator("dd")).not.toHaveText(
    "Unclaimed",
  );
  await expect(fact(dialog, "Lease").locator("dd")).not.toHaveText(
    "No active lease",
  );
  await expect(fact(dialog, "Fencing token").locator("dd")).toHaveText(
    String(claim.token),
  );
  // Label over value, a hairline above each cell, two columns in the pane:
  // the memory pane's facts, not a run-on band.
  const cells = await facts.locator(":scope > div").all();
  for (const cell of cells) {
    await expect(cell).toHaveCSS("border-top-width", "1px");
  }
  const [first, second] = [
    await cells[0]!.boundingBox(),
    await cells[1]!.boundingBox(),
  ];
  expect(Math.abs(first!.y - second!.y)).toBeLessThanOrEqual(1);
  expect(second!.x).toBeGreaterThan(first!.x + first!.width / 2);

  const long = await create(
    request,
    `recording-${"long-project-name-".repeat(12)}`.slice(0, 200),
  );
  for (const width of [390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/todos?open=${encodeURIComponent(long.id)}`);
    await expect(dialog.locator(".facts dt")).toHaveCount(5);
    const overflow = await page.evaluate<boolean>(
      `document.querySelector('dialog').scrollWidth > document.querySelector('dialog').clientWidth`,
    );
    expect(overflow).toBe(false);
    const add = dialog.getByRole("link", { name: "Add sub-task", exact: true });
    await add.click();
    const step = dialog.getByRole("textbox", { name: "Sub-task", exact: true });
    await expect(step).toBeFocused();
    const box = await step.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(width);
    await dialog.getByRole("link", { name: "Cancel", exact: true }).click();
    await expect(add).toBeFocused();
  }
});

test("adds a subtask through the same labeled link with scripting off (P11)", async ({
  page,
  request,
  browser,
}) => {
  const todo = await create(request, "recording-no-script");
  const plain = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 320, height: 900 },
  });
  try {
    const tab = await plain.newPage();
    await tab.goto(`/todos?open=${encodeURIComponent(todo.id)}`);
    await tab.getByRole("link", { name: "Add sub-task", exact: true }).click();
    await tab
      .getByRole("textbox", { name: "Sub-task", exact: true })
      .fill("No-script step");
    await tab.getByRole("button", { name: "Add", exact: true }).click();
    await expect(
      tab.getByRole("dialog").getByText("No-script step", { exact: true }),
    ).toBeVisible();
    await expect(tab.getByRole("dialog").locator(".facts dt")).toHaveCount(5);
    await tab
      .getByRole("dialog")
      .getByRole("link", { name: "Edit Body" })
      .click();
    await expect(
      tab.getByRole("textbox", { name: "Body", exact: true }),
    ).toBeVisible();
  } finally {
    await plain.close();
  }
});

test("adds a pointer through its modal's ?edit= link with scripting off (P3/P11/P15)", async ({
  request,
  browser,
}) => {
  const todo = await create(request, "recording-no-script-pointer");
  const plain = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 900 },
  });
  try {
    const tab = await plain.newPage();
    await tab.goto(`/todos?open=${encodeURIComponent(todo.id)}`);
    await tab.getByRole("link", { name: "Add pointer", exact: true }).click();
    await expect(tab).toHaveURL(/edit=.*\.refs/);
    const modal = tab.getByRole("dialog", { name: "Add a pointer" });
    await modal
      .getByRole("combobox", { name: "Pointer kind", exact: true })
      .fill("doc");
    await modal.getByLabel("Pointer", { exact: true }).fill("ADR-0018");
    await modal
      .getByRole("button", { name: "Add pointer", exact: true })
      .click();
    // The post redirects to the pane, so the modal is gone and the row is in.
    await expect(tab).not.toHaveURL(/edit=/);
    await expect(modal).toHaveCount(0);
    await expect(tab.locator(".refs")).toContainText("ADR-0018");
    const fetched = await mcp(request, "fetch", { id: todo.id });
    expect(fetched.metadata.refs).toEqual([{ kind: "doc", value: "ADR-0018" }]);
  } finally {
    await plain.close();
  }
});

/**
 * The walkthrough of 2026-11-03: the project sat top right while its tags
 * wrapped onto the line below, and the sub-task count floated between the
 * title and the state. Now the project, tags and state are one line on the
 * title's edge, and the count sits right after the title. P4, P7.
 */
test("puts a row's project, tags and state on one line, and its sub-task count after the title (P4/P7)", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const tag = (name: string) => `${name}-${run}`;
  const make = (args: Record<string, unknown>) =>
    mcp(request, "create_todo", args).then((todo) => String(todo.id));
  const project = `row-meta-${run}`;
  const ids = {
    plain: await make({
      title: `Investigate Codex plugin hooks and the server name ${run}`,
      project,
      tags: [
        tag("area:clients"),
        tag("codex"),
        tag("hooks"),
        tag("priority:3"),
      ],
      body: "- [ ] One\n- [ ] Two\n- [x] Three\n- [ ] Four",
    }),
    many: await make({
      title: `Draft the onboarding checklist for new contributors ${run}`,
      project,
      tags: Array.from({ length: 9 }, (_, i) => tag(`tag-${i}`)),
    }),
    long: await make({
      title: `Gate hook searches on the server, once per error per session, at most three per session ${run}`,
      project: `${project}-and-a-very-long-project-name-for-self-hosting`,
      tags: [tag("area:search")],
      body: "- [ ] Measure\n- [ ] Gate",
    }),
    bare: await make({ title: `No project, no tags ${run}`, project }),
    claimed: await make({ title: `Claimed ${run}`, project, tags: [tag("x")] }),
    blocked: await make({ title: `Blocked ${run}`, project, tags: [tag("y")] }),
    done: await make({ title: `Done ${run}`, project, tags: [tag("z")] }),
  };
  // MCP files every to-do under a project; the console can clear one.
  await goto(page, `/todos?open=${encodeURIComponent(ids.bare)}`);
  const pane = page.getByRole("dialog");
  await pane.getByRole("link", { name: "Edit project" }).click();
  await pane.getByRole("combobox", { name: "Project" }).fill("");
  await pane.getByRole("button", { name: "Save" }).click();
  await expect(page).not.toHaveURL(/edit=/);
  await page.waitForLoadState("networkidle");
  await mcp(request, "claim_todo", { id: ids.claimed, ttl_seconds: 600 });
  const held = await mcp(request, "claim_todo", {
    id: ids.blocked,
    ttl_seconds: 600,
  });
  await mcp(request, "update_todo", {
    id: ids.blocked,
    token: held.token,
    blocked_on: "legal review",
  });
  const closing = await mcp(request, "claim_todo", { id: ids.done });
  await mcp(request, "complete_todo", {
    id: ids.done,
    token: closing.token,
    summary: "Done.",
  });

  const row = (id: string) =>
    page
      .locator(".todo-list > .todo-card")
      .filter({ has: page.locator(`input[name="id"][value="${id}"]`) })
      .first();
  const box = async (locator: Locator) => (await locator.boundingBox())!;
  const middle = (b: { y: number; height: number }) => b.y + b.height / 2;

  // Every row hangs its metadata line from the title's edge, under a title
  // that has the row to itself, and the folder and first chip share a centre.
  async function lines(id: string, width: number) {
    const card = row(id);
    await expect(card).toBeVisible();
    const cardBox = await box(card);
    const head = await box(card.locator(":scope > .todo-head"));
    const title = await box(card.locator(":scope > .todo-head .todo-title"));
    const meta = card.locator(":scope > .todo-tags");
    const metaBox = await box(meta);
    expect(head.width).toBeGreaterThan(cardBox.width * 0.8);
    expect(Math.abs(metaBox.x - title.x)).toBeLessThanOrEqual(1);
    expect(metaBox.y).toBeGreaterThanOrEqual(head.y + head.height - 1);
    expect(metaBox.x + metaBox.width).toBeLessThanOrEqual(
      cardBox.x + cardBox.width,
    );
    await expect(card.locator(":scope > .todo-head .pill")).toHaveCount(0);
    const folder = meta.locator(":scope > .project-chip");
    const chip = meta.locator(".tags > .chip").first();
    // A project name too long for the line wraps, and so does its centre.
    if (
      (await folder.count()) &&
      (await chip.count()) &&
      (id !== ids.long || width === 1280)
    ) {
      const f = await box(folder);
      const c = await box(chip);
      expect(Math.abs(middle(f) - middle(c))).toBeLessThanOrEqual(1);
    }
  }

  // The sub-task count follows the title it belongs to, on its first line.
  async function countFollowsTitle(id: string) {
    const card = row(id);
    const title = await box(card.locator(":scope > .todo-head .todo-title"));
    const count = await box(card.locator(":scope > .todo-head .task-count"));
    expect(count.x - (title.x + title.width)).toBeGreaterThanOrEqual(0);
    expect(count.x - (title.x + title.width)).toBeLessThanOrEqual(12);
    expect(Math.abs(count.y - title.y)).toBeLessThanOrEqual(2);
  }

  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 900 });
    // The row with no project and the long project, found by their words.
    await goto(page, `/todos?q=${encodeURIComponent(run)}`);
    await expect(
      row(ids.bare).locator(":scope > .todo-tags > .project-chip"),
    ).toHaveCount(0);
    await lines(ids.bare, width);
    await lines(ids.long, width);
    await countFollowsTitle(ids.long);
    await page.screenshot({
      path: test.info().outputPath(`rows-search-${width}.png`),
      fullPage: true,
    });

    // An agent's claim, block and completion reach D1 through the
    // coordinator's mirror alarm.
    await expect(async () => {
      await goto(
        page,
        `/todos?project=${encodeURIComponent(project)}&done=show`,
      );
      for (const id of [ids.claimed, ids.done])
        await expect(row(id).locator(".pill")).toHaveCount(1, { timeout: 500 });
      await expect(row(ids.blocked)).toHaveClass(/\bis-blocked\b/, {
        timeout: 500,
      });
    }).toPass();
    for (const id of [ids.plain, ids.many, ids.claimed, ids.blocked, ids.done])
      await lines(id, width);

    await countFollowsTitle(ids.plain);
    await expect(row(ids.plain).locator(".task-count")).toHaveText("1/4");

    // The state is the line's last word, on the folder's centre line.
    for (const [id, state] of [
      [ids.claimed, "claimed"],
      [ids.done, "done"],
    ] as const) {
      const meta = row(id).locator(":scope > .todo-tags");
      const pill = meta.locator(":scope > .pill");
      await expect(pill).toHaveText(state);
      const p = await box(pill);
      const f = await box(meta.locator(":scope > .project-chip"));
      const m = await box(meta);
      expect(Math.abs(p.x + p.width - (m.x + m.width))).toBeLessThanOrEqual(1);
      // A phone line too full for it puts the pill at the end of the next.
      if (width === 1280)
        expect(Math.abs(middle(p) - middle(f))).toBeLessThanOrEqual(1);
    }
    await expect(row(ids.blocked).locator(".pill")).toHaveCount(0);

    // Nine tags wrap inside their line rather than pushing the title.
    const many = row(ids.many).locator(":scope > .todo-tags");
    if (width === 390) expect((await box(many)).height).toBeGreaterThan(30);

    await page.screenshot({
      path: test.info().outputPath(`rows-${width}.png`),
      fullPage: true,
    });
  }

  // The pane opened from a row keeps its own layout: the row rules stop at
  // the row's direct children.
  await page.setViewportSize({ width: 1280, height: 900 });
  await row(ids.plain).locator(".todo-open").click();
  const dialog = page.getByRole("dialog");
  await expect(dialog.locator(".todo-detail")).toBeVisible();
  await expect(dialog.locator(".todo-tags")).toHaveCount(0);
  await page.screenshot({ path: test.info().outputPath("pane-1280.png") });
});

/**
 * The owner's review of 2026-11-08: tags on the to-do list sat in 24px slots,
 * taller than the same tags on /memories and /library, and the add control's
 * words were drawn over the last tags. A tag takes its size from its place (V8): every
 * list row is compact, whatever feature drew it, and the + unfolds in line.
 */
test("list rows draw compact tags at one size, and the + unfolds in line after them (V8/P4)", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const project = `tag-size-${run}`;
  const tags = [`docs-${run}`, `onboarding-${run}`, `priority:1-${run}`];
  await mcp(request, "create_todo", {
    title: `Compact tags ${run}`,
    project,
    tags,
  });
  const memory = await mcp(request, "save_memory", {
    type: "decision",
    title: `Compact memory ${run}`,
    body: "A memory whose tags sit in a list row.",
    project,
    tags,
  });
  await page.setViewportSize({ width: 1280, height: 900 });

  const measure = (locator: Locator) =>
    locator.evaluate((el: any) => {
      const style = el.ownerDocument.defaultView.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return {
        font: style.fontSize,
        fill: style.backgroundColor,
        height: Math.round(rect.height),
      };
    });

  await goto(page, `/todos?project=${project}`);
  const card = page.locator(".todo-list > .todo-card").first();
  const chip = card.locator(".chip").first();
  const todoTag = await measure(chip);
  expect(todoTag.font).toBe("11.25px");
  expect(todoTag.height).toBeLessThanOrEqual(20);

  // The + is the last chip; unfolded, it grows rightwards from where it was
  // and covers nothing: the last tag keeps its place.
  const last = card.locator(".chip").last();
  const add = card.getByRole("link", { name: "Add tag", exact: true });
  const lastBefore = (await last.boundingBox())!;
  const addBefore = (await add.boundingBox())!;
  await add.hover();
  await expect(add.locator(".chip-add-label")).toBeVisible();
  const lastAfter = (await last.boundingBox())!;
  const addAfter = (await add.boundingBox())!;
  expect(lastAfter.x).toBe(lastBefore.x);
  expect(Math.round(addAfter.x)).toBe(Math.round(addBefore.x));
  expect(addAfter.width).toBeGreaterThan(addBefore.width);
  expect(addAfter.x).toBeGreaterThanOrEqual(lastAfter.x + lastAfter.width);

  // No underline on a link in a list row.
  const decoration = (locator: Locator) =>
    locator.evaluate((el: any) =>
      String(
        el.ownerDocument.defaultView.getComputedStyle(el).textDecorationLine,
      ),
    );
  expect(await decoration(card.locator(".todo-open"))).toBe("none");
  expect(await decoration(card.locator(".project-chip"))).toBe("none");

  // The same tags on /memories are the same size.
  await goto(page, `/memories?project=${project}`);
  const memoryTag = await measure(
    page.locator(".item-list .tag").filter({ hasText: tags[0] }).first(),
  );
  expect(memoryTag.font).toBe(todoTag.font);
  expect(memoryTag.fill).toBe(todoTag.fill);
  expect(Math.abs(memoryTag.height - todoTag.height)).toBeLessThanOrEqual(1);

  // Opened, the item's pane is not a list row: the same chip, standard size.
  await goto(page, `/memories?open=${encodeURIComponent(String(memory.id))}`);
  const pane = page.getByRole("dialog");
  await expect(pane).toBeVisible();
  const paneTag = await measure(pane.locator(".chip").first());
  expect(paneTag.fill).toBe(todoTag.fill);
  expect(paneTag.height).toBeGreaterThan(todoTag.height);
});

// The chosen width is set before the first paint, not by the grip's effect
// after hydration, so a reload never draws the default and then moves the
// divider. With every bundled script refused, the page never hydrates; only
// the inline head script can have set the width the pane is drawn at. P4.
test("a reload paints the pane at its chosen width before hydration (P4)", async ({
  page,
  request,
}) => {
  const todo = await mcp(request, "create_todo", {
    title: `Pane paint ${crypto.randomUUID().slice(0, 8)}`,
    project: "valise",
  });
  await page.setViewportSize({ width: 1280, height: 900 });
  await goto(page, "/todos");
  await page.evaluate("localStorage.setItem('valise:pane-width', '420')");
  await page.route(/\.m?js(\?.*)?$/, (route) => route.abort());
  await page.goto(`/todos?open=${encodeURIComponent(String(todo.id))}`);
  const pane = page.locator("dialog.modal-pane[open]");
  await expect(pane).toBeVisible();
  expect(Math.round((await pane.boundingBox())!.width)).toBe(420);

  // A width chosen in a wider window is clamped to 70% of this one.
  await page.evaluate("localStorage.setItem('valise:pane-width', '2000')");
  await page.reload();
  await expect(pane).toBeVisible();
  expect(Math.round((await pane.boundingBox())!.width)).toBe(896);
});

/**
 * The owner's request of 2026-11-08: a `todo:tdo_…` an agent writes in a
 * body is a card with that to-do's title and state, linking to it, as Jira
 * draws a ticket key. Text, inline code and a sub-task all qualify; an id
 * that names nothing still links, by its short id. Plain-text places (the
 * row preview, the status line) read the title instead of the id. P7.
 */
test("a to-do id in a body is a card with the to-do's title and state (P7)", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const project = `mentions-${run}`;
  const spike = await mcp(request, "create_todo", {
    title: `Local proxy spike ${run}`,
    project,
  });
  const retired = await mcp(request, "create_todo", {
    title: `Retire the exporter ${run}`,
    project,
  });
  const lease = await mcp(request, "claim_todo", { id: retired.id });
  await mcp(request, "complete_todo", {
    id: retired.id,
    token: lease.token,
    summary: "Gone.",
  });
  const missing = "todo:tdo_00000000-0000-4000-8000-000000000000";
  const host = await mcp(request, "create_todo", {
    title: `Ship the proxy ${run}`,
    project,
    body: `Related: ${spike.id} (the spike).\n\nAlso \`${retired.id}\` and ${missing}.\n\n- [ ] Wire it after ${spike.id} lands`,
  });
  const held = await mcp(request, "claim_todo", { id: host.id });
  await mcp(request, "update_todo", {
    id: host.id,
    token: held.token,
    body: `Waiting on ${spike.id}.`,
  });

  await goto(page, `/todos?project=${project}`);
  const row = page
    .locator(".todo-list > .todo-card")
    .filter({ hasText: `Ship the proxy ${run}` });
  await expect(row.locator(".todo-preview")).toHaveText(
    `Related: Local proxy spike ${run} (the spike).`,
  );
  await expect(row.getByTestId("todo-status")).toContainText(
    `Waiting on Local proxy spike ${run}.`,
  );

  const pane = page.getByRole("dialog");
  const cards = pane.locator(".prose a.todo-mention");
  // The completion reaches the list a moment after the call returns.
  await expect(async () => {
    await goto(
      page,
      `/todos?project=${project}&open=${encodeURIComponent(String(host.id))}`,
    );
    await expect(
      cards.filter({ hasText: `Retire the exporter ${run}` }),
    ).toContainText("done", { timeout: 1000 });
  }).toPass({ timeout: 15_000 });
  // Two in the body's text, one in code, one unknown, one in the sub-task,
  // one in the update.
  await expect(cards).toHaveCount(5);
  const spikeCard = cards
    .filter({ hasText: `Local proxy spike ${run}` })
    .first();
  await expect(spikeCard).toContainText("pending");
  await expect(
    cards.filter({ hasText: `Retire the exporter ${run}` }),
  ).toContainText("done");
  await expect(cards.filter({ hasText: "To-do 00000000" })).toHaveCount(1);
  await expect(pane).not.toContainText("todo:tdo_");

  // One line high, inside the paragraph, and a link to the to-do it names.
  const box = (await spikeCard.boundingBox())!;
  expect(box.height).toBeLessThanOrEqual(24);
  await spikeCard.click();
  await expect(page).toHaveURL(
    new RegExp(`open=${encodeURIComponent(String(spike.id))}`),
  );
});

// A card is one unbreakable run; its paragraph narrows to the pane and the
// title truncates, instead of the pane scrolling sideways (owner, 2026-11-08).
test("a to-do card with a long title fits the pane at every width", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const long = await mcp(request, "create_todo", {
    title: `Gate hook searches on the server, once per error per session, at most three per session, and record each refusal ${run}`,
    project: `mention-fit-${run}`,
  });
  const host = await mcp(request, "create_todo", {
    title: `Host ${run}`,
    project: `mention-fit-${run}`,
    body: `Related: ${long.id} (gate hook searches).\n\n- [ ] After ${long.id}`,
  });
  for (const width of [1280, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/todos?open=${encodeURIComponent(String(host.id))}`);
    const body = page.locator("dialog[open] .modal-body");
    await expect(body.locator("a.todo-mention").first()).toBeVisible();
    const [scroll, client] = await body.evaluate(
      (el: any) => [el.scrollWidth, el.clientWidth] as const,
    );
    expect(scroll, `${width}px`).toBeLessThanOrEqual(client);
  }
});

// Pages whose loader does not title mentions ask for the titles once the
// pane is on screen: a memory naming a to-do shows that to-do's title.
test("a memory pane fetches the titles of the to-dos it names", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const todo = await mcp(request, "create_todo", {
    title: `Named from a memory ${run}`,
    project: `mention-memory-${run}`,
  });
  const memory = await mcp(request, "save_memory", {
    type: "decision",
    title: `Memory naming a to-do ${run}`,
    body: `Settled while doing ${todo.id}.`,
    project: `mention-memory-${run}`,
    tags: ["mentions"],
  });
  await goto(page, `/memories?open=${encodeURIComponent(String(memory.id))}`);
  const card = page.getByRole("dialog").locator("a.todo-mention");
  await expect(card).toContainText(`Named from a memory ${run}`);
  await expect(card).toContainText("pending");
  await card.click();
  await expect(page).toHaveURL(
    new RegExp(`/todos\\?open=${encodeURIComponent(String(todo.id))}`),
  );
});
