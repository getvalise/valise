import { readFileSync } from "node:fs";
import {
  type APIRequestContext,
  devices,
  type Locator,
  type Page,
} from "@playwright/test";
import { MEMORY_TYPES } from "../../app/concepts/memory-types";
import {
  test as base,
  expect,
  mcpCall as mcp,
  parseRpc,
  seed,
  signedOut,
  signIn,
} from "./fixtures/session";

const MEMORY_TYPE_NAMES = MEMORY_TYPES.map(([name]) => name);

/**
 * Every navigation waits for React to hydrate the page before the test acts
 * on it. A click that lands first gets the browser's default instead of the
 * app's handler: the sign-in form posts as a document to `/login` rather than
 * a fetch to `/login.data`, so `submit()` waits for a response that never
 * comes. On a CI runner the dev server serves its modules slowly enough to
 * lose that race about one run in three.
 *
 * React writes `__reactProps$<id>` onto each node it hydrates, and `<body>`
 * completes after everything inside it.
 */
const test = base.extend({
  page: async ({ page }, use) => {
    await use(hydrating(page));
  },
});

function hydrating(page: Page): Page {
  const goto = page.goto.bind(page);
  page.goto = async (url, options) => {
    const response = await goto(url, options);
    // A string, not a closure: this repo compiles without the DOM lib.
    await page.waitForFunction(
      `Object.keys(document.body).some((key) => key.startsWith("__reactProps$"))`,
    );
    return response;
  };
  return page;
}

test.beforeEach(async ({ request }) => {
  await seed(request);
});

test("workbench specimens: primitives, sections, principles, modal and combobox", async ({
  page,
}) => {
  test.setTimeout(90000);
  await test.step("renders every primitive on the workbench", async () => {
    await page.goto("/workbench?tab=components");
    const specimens = page.getByTestId("specimen");
    const heads = specimens.locator(":scope > h2");
    await expect(specimens).toHaveCount(15);
    for (const name of [
      "Theme",
      "Typography",
      "Icons",
      "Buttons",
      "Switch",
      "Tags and project",
      "List toolbar",
      "Item list",
      "Detail pane",
      "Section tabs",
      "Pickers",
      "Forms",
      "Stitch",
      "Empty state",
    ])
      await expect(
        heads.filter({ hasText: new RegExp(`^${name}`) }),
        name,
      ).toHaveCount(1);
    // Every role in both themes, and the whole closed icon set.
    await expect(page.locator("[data-theme-swatches=light] li")).toHaveCount(
      await page.locator("[data-theme-swatches=dark] li").count(),
    );
    await expect(page.locator("[data-theme-swatches] li")).not.toHaveCount(0);
    await expect(page.locator(".icons li")).not.toHaveCount(0);
    await expect(
      page.locator(".icons li", { hasText: /^valise$/ }),
    ).toHaveCount(1);
  });
  await test.step("shows backup status on every workbench tab", async () => {
    for (const tab of ["components", "logs", "evals"]) {
      await page.goto(`/workbench?tab=${tab}`);
      await expect(page.getByTestId("backup-status")).toHaveText(
        /^Backups: (last complete snapshot .+ UTC, snapshot-\S+|no complete snapshot yet); .+\.$/,
      );
    }
  });
  await test.step("sets the workbench sections under the sidebar, a level down", async () => {
    await page.goto("/workbench?tab=components");
    const strap = page.getByRole("navigation", { name: "Workspace" });
    const sections = page.getByRole("navigation", {
      name: "Workbench sections",
    });
    await sections.getByRole("link", { name: "Logs" }).click();
    await expect(page).toHaveURL(/tab=logs/);
    const current = sections.locator('a[aria-current="page"]');
    await expect(current).toHaveText("Logs");
    // Subordinate: smaller type than the sidebar, and the active highlight is
    // the sidebar's alone.
    // A string, not a closure: this repo compiles without the DOM lib.
    const size = (selector: string) =>
      page.evaluate<number>(
        `parseFloat(getComputedStyle(document.querySelector('${selector}')).fontSize)`,
      );
    expect(
      await size('nav[aria-label="Workbench sections"] a[aria-current="page"]'),
    ).toBeLessThan(
      await size('nav[aria-label="Workspace"] a[aria-current="page"]'),
    );
    await expect(strap.locator('a[aria-current="page"]')).toHaveAttribute(
      "data-active",
      "true",
    );
    await expect(current).not.toHaveCSS(
      "border-bottom-color",
      "rgb(91, 42, 134)",
    );
  });
  await test.step("shows every design principle, and every specimen names one", async () => {
    await page.goto("/workbench?tab=components");

    // The visual language plus the fifteen numbered principles.
    const ids = await page
      .getByRole("region", { name: "Design principles" })
      .locator("details")
      .evaluateAll((nodes) =>
        nodes.map((node) => (node as unknown as { id: string }).id),
      );
    expect(ids).toContain("visual");
    expect(ids.filter((id) => /^p\d+$/.test(id))).toHaveLength(15);
    // The whole file renders, closing sections included.
    expect(ids).toContain("what-this-rejects");
    expect(ids).toContain("sources");

    // Every specimen names at least one rule, and every named rule resolves
    // to a disclosure above it. A typo'd id renders no chip.
    const heads = page.getByTestId("specimen").locator(":scope > h2");
    for (const head of await heads.all())
      await expect(head.getByRole("link").first()).toBeVisible();
    const chips = heads.getByRole("link");
    await expect(chips.filter({ hasText: /^V\d · / })).not.toHaveCount(0);
    const targets = await chips.evaluateAll((nodes) =>
      nodes.map(
        (node) => (node as unknown as { hash?: string }).hash?.slice(1) ?? "",
      ),
    );
    for (const target of targets) expect(ids).toContain(target);

    // The body is the file's prose, not a stub. P4 is the one with the numbers.
    const p4 = page.locator("details#p4");
    await p4.locator("summary").click();
    await expect(p4).toContainText("preventScrollReset");
    await expect(p4.getByRole("note", { name: "Status" })).toContainText(
      "created_at",
    );
  });
  await test.step("opens and dismisses the workbench modal", async () => {
    await page.goto("/workbench?tab=components");

    const modal = page.locator("dialog.modal:not(.modal-pane)");
    await expect(modal).toBeHidden();
    await page.getByRole("button", { name: "Open modal" }).click();
    await expect(modal).toBeVisible();

    // The platform's focus trap is the reason this is a <dialog>: assert that
    // focus actually moved inside it rather than staying on the trigger.
    await expect(modal.locator(":focus")).toHaveCount(1);

    await page.keyboard.press("Escape");
    await expect(modal).toBeHidden();

    // Reopening after a close proves the effect follows state in both
    // directions, which a one-way showModal() would pass and then wedge.
    await page.getByRole("button", { name: "Open modal" }).click();
    await expect(modal).toBeVisible();
    await modal.locator("footer").getByRole("button").click();
    await expect(modal).toBeHidden();
  });
  await test.step("filters and selects in the combobox by keyboard", async () => {
    await page.goto("/workbench?tab=components");

    const combobox = page.getByRole("combobox", { name: "Model" });
    await combobox.click();
    // Scoped to the listbox: a native <select>'s <option> carries the same
    // role, and the Select specimen sits in the same form.
    const options = page
      .getByRole("listbox", { name: "Model" })
      .getByRole("option");
    await expect(options).toHaveCount(7);

    await combobox.fill("luna");
    await expect(options).toHaveCount(1);
    await expect(options.first()).toHaveText(/GPT-6 Luna/);

    await combobox.fill("claude");
    await expect(options).toHaveCount(2);
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await expect(options).toHaveCount(0);
    await expect(combobox).toHaveValue("Claude Haiku 5.5");

    // The value a form would post, which is the whole reason for the hidden
    // input: the visible text is a label, not the slug.
    await expect(page.locator('input[name="wb-model"]')).toHaveValue(
      "anthropic/claude-haiku-5.5",
    );

    // A filter that matches nothing says so rather than silently emptying.
    await combobox.fill("no-such-model");
    await expect(page.locator(".combobox-empty")).toBeVisible();
  });
  await test.step("returns visual focus to the combobox textbox on the caret keys", async () => {
    await page.goto("/workbench?tab=components");

    const combobox = page.getByRole("combobox", { name: "Model" });
    const options = page
      .getByRole("listbox", { name: "Model" })
      .getByRole("option");
    const caret = () =>
      combobox.evaluate(
        (input) =>
          (input as unknown as { selectionStart: number }).selectionStart,
      );

    await combobox.fill("claude");
    await expect(options).toHaveCount(2);

    for (const [key, expected] of [
      ["Home", 0],
      ["End", 6],
      ["ArrowLeft", 5],
      ["ArrowRight", 6],
    ] as const) {
      // Into the list first, so there is an option for the key to let go of.
      await page.keyboard.press("ArrowDown");
      await expect(combobox).toHaveAttribute("aria-activedescendant", /option/);
      await page.keyboard.press(key);
      await expect(combobox, key).not.toHaveAttribute("aria-activedescendant");
      await expect(options.and(page.locator(".active")), key).toHaveCount(0);
      expect(await caret(), key).toBe(expected);
      // The list stays open and keeps its filter; only the focus moved.
      await expect(options).toHaveCount(2);
    }

    // Down from the textbox enters at the top, Up at the bottom.
    await page.keyboard.press("ArrowUp");
    await expect(options.last()).toHaveClass(/active/);
    await page.keyboard.press("Home");
    await page.keyboard.press("ArrowDown");
    await expect(options.first()).toHaveClass(/active/);
  });
});

/**
 * The Components tab is rendered from `docs/design/principles.md`, so a
 * principle that is renamed or deleted has to break something. Without this,
 * a specimen's rule chip would silently disappear and the page would still
 * look fine.
 */
test("logs tab: what a client sent, refusals, sessions, and the why filter", async ({
  page,
  request,
}) => {
  test.setTimeout(90000);
  await test.step("shows what a client sent on the logs tab", async () => {
    const marker = `ui-logs-proof-${crypto.randomUUID().slice(0, 8)}`;
    // Its own agent, so its run is one row rather than something to hunt for in
    // a database every other test also writes to.
    await mcpAs(request, marker, "search", { query: marker });
    // A call the preflight refuses still has to appear, with its arguments.
    await mcpAs(
      request,
      marker,
      "create_todo",
      { title: marker },
      { "mcp-method": "tools/call", "mcp-name": "create_todo" },
    );

    await page.goto("/workbench?tab=logs");
    await expect(page.locator(".kpi").first()).toBeVisible();
    // The newest run arrives open, so the latest calls need no click.
    await expect(page.locator(".runs > li > details").first()).toHaveAttribute(
      "open",
      "",
    );

    // Calls live inside their run now, so open the run that carried this one.
    const run = page.locator(".runs > li").filter({
      has: page.locator(".caller", { hasText: marker }),
    });
    await openRun(run);
    const refused = run
      .locator(".calls > li")
      .filter({ has: page.getByText("invalid_input", { exact: true }) });
    await refused.locator(".call-row").click();
    const pane = page.getByRole("complementary", { name: "Call details" });
    await expect(pane.locator("pre")).toContainText(marker);
    // The payload is highlighted: `title` is a key, the marker a string.
    await expect(
      pane.locator("pre.json .j-key", { hasText: '"title"' }),
    ).toHaveCount(1);
    await expect(
      pane.locator("pre.json .j-str", { hasText: marker }),
    ).toHaveCount(1);
    const requestFacts = pane.locator(".call-facts").first();
    await expect(requestFacts.locator(".wide").nth(2)).toContainText(
      "tools/call",
    );
    await expect(requestFacts.locator(".wide").nth(3)).toContainText(
      "create_todo",
    );
    // A value that can run long gets a whole row, so the transport's value is
    // more than half the facts' width rather than one 7rem column.
    const facts = await pane.locator(".call-facts").last().boundingBox();
    const transport = await pane
      .locator(".call-facts > .wide", { hasText: "Transport" })
      .locator("dd")
      .boundingBox();
    expect(transport?.width ?? 0).toBeGreaterThan((facts?.width ?? 0) / 2);

    // The rolled-up row is the point of the page now, so assert it reads.
    await expect(run.locator("> details > summary")).toContainText("2 calls");
    await expect(page.locator(".kpi").first()).toContainText("Calls");

    // Signing in is itself an auth event, so the trail is never empty here.
    // It opens on request, which is why this clicks before it asserts.
    await page.locator(".auth-trail > summary").click();
    await expect(page.getByText("console_login").first()).toBeVisible();
  });
  await test.step("labels optional event-stream refusals without flagging a failed run", async () => {
    const marker = `ui-stream-${crypto.randomUUID().slice(0, 8)}`;
    const response = await request.get("/mcp", {
      headers: {
        accept: "text/event-stream",
        "mcp-protocol-version": "2025-11-25",
        "x-valise-agent": marker,
        "x-valise-client": "console-test",
      },
    });
    expect(response.status()).toBe(405);
    await mcpAs(request, marker, "list_ready", {});
    await page.goto(`/workbench?tab=logs&agent=${marker}`);
    const run = page.locator(".runs > li");
    await expect(run.locator(".call-row")).toHaveCount(1);
    await page.getByLabel("Handshakes").check();
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await openRun(run);
    await expect(run.locator(".call-row")).toHaveCount(2);
    await expect(run.locator("> details > summary")).not.toContainText(
      "not ok",
    );
    const probe = run.locator(".call-row", { hasText: "stream not offered" });
    await expect(probe.locator(".pill")).toHaveClass(/label/);
    await probe.click();
    const pane = page.getByRole("complementary", { name: "Call details" });
    await expect(pane).toContainText(
      "Optional event stream not offered; tool calls use POST.",
    );
    await expect(
      pane
        .locator(".wide", {
          has: page.getByText("HTTP method", { exact: true }),
        })
        .locator("dd"),
    ).toHaveText("GET");
    await expect(
      pane
        .locator(".wide", { has: page.getByText("Status", { exact: true }) })
        .locator("dd"),
    ).toHaveText("405");
    await expect(
      pane
        .locator(".wide", { has: page.getByText("Error", { exact: true }) })
        .locator("dd"),
    ).toHaveText("—");
  });
  await test.step("tells two sessions of one agent apart on the logs tab", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const agent = `ui-sessions-${id}`;
    // One agent, as every Claude Code on an OAuth grant is, in two sessions.
    for (const session of ["terminal", "conductor"]) {
      await mcpAs(
        request,
        agent,
        "list_ready",
        {},
        {
          "x-valise-session": `${session}-${id}`,
          "x-valise-session-name": `${session}-${id}`,
          "x-valise-host": "laptop",
          "x-valise-plugin": "valise/0.3.0",
        },
      );
    }

    await page.goto("/workbench?tab=logs&window=24");

    for (const session of ["terminal", "conductor"]) {
      const run = page.locator(".runs > li").filter({
        has: page.locator(".caller", { hasText: `${session}-${id}` }),
      });
      await expect(run).toHaveCount(1);
      await expect(run.locator(".via")).toContainText("laptop");
      await expect(run.locator(".badges")).toContainText("valise/0.3.0");
    }
  });
  await test.step("filters the logs tab to the calls that said why", async () => {
    const marker = `ui-intent-proof-${crypto.randomUUID().slice(0, 8)}`;
    // Every call from one agent, so exactly one run carries this marker.
    const made = await mcp(request, "create_todo", {
      title: marker,
      project: "valise",
    });
    const id = made.result.structuredContent.id as string;
    await mcpAs(request, marker, "claim_todo", { id, why: marker });
    // A call on a tool that offers no `why`, so the filter has work to do.
    await mcpAs(request, marker, "search", { query: marker });

    await page.goto("/workbench?tab=logs&window=24&intent=1");
    // The filter applies to calls, so what survives in this run carries one.
    const run = page.locator(".runs > li").filter({
      has: page.locator(".caller", { hasText: marker }),
    });
    await openRun(run);
    await expect(run.locator(".calls .why", { hasText: marker })).toBeVisible();
    // Every call the filter leaves has to carry one. Counting rows instead
    // would assert on whatever else the local database happens to hold.
    const shown = await run.locator(".calls > li").count();
    await expect(run.locator(".calls .why")).toHaveCount(shown);
    await expect(
      run.locator(".calls > li").filter({ hasText: "search" }),
    ).toHaveCount(0);

    // Unfiltered, the search call that said nothing is back in the run.
    await page.goto("/workbench?tab=logs&window=24");
    const all = page.locator(".runs > li").filter({
      has: page.locator(".caller", { hasText: marker }),
    });
    await all.locator("> details > summary").click();
    await expect(
      all.locator(".calls > li").filter({ hasText: "search" }),
    ).toHaveCount(1);
  });
});

test("follows a to-do id and a skill id from the logs pane to the item", async ({
  page,
  request,
}) => {
  const marker = `ui-item-link-${crypto.randomUUID().slice(0, 8)}`;
  const made = await mcp(request, "create_todo", {
    title: marker,
    body: `Opened from the logs pane: ${marker}`,
    project: "valise",
  });
  const todoId = made.result.structuredContent.id as string;
  // Newer rows sort above it, so landing on it takes a scroll.
  for (let index = 0; index < 8; index += 1) {
    await mcp(request, "create_todo", {
      title: `${marker} filler ${index}`,
      project: "valise",
    });
  }
  const name = `link-${marker}`;
  const published = await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: Opened from the logs pane.\n---\n\nBody.`,
  });
  const skillId = published.result.structuredContent.id as string;
  // One agent per id, so each run holds exactly the one fetch call.
  await mcpAs(request, `${marker}-todo`, "fetch", { id: todoId });
  await mcpAs(request, `${marker}-skill`, "fetch", { id: skillId });

  const follow = async (agent: string, id: string) => {
    await page.goto("/workbench?tab=logs&window=24");
    const run = page.locator(".runs > li").filter({
      has: page.locator(".caller", { hasText: agent }),
    });
    await openRun(run);
    await run.locator(".call-row").first().click();
    const pane = page.getByRole("complementary", { name: "Call details" });
    await pane.getByRole("link", { name: `"${id}"` }).click();
  };

  await signIn(page);
  await follow(`${marker}-todo`, todoId);
  await expect(page).toHaveURL(`/todos?open=${encodeURIComponent(todoId)}`);
  const card = page.locator(".todo-card", {
    has: page.getByRole("heading", { name: marker, exact: true }),
  });
  await expect(card.getByRole("dialog", { name: marker })).toBeVisible();

  await follow(`${marker}-skill`, skillId);
  await expect(page).toHaveURL(`/skills?open=${encodeURIComponent(skillId)}`);
  await expect(page.getByRole("dialog", { name })).toBeVisible();
});

test("puts the to-do a person opens in the URL, without moving the list", async ({
  page,
  request,
}) => {
  const marker = `ui-open-url-${crypto.randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  for (let index = 0; index < 3; index += 1) {
    const made = await mcp(request, "create_todo", {
      title: `${marker} ${index}`,
      project: "valise",
    });
    ids.push(made.result.structuredContent.id as string);
  }
  // The newest row, first in the list, so the click needs no scroll of its
  // own and any movement is the page's.
  const newest = ids[2];
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  const href = `/todos?q=${marker}`;
  await page.goto(href);
  const card = cardFor(page, newest);
  const top = async () => (await card.boundingBox())?.y ?? 0;
  await expect(page.locator(".todo-card").first()).toContainText(`${marker} 2`);
  const before = await top();

  await expandRow(card);
  await expect(page).toHaveURL(`${href}&open=${encodeURIComponent(newest)}`);
  // Let any reload the URL change set off land before measuring.
  await page.waitForLoadState("networkidle");
  expect(Math.abs((await top()) - before)).toBeLessThanOrEqual(1);

  // The URL is the link: a reload lands on the same to-do, open.
  await page.goto(page.url());
  await expect(card.getByRole("dialog")).toBeVisible();

  // Closing the dialog takes it back out.
  await page.keyboard.press("Escape");
  await expect(card.getByRole("dialog")).toHaveCount(0);
  await expect(page).toHaveURL(href);
});

test("opens a to-do in a pane beside a live list, and resizes it from the clasp", async ({
  page,
  request,
}) => {
  const marker = `ui-pane-${crypto.randomUUID().slice(0, 8)}`;
  const ids: string[] = [];
  for (let index = 0; index < 2; index += 1) {
    const made = await mcp(request, "create_todo", {
      title: `${marker} ${index}`,
      project: "valise",
    });
    ids.push(made.result.structuredContent.id as string);
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn(page);
  await page.evaluate("localStorage.removeItem('valise:pane-width')");
  await page.goto(`/todos?q=${marker}`);
  const [first, second] = ids.map((id) => cardFor(page, id));

  await expandRow(first);
  const pane = first.getByRole("dialog");
  // Docked on the right edge, and not modal: no backdrop, no inert page.
  expect(
    await pane.evaluate((el) =>
      (el as unknown as { matches(selector: string): boolean }).matches(
        ":modal",
      ),
    ),
  ).toBe(false);
  const docked = await pane.boundingBox();
  expect(Math.round((docked?.x ?? 0) + (docked?.width ?? 0))).toBe(1280);
  // A claim's state is drawn as well as written.
  await expect(pane.locator(".facts .lucide-released")).toBeVisible();
  await expect(pane.locator(".facts .lucide-lease")).toBeVisible();

  // The list beside it is live: the next row opens in its place.
  await second.locator(".todo-open").click();
  await expect(second.getByRole("dialog")).toBeVisible();
  await expect(first.locator("dialog")).toHaveCount(0);

  const grip = page.getByRole("separator", { name: "Resize the pane" });
  const width = async () =>
    Math.round((await second.getByRole("dialog").boundingBox())?.width ?? 0);
  const start = await width();
  const at = await grip.boundingBox();
  const y = (at?.y ?? 0) + (at?.height ?? 0) / 2;
  await page.mouse.move((at?.x ?? 0) + 7, y);
  await page.mouse.down();
  await page.mouse.move((at?.x ?? 0) - 150, y, { steps: 6 });
  await page.mouse.up();
  expect(Math.abs((await width()) - (start + 157))).toBeLessThanOrEqual(4);

  // The keyboard reaches the same bounds; the width outlives a reload.
  await grip.focus();
  await page.keyboard.press("End");
  expect(await width()).toBe(330);
  await page.reload();
  await expect(second.getByRole("dialog")).toBeVisible();
  expect(await width()).toBe(330);
  // A double click forgets it.
  await page.getByRole("separator", { name: "Resize the pane" }).dblclick();
  expect(await width()).toBe(start);
});

test("groups the log into runs and sorts them", async ({ page, request }) => {
  const id = crypto.randomUUID().slice(0, 8);
  const busy = `ui-run-busy-${id}`;
  const quiet = `ui-run-quiet-${id}`;
  // One agent that fumbles and repairs, so the badges have something real.
  await mcpAs(request, busy, "create_todo", { title: busy });
  await mcpAs(request, busy, "create_todo", { title: busy, project: "valise" });
  await mcpAs(request, busy, "search", { query: busy });
  // A second agent at the same moment must not join that run.
  await mcpAs(request, quiet, "list_ready", {});

  await page.goto("/workbench?tab=logs&window=24");

  const run = page.locator(".runs > li").filter({
    has: page.locator(".caller", { hasText: busy }),
  });
  // `> details > summary` is the run's own; every call inside has one too.
  const head = run.locator("> details > summary");
  await expect(head).toContainText("3 calls");
  await expect(run.locator(".badges")).toContainText("recovered");

  // The other agent is its own row, not folded into the first.
  await expect(page.locator(".runs > li", { hasText: quiet })).toHaveCount(1);

  // Opening a run shows the calls it rolled up, with their arguments.
  await openRun(run);
  await expect(run.locator(".calls > li")).toHaveCount(3);
  const refused = run.locator(".calls > li", { hasText: "create_todo" }).last();
  await refused.locator(".call-row").click();
  await expect(
    page.getByRole("complementary", { name: "Call details" }).locator("pre"),
  ).toContainText(busy);

  // Sorting is a different order of the same rows, not a filter.
  await page.goto("/workbench?tab=logs&window=24&sort=errors");
  await expect(
    page.locator(".runs > li").first().locator(".badges"),
  ).toContainText("not ok");
});

test("shows how often agents fetched each memory, and sorts by it", async ({
  page,
  request,
}) => {
  const marker = `ui-fetched-${crypto.randomUUID().slice(0, 8)}`;
  const save = async (title: string) => {
    const saved = await mcp(request, "save_memory", {
      type: "fact",
      title,
      body: `${marker} body`,
      tags: ["metrics"],
      project: "valise",
    });
    return saved.result.structuredContent.id as string;
  };
  const quiet = await save(`${marker} quiet`);
  const read = await save(`${marker} read`);
  await mcp(request, "fetch", { id: read });
  await mcp(request, "fetch", { id: read });
  expect(quiet).toMatch(/^memory:/);

  await page.goto(`/memories?q=${marker}`);
  const rows = page.locator("ul.memories > li").filter({ hasText: marker });
  const row = (title: string) => rows.filter({ hasText: `${marker} ${title}` });
  await expect(row("read").locator(".fetched")).toContainText("2↓");
  // A memory nobody fetched carries no count at all.
  await expect(row("quiet").locator(".fetched")).toHaveCount(0);

  await sortMemories(page, "Most fetched");
  await expect(page).toHaveURL(/[?&]sort=fetched/);
  await expect(rows.first()).toContainText("read");
  // The order survives a filter and the modal, because both carry it.
  await rows.first().locator("a.item-title").click();
  await expect(page).toHaveURL(/[?&]sort=fetched/);
  const modal = page.locator("dialog.modal[open]");
  await expect(
    modal.locator(".facts > div", { hasText: "Fetched" }).first(),
  ).toContainText("2 times in 30 days");
});

test("reorders memories by last fetch and by fetch count", async ({
  page,
  request,
}) => {
  const marker = `ui-order-${crypto.randomUUID().slice(0, 8)}`;
  const save = async (title: string) => {
    const saved = await mcp(request, "save_memory", {
      type: "fact",
      title: `${marker} ${title}`,
      body: `${marker} body`,
      tags: ["metrics"],
      project: "valise",
    });
    return saved.result.structuredContent.id as string;
  };
  // `updated_at` is whole seconds, so saves inside one second tie and fall
  // back to a random id. Space them so "newest update first" is defined.
  const spaced = async (title: string) => {
    const id = await save(title);
    await new Promise((done) => setTimeout(done, 1100));
    return id;
  };
  const busy = await spaced("busy");
  const fresh = await spaced("fresh");
  await save("quiet");
  await mcp(request, "fetch", { id: busy });
  await mcp(request, "fetch", { id: busy });
  await mcp(request, "fetch", { id: fresh });

  await page.goto(`/memories?q=${marker}`);
  const rows = page.locator("ul.memories > li").filter({ hasText: marker });
  // Newest update first: the last one saved.
  await expect(rows.first()).toContainText(`${marker} quiet`);

  await sortMemories(page, "Last fetched");
  await expect(page).toHaveURL(/[?&]sort=last-fetched/);
  await expect(rows.first()).toContainText(`${marker} fresh`);
  await expect(rows.last()).toContainText(`${marker} quiet`);
  // The menu's button names the order in force.
  await expect(
    page.getByRole("button", { name: "Sort memories" }),
  ).toContainText("Last fetched");

  await sortMemories(page, "Most fetched");
  await expect(page).toHaveURL(/[?&]sort=fetched/);
  await expect(rows.first()).toContainText(`${marker} busy`);

  await sortMemories(page, "Recently updated");
  await expect(page).not.toHaveURL(/[?&]sort=/);
  await expect(rows.first()).toContainText(`${marker} quiet`);
});

test("filters the logs on a value clicked in the pane, and drops it from its chip", async ({
  page,
  request,
}) => {
  const marker = `ui-field-${crypto.randomUUID().slice(0, 8)}`;
  const studio = `${marker}-studio`;
  const laptop = `${marker}-laptop`;
  await mcpAs(
    request,
    marker,
    "search",
    { query: "a" },
    {
      "x-valise-host": studio,
    },
  );
  await mcpAs(
    request,
    marker,
    "search",
    { query: "b" },
    {
      "x-valise-host": laptop,
    },
  );

  await page.goto("/workbench?tab=logs&window=24");
  const run = page.locator(".runs > li").filter({
    has: page.locator(".caller", { hasText: marker }),
  });
  await openRun(run);
  await expect(run.locator(".call-row")).toHaveCount(2);
  await run.locator(".call-row").first().click();
  const pane = page.getByRole("complementary", { name: "Call details" });
  const host = await pane
    .locator(".wide", { has: page.locator("dt", { hasText: /^Host$/ }) })
    .locator("dd")
    .innerText();

  // The value is the filter: the URL carries it, the list narrows to it, and
  // the pane stays on the call.
  await pane.getByRole("link", { name: host }).click();
  await expect(page).toHaveURL(new RegExp(`[?&]host=${host}(&|$)`));
  await expect(page).toHaveURL(/[?&]call=cal_/);
  const chips = page.getByRole("list", { name: "Active filters" });
  await expect(chips).toContainText(`host:${host}`);
  await openRun(run);
  await expect(run.locator(".call-row")).toHaveCount(1);
  await expect(pane).toBeVisible();

  // A second field ANDs with the first, and a reload keeps both.
  await pane.getByRole("link", { name: "search", exact: true }).click();
  await expect(page).toHaveURL(/[?&]tool=search(&|$)/);
  await page.reload();
  await expect(chips.locator(".chip")).toHaveCount(2);
  await expect(page.locator("select[name='tool']")).toHaveValue("search");

  // Each chip removes its own filter and leaves the other.
  await chips.getByRole("link", { name: "Remove host filter" }).click();
  await expect(page).not.toHaveURL(/[?&]host=/);
  await expect(chips.locator(".chip")).toHaveCount(1);
  await openRun(run);
  await expect(run.locator(".call-row")).toHaveCount(2);
});

test("opens a call in a pane beside the list, from its URL and its keys", async ({
  page,
  request,
}) => {
  const marker = `ui-pane-${crypto.randomUUID().slice(0, 8)}`;
  await mcpAs(request, marker, "search", { query: marker });
  await mcpAs(request, marker, "create_todo", {
    title: marker,
    project: "valise",
  });

  await page.goto("/workbench?tab=logs&window=24");
  const run = page.locator(".runs > li").filter({
    has: page.locator(".caller", { hasText: marker }),
  });
  await openRun(run);
  const rows = run.locator(".call-row");
  await expect(rows).toHaveCount(2);
  const pane = page.getByRole("complementary", { name: "Call details" });
  await expect(pane).toHaveCount(0);

  // Selecting a row puts it in the URL and opens it on the right.
  await rows.first().click();
  await expect(page).toHaveURL(/[?&]call=cal_/);
  await expect(rows.first()).toHaveAttribute("aria-current", "true");
  await expect(pane.locator(".call-pane-head")).toContainText("search");
  // The payload has a label like every other field.
  await expect(
    pane.locator(".call-facts dt", { hasText: "Arguments" }),
  ).toBeVisible();
  // A row names the item its call acted on; one that acted on none does not.
  await expect(rows.nth(1).locator(".target")).toHaveText(/^todo:tdo_\w{4}…$/);
  await expect(rows.first().locator(".target")).toHaveCount(0);
  const list = await page.locator(".runs").boundingBox();
  const side = await pane.boundingBox();
  expect(side?.x ?? 0).toBeGreaterThanOrEqual(
    (list?.x ?? 0) + (list?.width ?? 0),
  );
  // Docked on the window's right edge at --pane-width, min(36rem, 45vw).
  const viewport = page.viewportSize();
  expect((side?.x ?? 0) + (side?.width ?? 0)).toBeCloseTo(
    viewport?.width ?? 0,
    0,
  );
  expect(side?.width ?? 0).toBeCloseTo(
    Math.min(36 * 15, 0.45 * (viewport?.width ?? 0)),
    0,
  );

  // j and k walk the calls; each step is a history entry.
  await expect(page.locator(".logs-split[data-keys='on']")).toHaveCount(1);
  await page.keyboard.press("j");
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");
  await expect(pane.locator("pre")).toContainText(marker);
  const shared = page.url();
  await page.keyboard.press("k");
  await expect(rows.first()).toHaveAttribute("aria-current", "true");
  await page.goBack();
  await expect(page).toHaveURL(shared);
  await expect(rows.nth(1)).toHaveAttribute("aria-current", "true");

  // The URL is the share link: a fresh tab opens the same call.
  const fresh = hydrating(await page.context().newPage());
  await fresh.goto(shared);
  await expect(
    fresh.getByRole("complementary", { name: "Call details" }).locator("pre"),
  ).toContainText(marker);
  await fresh.close();

  // A filter that no longer lists the call still opens it, read by id.
  const callId = new URL(shared).searchParams.get("call");
  await page.goto(
    `/workbench?tab=logs&window=24&tool=no-such-tool&call=${callId}`,
  );
  await expect(page.getByText("No calls match those filters.")).toBeVisible();
  await expect(pane.locator("pre")).toContainText(marker);

  // Escape closes it, and so does the close link.
  await expect(page.locator(".logs-split[data-keys='on']")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(pane).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]call=/);
  await page.goto(shared);
  await pane.getByRole("link", { name: "Close" }).click();
  await expect(pane).toHaveCount(0);

  // On a phone there is no room to split, so the pane covers the list.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(shared);
  const cover = await pane.boundingBox();
  expect(cover?.width ?? 0).toBeGreaterThanOrEqual(389);
});

test("shows where to connect and which sessions called on connections", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  await mcpAs(
    request,
    `ui-connections-${id}`,
    "list_ready",
    {},
    {
      "x-valise-session": `session-${id}`,
      "x-valise-session-name": `conn-${id}`,
      "x-valise-host": "laptop",
      "x-valise-plugin": "valise/0.3.0",
    },
  );

  await page.goto("/connections");

  const connect = page.locator(".connect");
  await expect(connect.locator("> code")).toContainText("/mcp");
  await expect(connect).toContainText("/plugin install valise@valise");

  const row = page.locator("tr", { hasText: `conn-${id}` });
  await expect(row).toContainText("laptop");
  await expect(row).toContainText("valise/0.3.0");
  // Loopback calls belong to no connection, and the row says so.
  await expect(row).toContainText("local dev");
});

test("scores every case at its newest result on the evals tab", async ({
  page,
}) => {
  await page.goto("/workbench?tab=evals");
  const summary = page.locator("table.dense").first();
  await expect(summary.getByText("Primary tool")).toBeVisible();
  await expect(summary.getByText("Via skill")).toBeVisible();
  // Passed, and in no more turns than the case allows.
  await expect(summary.getByText("Within budget")).toBeVisible();
  // What a correct answer cost, which tool choice alone never says.
  await expect(summary.getByText("Turns")).toBeVisible();
  await expect(summary.getByText("Tokens")).toBeVisible();
  await expect(summary.getByText("Cost")).toBeVisible();
  await expect(summary.getByText("Said why")).toBeVisible();
  const models = await summary.locator("tr").count();
  expect(models).toBeGreaterThan(1);
  // Every body row has to be as wide as the header. A dropped cell shifts
  // every number one column left and still renders, which is how the cost
  // column once came out reading the fill rate.
  const headers = await summary.locator("tr th").count();
  for (const row of await summary.locator("tr:not(:has(th))").all()) {
    expect(await row.locator("td").count()).toBe(headers);
  }
  // One row per case in the suite, whatever the newest run sent. A focused
  // rerun of one case used to leave the matrix holding that case alone.
  const suite: { cases: { id: string }[] } = JSON.parse(
    readFileSync("evals/cases.json", "utf8"),
  );
  await expect(page.locator("table.matrix").first().locator("tr")).toHaveCount(
    suite.cases.length + 1,
  );
  await expect(page.locator("table.run-log")).toContainText("dropped");
});

test("opens a case beside the matrix, with every run that sent it", async ({
  page,
}) => {
  await page.goto("/workbench?tab=evals");
  const pane = page.locator("aside.call-pane");
  await expect(pane).toHaveCount(0);

  await page
    .locator("table.matrix tr", { hasText: "memory-preference" })
    .locator("a.cell")
    .nth(1)
    .click();

  // What is open is in the URL. P3.
  await expect(page).toHaveURL(/case=memory-preference/);
  await expect(pane).toBeVisible();
  // The prompt as the run sent it, read from the run file rather than from
  // evals/cases.json, so editing a case cannot rewrite an old score.
  await expect(pane).toContainText("Remember this for next time");
  await expect(pane).toContainText("save_memory");
  // The history names what each run tested and what became of it.
  await expect(pane.locator(".case-history > li").first()).toBeVisible();
  await expect(pane.locator(".case-history")).toContainText(/kept|dropped/);

  await pane.getByRole("link", { name: "Close" }).click();
  await expect(page).not.toHaveURL(/case=/);
  await expect(pane).toHaveCount(0);
});

test.describe("signed out", () => {
  test.use({ storageState: signedOut });

  test("loads the stylesheet and resolves the palette tokens", async ({
    page,
    request,
  }) => {
    expect((await request.get("/valise.css")).status()).toBe(200);
    await page.goto("/login");
    // --paper reaching a card's background is the whole chain in one assertion:
    // the link element rendered, the file loaded, and the token resolved.
    // The palette is still being tuned, so this checks that the tokens
    // resolve to a colour, not which colour.
    await expect(page.locator(".card").first()).toHaveCSS(
      "background-color",
      /^oklch\(/,
    );
    await expect(page.locator("html")).toHaveCSS("--primary", /^oklch\(/);
  });

  test("redirects a logged-out browser from every protected console route", async ({
    page,
  }) => {
    for (const route of [
      "/",
      "/todos",
      "/memories",
      "/skills",
      "/connections",
      "/hooks",
      "/workbench",
      "/logout",
    ]) {
      await page.goto(route);
      await expect(page).toHaveURL(/\/login\?next=/);
    }
  });
});

test("edits a to-do body in place and exposes it through MCP fetch", async ({
  page,
  request,
}) => {
  await page.goto("/todos?q=Calibrate+cross-concept+BM25+weights");
  const card = cardFor(page, "todo:tdo_seed_rank_calibration");
  // No record-wide form: the pen beside the body opens that one field. It is
  // a link, so it is reachable without a pointer once the row is open.
  await expandRow(card);
  await card.getByRole("link", { name: "Edit body" }).click();
  await card.getByLabel("Body", { exact: true }).fill("ui-todo-mcp-proof");
  await submit(page, card.getByRole("button", { name: "Save" }), "/todos");

  const fetched = await mcp(request, "fetch", {
    id: "todo:tdo_seed_rank_calibration",
  });
  expect(fetched.result.structuredContent.text).toBe("ui-todo-mcp-proof");
});

test("lists to-dos in one column, folded to a line, and opens one in a dialog", async ({
  page,
  request,
}) => {
  const short = await mcp(request, "create_todo", {
    title: `UI short row ${crypto.randomUUID()}`,
    project: "valise",
  });
  const long = await mcp(request, "create_todo", {
    title: `UI long row ${crypto.randomUUID()}`,
    project: "valise",
    body: `First line of the long one.\n\n${"A paragraph of real text. ".repeat(40)}`,
  });
  const shortId = short.result.structuredContent.id as string;
  const longId = long.result.structuredContent.id as string;

  await page.goto("/todos");
  const shortCard = cardFor(page, shortId);
  const longCard = cardFor(page, longId);
  await expect(longCard.locator(".todo-preview")).toHaveText(
    "First line of the long one.",
  );

  // One column: every row starts at the same x and spans the same width, so
  // a short to-do is not stretched to the height of a long one beside it.
  const [a, b] = [await shortCard.boundingBox(), await longCard.boundingBox()];
  expect(a?.x).toBe(b?.x);
  expect(a?.width).toBe(b?.width);
  // Folded, the long one is no taller than the short one.
  expect(Math.abs((a?.height ?? 0) - (b?.height ?? 0))).toBeLessThanOrEqual(1);

  // The first line of the body opens it too, and only that one.
  // The whole row is the door; click it where the summary is drawn.
  const summary = await longCard.locator(".todo-summary").boundingBox();
  await page.mouse.click(
    (summary?.x ?? 0) + 40,
    (summary?.y ?? 0) + (summary?.height ?? 0) / 2,
  );
  await expect(longCard.getByRole("dialog")).toContainText(
    "A paragraph of real text.",
  );
  await expect(shortCard.locator("dialog")).toHaveCount(0);
  // The list behind the dialog did not reflow.
  expect((await longCard.boundingBox())?.height).toBe(b?.height);
});

test("ticks a sub-task from the card and writes it back into the Markdown", async ({
  page,
  request,
}) => {
  const title = `UI subtask proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
    body: "Lead in.\n\n- [ ] first step\n- [ ] first step\n\n```\n- [ ] in a fence\n```",
  });
  const id = created.result.structuredContent.id as string;

  await page.goto("/todos");
  const card = cardFor(page, id);
  await expandRow(card);
  // The fenced line looks exactly like a task and must not become one.
  const boxes = card.locator(".task-box");
  await expect(boxes).toHaveCount(2);
  await expect(card.locator(".task-count")).toHaveText("0/2");

  // Two items with identical text: ticking the second must not tick the first.
  await submit(page, boxes.nth(1), "/todos");
  await expect(cardFor(page, id).locator(".task-count")).toHaveText("1/2");
  // The write revalidates the list; the to-do being worked stays open.
  await expect(cardFor(page, id).getByRole("dialog")).toBeVisible();

  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.text).toBe(
    "Lead in.\n\n- [ ] first step\n- [x] first step\n\n```\n- [ ] in a fence\n```",
  );

  // Adding one appends to the same list rather than to the end of the body.
  await cardFor(page, id).getByRole("link", { name: "Add sub-task" }).click();
  await cardFor(page, id)
    .getByLabel("Sub-task", { exact: true })
    .fill("third step");
  await submit(
    page,
    cardFor(page, id).getByRole("button", { name: "Add", exact: true }),
    "/todos",
  );
  await expect(cardFor(page, id).locator(".task-count")).toHaveText("1/3");
});

test("expands a row's sub-tasks in the list, ticks one there, and remembers it", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID();
  const created = await mcp(request, "create_todo", {
    title: `UI subtask expand ${run}`,
    project: "valise",
    body: "Lead in.\n\n- [ ] first step\n- [x] second step",
  });
  const other = await mcp(request, "create_todo", {
    title: `UI subtask expand other ${run}`,
    project: "valise",
    body: "- [ ] untouched",
  });
  const id = created.result.structuredContent.id as string;
  const otherId = other.result.structuredContent.id as string;

  await page.goto("/todos");
  const card = cardFor(page, id);
  const toggle = card.getByRole("button", { name: "Sub-tasks, 1 of 2 done" });
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(card.locator(".todo-subtasks")).toHaveCount(0);

  // The count unfolds the checklist under the row, with no dialog and no URL.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  const list = card.locator(".todo-subtasks");
  await expect(list.getByRole("checkbox")).toHaveCount(2);
  await expect(
    list.getByRole("checkbox", { name: "second step" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(card.locator("dialog")).toHaveCount(0);
  expect(new URL(page.url()).search).toBe("");

  // A tick there writes the body and paints at once; the row stays unfolded.
  await submit(
    page,
    list.getByRole("checkbox", { name: "first step" }),
    "/todos",
  );
  await expect(card.locator(".task-count")).toHaveText("2/2");
  await expect(
    list.getByRole("checkbox", { name: "first step" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(card.locator("dialog")).toHaveCount(0);
  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.text).toBe(
    "Lead in.\n\n- [x] first step\n- [x] second step",
  );

  // Unfolded survives a reload, for this row only.
  await page.reload();
  await expect(cardFor(page, id).locator(".todo-subtasks")).toBeVisible();
  await expect(cardFor(page, otherId).locator(".todo-subtasks")).toHaveCount(0);

  // The same control folds it, and folded survives a reload too.
  await cardFor(page, id)
    .getByRole("button", { name: /^Sub-tasks,/ })
    .click();
  await expect(cardFor(page, id).locator(".todo-subtasks")).toHaveCount(0);
  await page.reload();
  await expect(
    cardFor(page, id).getByRole("button", { name: /^Sub-tasks,/ }),
  ).toHaveAttribute("aria-expanded", "false");
  await expect(cardFor(page, id).locator(".todo-subtasks")).toHaveCount(0);
});

/**
 * The sub-task rows above are all short and plain, which is how a flex
 * container on `.task-list-item` survived review: flex makes every contiguous
 * text run and every inline element its own flex item, so a real sentence with
 * `code` in it laid out as side-by-side columns that each wrapped separately.
 * This asserts the row flows as one paragraph.
 */
test("flows a sub-task with inline code as one paragraph, not columns", async ({
  page,
  request,
}) => {
  const title = `UI subtask flow proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
    body: "Lead in.\n\n- [ ] `listTodos` orders by `created_at DESC` with done still last, so no mutation can change a row's position and nothing jumps.",
  });
  const id = created.result.structuredContent.id as string;

  await page.goto("/todos");
  await expandRow(cardFor(page, id));
  await cardFor(page, id).locator(".task-list-item").first().waitFor();

  // A string, not a closure, for the same reason as the hit-area test above.
  const flow = await page.evaluate<Flowed>(`(() => {
    const card = [...document.querySelectorAll(".todo-card")].find((one) =>
      one.querySelector('input[name="id"][value="${id}"]'));
    const row = card.querySelector(".task-list-item");
    const style = getComputedStyle(row);
    const box = row.getBoundingClientRect();
    const code = [...row.querySelectorAll("code")];
    return {
      display: style.display,
      lines: box.height / parseFloat(style.lineHeight),
      codeOverflow: Math.max(
        ...code.map((one) => one.getBoundingClientRect().right - box.right),
      ),
    };
  })()`);

  // Flex is the regression; the row is a block with a hanging indent.
  expect(flow.display).not.toBe("flex");
  // Shredded, this sentence took about fifteen line boxes in a card column.
  // Flowing, it takes under five. Eight is wide and still fails the regression.
  expect(flow.lines).toBeLessThan(8);
  // Every inline run stays inside the row rather than beside it.
  expect(flow.codeOverflow).toBeLessThanOrEqual(1);
});

/**
 * P4 and P5. Before: ticking a sub-task on the eighth card moved it to first
 * and the window from 1268px to 0, and completing a to-do sent it from fourth
 * to thirty-seventh. A write must not move the row it acted on, or the page.
 */
test("keeps a row and the scroll offset where they were through a write", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  for (let i = 0; i < 10; i++) {
    await mcp(request, "create_todo", {
      title: `UI stays put ${run} ${i}`,
      project: "valise",
      tags: [`stay-${run}`],
      body: "- [ ] one step\n- [ ] another step",
    });
  }
  await signIn(page);
  await page.setViewportSize({ width: 1280, height: 600 });
  await page.goto(`/todos?tag=stay-${run}`);
  // The seventh row of ten, well below the fold.
  const id =
    (await page
      .locator(".todo-card")
      .nth(6)
      .locator('input[name="id"]')
      .first()
      .getAttribute("value")) ?? "";
  const card = cardFor(page, id);
  await expandRow(card);
  await card.scrollIntoViewIfNeeded();

  // Where the row sits on screen, not window.scrollY: the first completion
  // inserts "Show done (1)" above the list, and the browser's scroll
  // anchoring raises scrollY by that height so the row stays where it was.
  const where = () =>
    page.evaluate<{ index: number; top: number }>(`(() => {
      const cards = [...document.querySelectorAll(".todo-card")];
      const index = cards.findIndex((one) =>
        one.querySelector('input[name="id"][value="${id}"]'));
      return { index, top: cards[index].getBoundingClientRect().top };
    })()`);
  const before = await where();
  expect(before.index).toBe(6);
  expect(await page.evaluate<number>("window.scrollY")).toBeGreaterThan(200);
  // Anchoring scrolls in whole pixels, so a row at 225.6px can land at 225.
  const stayed = async () => {
    const after = await where();
    expect(after.index).toBe(before.index);
    expect(Math.abs(after.top - before.top)).toBeLessThan(1);
  };

  await submit(page, card.locator(".task-box").first(), "/todos");
  await expect(card.locator(".task-count")).toHaveText("1/2");
  await stayed();
  // Closing the dialog hands focus back to the row, where it was.
  await page.keyboard.press("Escape");
  await expect(card.locator("dialog")).toHaveCount(0);
  await stayed();

  // Completing changes the row, it does not move it. The pill turns before
  // the list revalidates; the toggle arriving is the revalidation landing.
  await submit(
    page,
    card.getByRole("checkbox", { name: /^Complete:/ }),
    "/todos",
  );
  // Done rows are hidden by default, but the one just completed is held
  // where it was until the list reopens.
  await expect(card.locator(".pill")).toHaveText("done");
  const show = page.getByRole("link", { name: "Show done (1)" });
  await expect(show).toBeVisible();
  await stayed();
  await expect(card.locator(".pill")).toHaveText("done");

  // The control says how many done rows it shows, and hides them again.
  await show.click();
  await expect(page).toHaveURL(/done=show/);
  await expect(cardFor(page, id)).toHaveCount(1);
  await expect(page.locator(".todo-card")).toHaveCount(10);
  await page.getByRole("link", { name: "Hide done (1)" }).click();
  await expect(cardFor(page, id)).toHaveCount(0);
  await expect(page.locator(".todo-card")).toHaveCount(9);
});

test("completes a to-do from its checkbox over a live agent claim", async ({
  page,
  request,
}) => {
  const title = `UI complete proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  // An agent holds the lease. The console still closes the ticket.
  await mcp(request, "claim_todo", { id, ttl_seconds: 600 });

  await page.goto("/todos");
  const card = cardFor(page, id);
  await card.locator(".todo-open").click();
  const dialog = page.getByRole("dialog", { name: title });
  await expect(dialog).toBeVisible();
  const complete = dialog.getByRole("checkbox", {
    name: `Complete: ${title}`,
  });
  await expect(complete).toHaveAttribute("aria-checked", "false");
  await submit(page, complete, "/todos");

  const done = cardFor(page, id);
  await expect(done.locator(".pill")).toHaveText("done");
  await expect(
    dialog.getByRole("checkbox", { name: `Reopen: ${title}` }),
  ).toHaveAttribute("aria-checked", "true");

  // That the agent's stale token is then refused is "lets the console
  // override a live claim and fences the agent that held it" in
  // test/mcp/claiming.worker.test.ts.

  // Reopening is the same control, back the other way.
  await submit(
    page,
    dialog.getByRole("checkbox", { name: `Reopen: ${title}` }),
    "/todos",
  );
  await expect(cardFor(page, id).locator(".pill")).toHaveCount(0);
});

test("shows a blocked row's blocker folded, filters to blocked, and unblocks from the folded row", async ({
  page,
  request,
}) => {
  const title = `UI blocked proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  const claimed = await mcp(request, "claim_todo", { id, ttl_seconds: 600 });
  await mcp(request, "update_todo", {
    id,
    token: claimed.result.structuredContent.token,
    blocked_on: "PR #99 has to merge",
  });

  await signIn(page);
  // An agent's block reaches D1 through the coordinator's mirror alarm, so
  // the list can lag it by a moment (ADR-0002).
  const only = page.getByRole("link", { name: /^Only blocked \(\d+\)$/ });
  await expect(async () => {
    await page.goto("/todos");
    await expect(cardFor(page, id)).toHaveClass(/\bis-blocked\b/, {
      timeout: 500,
    });
  }).toPass();
  // A blocked row carries no state pill; its strap and line say it.
  await expect(cardFor(page, id).locator(".pill")).toHaveCount(0);
  await expect(only).toBeVisible();
  await only.click();
  await expect(page).toHaveURL(/state=blocked/);
  await expect(cardFor(page, id)).toBeVisible();
  await expect(page.locator(".todo-card:not(.is-blocked)")).toHaveCount(0);
  await expect(page.getByRole("link", { name: /done \(/ })).toHaveCount(0);

  // The tag box takes the same filter as a facet.
  await page.goto("/todos?tag=state%3Ablocked");
  await expect(cardFor(page, id)).toBeVisible();
  await expect(page.locator(".todo-card").first()).toHaveClass(
    /\bis-blocked\b/,
  );

  const card = cardFor(page, id);
  await expect(card.locator("dialog")).toHaveCount(0);
  await expect(card.getByText("Blocked on PR #99 has to merge.")).toBeVisible();
  await submit(
    page,
    card.getByRole("button", { name: `Unblock: ${title}` }),
    "/todos",
  );

  // Unblocked rows leave the blocked-only list.
  await expect(cardFor(page, id)).toHaveCount(0);
  await page.goto("/todos");
  await expect(cardFor(page, id).locator(".pill")).toHaveCount(0);
  await expect(cardFor(page, id).getByText(/^Blocked on/)).toHaveCount(0);
});

test("shows a row's update count and its status, on the row and at the top of the pane", async ({
  page,
  request,
}) => {
  const created = await mcp(request, "create_todo", {
    title: `UI last update proof ${crypto.randomUUID()}`,
    project: "valise",
  });
  const quiet = await mcp(request, "create_todo", {
    title: `UI no updates proof ${crypto.randomUUID()}`,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  const claimed = await mcp(request, "claim_todo", { id, ttl_seconds: 600 });
  await mcp(request, "update_todo", {
    id,
    token: claimed.result.structuredContent.token,
    body: "All four slices pass verify on feat/assets-finalize. The merge waits on review.",
  });

  await page.goto("/todos");
  const card = cardFor(page, id);
  await expect(card.locator(".todo-meta")).toHaveText("2 updates");
  const line = card.locator(".todo-last-update");
  await expect(line).toHaveText(
    /^Progress · just now All four slices pass verify on feat\/assets-finalize\. The merge waits on review\.$/,
  );
  // One line, inside the row, under the preview.
  const [row, last] = [
    await card.locator(".todo-summary").boundingBox(),
    await line.boundingBox(),
  ];
  expect(last?.y ?? 0).toBeGreaterThanOrEqual(
    (row?.y ?? 0) + (row?.height ?? 0) - 1,
  );
  expect(last?.height ?? 0).toBeLessThan(24);
  await expect(
    cardFor(page, quiet.result.structuredContent.id as string).locator(
      ".todo-last-update",
    ),
  ).toHaveCount(0);

  // The pane opens on the same status, first, above the body.
  await card.locator(".todo-open").click();
  const pane = page.locator("dialog[open] .todo-detail");
  await expect(pane.locator(":scope > :first-child > :first-child")).toHaveText(
    /^Progress · just now All four slices pass verify on feat\/assets-finalize\. The merge waits on review\.$/,
  );
});

for (const scripting of [true, false]) {
  test(`to-do checklist and comment preserve pane state with scripting ${scripting ? "on" : "off"}`, async ({
    page: hydratedPage,
    browser,
    request,
  }) => {
    const run = crypto.randomUUID().slice(0, 8);
    const title = `P11 pane ${run}`;
    const made = await mcp(request, "create_todo", {
      title,
      project: "valise",
      body: "- [ ] Review P11",
    });
    const id = made.result.structuredContent.id as string;
    const context = scripting
      ? null
      : await browser.newContext({ javaScriptEnabled: false });
    const page = context ? await context.newPage() : hydratedPage;
    await signIn(page, "/todos", scripting);
    const start = `/todos?q=${run}&open=${encodeURIComponent(id)}&history=oldest`;
    await page.goto(start);
    const pane = page.getByRole("dialog", { name: title });
    const checkbox = pane.getByRole("checkbox", { name: "Review P11" });
    const navigations: string[] = [];
    let release = () => {};
    let held = Promise.resolve();
    const hold = () => {
      held = new Promise<void>((resolve) => {
        release = resolve;
      });
    };
    if (scripting) {
      await page.route("**/todos.data*", async (route) => {
        if (route.request().method() === "POST") await held;
        await route.continue();
      });
      page.on("framenavigated", (frame) => {
        if (frame === page.mainFrame()) navigations.push(frame.url());
      });
      hold();
      const response = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          new URL(response.url()).pathname === "/todos.data",
      );
      await checkbox.click();
      await expect(checkbox).toHaveAttribute("aria-checked", "true");
      release();
      expect((await response).ok()).toBe(true);
    } else await checkbox.click();
    await expect(checkbox).toHaveAttribute("aria-checked", "true");
    const box = pane.getByRole("textbox", { name: `Comment on ${title}` });
    await box.fill(`Reviewed ${run}`);
    if (scripting) hold();
    await pane.getByRole("button", { name: "Comment", exact: true }).click();
    if (scripting) {
      await expect(
        pane.getByRole("button", { name: "Commenting…" }),
      ).toBeDisabled();
      release();
    }
    await expect(box).toHaveValue("");
    await expect(pane.getByRole("region", { name: "History" })).toContainText(
      `Reviewed ${run}`,
    );
    await expect(page).toHaveURL(start);
    if (scripting) {
      await box.fill("   ");
      await pane.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(pane.locator(".todo-comment [role=alert]")).toBeVisible();
      await expect(box).toHaveValue("   ");
      expect(navigations).toEqual([]);
    }
    await context?.close();
  });
}

test("answers an agent's question from the comment box, without claiming", async ({
  page,
  request,
}) => {
  const title = `UI comment proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  await mcp(request, "claim_todo", { id, ttl_seconds: 600 });
  await mcp(request, "comment_todo", { id, body: "Which branch is this on?" });

  await page.goto("/todos");
  const card = cardFor(page, id);
  await expandRow(card);
  const box = card.getByRole("textbox", { name: `Comment on ${title}` });
  await box.fill("On main, merged this morning.");
  await submit(page, card.getByRole("button", { name: "Comment" }), "/todos");
  await expect(box).toHaveValue("");

  // Order inside one second is not defined (timestamps are whole seconds);
  // test/mcp/claiming.worker.test.ts checks the order with spaced rows.
  const log = card.getByRole("region", { name: "History" }).locator("li");
  await expect(
    log.filter({ hasText: "On main, merged this morning." }),
  ).toContainText("commented");
  await expect(
    log.filter({ hasText: "Which branch is this on?" }),
  ).toContainText("playwright commented");

  // The agent still holds the lease, and reads the answer over MCP. The
  // claim reaches the row through the coordinator's mirror (ADR-0002), so
  // a fast run can read before it lands.
  await expect
    .poll(async () => {
      const fetched = await mcp(request, "fetch", { id });
      const metadata = fetched.result.structuredContent.metadata as {
        lease_holder: string;
        updates: { kind: string; body: string }[];
      };
      return {
        holder: metadata.lease_holder,
        comments: metadata.updates.filter((update) => update.kind === "comment")
          .length,
      };
    })
    .toEqual({ holder: "playwright", comments: 2 });
});

test("names an agent by its session and a short client name, not its registration url", async ({
  page,
  request,
}) => {
  const title = `UI session name proof ${crypto.randomUUID()}`;
  const session = `mcp-guides-improvements-${crypto.randomUUID().slice(0, 4)}`;
  const agent = "https://claude.ai/oauth/claude-code-client-metadata";
  const named = { "x-valise-session-name": session };
  const created = await mcpAs(
    request,
    agent,
    "create_todo",
    { title, project: "valise" },
    named,
  );
  const hit = { id: created.result.structuredContent.id as string };
  await mcpAs(
    request,
    agent,
    "comment_todo",
    { id: hit.id, body: "Session-named comment." },
    named,
  );
  // A comment from a client that sends no name falls back to the client.
  await mcpAs(request, agent, "comment_todo", {
    id: hit.id,
    body: "Nameless comment.",
  });

  await page.goto(`/todos?open=${encodeURIComponent(hit.id)}`);
  const card = cardFor(page, hit.id);
  const log = card.getByRole("region", { name: "History" }).locator("li");
  await expect(log.filter({ hasText: "Session-named comment." })).toContainText(
    `${session} · Claude Code commented`,
  );
  await expect(log.filter({ hasText: "Nameless comment." })).toContainText(
    "Claude Code commented",
  );
  await expect(card).not.toContainText("claude-code-client-metadata");
  await expect(
    card.getByText(`${session} · Claude Code`).first(),
  ).toBeVisible();
});

test("shows claims, progress, blocks and comments as one history, with when each happened", async ({
  page,
  request,
}) => {
  const title = `UI history proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  const claimed = await mcp(request, "claim_todo", { id, ttl_seconds: 600 });
  const token = claimed.result.structuredContent.token;
  await mcp(request, "update_todo", {
    id,
    token,
    body: "The 500 is D1's **50-byte** LIKE limit.",
  });
  await mcp(request, "comment_todo", { id, body: "Does instr() fix it?" });
  await mcp(request, "update_todo", {
    id,
    token,
    blocked_on: "PR #99 has to merge",
  });

  await signIn(page);
  // The block reaches D1 through the coordinator's mirror alarm (ADR-0002).
  await expect(async () => {
    await page.goto(`/todos?open=${encodeURIComponent(id)}`);
    await expect(
      cardFor(page, id).getByRole("region", { name: "History" }).locator("li"),
    ).toHaveCount(4, { timeout: 1_000 });
  }).toPass();
  const history = cardFor(page, id).getByRole("region", {
    name: "History",
    exact: true,
  });
  const entries = history.locator("li");

  // Newest first unless the person flips it. Rows inside one second tie on
  // their UUIDv7, which is write order.
  await expect(history).toContainText("Newest first");
  await expect(entries.nth(0)).toContainText("playwright blocked it");
  await expect(entries.nth(0)).toContainText("PR #99 has to merge");
  await expect(entries.nth(1)).toContainText("playwright commented");
  await expect(entries.nth(1)).toContainText("Does instr() fix it?");
  await expect(entries.nth(3)).toContainText("playwright claimed it");

  // The order is the person's to choose, and the URL remembers it (P3).
  await history.getByRole("link", { name: "Show oldest first" }).click();
  await expect(page).toHaveURL(/history=oldest/);
  await expect(history).toContainText("Oldest first");
  await expect(entries.nth(0)).toContainText("playwright claimed it");
  await expect(entries.nth(1)).toContainText("playwright posted progress");
  // An agent's progress is Markdown, like the description.
  await expect(
    entries.nth(1).locator("strong", { hasText: "50-byte" }),
  ).toBeVisible();
  await expect(entries.nth(2)).toContainText("playwright commented");
  await expect(entries.nth(3)).toContainText("playwright blocked it");
  await page.reload();
  await expect(history).toContainText("Oldest first");
  await expect(entries.nth(0)).toContainText("playwright claimed it");

  // Each entry says when, relative, with the exact UTC time on hover.
  const when = entries.nth(0).locator("time");
  await expect(when).toHaveText(/^(just now|\d+ min ago)$/);
  await expect(when).toHaveAttribute(
    "title",
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2} UTC$/,
  );
  await expect(when).toHaveAttribute("datetime", /^\d{4}-\d{2}-\d{2}T/);

  // A comment from the console joins the same history, last in this order.
  const box = cardFor(page, id).getByRole("textbox", {
    name: `Comment on ${title}`,
  });
  await box.fill("Yes, instr() has no limit.");
  await submit(
    page,
    cardFor(page, id).getByRole("button", { name: "Comment" }),
    "/todos",
  );
  await expect(entries).toHaveCount(5);
  await expect(entries.last()).toContainText("Yes, instr() has no limit.");
  await expect(entries.last().locator("time")).toHaveText("just now");
});

test("attaches a file to a to-do from its card and serves it back", async ({
  page,
  request,
  playwright,
  baseURL,
}) => {
  const title = `UI attach proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;

  await page.goto("/todos");
  const card = cardFor(page, id);
  await expandRow(card);
  await card.getByRole("link", { name: "Add files" }).click();
  const dialog = page.getByRole("dialog", { name: "Add files" });
  await pick(
    page,
    dialog.getByLabel("Choose a file"),
    {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("attached from playwright"),
    },
    "/todos",
  );
  await expect(dialog).toBeHidden();

  const link = card.getByRole("link", { name: "notes.txt" });
  await expect(link).toBeVisible();
  await expect(card.locator(".todo-meta")).toContainText("1 file");

  // The link is the console session's: it downloads, and a stranger gets 401.
  const href = (await link.getAttribute("href")) ?? "";
  const served = await page.request.get(href);
  expect(served.status()).toBe(200);
  expect(served.headers()["content-disposition"]).toBe(
    "attachment; filename*=UTF-8''notes.txt",
  );
  expect(await served.text()).toBe("attached from playwright");
  const visitor = await playwright.request.newContext({
    baseURL,
    storageState: signedOut,
  });
  const stranger = await visitor.get(href, { maxRedirects: 0 });
  expect(stranger.status()).not.toBe(200);
  await visitor.dispose();

  // A click previews the file in a modal instead of downloading it, and
  // Escape puts the person back in the same open to-do.
  await link.click();
  const preview = page.getByRole("dialog", { name: "notes.txt" });
  await expect(preview).toBeVisible();
  await expect(preview.locator("pre")).toHaveText("attached from playwright");
  await expect(preview.getByRole("link", { name: "Download" })).toHaveAttribute(
    "href",
    href,
  );
  await page.keyboard.press("Escape");
  await expect(preview).toHaveCount(0);
  await expect(page).toHaveURL(`/todos?open=${encodeURIComponent(id)}`);
  await expect(card.locator("dialog").first()).toBeVisible();
  await submit(
    page,
    card.getByRole("button", { name: "Remove file notes.txt", exact: true }),
    "/todos",
  );
  await expect(
    card.getByRole("button", { name: "Restore file notes.txt", exact: true }),
  ).toBeVisible();
  await expect(card.locator(".todo-meta")).not.toContainText("1 file");
  expect((await page.request.get(href)).status()).toBe(200);
  await submit(
    page,
    card.getByRole("button", { name: "Restore file notes.txt", exact: true }),
    "/todos",
  );
  await expect(
    card.getByRole("button", { name: "Remove file notes.txt", exact: true }),
  ).toBeVisible();
  await expect(card.locator(".todo-meta")).toContainText("1 file");
});

test("attaches a memory file in its modal and opens its owned bytes", async ({
  page,
  request,
}) => {
  const title = `Memory file ${crypto.randomUUID()}`;
  const saved = await mcp(request, "save_memory", {
    type: "fact",
    title,
    body: "Diagram evidence.",
    tags: ["attachment"],
  });
  const id = saved.result.structuredContent.id as string;
  await page.goto(`/memories?open=${encodeURIComponent(id)}`);
  const modal = page.getByRole("dialog", { name: title });
  await modal.getByRole("link", { name: "Add files" }).click();
  const adding = page.getByRole("dialog", { name: "Add files" });
  await pick(
    page,
    adding.getByLabel("Choose a file"),
    {
      name: "evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("memory evidence"),
    },
    "/memories",
  );
  await expect(adding).toBeHidden();
  const link = modal.getByRole("link", { name: "evidence.txt" });
  await expect(link).toBeVisible();
  const href = (await link.getAttribute("href")) ?? "";
  const served = await page.request.get(href);
  expect(served.status()).toBe(200);
  expect(await served.text()).toBe("memory evidence");
  await link.click();
  await expect(
    page.getByRole("dialog", { name: "evidence.txt" }).locator("pre"),
  ).toHaveText("memory evidence");
  await page.keyboard.press("Escape");
  await page.reload();
  await expect(modal.getByRole("link", { name: "evidence.txt" })).toBeVisible();
  await submit(
    page,
    modal.getByRole("button", {
      name: "Remove file evidence.txt",
      exact: true,
    }),
    "/memories",
  );
  await expect(
    modal.getByRole("button", {
      name: "Restore file evidence.txt",
      exact: true,
    }),
  ).toBeVisible();
  await submit(
    page,
    modal.getByRole("button", {
      name: "Restore file evidence.txt",
      exact: true,
    }),
    "/memories",
  );
  await expect(
    modal.getByRole("button", {
      name: "Remove file evidence.txt",
      exact: true,
    }),
  ).toBeVisible();
});

test("removes and restores a file on its own row with scripting off", async ({
  browser,
  request,
}) => {
  const created = await mcp(request, "create_todo", {
    title: `No script file ${crypto.randomUUID()}`,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  try {
    await page.goto("/todos");
    await page.goto(`/todos?open=${encodeURIComponent(id)}`);
    const card = cardFor(page, id);
    await card.getByRole("link", { name: "Add files" }).click();
    const dialog = page.getByRole("dialog", { name: "Add files" });
    await dialog.getByLabel("Choose a file").setInputFiles({
      name: "plain.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("keep bytes"),
    });
    await dialog.getByRole("button", { name: "Attach", exact: true }).click();
    await expect(card.getByRole("link", { name: "plain.txt" })).toBeVisible();
    await card
      .getByRole("button", { name: "Remove file plain.txt", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: "Restore file plain.txt", exact: true }),
    ).toBeVisible();
    await card
      .getByRole("button", { name: "Restore file plain.txt", exact: true })
      .click();
    await expect(
      card.getByRole("button", { name: "Remove file plain.txt", exact: true }),
    ).toBeVisible();
  } finally {
    await context.close();
  }
});

test("previews an attached image and PDF in a modal that a backdrop click closes", async ({
  page,
  request,
}) => {
  const title = `UI preview proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;

  await page.goto("/todos");
  const card = cardFor(page, id);
  await expandRow(card);
  // A 1x1 PNG, and the smallest PDF a viewer will open.
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const pdf = Buffer.from(
    "%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  );
  for (const file of [
    { name: "shot.png", mimeType: "image/png", buffer: png },
    { name: "spec.pdf", mimeType: "application/pdf", buffer: pdf },
  ]) {
    await card.getByRole("link", { name: "Add files" }).click();
    const dialog = page.getByRole("dialog", { name: "Add files" });
    await pick(page, dialog.getByLabel("Choose a file"), file, "/todos");
    await expect(card.getByRole("link", { name: file.name })).toBeVisible();
  }

  await card.getByRole("link", { name: "shot.png" }).click();
  const image = page.getByRole("dialog", { name: "shot.png" });
  const img = image.getByRole("img", { name: "shot.png" });
  await expect(img).toBeVisible();
  await expect
    .poll(() =>
      img.evaluate((node) => (node as { naturalWidth?: number }).naturalWidth),
    )
    .toBe(1);
  // A click outside the dialog's box lands on its backdrop, and shuts the
  // preview only: the to-do it was opened from stays open.
  await page.mouse.click(4, 4);
  await expect(image).toHaveCount(0);
  await expect(page).toHaveURL(`/todos?open=${encodeURIComponent(id)}`);
  await expect(card.locator("dialog").first()).toBeVisible();

  await card.getByRole("link", { name: "spec.pdf" }).click();
  const doc = page.getByRole("dialog", { name: "spec.pdf" });
  // `/files/` sends a PDF as an attachment, so the frame is the bytes
  // retyped in a blob URL, never the download URL itself.
  await expect(doc.locator("iframe")).toHaveAttribute("src", /^blob:/);
  await doc.getByRole("button", { name: "Close" }).click();
  await expect(doc).toHaveCount(0);
});

test("attaches files dropped on a to-do, and shows dropped images inline in the description and comments", async ({
  page,
  request,
}) => {
  const title = `UI drop proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;

  await page.goto("/todos");
  const card = cardFor(page, id);
  await expandRow(card);
  const dialog = card.locator("dialog");
  const files = dialog.locator(".attachments");

  // Anywhere on the dialog: the file attaches and nothing else changes.
  await posted(page, () =>
    dropFiles(dialog.locator(".facts"), [
      { name: "notes.txt", type: "text/plain", base64: btoa("dropped") },
    ]),
  );
  await expect(files.getByRole("link", { name: "notes.txt" })).toBeVisible();

  // Into the description editor: attached, and linked at the caret.
  await dialog.getByRole("link", { name: "Add a description" }).click();
  const body = dialog.getByRole("textbox", { name: "Body", exact: true });
  await body.fill("The broken state:");
  await posted(page, () =>
    dropFiles(body, [{ name: "shot.png", type: "image/png", base64: PIXEL }]),
  );
  await expect(body).toHaveValue(
    /^The broken state:\n!\[shot\.png\]\(\/files\/[^)]+\)\n$/,
  );
  await expect(files.getByRole("link", { name: "shot.png" })).toBeVisible();
  await posted(page, () => body.press("ControlOrMeta+Enter"));
  const shown = dialog.locator(".todo-body img[alt='shot.png']");
  await expect(shown).toBeVisible();
  // It is the stored file, served back to the session, not a broken image.
  await expect
    .poll(() =>
      shown.evaluate(
        (img) => (img as unknown as { naturalWidth: number }).naturalWidth,
      ),
    )
    .toBe(1);

  // Into the comment box: the comment carries the image, and the log shows it.
  const box = dialog.getByRole("textbox", { name: `Comment on ${title}` });
  await box.fill("Still happens after the fix:");
  await posted(page, () =>
    dropFiles(box, [{ name: "again.png", type: "image/png", base64: PIXEL }]),
  );
  await expect(box).toHaveValue(/!\[again\.png\]\(\/files\/[^)]+\)/);
  await submit(page, dialog.getByRole("button", { name: "Comment" }), "/todos");
  await expect(
    dialog
      .getByRole("region", { name: "History" })
      .getByRole("img", { name: "again.png" }),
  ).toBeVisible();
  await expect(card.locator(".todo-meta")).toContainText("3 files");
});

test("shows a to-do's body, pointers, and origin, and adds a pointer through its modal", async ({
  page,
  request,
}) => {
  const title = `UI pointer proof ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
    body: "**Done when** the sweep reads the new path.",
    refs: [
      { kind: "repo", value: "getvalise/valise" },
      { kind: "file", value: "app/search/pulsar.ts" },
    ],
  });
  const id = created.result.structuredContent.id as string;

  await page.goto("/todos");
  const card = cardFor(page, id);
  // Folded, the row names what opening it shows.
  await expect(card.locator(".todo-summary")).toContainText("2 pointers");
  await expandRow(card);
  // Markdown, not its source: the bold run is an element on the page.
  await expect(card.locator("strong", { hasText: "Done when" })).toBeVisible();
  await expect(card.locator(".refs li")).toHaveCount(2);
  await expect(card.locator(".refs")).toContainText("app/search/pulsar.ts");
  // The origin: which agent, with the client it came through on hover.
  await expect(card.locator('[title="playwright · console-test"]')).toHaveText(
    "playwright",
  );

  // A kind and a value are two fields, so "Add pointer" opens a centred
  // modal, as state once hydrated (P3, P15). The kind offers the five
  // create_todo teaches, with what each means.
  const modal = page.getByRole("dialog", { name: "Add a pointer" });
  const add = async (kind: string | null, value: string) => {
    await card.getByRole("link", { name: "Add pointer" }).click();
    await expect(modal).toBeVisible();
    expect(page.url()).not.toContain("edit=");
    const kinds = modal.getByRole("combobox", { name: "Pointer kind" });
    await expect(kinds).toBeFocused();
    if (kind) {
      await kinds.fill(kind.slice(0, 1));
      await expect(
        modal.getByRole("option", { name: new RegExp(`^${kind}`) }),
      ).toContainText("the spec, plan, or ADR");
      await modal.getByRole("option", { name: new RegExp(`^${kind}`) }).click();
    }
    await modal.getByLabel("Pointer", { exact: true }).fill(value);
    await submit(
      page,
      modal.getByRole("button", { name: "Add pointer", exact: true }),
      "/todos",
    );
    await expect(modal).toHaveCount(0);
  };
  await add("doc", "ADR-0009");
  await expect(card.locator(".refs li")).toHaveCount(3);
  await settle(page, () =>
    card
      .getByRole("button", { name: "Remove pointer app/search/pulsar.ts" })
      .click(),
  );
  // A bare link needs no kind; the server infers it.
  await add(null, "https://example.com/brief");
  await expect(card.locator(".refs li")).toHaveCount(3);

  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.metadata).toMatchObject({
    refs: [
      { kind: "repo", value: "getvalise/valise" },
      { kind: "doc", value: "ADR-0009" },
      { kind: "url", value: "https://example.com/brief" },
    ],
  });

  // The project editor offers the projects already written. P9.
  const offered = `offered-${crypto.randomUUID().slice(0, 8)}`;
  await mcp(request, "create_todo", {
    title: `Project vocabulary ${offered}`,
    project: offered,
  });
  await page.goto(`/todos?q=${encodeURIComponent(title)}`);
  await expandRow(card);
  await card.getByRole("link", { name: "Edit project" }).click();
  await card
    .getByRole("combobox", { name: "Project" })
    .fill(offered.slice(0, -2));
  await card.getByRole("option", { name: offered, exact: true }).click();
  await submit(page, card.getByRole("button", { name: "Save" }), "/todos");
  const moved = await mcp(request, "fetch", { id });
  expect(moved.result.structuredContent.metadata).toMatchObject({
    project: offered,
  });
});

test("removes pointers from the dialog and returns focus to the set", async ({
  page,
  request,
}) => {
  const title = `UI pointer remove ${crypto.randomUUID()}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
    refs: [
      { kind: "file", value: "app/search/write.ts" },
      { kind: "doc", value: "docs/adr/0001-data-model.md" },
    ],
  });
  const id = created.result.structuredContent.id as string;

  await page.goto(
    `/todos?q=${encodeURIComponent(title)}&open=${encodeURIComponent(id)}`,
  );
  const dialog = cardFor(page, id).locator("dialog");
  await expect(dialog).toBeVisible();

  await settle(page, () =>
    dialog
      .getByRole("button", { name: "Remove pointer app/search/write.ts" })
      .click(),
  );
  await expect(dialog.getByRole("link", { name: "Add pointer" })).toBeFocused();

  await settle(page, () =>
    dialog
      .getByRole("button", {
        name: "Remove pointer docs/adr/0001-data-model.md",
      })
      .click(),
  );
  await expect(dialog.getByRole("link", { name: "Add pointer" })).toBeFocused();
  await expect(dialog.locator(".refs")).toHaveCount(0);
  const fetched = await mcp(request, "fetch", { id });
  // `fetch` leaves an empty list out rather than sending it (ADR-0003, #382).
  expect(fetched.result.structuredContent.metadata).not.toHaveProperty("refs");
});

/**
 * P6. Before: opening the title editor grew the first card 65px and pushed
 * the document 64px; tags 64px, body 89px, pointers 103px.
 */
test("opens every pen without moving the row or anything below it", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const edited = await mcp(request, "create_todo", {
    title: `UI pen proof ${run}`,
    project: "valise",
    tags: [`pen-${run}`, "console"],
    body: "One line of context.\n\n- [ ] a step",
    refs: [{ kind: "file", value: "app/components/editable.tsx" }],
  });
  const id = edited.result.structuredContent.id as string;
  await signIn(page);

  for (const [pen, label] of [
    ["Edit title", "Title"],
    ["Edit body", "Body"],
    ["Edit project", "Project"],
  ] as const) {
    await page.goto(`/todos?tag=pen-${run}`);
    const card = cardFor(page, id);
    // Tags and pointers carry their own × and + on the row, so every field
    // left here opens in the to-do's dialog, where what is below is the
    // comment box rather than the next row.
    await expandRow(card);
    const scope = card.locator("dialog");
    // The comment box, not its button, which shows only once the box is in
    // use.
    const below = scope.getByRole("textbox", { name: /^Comment on / });
    const measure = async () => ({
      card: (await scope.boundingBox())?.height ?? 0,
      // Document and dialog-body coordinates: focusing the field may scroll
      // it into view, which is the browser's move, not a reflow.
      below:
        ((await below.boundingBox())?.y ?? 0) +
        (await page.evaluate<number>(
          `window.scrollY + (document.querySelector("dialog .modal-body")?.scrollTop ?? 0)`,
        )),
    });
    const before = await measure();
    await scope.getByRole("link", { name: pen }).click();
    const field = scope.getByLabel(label, { exact: true }).first();
    await expect(field).toBeFocused();
    const after = await measure();
    expect(
      Math.abs(after.card - before.card),
      `${pen} changes the row's height`,
    ).toBeLessThanOrEqual(1);
    expect(
      Math.abs(after.below - before.below),
      `${pen} moves the row below`,
    ).toBeLessThanOrEqual(1);
  }
});

test("tells pointer kinds apart by colour, without the status chip", async ({
  page,
  request,
}) => {
  const kinds = ["repo", "file", "doc", "issue", "url"];
  const created = await mcp(request, "create_todo", {
    title: `UI ref kinds ${crypto.randomUUID().slice(0, 8)}`,
    project: "valise",
    refs: kinds.map((kind) => ({
      kind,
      value: kind === "url" ? "https://example.com" : `${kind}-value`,
    })),
  });
  const id = created.result.structuredContent.id as string;

  await page.goto("/todos");
  await expandRow(cardFor(page, id));
  const labels = cardFor(page, id).locator(".refs .ref-kind");
  await expect(labels).toHaveCount(kinds.length);
  // A string, not a closure: this repo compiles without the DOM lib.
  const styles = await page.evaluate<{ color: string; chip: string }[]>(`(() =>
    [...[...document.querySelectorAll(".todo-card")].find((card) =>
      card.querySelector('input[name="id"][value="${id}"]')).querySelectorAll(".ref-kind")].map((one) => ({
      color: getComputedStyle(one).color,
      chip: getComputedStyle(one, "::before").content,
    })))()`);
  // Five kinds, five colours, and no square in front of any of them.
  expect(new Set(styles.map((style) => style.color)).size).toBe(kinds.length);
  for (const style of styles) expect(style.chip).toBe("none");
});

/**
 * P8. "Add a pointer" used to be a muted label beside a pen that only a
 * hovering mouse could see. Now the phrase is the control.
 */
test("makes every empty value the control that fills it", async ({
  page,
  request,
}) => {
  // Short: D1 refuses a LIKE pattern over 50 bytes, and the search is one.
  const title = `UI empty ${crypto.randomUUID().slice(0, 8)}`;
  const created = await mcp(request, "create_todo", {
    title,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;

  await page.goto(`/todos?q=${encodeURIComponent(title)}`);
  const card = cardFor(page, id);
  // "Add tags" is on the row; the others are in the to-do's dialog. Every
  // add line in the pane has one shape and one indent (P15).
  for (const name of [
    "Add tags",
    "Add a description",
    "Add sub-task",
    "Add pointer",
    "Add relation",
  ]) {
    if (name !== "Add tags") await expandRow(card);
    const control = card.getByRole("link", { name, exact: true });
    await expect(control).toBeVisible();
    // Visible without hover, and a 24px target, under a fine pointer.
    await expect(control).toHaveCSS("opacity", "1");
    expect((await control.boundingBox())?.height).toBeGreaterThanOrEqual(24);
  }
  // A string, not a closure: this repo compiles without the DOM lib.
  const lines = await page.evaluate<string[]>(`[...document.querySelectorAll(
    "dialog.modal-pane .add-value")].map((link) => {
      const box = link.getBoundingClientRect();
      const style = getComputedStyle(link);
      return [Math.round(box.left), Math.round(box.height), style.fontSize,
        style.borderStyle].join(" ");
    })`);
  expect(lines.length).toBeGreaterThanOrEqual(4);
  expect(new Set(lines).size).toBe(1);
  // No pen beside an empty value: the phrase is the only door, and enough.
  await expect(card.getByRole("link", { name: "Edit pointers" })).toHaveCount(
    0,
  );
  await expect(card.locator(".refs")).toHaveCount(0);
});

test("hides the pen only where a pointer can hover, and keeps every hit area at 24px", async ({
  browser,
}) => {
  // Two contexts rather than two viewports: the question is the pointer, not
  // the width, and a narrow desktop window still reports a fine one.
  for (const [pointer, options, expected] of [
    ["fine", { viewport: { width: 1280, height: 900 } }, "0"],
    ["coarse", { ...devices["Pixel 7"] }, "1"],
  ] as const) {
    const context = await browser.newContext(options);
    const page = hydrating(await context.newPage());
    await page.goto("/todos?q=Calibrate");
    await expandRow(page.locator(".todo-card").first());
    // The click that opened the dialog leaves the pointer over its title,
    // and showModal() focuses the first control in it, the title's pen. The
    // question is the pen with nothing hovering it and nothing focused.
    await page.mouse.move(0, 0);
    await page.evaluate("document.activeElement?.blur()");
    await expect(page.locator(".todo-title .pen")).toHaveCSS(
      "opacity",
      expected,
    );

    // A string, not a closure: this repo compiles without the DOM lib, so
    // the page's own globals do not typecheck inside one.
    const measured = await page.evaluate<Measured>(`(() => {
      const hit = (selector) => {
        const element = document.querySelector(selector);
        const box = element.getBoundingClientRect();
        const after = getComputedStyle(element, "::after");
        // The circle and the task box carry their hit area on ::after; the
        // pen is its own box.
        return after.width === "auto"
          ? [box.width, box.height]
          : [parseFloat(after.width), parseFloat(after.height)];
      };
      return {
        pen: getComputedStyle(document.querySelector(".todo-title .pen")).opacity,
        areas: [".todo-title .pen", ".check-circle", ".task-box"].map(hit),
      };
    })()`);

    expect(measured.pen, `pen opacity under a ${pointer} pointer`).toBe(
      expected,
    );
    // SC 2.5.8 is 24 CSS px, and this stylesheet's root font size is not 16.
    for (const [width, height] of measured.areas) {
      expect(width).toBeGreaterThanOrEqual(24);
      expect(height).toBeGreaterThanOrEqual(24);
    }
    await context.close();
  }
});

/**
 * D1 caps a LIKE pattern at 50 bytes, and the lists used to wrap the term in
 * two wildcards, so a 49-character term 500ed every list. A pasted title is
 * that long, so the boundary is tested directly rather than with a short term.
 */
/**
 * Clear was `href="."`, which on /memories resolves to /, so clearing a
 * filter left the list for the homepage.
 */
test("clears the filters and stays on the same list", async ({ page }) => {
  await signIn(page);
  for (const path of ["/todos", "/memories", "/skills"]) {
    await page.goto(`${path}?q=duckdb&tag=nothing`);
    const toolbar = page.locator(".list-toolbar");
    await expect(toolbar.locator('button[data-facet="tag"]')).toContainText(
      "nothing",
    );
    await toolbar.getByRole("link", { name: "Reset" }).click();
    await expect(page).toHaveURL((url) => url.pathname === path && !url.search);
    await expect(
      toolbar.getByRole("searchbox", { name: "Search" }),
    ).toHaveValue("");
    await expect(toolbar.locator('button[data-facet="tag"]')).toHaveText("Tag");
  }
});

/**
 * A tag chip is a client-side navigation, so the toolbar stays mounted. It
 * has to show the tag the URL now filters by, and the next search has to
 * keep it rather than drop it.
 */
test("shows a clicked tag in the Tag filter, and the next search keeps it", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const tag = `chip${run}`;
  for (const [title, tags] of [
    [`Chip filter ${run} tagged`, [tag]],
    [`Chip filter ${run} other`, [`other${run}`]],
  ] as const) {
    await mcp(request, "save_memory", {
      type: "fact",
      title,
      body: "A memory for the tag chip filter case.",
      tags,
      project: "valise",
    });
  }

  await page.goto(`/memories?q=${encodeURIComponent(`Chip filter ${run}`)}`);
  await expect(page.getByRole("link", { name: /^Chip filter / })).toHaveCount(
    2,
  );
  await page.getByRole("link", { name: tag, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
  const toolbar = page.locator(".list-toolbar");
  // The Tag filter names the tag, and the search box keeps its text.
  await expect(toolbar.locator('button[data-facet="tag"]')).toContainText(tag);
  const search = toolbar.getByRole("searchbox", { name: "Search" });
  await expect(search).toHaveValue(`Chip filter ${run}`);

  // The next search submits the tag with it.
  await search.press("Enter");
  await expect(page).toHaveURL(/[?&]q=Chip/);
  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
  await expect(page.getByRole("link", { name: /^Chip filter / })).toHaveCount(
    1,
  );
});

test("applies a filter as soon as a suggestion is picked", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  for (const [title, tags] of [
    [`Pick filter ${run} first`, [`pickone${run}`]],
    [`Pick filter ${run} second`, [`picktwo${run}`]],
  ] as const) {
    await mcp(request, "save_memory", {
      type: "fact",
      title,
      body: "A memory for the pick-to-filter case.",
      tags,
      project: "valise",
    });
  }
  const rows = page.getByRole("link", { name: /^Pick filter / });

  await page.goto(`/memories?q=${encodeURIComponent(`Pick filter ${run}`)}`);
  await expect(rows).toHaveCount(2);

  // A click on a suggestion is the whole request; no Filter press.
  const facet = page.locator('.list-toolbar button[data-facet="tag"]');
  const input = page.locator("[cmdk-input]");
  const open = async () => {
    if (!(await input.isVisible())) await facet.click();
    await expect(input).toBeVisible();
  };
  await open();
  await input.fill(`pickone${run}`);
  await page.getByRole("option", { name: `pickone${run}` }).click();
  await expect(page).toHaveURL(new RegExp(`tag=pickone${run}`));
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("link", { name: /first$/ })).toBeVisible();
  await expect(facet).toContainText(`pickone${run}`);

  // So is Enter on a suggestion.
  await open();
  await input.fill(`picktwo${run}`);
  await expect(
    page.getByRole("option", { name: `picktwo${run}` }),
  ).toBeVisible();
  await input.press("Enter");
  // A second tag narrows: a row has to carry both, and none does.
  await expect(page).toHaveURL(
    new RegExp(`tag=pickone${run}&tag=picktwo${run}`),
  );
  await expect(rows).toHaveCount(0);

  // Picking a chosen tag again drops it.
  await open();
  await input.fill(`picktwo${run}`);
  await page.getByRole("option", { name: `picktwo${run}` }).click();
  await expect(page).not.toHaveURL(new RegExp(`tag=picktwo${run}`));
  await expect(page).toHaveURL(new RegExp(`tag=pickone${run}`));
  await expect(rows).toHaveCount(1);
  await expect(page.getByRole("link", { name: /first$/ })).toBeVisible();

  // Clear filter is a navigation to the list without any tag.
  await open();
  await input.fill("");
  await page.getByRole("option", { name: "Clear filter" }).click();
  await expect(page).not.toHaveURL(/tag=/);
  await expect(rows).toHaveCount(2);
});

test("edits a memory in place and keeps the text it replaced", async ({
  page,
  request,
}) => {
  const title = `UI memory edit proof ${crypto.randomUUID()}`;
  await mcp(request, "save_memory", {
    type: "preference",
    title,
    body: "The first wording of the claim.",
    tags: ["ui"],
    project: "valise",
  });

  await page.goto("/memories");
  await page.getByRole("link", { name: title }).click();
  const modal = page.locator("dialog.modal[open]");
  await expect(modal).toBeVisible();
  // Opening a memory is a URL, so the dialog survives a reload.
  await expect(page).toHaveURL(/[?&]open=memory%3A/);

  await modal.getByRole("link", { name: "Edit body" }).click();
  await modal.getByLabel("Body", { exact: true }).fill("The second wording.");
  await submit(page, modal.getByRole("button", { name: "Save" }), "/memories");

  const reopened = page.locator("dialog.modal[open]");
  await expect(reopened.locator(".prose")).toContainText("The second wording.");
  // The edit wrote a revision, and the revision holds the text it replaced.
  // History is one line in the pane, a link to a table of versions (P14).
  const line = reopened.getByRole("link", { name: /^2 saved versions · / });
  await expect(line).toBeVisible();
  await line.click();
  await expect(page).toHaveURL(/[?&]edit=memory%3A[^&]+\.history/);
  const history = page.getByRole("dialog", { name: `History of ${title}` });
  await expect(history.getByRole("row")).toHaveCount(3);
  await expect(history.getByRole("row").nth(1)).toContainText("v2current");
  await expect(history.getByRole("row").nth(1)).toContainText("Body");
  await expect(history.getByRole("row").nth(2)).toContainText("First version");
  await history.getByRole("button", { name: "v1", exact: true }).click();
  const v1 = history.getByRole("region", { name: "v1 as saved" });
  await expect(v1).toContainText("The first wording of the claim.");
  await expect(v1.locator("pre")).toHaveCount(0);
  // The open table is the URL's, so it survives a reload.
  await page.reload();
  await expect(history).toBeVisible();
  await history.getByRole("button", { name: "Close" }).click();
  await expect(page).not.toHaveURL(/edit=/);
  await expect(page).toHaveURL(/[?&]open=memory%3A/);

  // What an agent reads is the new wording, not the archived one.
  const searched = await mcp(request, "search", { query: "second wording" });
  expect(
    (searched.result.structuredContent.results as { title: string }[]).map(
      (hit) => hit.title,
    ),
  ).toContain(title);
});

test("archives a memory from its modal and drops it from the list", async ({
  page,
  request,
}) => {
  const title = `UI archive proof ${crypto.randomUUID()}`;
  const marker = `ui-memory-archive-proof-${crypto.randomUUID()}`;
  const saved = await mcp(request, "save_memory", {
    type: "reference",
    title,
    body: `Pointer: **${marker}**`,
    tags: ["ui"],
    project: "valise",
  });
  expect(saved.result.structuredContent.id).toEqual(expect.any(String));

  await page.goto("/memories");
  await page.getByRole("link", { name: title }).click();
  const modal = page.locator("dialog.modal");
  await expect(modal).toBeVisible();
  // The body is Markdown and renders as markup: the bold run is an element,
  // not a pair of asterisks.
  await expect(modal.locator(".prose strong")).toHaveText(marker);
  await submit(
    page,
    modal.getByRole("button", { name: "Archive memory" }),
    "/memories",
  );

  // Archiving removes the search projection: "archives a memory
  // idempotently and removes its projection" in test/d1/schema.worker.test.ts.
  await expect(page.getByRole("link", { name: title })).toHaveCount(0);
});

test("archive paints pending and keeps the filtered URL without navigating", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const saved = await mcp(request, "save_memory", {
    type: "reference",
    title: `Archive pending ${run}`,
    body: "Archive in place.",
    project: "valise",
    tags: [run],
  });
  const start = `/memories?tag=${run}&open=${encodeURIComponent(saved.result.structuredContent.id as string)}`;
  await page.goto(start);
  const modal = page.locator("dialog.modal[open]");
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/memories.data*", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await modal.getByRole("button", { name: "Archive memory" }).click();
  await expect(
    modal.getByRole("button", { name: "Archiving…" }),
  ).toBeDisabled();
  release();
  await expect(modal).toHaveCount(0);
  await expect(page).toHaveURL(start);
  expect(navigations).toEqual([]);
  await expect(
    page.getByRole("link", { name: `Archive pending ${run}` }),
  ).toHaveCount(0);
});

test("bulk changes paint pending and keep the acted-on skill in place", async ({
  page,
  request,
}) => {
  const name = `ui-p11-${crypto.randomUUID().slice(0, 8)}`;
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: In-place bulk change.\n---\n\nBody.`,
  });
  await page.goto(`/skills?q=${name}`);
  const row = skillRow(page, name);
  await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  const bar = page.locator("#skill-changes");
  await expect(bar).toBeVisible();
  const top = (await row.boundingBox())?.y ?? 0;
  const url = page.url();
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/skills.data*", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  await bar.getByRole("button", { name: "Disable", exact: true }).click();
  await expect(bar).toContainText("Saving…");
  await expect(
    bar.getByRole("button", { name: "Disable", exact: true }),
  ).toBeDisabled();
  release();
  await expect(page.getByRole("status")).toHaveText(`Disabled ${name}.`);
  // The change clears the ticks it acted on, and the bar with them.
  await expect(bar).toHaveCount(0);
  await expect(enabledSwitch(page, name)).toHaveAttribute(
    "aria-checked",
    "false",
  );
  await expect(page).toHaveURL(url);
  expect(navigations).toEqual([]);
  expect(
    Math.abs(((await row.boundingBox())?.y ?? 0) - top),
  ).toBeLessThanOrEqual(1);
  // Leave the shared store as enabled, and exercise the reverse operation.
  await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  await submit(
    page,
    bar.getByRole("button", { name: "Enable", exact: true }),
    "/skills",
  );
  await expect(enabledSwitch(page, name)).toHaveAttribute(
    "aria-checked",
    "true",
  );
});

test("SKILL.md review and archive keep ordinary document submissions with scripting off", async ({
  browser,
  request,
}) => {
  const name = `ui-p11-noscript-${crypto.randomUUID().slice(0, 8)}`;
  const body = `---\nname: ${name}\ndescription: Document form proof.\n---\n\nOriginal.`;
  await mcp(request, "publish_skill", { body });
  const saved = await mcp(request, "save_memory", {
    type: "reference",
    title: name,
    body: "Archive without scripts.",
    tags: ["ui"],
    project: "valise",
  });
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/skills");
  await page.goto(`/skills?q=${name}&open=${name}&edit=${name}.body`);
  const modal = page.getByRole("dialog", { name });
  const field = modal.getByRole("textbox", { name: "SKILL.md", exact: true });
  await field.fill(body.replace("Original.", "Document edited."));
  await modal.getByRole("button", { name: "Review changes" }).click();
  await expect(modal.locator(".diff .add")).toContainText("Document edited.");
  await modal.getByRole("button", { name: "Publish version 2" }).click();
  await expect(page).toHaveURL(`/skills?q=${name}&open=${name}`);
  await expect(modal.locator(".skill-version-body")).toContainText(
    "Document edited.",
  );
  await page.goto(
    `/memories?q=${name}&open=${encodeURIComponent(saved.result.structuredContent.id as string)}`,
  );
  await page.getByRole("button", { name: "Archive memory" }).click();
  await expect(page).toHaveURL(`/memories?q=${name}`);
  await expect(page.getByRole("link", { name })).toHaveCount(0);
  await context.close();
});

test("adds a written skill through the preview, and MCP serves it as the head", async ({
  page,
  request,
}) => {
  const name = `ui-console-skill-${crypto.randomUUID().slice(0, 8)}`;
  await page.goto("/skills");
  await page.getByRole("link", { name: "Add skill" }).first().click();
  const dialog = page.getByRole("dialog", { name: "Add skill" });
  await dialog.getByRole("link", { name: "Write SKILL.md" }).click();
  await expect(page).toHaveURL("/skills?add=write");
  const field = dialog.getByLabel("SKILL.md");
  // The write route starts from a template with its frontmatter filled in.
  await expect(field).toHaveValue(/^---\nname: my-skill\ndescription: /);

  // A frontmatter error shows in the preview, beside the text that has it.
  await field.fill("# No frontmatter");
  await submit(
    page,
    dialog.getByRole("button", { name: "Preview" }),
    "/skills",
  );
  await expect(dialog.getByRole("alert")).toContainText(
    "must start with YAML frontmatter",
  );
  await expect(dialog.getByRole("button", { name: "Add skill" })).toHaveCount(
    0,
  );

  const body = `---\nname: ${name}\ndescription: Verify the console publishes a skill head.\n---\n\nThe UI skill head marker.`;
  await field.fill(body);
  await submit(
    page,
    dialog.getByRole("button", { name: "Preview" }),
    "/skills",
  );
  await expect(dialog.locator(".facts")).toContainText(name);
  await submit(
    page,
    dialog.getByRole("button", { name: "Add skill" }),
    "/skills",
  );
  await expect(page).toHaveURL(`/skills?open=${name}`);

  const skill = await mcp(request, "get_skill", { name });
  expect(skill.result.structuredContent.body).toBe(body);

  // The same name again is a new version, and the preview says so with a diff.
  await page.goto("/skills?add=write");
  await field.fill(body.replace("head marker.", "second marker."));
  await submit(
    page,
    dialog.getByRole("button", { name: "Preview" }),
    "/skills",
  );
  await expect(dialog.locator(".warn")).toContainText(`${name} already exists`);
  await expect(dialog.locator(".diff .add")).toHaveText(
    "+ The UI skill second marker.",
  );
  await submit(
    page,
    dialog.getByRole("button", { name: "Publish version 2" }),
    "/skills",
  );
  const second = await mcp(request, "get_skill", { name });
  expect(second.result.structuredContent.version).toBe(2);
});

test("opens a skill's bundle, versions, and the doors that reached it", async ({
  page,
  request,
}) => {
  const name = `ui-bundle-skill-${crypto.randomUUID().slice(0, 8)}`;
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: A skill with a nested bundle.\nlicense: MIT\n---\n\n# First version\n\nA **first** release.`,
    project: "valise",
    files: [
      { path: "references/checklist.md", content: "# Checklist\n" },
      { path: "references/examples/good.md", content: "Good.\n" },
      { path: "scripts/collect.sh", content: "#!/bin/sh\n" },
    ],
  });
  // A second version with a smaller bundle. Each version carries its own
  // manifest, so switching version has to switch the tree as well as the body.
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: A skill with a nested bundle.\nlicense: Apache-2.0\n---\n\n# Second version\n\nA **second** release.`,
    files: [{ path: "scripts/collect.sh", content: "#!/bin/sh\n" }],
  });
  // One call at each door, so each counter has a different number.
  await mcp(request, `skill_${name}`, {});
  await mcp(request, `skill_${name}`, {});
  await mcp(request, "get_skill", { name });

  await page.goto(`/skills?q=${name}`);
  const row = skillRow(page, name);
  // The row's version carries the door counts in its title.
  await expect(row.locator(".item-meta [title^='v2;']")).toHaveAttribute(
    "title",
    /calls in thirty days: 2 as its tool, 1 via get_skill,/,
  );

  await row.locator("a.item-title").click();
  // The page carries two dialogs, the detail and the publish form, so this
  // has to name the one it means.
  const modal = page.getByRole("dialog", { name });
  await expect(modal).toBeVisible();

  // The head first: one script beside SKILL.md.
  const frontmatter = modal.getByRole("table", {
    name: "SKILL.md frontmatter",
  });
  await expect(frontmatter.locator("tr", { hasText: "license" })).toContainText(
    "Apache-2.0",
  );
  await expect(modal.locator(".prose h1")).toHaveText("Second version");
  await expect(modal.locator(".prose strong")).toHaveText("second");
  await expect(modal.locator(".file-tree .file")).toHaveCount(2);

  // v1 swaps both the body and the bundle, and its bundle nests: `examples`
  // is a folder inside a folder, not a path with a slash in it.
  await modal.getByRole("button", { name: "v1", exact: true }).click();
  await expect(frontmatter.locator("tr", { hasText: "license" })).toContainText(
    "MIT",
  );
  await expect(modal.locator(".prose h1")).toHaveText("First version");
  await expect(modal.locator(".prose strong")).toHaveText("first");
  await expect(modal.locator(".file-tree .folder > span")).toContainText([
    "references",
    "examples",
    "scripts",
  ]);
  await expect(modal.locator(".file-tree .file")).toHaveCount(4);
});

test("edits a skill's SKILL.md from its dialog, reviewing the diff before publishing", async ({
  page,
  request,
}) => {
  const name = `ui-edit-skill-${crypto.randomUUID().slice(0, 8)}`;
  const head = `---\nname: ${name}\ndescription: A skill to edit.\n---\n\nThe old line.`;
  await mcp(request, "publish_skill", {
    body: head,
    files: [{ path: "scripts/run.sh", content: "#!/bin/sh\n" }],
  });

  await page.goto(`/skills?open=${name}`);
  const modal = page.getByRole("dialog", { name });
  await modal.getByRole("link", { name: "Edit SKILL.md" }).click();
  await expect(page).toHaveURL(`/skills?open=${name}&edit=${name}.body`);

  const field = modal.getByRole("textbox", { name: "SKILL.md", exact: true });
  await expect(field).toHaveValue(head);
  const navigations: string[] = [];
  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) navigations.push(frame.url());
  });
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/skills.data*", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });

  // A rename is refused in the dialog, not published as a second skill.
  await field.fill(head.replace(`name: ${name}`, `name: ${name}-renamed`));
  await modal.getByRole("button", { name: "Review changes" }).click();
  await expect(
    modal.getByRole("button", { name: "Reviewing…" }),
  ).toBeDisabled();
  release();
  await expect(modal.getByRole("alert")).toContainText(`keeps name: ${name}`);
  await expect(field).toHaveValue(
    head.replace(`name: ${name}`, `name: ${name}-renamed`),
  );

  await field.fill(head.replace("The old line.", "The new line."));
  await submit(
    page,
    modal.getByRole("button", { name: "Review changes" }),
    "/skills",
  );
  await expect(modal.locator(".diff .del")).toHaveText("- The old line.");
  await expect(modal.locator(".diff .add")).toHaveText("+ The new line.");

  await submit(
    page,
    modal.getByRole("button", { name: "Publish version 2" }),
    "/skills",
  );
  await expect(page).toHaveURL(`/skills?open=${name}&edit=${name}.body`);
  await expect(modal.getByRole("status")).toContainText("Published version 2.");
  expect(navigations).toEqual([]);
  await modal.getByRole("link", { name: "Back to skill" }).click();
  await expect(page).toHaveURL(`/skills?open=${name}`);
  await expect(modal.locator(".skill-version-body .prose")).toContainText(
    "The new line.",
  );

  const served = await mcp(request, "get_skill", { name });
  expect(served.result.structuredContent).toMatchObject({
    version: 2,
    files: [expect.objectContaining({ path: "scripts/run.sh" })],
  });
});

/**
 * A long name used to overflow its box and paint over the cells beside it.
 * A skill's title truncates to one line, so the check is that the title's
 * box ends before the row's facts start, and that its text either fits that
 * box or is clipped to it rather than spilling. A memory's title wraps and
 * its facts sit on their own line below it, so there the facts start under
 * the title and the whole title shows. `test/ui/memory-list.spec.ts`.
 */
test("keeps a long name inside its row on skills and memories", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const name = `ui-wrap-${id}-${"a-much-longer-skill-name".repeat(3)}`;
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: A name long enough to wrap.\n---\n\nBody.`,
  });
  const title = `UI wrap proof ${id} ${"with a title long enough to need more than one line ".repeat(2)}`;
  await mcp(request, "save_memory", {
    type: "fact",
    title,
    body: "Wrapping.",
    tags: ["ui"],
    project: "valise",
  });

  await signIn(page);
  for (const path of ["/skills", "/memories"]) {
    await page.goto(`${path}?q=${id}`);
    await expect(page.locator("a.item-title", { hasText: id })).toBeVisible();
    // A string, not a closure: this repo compiles without the DOM lib.
    const { titleRight, titleBottom, metaLeft, metaTop, contained } =
      await page.evaluate<{
        titleRight: number;
        titleBottom: number;
        metaLeft: number;
        metaTop: number;
        contained: boolean;
      }>(`(() => {
      const title = [...document.querySelectorAll("a.item-title")].find(
        (link) => link.textContent.includes(${JSON.stringify(id)}),
      );
      const meta = title.closest(".item-row").querySelector(".item-meta");
      return {
        titleRight: title.getBoundingClientRect().right,
        titleBottom: title.getBoundingClientRect().bottom,
        metaLeft: meta.getBoundingClientRect().left,
        metaTop: meta.getBoundingClientRect().top,
        contained:
          title.scrollWidth <= title.clientWidth ||
          getComputedStyle(title).overflow === "hidden",
      };
    })()`);
    expect(contained, path).toBe(true);
    if (path === "/memories")
      expect(metaTop, path).toBeGreaterThanOrEqual(titleBottom);
    else expect(titleRight, path).toBeLessThanOrEqual(metaLeft);
  }
});

test("suggests curated skills with the owner's reason, each opening its preview", async ({
  page,
}) => {
  await page.goto("/skills");
  // The list carries no suggestions of its own; they belong to adding one.
  await expect(
    page.getByRole("region", { name: "Suggested skills" }),
  ).toHaveCount(0);
  await page.getByRole("link", { name: "Add skill", exact: true }).click();
  await expect(page).toHaveURL(/[?&]add=search/);
  const dialog = page.getByRole("dialog", { name: "Add skill" });
  const suggested = dialog.getByRole("region", { name: "Suggested skills" });
  await expect(suggested.getByText("Suggested")).toBeVisible();
  const row = suggested.locator("li", { hasText: "find-skills" });
  await expect(row.locator(".prose")).toContainText("skills.sh");
  // J8 acceptance, 2026-10-29: a member read the curator's to-do note.
  await expect(suggested).not.toContainText("Placeholder");
  await expect(row.getByRole("link", { name: "find-skills" })).toHaveAttribute(
    "href",
    "/skills?add=search&find=find-skills&preview=vercel-labs%2Fskills%2Ffind-skills",
  );
  await expect(
    suggested
      .locator("li", { hasText: "conversation-history" })
      .getByRole("link", { name: "conversation-history" }),
  ).toHaveAttribute("href", /add=url&url=https%3A%2F%2Fgithub\.com/);
});

test("answers a pasted URL it cannot read with a message, not a 500", async ({
  page,
}) => {
  await page.goto("/skills?add=url");
  const dialog = page.getByRole("dialog", { name: "Add skill" });
  const field = dialog.getByRole("textbox", {
    name: "GitHub or skills.sh URL",
  });
  await field.fill("https://example.com/not/a/skill");
  await dialog.getByRole("button", { name: "Open" }).click();
  await expect(page).toHaveURL(/add=url&url=https/);
  await expect(dialog.getByRole("alert")).toContainText(
    "is not a GitHub file, folder or repository",
  );
});

test("offers the registry panel and calls nobody until asked", async ({
  page,
}) => {
  await signIn(page);
  const upstream: string[] = [];
  // The search runs in the Worker, so this watches what the page itself does
  // and asserts the panel costs no call before a query is typed.
  page.on("request", (request) => {
    if (!request.url().startsWith("http://localhost")) {
      upstream.push(request.url());
    }
  });

  await page.goto("/skills?add=search");
  await expect(
    page.getByRole("searchbox", { name: "Find a skill on skills.sh" }),
  ).toBeVisible();
  // The same curated picks are available beside search, without an upstream call.
  const dialog = page.getByRole("dialog", { name: "Add skill" });
  const suggested = dialog.getByRole("region", { name: "Suggested skills" });
  await expect(suggested.getByText("Suggested", { exact: true })).toBeVisible();
  await expect(
    suggested.getByRole("link", { name: "find-skills", exact: true }),
  ).toHaveAttribute(
    "href",
    "/skills?add=search&find=find-skills&preview=vercel-labs%2Fskills%2Ffind-skills",
  );
  await expect(
    suggested.getByRole("link", { name: "conversation-history", exact: true }),
  ).toHaveAttribute("href", /add=url&url=https%3A%2F%2Fgithub\.com/);
  expect(upstream).toEqual([]);
});

test("edits hook text field by field and serves it to a config:read token", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  await page.goto("/connections");
  await page.getByLabel("Label").fill(`UI hooks ${run}`);
  await page.getByLabel("config:read").check();
  await submit(
    page,
    page.getByRole("button", { name: "Create token" }),
    "/connections",
  );
  const token = (await page.locator(".token-reveal code").textContent()) ?? "";
  const served = async () => {
    const response = await request.get("/config/hooks", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status()).toBe(200);
    return response.json();
  };

  await page.goto("/hooks");
  await page.getByRole("link", { name: "Edit recall reminder text" }).click();
  await page
    .getByRole("textbox", { name: "Recall reminder text" })
    .fill(`Search first ${run}.`);
  await submit(page, page.getByRole("button", { name: "Save" }), "/hooks");
  await expect(
    page.locator(".todo-card").getByText(`Search first ${run}.`),
  ).toBeVisible();

  // P8: the empty slot under each event is the control that adds one.
  await page.getByRole("link", { name: "Add a Stop entry" }).click();
  await page
    .getByRole("textbox", { name: "New Stop text" })
    .fill(`Tag priority ${run}.`);
  await submit(page, page.getByRole("button", { name: "Save" }), "/hooks");
  const custom = page
    .locator(".todo-card")
    .filter({ hasText: `Tag priority ${run}.` });
  await expect(custom).toBeVisible();
  const name = (await custom.locator("h3").textContent())?.trim() ?? "";
  expect(name).toMatch(/^Custom entry \d+$/);

  await submit(
    page,
    page.getByRole("switch", { name: "Capture nudge enabled" }),
    "/hooks",
  );
  await expect(
    page.getByRole("switch", { name: "Capture nudge enabled" }),
  ).not.toBeChecked();

  // The same token reads the startup brief the hook caches beside the config.
  const brief = await request.get("/config/brief", {
    headers: { authorization: `Bearer ${token}` },
  });
  expect(brief.status()).toBe(200);
  expect(brief.headers()["content-type"]).toContain("text/plain");

  const document = await served();
  expect(document["recall-reminder"].text).toBe(`Search first ${run}.`);
  expect(document["capture-nudge"].enabled).toBe(false);
  expect(document.custom).toContainEqual({
    event: "Stop",
    text: `Tag priority ${run}.`,
  });

  // A refused edit names the hook script's own rule and stores nothing.
  await page.getByRole("link", { name: "Edit recall reminder text" }).click();
  await page
    .getByRole("textbox", { name: "Recall reminder text" })
    .fill("x".repeat(2001));
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByRole("alert")).toContainText("at most 2000");

  // Put the shared fixture back for whichever test reads it next.
  await page.goto("/hooks");
  await submit(
    page,
    page.getByRole("button", { name: `Remove ${name}` }),
    "/hooks",
  );
  await submit(
    page,
    page.getByRole("button", { name: "Use the shipped text" }),
    "/hooks",
  );
  await submit(
    page,
    page.getByRole("switch", { name: "Capture nudge enabled" }),
    "/hooks",
  );
  const restored = await served();
  expect(restored["recall-reminder"]).toBeUndefined();
  expect(restored["capture-nudge"]).toBeUndefined();
});

test("revokes a bearer token and the next authenticated MCP call fails", async ({
  page,
  request,
}) => {
  const label = `UI revoke proof ${crypto.randomUUID()}`;
  await page.goto("/connections");
  await page.getByLabel("Label").fill(label);
  await page.getByLabel("search:read").check();
  await submit(
    page,
    page.getByRole("button", { name: "Create token" }),
    "/connections",
  );
  const token = await page.locator(".token-reveal code").textContent();
  expect(token).toMatch(/^vls_/);
  const before = await authenticatedMcp(request, token ?? "", "search", {
    query: "duckdb",
  });
  expect(before.status()).toBe(200);

  const tokenCard = page.locator(".todo-card").filter({
    hasText: label,
  });
  await submit(
    page,
    tokenCard.getByRole("button", { name: "Revoke token" }),
    "/connections",
  );
  const after = await authenticatedMcp(request, token ?? "", "search", {
    query: "duckdb",
  });
  expect(after.status()).toBe(401);
});

/**
 * The APG row that gets missed: Left, Right, Home and End move the caret and
 * take visual focus back to the textbox. They never walk the list.
 */
test("disables, deletes and restores ticked skills from the list", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const names = [`ui-bulk-a-${run}`, `ui-bulk-b-${run}`];
  for (const name of names) {
    await mcp(request, "publish_skill", {
      body: `---\nname: ${name}\ndescription: Bulk change subject.\n---\n\nBody.`,
    });
  }
  const rowOf = (name: string) => skillRow(page, name);

  await page.goto(`/skills?q=${run}`);
  const bar = page.locator("#skill-changes");
  // Nothing ticked, nothing to do: the bar waits for a tick.
  await expect(
    page.getByRole("checkbox", { name: `Select ${names[0]}` }),
  ).toBeVisible();
  await expect(bar).toHaveCount(0);
  for (const name of names) {
    await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  }
  await expect(bar).toContainText("2 selected");
  await submit(page, bar.getByRole("button", { name: "Disable" }), "/skills");

  await expect(page.getByRole("status")).toHaveText(
    `Disabled ${names.join(", ")}.`,
  );
  for (const name of names) {
    await expect(enabledSwitch(page, name)).toHaveAttribute(
      "aria-checked",
      "false",
    );
  }
  // The ticks cleared with the change they made, and the bar with them.
  await expect(bar).toHaveCount(0);
  const denied = await mcp(request, "get_skill", { name: names[0] });
  expect((denied.result as { isError?: boolean }).isError).toBe(true);

  // Deleted rows leave the list for a named place, one click away. P5.
  await page.getByRole("checkbox", { name: `Select ${names[0]}` }).check();
  await submit(page, bar.getByRole("button", { name: "Delete" }), "/skills");
  await expect(rowOf(names[0])).toHaveCount(0);
  await expect(rowOf(names[1])).toHaveCount(1);
  await page.getByRole("link", { name: /^Show deleted \(\d+\)$/ }).click();
  await expect(page).toHaveURL(`/skills?q=${run}&deleted=show`);
  await expect(
    rowOf(names[0]).locator(".pill", { hasText: "deleted" }),
  ).toBeVisible();

  // Restore is the same bar, and the skill comes back as it was: still off.
  await page.getByRole("checkbox", { name: `Select ${names[0]}` }).check();
  await submit(page, bar.getByRole("button", { name: "Restore" }), "/skills");
  await expect(rowOf(names[0]).locator(".pill")).toHaveCount(0);
  await expect(enabledSwitch(page, names[0])).toHaveAttribute(
    "aria-checked",
    "false",
  );

  // Select-all ticks every row shown, and no more.
  await page.goto(`/skills?q=${run}`);
  await page
    .getByRole("checkbox", { name: "Select every skill shown" })
    .check();
  await expect(bar).toContainText("2 selected");
  await submit(page, bar.getByRole("button", { name: "Delete" }), "/skills");
  await expect(page.getByRole("status")).toHaveText(
    `Deleted ${names.join(", ")}.`,
  );
});

test("refuses auto-update for a skill written here, and says why", async ({
  page,
  request,
}) => {
  const name = `ui-auto-${crypto.randomUUID().slice(0, 8)}`;
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: Written here.\n---\n\nBody.`,
  });
  await page.goto(`/skills?q=${name}`);
  const bar = page.locator("#skill-changes");
  await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  await submit(
    page,
    bar.getByRole("button", { name: "Auto-update on" }),
    "/skills",
  );
  await expect(page.getByRole("status")).toHaveText(
    `Skipped ${name}: written here or built in, so there is no upstream to follow.`,
  );
  await expect(skillRow(page, name)).toHaveCount(1);
  await expect(skillRow(page, name).locator(".pill")).toHaveCount(0);

  // Update on a skill with no upstream finds nothing, and says so.
  await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  await submit(
    page,
    bar.getByRole("button", { name: "Update", exact: true }),
    "/skills",
  );
  await expect(page.getByRole("status")).toHaveText(
    "No updates for the selected skills.",
  );
});

test("changes ticked skills with scripting off", async ({
  browser,
  request,
}) => {
  const name = `ui-bulk-noscript-${crypto.randomUUID().slice(0, 8)}`;
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: No-script subject.\n---\n\nBody.`,
  });
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/skills");
  await expect(page.getByRole("heading", { name: "Skills" })).toBeVisible();
  await page.goto(`/skills?q=${name}`);

  const row = skillRow(page, name);
  await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  await page
    .locator("#skill-changes")
    .getByRole("button", { name: "Disable" })
    .click();
  await expect(page.getByRole("status")).toHaveText(`Disabled ${name}.`);
  await expect(enabledSwitch(page, name)).toHaveAttribute(
    "aria-checked",
    "false",
  );

  await page.getByRole("checkbox", { name: `Select ${name}` }).check();
  await page
    .locator("#skill-changes")
    .getByRole("button", { name: "Delete" })
    .click();
  await expect(row).toHaveCount(0);
  await context.close();
});

test("toggles a skill off and the MCP surface stops serving it", async ({
  page,
  request,
}) => {
  await page.goto("/skills");
  await page.getByRole("link", { name: "capture-this", exact: true }).click();
  // The page holds a second, closed dialog for the publish form.
  const modal = page.locator("dialog.modal[open]");
  await expect(modal).toBeVisible();
  await submit(
    page,
    modal.getByRole("switch", { name: "Skill enabled" }),
    "/skills",
  );

  // The console still shows the row, switched off, which is how it comes back.
  const row = skillRow(page, "capture-this");
  await expect(row).toHaveCount(1);
  const listed = enabledSwitch(page, "capture-this");
  await expect(listed).toHaveAttribute("aria-checked", "false");
  const denied = await mcp(request, "get_skill", { name: "capture-this" });
  expect((denied.result as { isError?: boolean }).isError).toBe(true);

  // The modal stays open across the action, showing the state it changed.
  await expect(modal.getByText("No agent sees this skill")).toBeVisible();
  await submit(
    page,
    modal.getByRole("switch", { name: "Skill enabled" }),
    "/skills",
  );
  await expect(listed).toHaveAttribute("aria-checked", "true");
  const served = await mcp(request, "get_skill", { name: "capture-this" });
  expect(served.result.structuredContent.name).toBe("capture-this");
});

type Measured = { pen: string; areas: [number, number][] };
type Flowed = { display: string; lines: number; codeOverflow: number };

/** A skill's row in the list, found by its title link. */
function skillRow(page: Page, name: string): Locator {
  return page.locator("ul.skill-list > li.item-row", {
    has: page.locator("a.item-title", { hasText: new RegExp(`^${name}$`) }),
  });
}

/** The row's enabled switch; its state is the skill's on or off. */
function enabledSwitch(page: Page, name: string): Locator {
  return page.getByRole("switch", { name: `${name} enabled` });
}

/** Picks a memory order from the toolbar's sort menu. */
async function sortMemories(page: Page, order: string): Promise<void> {
  await page.getByRole("button", { name: "Sort memories" }).click();
  await page.getByRole("menuitem", { name: order }).click();
}

/** Opens a to-do's dialog, the way a reader does, by a click on its title. */
async function expandRow(card: Locator): Promise<void> {
  const dialog = card.locator("dialog");
  if ((await dialog.count()) === 0) await card.locator(".todo-open").click();
  await expect(dialog).toBeVisible();
}

/** The card for one to-do, found by the id its own forms post. */
/**
 * P7: a set gets add and remove, one item at a time and without a pencil.
 * The same chip row on all three routes, so one helper drives it: remove by
 * its named button, add through the `+`, each change posting on its own,
 * and a typed tag nobody has used yet is created rather than refused. The
 * publish form keeps the whole-set editor, because there the set is one
 * field of a form that has no write of its own yet.
 */
test("adds and removes a tag from the chip row on to-dos, memories and skills", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const fresh = `fresh-${id}`;

  async function swapTags(scope: Locator, remove: string) {
    await settle(page, () =>
      scope.getByRole("button", { name: `Remove ${remove}` }).click(),
    );
    await expect(
      scope.getByRole("button", { name: `Remove ${remove}` }),
    ).toHaveCount(0);
    // The remove took its own button away; focus lands on the add control,
    // the `+` or the box if it is already open, not on the body.
    await expect(scope.locator(".chip-new :focus")).toHaveCount(1);
    const add = scope.getByRole("link", { name: "Add tag" });
    if (await add.isVisible()) await add.click();
    const box = scope.getByRole("combobox", { name: "Add tag" });
    await expect(box).toBeFocused();
    await box.fill(fresh);
    // Create-on-miss: what was typed is the first option.
    await expect(scope.getByRole("option").first()).toHaveText(
      new RegExp(fresh),
    );
    // Enter picks, and the pick posts the set on its own. No Save: there is
    // no editor open to save.
    await settle(page, () => page.keyboard.press("Enter"));
    await expect(
      scope.getByRole("button", { name: `Remove ${fresh}` }),
    ).toBeVisible();
    // The box is empty again and still has the caret, for the next tag.
    await expect(box).toHaveValue("");
    await expect(box).toBeFocused();
  }

  // To-dos: the row, no pen and no Save.
  const todo = await mcp(request, "create_todo", {
    title: `UI tag proof ${id}`,
    project: "valise",
    tags: ["ui", "stale"],
  });
  const todoId = todo.result.structuredContent.id as string;
  await page.goto("/todos");
  const card = cardFor(page, todoId);
  await swapTags(card, "stale");
  const fetchedTodo = await mcp(request, "fetch", { id: todoId });
  expect(fetchedTodo.result.structuredContent.metadata).toMatchObject({
    tags: ["ui", fresh],
  });

  // Memories.
  const title = `UI tag proof ${id}`;
  const memory = await mcp(request, "save_memory", {
    type: "fact",
    title,
    body: "Tags are a set.",
    project: "valise",
    tags: ["ui", "stale"],
  });
  const memoryId = memory.result.structuredContent.id as string;
  await page.goto("/memories");
  await page.getByRole("link", { name: title }).click();
  const modal = page.locator("dialog.modal[open]");
  await swapTags(modal, "stale");
  const fetchedMemory = await mcp(request, "fetch", { id: memoryId });
  expect(fetchedMemory.result.structuredContent.metadata).toMatchObject({
    tags: ["ui", fresh],
  });

  // Skills: the Add skill preview has no tags to start from, so add one
  // first. Its editor posts the set with the publish, not per chip.
  const name = `ui-tag-skill-${id}`;
  await page.goto("/skills?add=write");
  const publish = page.getByRole("dialog", { name: "Add skill" });
  await publish
    .getByLabel("SKILL.md")
    .fill(`---\nname: ${name}\ndescription: Tags as a set.\n---\n\nBody.`);
  await submit(
    page,
    publish.getByRole("button", { name: "Preview" }),
    "/skills",
  );
  await publish.getByRole("button", { name: "Add tag" }).click();
  await publish.getByRole("combobox", { name: "Add tag" }).fill(fresh);
  await page.keyboard.press("Enter");
  await submit(
    page,
    publish.getByRole("button", { name: "Add skill" }),
    "/skills",
  );
  const skill = await mcp(request, "get_skill", { name });
  expect(skill.result.structuredContent.tags).toEqual([fresh]);
});

test("edits a skill's tags and project from its dialog without a new version", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const name = `ui-label-skill-${id}`;
  const kept = `kept-${id}`;
  await mcp(request, "publish_skill", {
    body: `---\nname: ${name}\ndescription: Labels without a version.\n---\n\nBody.`,
    tags: ["ui", "stale"],
  });

  await page.goto(`/skills?open=${name}`);
  const modal = page.getByRole("dialog", { name });
  // Each change posts on its own, so the URL keeps the dialog and never
  // gains an editor, and there is no Save to close it with.
  await expect(page).toHaveURL(`/skills?open=${name}`);
  await settle(page, () =>
    modal.getByRole("button", { name: "Remove stale" }).click(),
  );
  await modal.getByRole("link", { name: "Add tag" }).click();
  await modal.getByRole("combobox", { name: "Add tag" }).fill(kept);
  await settle(page, () => page.keyboard.press("Enter"));

  await modal.getByRole("link", { name: "Add a project" }).click();
  await modal.getByRole("combobox", { name: "Project" }).fill(`proj-${id}`);
  await submit(page, modal.getByRole("button", { name: "Save" }), "/skills");

  const served = await mcp(request, "get_skill", { name });
  expect(served.result.structuredContent).toMatchObject({
    version: 1,
    tags: ["ui", kept],
    project: `proj-${id}`,
  });

  // The list row carries the same chips, and each one is its filter.
  await page.goto(`/skills?q=${name}`);
  const row = skillRow(page, name);
  await expect(row.locator(".tags a.tag")).toHaveText(["ui", kept]);
  await expect(row.locator(".project-chip")).toHaveText(`proj-${id}`);
  await row.getByRole("link", { name: kept }).click();
  await expect(page).toHaveURL(`/skills?q=${name}&tag=${kept}`);
  await expect(page.locator("ul.skill-list > li.item-row")).toHaveCount(1);
});

test("shows a memory's tags as filter chips in the modal, as in the list", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const tagged = `UI modal chips ${run}`;
  await mcp(request, "save_memory", {
    type: "fact",
    title: tagged,
    body: "Tags are chips.",
    tags: [`chip${run}`, "ui"],
  });

  await page.goto("/memories");
  const row = page.locator("ul.memories > li.item-row", {
    has: page.locator("a.item-title", { hasText: tagged }),
  });
  await expect(row.locator(".item-meta .tags a.tag")).toHaveText([
    `chip${run}`,
    "ui",
  ]);
  await row.locator("a.item-title").click();
  const modal = page.locator("dialog.modal[open]");
  // The same chips as the row, not a comma-separated string.
  await expect(modal.locator(".tagset .chip-link")).toHaveText([
    `chip${run}`,
    "ui",
  ]);
  await modal.getByRole("link", { name: `chip${run}`, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`tag=chip${run}`));
  await expect(page.locator("dialog.modal[open]")).toHaveCount(0);
  await expect(page.locator("ul.memories > li.item-row")).toHaveCount(1);
});

/**
 * A project is one per item, so it must not read as one more tag: it carries
 * a folder and no box, where a tag is a mono word in a hairline box.
 */
test("draws the project chip in a different shape from the tag chips", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const made = await mcp(request, "create_todo", {
    title: `Project chip shape ${run}`,
    project: `proj${run}`,
    tags: ["ui", `tag${run}`],
  });
  const todoId = made.result.structuredContent.id as string;
  await mcp(request, "save_memory", {
    type: "fact",
    title: `Project chip shape ${run}`,
    body: "Project versus tags.",
    project: `proj${run}`,
    tags: ["ui", `tag${run}`],
  });

  const shape = async (chip: Locator) => ({
    // A folder icon is part of the project label; a tag's close icon belongs
    // to its nested remove button, not to the chip's shape.
    icon: (await chip.locator(":scope > svg").count()) > 0,
    ...(await chip.evaluate((node) => {
      // Named here, because this suite compiles without the DOM lib.
      const { getComputedStyle } = globalThis as unknown as {
        getComputedStyle(element: unknown): {
          borderTopWidth: string;
          fontFamily: string;
        };
      };
      const style = getComputedStyle(node);
      return { border: style.borderTopWidth, font: style.fontFamily };
    })),
  });

  await signIn(page);
  for (const [path, scope] of [
    [`/todos?project=proj${run}`, cardFor(page, todoId)],
    [
      `/memories?project=proj${run}`,
      page.locator("ul.memories > li.item-row").first(),
    ],
  ] as const) {
    await page.goto(path);
    const project = scope.locator(".project-chip");
    const tag = path.startsWith("/todos")
      ? scope.locator(".tagset .chip").first()
      : scope.locator("a.tag").first();
    await expect(project).toHaveText(`proj${run}`);
    const projectShape = await shape(project);
    const tagShape = await shape(tag);
    expect(projectShape.icon).toBe(true);
    expect(tagShape.icon).toBe(false);
    expect(projectShape.border).toBe("0px");
    expect(tagShape.border).toBe("1px");
    expect(projectShape.font).not.toBe(tagShape.font);
  }
});

/**
 * A project chip is the filter for its project, the same as a tag chip is for
 * its tag: the list narrows, and the Project filter says so.
 */
test("filters by a project from its chip on to-dos, memories and the modal", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const title = `Project chip filter ${run}`;
  const project = `pf${run}`;
  const made = await mcp(request, "create_todo", { title, project });
  const todoId = made.result.structuredContent.id as string;
  await mcp(request, "create_todo", { title, project: `other${run}` });
  for (const each of [project, `other${run}`]) {
    await mcp(request, "save_memory", {
      type: "fact",
      title,
      body: "A memory for the project chip filter case.",
      tags: ["ui"],
      project: each,
    });
  }
  const q = encodeURIComponent(title);
  const projectFacet = page.locator(
    '.list-toolbar button[data-facet="project"]',
  );

  await page.goto(`/todos?q=${q}`);
  await expect(page.locator(".todo-card")).toHaveCount(2);
  await cardFor(page, todoId)
    .getByRole("link", { name: project, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`project=${project}`));
  await expect(page).toHaveURL(/q=Project/);
  await expect(page.locator(".todo-card")).toHaveCount(1);
  await expect(projectFacet).toContainText(project);

  await page.goto(`/memories?q=${q}`);
  const rows = page.locator("ul.memories > li.item-row");
  await expect(rows).toHaveCount(2);
  await page.getByRole("link", { name: project, exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`project=${project}`));
  await expect(rows).toHaveCount(1);
  await expect(projectFacet).toContainText(project);

  // From the modal: the chip closes it and lands on the filtered list.
  await page.goto(`/memories?q=${q}`);
  await rows
    .filter({ has: page.getByRole("link", { name: project, exact: true }) })
    .locator("a.item-title")
    .click();
  const modal = page.locator("dialog.modal[open]");
  await modal.getByRole("link", { name: project, exact: true }).click();
  await expect(page.locator("dialog.modal[open]")).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`project=${project}`));
  await expect(rows).toHaveCount(1);
  await expect(projectFacet).toContainText(project);
});

/**
 * The project chip row above the list is gone; its counts moved into the
 * Project filter. Each option says how many rows picking it shows, under the
 * search and tags already applied, and a row's own chip is the way back out.
 */
test("narrows /todos to a project from the Project filter, and widens again", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const project = `row${run}`;
  const other = `rowother${run}`;
  const tag = `rowtag${run}`;
  for (const [title, where, tags] of [
    [`Chip row one ${run}`, project, [tag]],
    [`Chip row two ${run}`, project, []],
    [`Chip row three ${run}`, other, [tag]],
  ] as const) {
    await mcp(request, "create_todo", { title, project: where, tags });
  }
  await page.goto(`/todos?q=${run}`);
  const facet = page.locator('.list-toolbar button[data-facet="project"]');
  const option = (name: string, count: number) =>
    page
      .getByRole("option")
      .filter({ hasText: new RegExp(`^${name}\\s*${count}$`) });

  // The count is what one click shows, under the search already applied.
  await facet.click();
  await expect(option(project, 2)).toBeVisible();
  await expect(option(other, 1)).toBeVisible();
  await option(project, 2).click();
  await expect(page).toHaveURL(new RegExp(`project=${project}`));
  await expect(page.locator(".todo-card")).toHaveCount(2);
  await expect(facet).toContainText(project);
  // Every row's own chip reads as the filter in force too.
  await expect(
    page.locator(".todo-card .project-chip[aria-current]"),
  ).toHaveCount(2);

  // The selected chip is the way back out, from a card.
  await page.keyboard.press("Escape");
  await page
    .locator(".todo-card")
    .first()
    .getByRole("link", { name: project, exact: true })
    .click();
  await expect(page).not.toHaveURL(/project=/);
  await expect(page.locator(".todo-card")).toHaveCount(3);

  // It combines with the tag filter, and the counts follow the tag.
  await page.goto(`/todos?q=${run}&tag=${tag}`);
  await facet.click();
  await option(project, 1).click();
  await expect(page).toHaveURL(new RegExp(`project=${project}`));
  await expect(page).toHaveURL(new RegExp(`tag=${tag}`));
  await expect(page.locator(".todo-card")).toHaveCount(1);
});

/**
 * P9: the words the endpoint teaches an agent are offered to the person. The
 * memory type offers MEMORY_TYPES, the filter bar and the tag editor offer
 * what was written, and a value nobody wrote yet is still accepted.
 */
test("offers memory types, projects and tags, and still takes a new one", async ({
  page,
  request,
}) => {
  const id = crypto.randomUUID().slice(0, 8);
  const project = `vocab-${id}`;
  const tag = `known-${id}`;
  const title = `UI vocabulary proof ${id}`;
  const saved = await mcp(request, "save_memory", {
    type: "fact",
    title,
    body: "Offered, not enforced.",
    tags: [tag],
    project,
  });
  const memoryId = saved.result.structuredContent.id as string;

  await signIn(page);

  // The Project filter: a prefix of a written project lists it, and picking
  // it filters by it.
  await page.goto("/memories");
  const projectFacet = page.locator(
    '.list-toolbar button[data-facet="project"]',
  );
  await projectFacet.click();
  await page.locator("[cmdk-input]").fill(project.slice(0, -2));
  const offered = page.getByRole("option").filter({ hasText: project });
  await expect(offered).toBeVisible();
  await offered.click();
  await expect(page).toHaveURL(new RegExp(`project=${project}`));
  await expect(page.locator("ul.memories a.item-title")).toHaveText([title]);

  // A project nobody has written still filters from the URL: the toolbar
  // offers values but does not enforce them.
  await page.goto(`/memories?project=unwritten-${id}`);
  await expect(projectFacet).toContainText(`unwritten-${id}`);
  await expect(page.locator("ul.memories a.item-title")).toHaveCount(0);

  // The type editor offers the six taught types.
  await page.goto(`/memories?open=${encodeURIComponent(memoryId)}`);
  const modal = page.locator("dialog.modal[open]");
  await modal.getByRole("link", { name: "Edit type" }).click();
  const typeBox = modal.getByRole("combobox", { name: "Type" });
  await expect(typeBox).toBeFocused();
  const types = modal
    .getByRole("listbox", { name: "Type" })
    .getByRole("option");
  // Focused but shut, so the list does not land on Save; Down opens it.
  await expect(types).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  for (const name of MEMORY_TYPE_NAMES) {
    await expect(
      types.filter({ hasText: new RegExp(`^${name}$`) }),
    ).toHaveCount(1);
  }
  await typeBox.fill("deci");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(typeBox).toHaveValue("decision");
  await submit(page, modal.getByRole("button", { name: "Save" }), "/memories");
  const fetched = await mcp(request, "fetch", { id: memoryId });
  expect(fetched.result.structuredContent.metadata).toMatchObject({
    type: "decision",
  });

  // The tag row offers a tag written on another record.
  const todo = await mcp(request, "create_todo", {
    title: `UI vocabulary todo ${id}`,
    project: "valise",
  });
  await page.goto(`/todos?q=${encodeURIComponent(`vocabulary todo ${id}`)}`);
  const card = cardFor(page, todo.result.structuredContent.id as string);
  // No tags yet, so the empty value is the control (P8), and the phrase
  // opens the set's own add box.
  await card.getByRole("link", { name: "Add tags" }).click();
  await card.getByRole("combobox", { name: "Add tag" }).fill(tag.slice(0, -2));
  await settle(page, () => card.getByRole("option", { name: tag }).click());
  await expect(
    card.getByRole("button", { name: `Remove ${tag}` }),
  ).toBeVisible();
});

test("files a to-do from one line, suggesting facets at the caret", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const key = `k${run}`;
  const tag = `t${run}tag`;
  // Written once by an agent, so the store's vocabulary holds both.
  await mcp(request, "create_todo", {
    title: `Composer vocabulary ${run}`,
    project: "valise",
    tags: [`${key}:alpha`, tag],
  });

  await signIn(page);
  // `?edit=new` is the add row's own URL, so it opens straight onto the field.
  await page.goto("/todos?edit=new");
  const box = page.getByRole("combobox", { name: "New to-do" });
  // The hint shows the shorthand that fills the project column.
  await expect(box).toHaveAttribute("placeholder", /@\S+/);
  await page.goto(`/todos?project=${key}&edit=new`);
  await expect(box).toHaveAttribute("placeholder", new RegExp(`@${key} `));
  await page.goto("/todos");
  await page.getByRole("link", { name: "New to-do", exact: true }).click();
  await expect(box).toBeFocused();

  // A bare word offers the key; picking it leaves the list on its values.
  await box.pressSequentially(`Composer ${run} ${key.slice(0, 5)}`);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue(`Composer ${run} ${key}:`);
  const value = page.getByRole("option", { name: `${key}:alpha` });
  await expect(value).toContainText("1 to-do");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue(`Composer ${run} ${key}:alpha `);
  await box.pressSequentially(`#${tag.slice(0, 4)}`);
  await page.getByRole("option", { name: `#${tag}` }).click();
  // `@` offers the store's projects, and files the pick as the column.
  await box.pressSequentially("@vali");
  await page.getByRole("option", { name: "@valise", exact: true }).click();

  // Enter files it and leaves the field empty and focused for the next one.
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(box).toBeFocused();
  const card = page.locator(".todo-card", {
    has: page.locator("h2", { hasText: new RegExp(`^Composer ${run}$`) }),
  });
  await expect(card).toHaveCount(1);
  const id = await card.locator('input[name="id"]').first().inputValue();
  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.metadata).toMatchObject({
    project: "valise",
    tags: [`${key}:alpha`, tag],
    source_agent: "console",
    source_client: "web",
  });

  // With the list open but nothing picked, Enter commits the line as typed.
  await box.pressSequentially(`Plain ${run} ${key.slice(0, 5)}`);
  await expect(page.getByRole("option", { name: `${key}:` })).toBeVisible();
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  // Two in one second tie on created_at, so look for it rather than at row 1.
  await expect(
    page.locator(".todo-card h2", {
      hasText: `Plain ${run} ${key.slice(0, 5)}`,
    }),
  ).toHaveCount(1);

  // A refused line comes back to be fixed, and the next commit clears it.
  await box.fill(`Typed ${run} type:decision`);
  await page.keyboard.press("Enter");
  await expect(page.locator(".todo-add [role=alert]")).toContainText(
    "type: is reserved",
  );
  await expect(box).toHaveValue(`Typed ${run} type:decision`);
  await box.fill(`Typed ${run}`);
  await page.keyboard.press("Enter");
  await expect(box).toHaveValue("");
  await expect(page.locator(".todo-add [role=alert]")).toHaveCount(0);
});

/**
 * Todoist parity: Tab completes wherever a tag or project is typed. It takes
 * the highlighted option, keeps focus for the next word, and a Tab that only
 * passes through a box picks nothing.
 */
test("completes tags and projects with Tab, and Tab through a box picks nothing", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const tag = `tab${run}tag`;
  const project = `tab-${run}`;
  // Written once by an agent, so the store's vocabulary holds both.
  await mcp(request, "create_todo", {
    title: `Tab completion ${run}`,
    project,
    tags: [tag],
  });

  await signIn(page);

  // The single-value combobox: typed, Tab takes the highlighted option and
  // the caret stays; a second Tab leaves.
  await page.goto("/workbench?tab=components");
  const model = page.getByRole("combobox", { name: "Model" });
  await model.fill("luna");
  await page.keyboard.press("Tab");
  await expect(model).toHaveValue("GPT-6 Luna");
  await expect(model).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(model).not.toBeFocused();
  // Focused and open but untouched: Tab moves on and the value stays.
  await model.click();
  await expect(
    page.getByRole("listbox", { name: "Model" }).getByRole("option").first(),
  ).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(model).not.toBeFocused();
  await expect(model).toHaveValue("GPT-6 Luna");

  // The composer: `#` and `project:` complete on Tab without arrowing in.
  await page.goto("/todos?edit=new");
  const box = page.getByRole("combobox", { name: "New to-do" });
  await box.pressSequentially(`Tabbed ${run} #${tag.slice(0, 6)}`);
  await expect(page.getByRole("option", { name: `#${tag}` })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(box).toHaveValue(`Tabbed ${run} #${tag} `);
  await expect(box).toBeFocused();
  await box.pressSequentially(`project:${project.slice(0, 6)}`);
  await page.keyboard.press("Tab");
  await expect(box).toHaveValue(`Tabbed ${run} #${tag} project:${project} `);
  // A bare word's list is only an offer: Tab leaves the word as written.
  await box.pressSequentially(tag.slice(0, 5));
  await expect(page.getByRole("option", { name: `#${tag}` })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(box).not.toBeFocused();
  await expect(box).toHaveValue(
    `Tabbed ${run} #${tag} project:${project} ${tag.slice(0, 5)}`,
  );

  // The tag row: Tab adds the known tag as a chip and leaves the box
  // empty and focused for the next one. The pick posts on its own.
  const bare = await mcp(request, "create_todo", {
    title: `Tab untagged ${run}`,
    project,
  });
  await page.goto(`/todos?q=${encodeURIComponent(`Tab untagged ${run}`)}`);
  const card = cardFor(page, bare.result.structuredContent.id as string);
  await card.getByRole("link", { name: "Add tags" }).click();
  const adder = card.getByRole("combobox", { name: "Add tag" });
  await adder.fill(tag.slice(0, 6));
  await settle(page, () => page.keyboard.press("Tab"));
  await expect(
    card.getByRole("button", { name: `Remove ${tag}` }),
  ).toBeVisible();
  await expect(card.getByRole("combobox", { name: "Add tag" })).toBeFocused();
  await expect(card.getByRole("combobox", { name: "Add tag" })).toHaveValue("");
});

test("files a to-do from the composer with scripting off", async ({
  browser,
}) => {
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  const run = crypto.randomUUID().slice(0, 8);
  // `signIn` waits on the `.data` fetch, which a plain form post never makes.
  await page.goto("/todos");
  await expect(page.getByRole("heading", { name: "To-dos" })).toBeVisible();
  // The add row is a link to `?edit=new`, and the form posts and redirects.
  await page.getByRole("link", { name: "New to-do", exact: true }).click();
  await page.getByLabel("New to-do").fill(`No script ${run} priority:2`);
  await page.getByLabel("Description").fill(`Filed with no script ${run}.`);
  await page.getByRole("button", { name: "Add to-do" }).click();
  // It stays open for the next one.
  await expect(page).toHaveURL(/edit=new/);
  await expect(page.getByLabel("New to-do")).toHaveValue("");
  const card = page.locator(".todo-card", {
    has: page.locator("h2", { hasText: new RegExp(`^No script ${run}$`) }),
  });
  await expect(card).toHaveCount(1);
  await expect(card.locator(".todo-tags")).toContainText("priority:2");
  await expect(card.locator(".todo-summary")).toContainText(
    `Filed with no script ${run}.`,
  );

  // The row's + remains a link without hydration, and its editor posts the
  // chosen set through a plain input rather than relying on combobox state.
  const addedTag = `no-script-${run}`;
  await card.getByRole("link", { name: "Add tag" }).click();
  const tags = page.getByRole("textbox", { name: "Tags" });
  await expect(tags).toHaveValue("priority:2");
  await tags.fill(`priority:2, ${addedTag}`);
  await page.getByRole("button", { name: "Save" }).click();
  await expect(
    card.getByRole("button", { name: `Remove ${addedTag}` }),
  ).toBeVisible();
  await context.close();
});

test("adds a to-do from the row at the top of the list, with a description", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  await page.goto("/todos");

  // Closed, the add row is the list's first item, one link above the first
  // to-do (P8).
  const opener = page.getByRole("link", { name: "New to-do", exact: true });
  const firstCardBox = await page.locator(".todo-card").first().boundingBox();
  const openerBox = await opener.boundingBox();
  expect(openerBox?.y).toBeLessThan(firstCardBox?.y ?? 0);
  await opener.click();
  const title = page.getByRole("combobox", { name: "New to-do" });
  await expect(title).toBeFocused();
  await title.fill(`Inline add ${run} project:valise`);
  const details = page.getByLabel("Description");
  await details.fill(`Why it matters ${run}.\n- [ ] first step`);
  // Where the row sits on screen, not scrollY: anchoring raises scrollY by
  // the new row's height so everything in view stays put.
  const before = (await title.boundingBox())?.y ?? 0;

  // Cmd/Ctrl+Enter in the description files it; the page never navigates.
  await details.press("ControlOrMeta+Enter");
  const landed = page.getByRole("status");
  // Other tests share this store, so blocked rows may lead the list.
  await expect(landed).toContainText(
    new RegExp(
      `Added "Inline add ${run}" (at the top of the list|beneath the blocked to-dos)\\.`,
    ),
  );
  await expect(title).toHaveValue("");
  await expect(details).toHaveValue("");
  await expect(title).toBeFocused();
  // New rows sort first in the list, beneath the stationary add row and
  // any blocked rows (P4).
  await expect(
    page.locator(".todo-card:not(.in-blocked) h2").first(),
  ).toHaveText(`Inline add ${run}`);
  expect(Math.abs(((await title.boundingBox())?.y ?? 0) - before)).toBeLessThan(
    2,
  );

  // The confirmation opens the new to-do, body and sub-task included.
  await landed.getByRole("link", { name: "Open it" }).click();
  const dialog = page.getByRole("dialog", { name: `Inline add ${run}` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(`Why it matters ${run}.`);
  await expect(
    dialog.getByRole("checkbox", { name: "first step" }),
  ).toHaveCount(1);
  const id = new URL(page.url()).searchParams.get("open") ?? "";
  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.metadata).toMatchObject({
    project: "valise",
    source_agent: "console",
  });
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  // Escape closes the add row, gives focus back to its link, and keeps the
  // draft for when it opens again.
  await title.fill(`Draft ${run}`);
  await title.press("Escape");
  await expect(title).toHaveCount(0);
  await expect(opener).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(title).toHaveValue(`Draft ${run}`);
  await page.getByRole("link", { name: "Cancel" }).click();
  await expect(title).toHaveCount(0);
});

test("opens a to-do in a dialog from a click, and edits its title with the composer's shorthand", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const created = await mcp(request, "create_todo", {
    title: `Title shorthand ${run}`,
    project: "valise",
    tags: [`kept${run}`],
  });
  const id = created.result.structuredContent.id as string;
  await page.goto(`/todos?q=${encodeURIComponent(`shorthand ${run}`)}`);
  const card = cardFor(page, id);

  // A click on the to-do in the list opens it, as in Todoist.
  await card.getByRole("link", { name: `Title shorthand ${run}` }).click();
  const dialog = page.getByRole("dialog", { name: `Title shorthand ${run}` });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(/[?&]open=todo%3A/);

  // In it, a click on the title opens the editor, and Escape reverts it
  // without closing the dialog.
  await dialog.locator("header h2").click();
  const box = dialog.getByRole("combobox", { name: "Title" });
  await expect(box).toBeFocused();
  await expect(box).toHaveValue(`Title shorthand ${run}`);
  await box.fill("Discarded");
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("header h2")).toHaveText(
    `Title shorthand ${run}`,
  );
  await expect(page).not.toHaveURL(/edit=/);

  // Facets and #tags join the tags already there; project: moves it. Enter
  // saves, through the form's own submit.
  await dialog.locator("header h2").click();
  await box.fill(`Renamed ${run} area:title #fresh${run} project:p${run}`);
  await posted(page, () => box.press("Enter"));
  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.title).toBe(`Renamed ${run}`);
  expect(fetched.result.structuredContent.metadata).toMatchObject({
    project: `p${run}`,
    tags: [`kept${run}`, "area:title", `fresh${run}`],
  });
});

/**
 * Todoist's detail view: the description is its own editor's target, and
 * leaving the field keeps what was typed. Save and Cancel stay beside it
 * (P6), so blur is one more way to save, not the only one.
 */
test("edits a to-do's title and description from a click in its dialog, saving on blur", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const created = await mcp(request, "create_todo", {
    title: `Click to edit ${run}`,
    project: "valise",
    body: "First paragraph, [a link](https://example.com).\n\n- [ ] a step",
  });
  const id = created.result.structuredContent.id as string;
  await page.goto(`/todos?q=${run}`);
  const card = cardFor(page, id);
  await expandRow(card);
  const dialog = card.getByRole("dialog");
  const body = dialog.getByRole("textbox", { name: "Body", exact: true });

  // A sub-task box inside the description keeps its own meaning.
  await submit(page, dialog.locator(".task-box").first(), "/todos");
  await expect(card.locator(".task-count")).toHaveText("1/1");
  await expect(body).toHaveCount(0);

  // A click on the text opens the editor; Escape reverts it, and the
  // dialog stays.
  await dialog.getByText("First paragraph").click();
  await expect(body).toBeFocused();
  await body.fill("thrown away");
  await page.keyboard.press("Escape");
  await expect(body).toHaveCount(0);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".todo-body")).toContainText("First paragraph");

  // Cmd or Ctrl+Enter saves.
  await dialog.getByText("First paragraph").click();
  await body.fill("Saved with the keyboard.");
  await posted(page, () => body.press("ControlOrMeta+Enter"));
  await expect(dialog.locator(".todo-body")).toHaveText(
    "Saved with the keyboard.",
  );

  // Clicking away from a changed field saves it.
  await dialog.getByText("Saved with the keyboard.").click();
  await body.fill("Saved on blur.");
  await posted(page, () => dialog.getByText("Opened by").click());
  await expect(body).toHaveCount(0);
  await expect(dialog.locator(".todo-body")).toHaveText("Saved on blur.");

  // So does the title, and an unchanged one closes without a write.
  await dialog.locator("header h2").click();
  const title = dialog.getByRole("combobox", { name: "Title" });
  await title.fill(`Blurred title ${run}`);
  await posted(page, () => dialog.getByText("Opened by").click());
  await expect(title).toHaveCount(0);
  await expect(card.locator(".todo-open")).toHaveText(`Blurred title ${run}`);
  const writes: string[] = [];
  page.on("request", (sent) => {
    if (sent.method() === "POST") writes.push(sent.url());
  });
  await dialog.locator("header h2").click();
  await expect(title).toBeFocused();
  await dialog.getByText("Opened by").click();
  await expect(title).toHaveCount(0);
  expect(writes).toEqual([]);

  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.title).toBe(`Blurred title ${run}`);
  expect(fetched.result.structuredContent.text).toBe("Saved on blur.");
});

test("opens and cancels a field without a loader call, and paints a save before the server answers", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const created = await mcp(request, "create_todo", {
    title: `Instant ${run}`,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  await signIn(page);
  // Searched by the run alone, so the renamed row still matches after the
  // revalidation that follows the save.
  const start = `/todos?q=${run}&open=${encodeURIComponent(id)}`;
  await page.goto(start);
  const card = cardFor(page, id);
  const loads: string[] = [];
  page.on("request", (sent) => {
    const url = new URL(sent.url());
    if (sent.method() === "GET" && url.pathname === "/todos.data") {
      loads.push(url.search);
    }
  });

  // Open and close are component state: no navigation, no loader. P3.
  const box = card.getByRole("combobox", { name: "Title" });
  await card.locator("dialog header h2").click();
  await expect(box).toBeFocused();
  await card.getByRole("link", { name: "Cancel" }).click();
  await expect(box).toHaveCount(0);
  await card.getByRole("link", { name: "Edit title" }).click();
  await page.keyboard.press("Escape");
  await expect(box).toHaveCount(0);
  expect(loads).toEqual([]);
  await expect(page).toHaveURL(start);

  // Hold the write, so what shows meanwhile can only be the client's.
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/todos.data*", async (route) => {
    if (route.request().method() === "POST") await held;
    await route.continue();
  });
  await card.locator("dialog header h2").click();
  await box.fill(`Instant renamed ${run} #hash${run}`);
  const answered = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      new URL(response.url()).pathname === "/todos.data",
  );
  await card.getByRole("button", { name: "Save" }).click();
  // Parsed the way the server parses it: the #tag is not part of the title.
  await expect(card.locator("dialog header h2")).toHaveText(
    `Instant renamed ${run}`,
  );
  await expect(box).toHaveCount(0);
  release();
  expect((await answered).ok()).toBe(true);

  // The fetcher save keeps the page's URL, `?open=` included. P11.
  await expect(page).toHaveURL(start);
  await expect(card.locator("dialog header h2")).toHaveText(
    `Instant renamed ${run}`,
  );
  const fetched = await mcp(request, "fetch", { id });
  expect(fetched.result.structuredContent.title).toBe(`Instant renamed ${run}`);
});

test("edits a field with scripting off, through ?edit= and the redirect", async ({
  browser,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const created = await mcp(request, "create_todo", {
    title: `No script ${run}`,
    project: "valise",
  });
  const id = created.result.structuredContent.id as string;
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto("/todos");
  await expect(page.getByRole("heading", { name: "To-dos" })).toBeVisible();

  await page.goto(`/todos?q=${encodeURIComponent(`No script ${run}`)}`);
  const card = cardFor(page, id);
  // The to-do opens as a document load, and the server renders its dialog
  // open, since there is no script to call showModal().
  await card.getByRole("link", { name: `No script ${run}` }).click();
  await expect(page).toHaveURL(/[?&]open=todo%3A/);
  await card.getByRole("link", { name: "Edit title" }).click();
  await expect(page).toHaveURL(/[?&]edit=todo%3A/);
  await card
    .getByRole("combobox", { name: "Title" })
    .fill(`No script ${run} posted`);
  await card.getByRole("button", { name: "Save" }).click();
  // The document post gets the redirect back to the list, editor closed.
  await expect(page).not.toHaveURL(/edit=/);
  await expect(page).toHaveURL(/[?&]open=todo%3A/);
  await expect(card.locator(".todo-open")).toHaveText(
    `No script ${run} posted`,
  );
  await context.close();
});

test("filters to-dos by a facet with counts, from the filter bar and the chips", async ({
  page,
  request,
}) => {
  const run = crypto.randomUUID().slice(0, 8);
  const key = `f${run}`;
  const ids: string[] = [];
  for (const [n, tags] of [
    [1, [`${key}:one`, `plain${run}`]],
    [2, [`${key}:one`]],
    [3, [`${key}:two`]],
  ] as const) {
    const made = await mcp(request, "create_todo", {
      title: `Facet filter ${run} ${n}`,
      project: "valise",
      tags,
    });
    ids.push(made.result.structuredContent.id as string);
  }

  await page.goto("/todos?done=show");
  // The Tag filter offers the facet values with how many to-dos carry each.
  await page.locator('.list-toolbar button[data-facet="tag"]').click();
  await page.locator("[cmdk-input]").fill(`${key}:`);
  const option = (value: string, count: number) =>
    page
      .getByRole("option")
      .filter({ hasText: new RegExp(`^${value}\\s*${count}$`) });
  await expect(option(`${key}:one`, 2)).toBeVisible();
  await expect(option(`${key}:two`, 1)).toBeVisible();
  await option(`${key}:one`, 2).click();
  // The pick submits the filter on its own, and keeps the done rows shown
  // rather than dropping the toggle.
  await expect(page).toHaveURL(/done=show/);
  await expect(page).toHaveURL(new RegExp(`tag=${key}%3Aone`));
  await expect(page.locator(".todo-card")).toHaveCount(2);

  // A chip on a row is the filter for its value.
  await cardFor(page, ids[0])
    .getByRole("link", { name: `plain${run}`, exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`tag=plain${run}`));
  await expect(page).toHaveURL(/done=show/);
  await expect(page.locator(".todo-card")).toHaveCount(1);

  // `project:` typed into the tag row moves the project, not a tag. The
  // pick posts the set on its own; there is no Save.
  const card = cardFor(page, ids[0]);
  await card.getByRole("link", { name: "Add tag" }).click();
  await card.getByRole("combobox", { name: "Add tag" }).fill(`project:p${run}`);
  await settle(page, () => page.keyboard.press("Enter"));
  const fetched = await mcp(request, "fetch", { id: ids[0] });
  expect(fetched.result.structuredContent.metadata).toMatchObject({
    project: `p${run}`,
    tags: [`${key}:one`, `plain${run}`],
  });
});

/** A 1x1 PNG, so a dropped image has real pixels to render. */
const PIXEL =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** Drags files from outside the page onto `target` and drops them, as a person does. */
async function dropFiles(
  target: Locator,
  files: { name: string; type: string; base64: string }[],
): Promise<void> {
  // A string, because this suite compiles without the DOM lib.
  const dataTransfer = await target.page().evaluateHandle(`(() => {
    const transfer = new DataTransfer();
    for (const file of ${JSON.stringify(files)}) {
      const bytes = Uint8Array.from(atob(file.base64), (c) => c.charCodeAt(0));
      transfer.items.add(new File([bytes], file.name, { type: file.type }));
    }
    return transfer;
  })()`);
  await target.dispatchEvent("dragenter", { dataTransfer });
  await target.dispatchEvent("dragover", { dataTransfer });
  await target.dispatchEvent("drop", { dataTransfer });
}

function cardFor(page: Page, id: string) {
  return page.locator(".todo-card", {
    has: page.locator(`input[name="id"][value="${id}"]`),
  });
}

/** Runs `act`, then waits for the console write it sets off to answer. */
async function posted(page: Page, act: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === "/todos.data",
  );
  await act();
  expect((await response).ok()).toBe(true);
}

/** Chooses files in a hydrated picker and waits for the upload it sets off. */
async function pick(
  page: Page,
  input: ReturnType<Page["getByLabel"]>,
  files: Parameters<ReturnType<Page["getByLabel"]>["setInputFiles"]>[0],
  pathname: string,
): Promise<void> {
  const response = page.waitForResponse(
    (candidate) =>
      candidate.request().method() === "POST" &&
      new URL(candidate.url()).pathname === `${pathname}.data`,
  );
  await input.setInputFiles(files);
  expect((await response).ok()).toBe(true);
}

async function submit(
  page: Page,
  button: ReturnType<Page["getByRole"]>,
  pathname: string,
): Promise<void> {
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return (
      candidate.request().method() === "POST" &&
      url.pathname === `${pathname}.data`
    );
  });
  await button.click();
  expect((await response).ok()).toBe(true);
}

/**
 * One chip write: run it, then wait for the action's own answer, so the
 * fetch that follows reads what the write stored rather than the chip the
 * optimistic paint already showed.
 */
async function settle(page: Page, write: () => Promise<void>): Promise<void> {
  const response = page.waitForResponse((candidate) => {
    const url = new URL(candidate.url());
    return (
      candidate.request().method() === "POST" && url.pathname.endsWith(".data")
    );
  });
  await write();
  expect((await response).ok()).toBe(true);
}

test("asks no confirmation for a link that is not a supersession", async ({
  page,
  request,
}) => {
  const marker = `link-related-${crypto.randomUUID().slice(0, 8)}`;
  const first = await mcp(request, "save_memory", {
    title: `${marker} first`,
    body: marker,
    type: "fact",
    tags: ["links"],
  });
  const second = await mcp(request, "save_memory", {
    title: `${marker} second`,
    body: marker,
    type: "fact",
    tags: ["links"],
    relates: [{ id: first.result.structuredContent.id, kind: "related" }],
  });
  await signIn(page, "/todos", true);
  await page.goto(
    `/memories?open=${encodeURIComponent(second.result.structuredContent.id)}`,
  );
  const links = page.getByRole("region", { name: "Memory links" });
  await expect(links.locator(".log > li")).toContainText("related · ");
  await expect(links.locator(".log > li")).toContainText("added by an agent");
  await expect(links).not.toContainText("model suggestion");
  await expect(links.getByRole("button", { name: "Confirm link" })).toHaveCount(
    0,
  );
  await expect(
    links.getByRole("button", { name: "Remove link" }),
  ).toBeVisible();
  for (const [name, width] of [
    ["desktop", 1280],
    ["mobile", 390],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await links.scrollIntoViewIfNeeded();
    await page.screenshot({
      path: test.info().outputPath(`memory-link-related-${name}.png`),
    });
  }
});

for (const scripting of [true, false]) {
  test(`adds a memory link from a modal over the pane with scripting ${scripting ? "on" : "off"}`, async ({
    page: hydratedPage,
    browser,
    request,
  }) => {
    const context = scripting
      ? null
      : await browser.newContext({ javaScriptEnabled: false });
    const page = context ? await context.newPage() : hydratedPage;
    const marker = `link-add-${crypto.randomUUID().slice(0, 8)}`;
    const target = (
      await mcp(request, "save_memory", {
        title: `${marker} target`,
        body: marker,
        type: "fact",
        tags: ["links"],
      })
    ).result.structuredContent.id as string;
    const source = (
      await mcp(request, "save_memory", {
        title: `${marker} source`,
        body: marker,
        type: "fact",
        tags: ["links"],
      })
    ).result.structuredContent.id as string;
    await signIn(page, "/todos", scripting);
    await page.goto(`/memories?open=${encodeURIComponent(source)}`);
    const links = page.getByRole("region", { name: "Memory links" });
    // No links: no heading, no empty sentence, no inline form. One control.
    await expect(links.locator(".log")).toHaveCount(0);
    await expect(links.getByRole("heading")).toHaveCount(0);
    await expect(links.locator("select, [role=combobox]")).toHaveCount(0);
    await links.getByRole("link", { name: "Add link" }).click();
    await expect(page).toHaveURL(/[?&]edit=memory%3A[^&]+\.links/);
    const modal = page.getByRole("dialog", { name: "Add a link" });
    await expect(modal).toBeVisible();
    await expect(modal).toContainText("Supersedes points to the older claim");
    await modal.getByLabel("Relationship").selectOption("related");
    if (scripting) {
      await modal.getByRole("combobox", { name: "Memory" }).click();
      await page.getByPlaceholder("Search memories by title").fill(marker);
      await page.getByRole("option", { name: `${marker} target` }).click();
    } else {
      await modal.getByLabel("Memory").selectOption(target);
    }
    await modal.getByRole("button", { name: "Add link" }).click();
    await expect(modal).toBeHidden();
    await expect(page).not.toHaveURL(/edit=/);
    await expect(links.locator(".log > li")).toContainText(
      `related · ${marker} target`,
    );
    const fetched = await mcp(request, "fetch", { id: source });
    expect(fetched.result.structuredContent).toMatchObject({
      metadata: { links: [{ kind: "related", id: target }] },
    });
    await context?.close();
  });

  test(`confirms and reverses memory links with scripting ${scripting ? "on" : "off"}`, async ({
    page: hydratedPage,
    browser,
    request,
  }) => {
    const context = scripting
      ? null
      : await browser.newContext({ javaScriptEnabled: false });
    const page = context ? await context.newPage() : hydratedPage;
    const marker = `link-ui-${crypto.randomUUID().slice(0, 8)}`;
    const saved = await mcp(request, "save_memory", {
      title: `${marker} old`,
      body: marker,
      type: "fact",
      tags: ["links"],
    });
    const old = saved.result.structuredContent.id as string;
    const replacement = await mcp(request, "save_memory", {
      title: `${marker} new`,
      body: marker,
      type: "fact",
      tags: ["links"],
      relates: [{ id: old, kind: "supersedes" }],
    });
    const fresh = replacement.result.structuredContent.id as string;
    const results = async () =>
      (await mcp(request, "search", { query: marker })).result.structuredContent
        .results as { id: string }[];
    expect((await results()).map((hit) => hit.id)).toContain(old);
    await signIn(page, "/todos", scripting);
    await page.goto(`/memories?open=${encodeURIComponent(fresh)}`);
    const links = page.getByRole("region", { name: "Memory links" });
    await expect(links).toContainText("model suggestion");
    await links.getByRole("button", { name: "Confirm link" }).click();
    await expect(
      links.getByRole("button", { name: "Confirm link" }),
    ).toHaveCount(0);
    await expect(links.locator(".log > li")).toContainText("confirmed");
    expect((await results()).map((hit) => hit.id)).not.toContain(old);
    await links.getByRole("button", { name: "Remove link" }).click();
    await expect(links).toContainText("removed");
    expect((await results()).map((hit) => hit.id)).toContain(old);
    await links.getByRole("button", { name: "Restore link" }).click();
    await expect(links.locator(".log > li")).toContainText("confirmed");
    expect((await results()).map((hit) => hit.id)).not.toContain(old);
    await expect(
      links.getByRole("button", { name: "Remove link" }),
    ).toBeVisible();
    await page.screenshot({
      path: test
        .info()
        .outputPath(`memory-links-${scripting ? "on" : "off"}.png`),
      fullPage: true,
    });
    await links.getByRole("button", { name: "Remove link" }).click();
    await expect(
      links.getByRole("button", { name: "Restore link" }),
    ).toBeVisible();
    await mcp(request, "edit_memory", {
      id: old,
      relates: [{ id: fresh, kind: "supersedes" }],
    });
    const conflict = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname ===
          (scripting ? "/memories.data" : "/memories"),
    );
    await links.getByRole("button", { name: "Restore link" }).click();
    expect((await conflict).status()).toBe(400);
    await expect(
      page.getByRole("heading", { name: "400", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("Memory link conflict", { exact: true }),
    ).toBeVisible();
    const fetched = await mcp(request, "fetch", { id: fresh });
    expect(fetched.result.structuredContent).toMatchObject({
      metadata: {
        links: [{ kind: "superseded-by", id: old, confirmed: false }],
      },
    });
    await context?.close();
  });
}

test("shows delivered search appearances separately from fetched memories", async ({
  page,
  request,
}) => {
  const marker = `appearance-ui-${crypto.randomUUID().slice(0, 8)}`;
  const saved = await mcp(request, "save_memory", {
    title: marker,
    body: marker,
    type: "fact",
    tags: ["metrics"],
  });
  const id = saved.result.structuredContent.id as string;
  await mcp(request, "search", { query: marker });
  await mcp(request, "search", { query: marker });
  await mcp(request, "fetch", { id });
  await page.goto(
    `/memories?q=${encodeURIComponent(marker)}&open=${encodeURIComponent(id)}`,
  );
  const row = page.locator("ul.memories > li.item-row", {
    has: page.locator("a.item-title", { hasText: marker }),
  });
  // Fetches and search appearances are two counts on the row.
  await expect(row.locator(".fetched")).toHaveText("1↓ 2◎");
  const facts = page.getByRole("dialog").locator(".facts");
  await expect(
    facts.locator("div", {
      has: page.getByText("In results", { exact: true }),
    }),
  ).toContainText("2 in 30 days");
});

async function mcpAs(
  request: APIRequestContext,
  agent: string,
  name: string,
  args: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<{ result: { structuredContent: Record<string, unknown> } }> {
  const response = await request.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": agent,
      "x-valise-client": "console-test",
      ...headers,
    },
    data: rpc(name, args),
  });
  return parseRpc(await response.text());
}

async function authenticatedMcp(
  request: APIRequestContext,
  token: string,
  name: string,
  args: Record<string, unknown>,
) {
  return request.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
    },
    data: rpc(name, args),
  });
}

function rpc(name: string, args: Record<string, unknown>) {
  return {
    jsonrpc: "2.0",
    id: crypto.randomUUID(),
    method: "tools/call",
    params: { name, arguments: args },
  };
}

/** The newest run arrives open, and a click on it would close it. */
async function openRun(run: Locator) {
  const details = run.locator("> details");
  if ((await details.getAttribute("open")) === null) {
    await details.locator("> summary").click();
  }
}
