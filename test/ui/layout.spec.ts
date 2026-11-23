import type { APIRequestContext, Page } from "@playwright/test";
import { expect, goto, mcp, seed, test } from "./fixtures/session";

/**
 * A colour token as the browser resolves it. The palette is tuned in
 * `styles/valise.css`; this file checks that each surface takes its role's
 * token, not which colour the token holds today.
 */
async function token(page: Page, name: string): Promise<string> {
  // A string, not a closure: this repo compiles without the DOM lib.
  return page.evaluate<string>(`(() => {
    const probe = document.createElement("i");
    probe.style.color = "var(${name})";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return value;
  })()`);
}

async function create(request: APIRequestContext, project: string) {
  const todo = await mcp(request, "create_todo", {
    title: `Filter coverage ${crypto.randomUUID().slice(0, 8)}`,
    project,
  });
  return { id: String(todo.id), title: String(todo.title) };
}

test.beforeEach(async ({ request }) => {
  await seed(request);
  // Populate Connections even when this file runs alone: an empty session
  // table cannot prove that dense tables stay inside the shared grid.
  expect(
    (
      await request.post("/mcp", {
        headers: {
          accept: "application/json, text/event-stream",
          "mcp-protocol-version": "2025-11-25",
          "x-valise-agent": "ui-layout-check",
          "x-valise-client": "ui-layout-client-with-a-long-name",
          "x-valise-session": "ui-layout-check",
          "x-valise-session-name": "ui-layout-session-with-a-long-name",
        },
        data: {
          jsonrpc: "2.0",
          id: "layout",
          method: "tools/call",
          params: {
            name: "list_ready",
            arguments: { project: "valise" },
            _meta: {
              "io.modelcontextprotocol/clientInfo": {
                name: "ui-layout-client-with-a-long-name",
                version: "1.0.0",
              },
            },
          },
        },
      })
    ).ok(),
  ).toBe(true);
});

test("every console route keeps one shell, the palette, and fits from desktop to 320px", async ({
  page,
}) => {
  test.setTimeout(120_000);
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: width === 1280 ? 900 : 844 });
    for (const path of [
      "/todos",
      "/memories",
      "/skills",
      "/library",
      "/connections",
      "/hooks",
      "/account",
      "/workbench?tab=components",
      "/workbench?tab=logs",
      "/workbench?tab=evals",
    ]) {
      const at = `${path} at ${width}px`;
      await goto(page, path);
      if (path === "/connections") {
        await expect(
          page.getByRole("cell", {
            name: "ui-layout-client-with-a-long-name 1.0.0",
            exact: true,
          }),
        ).toBeVisible();
      }
      await expect(page.locator(".workspace > .page-header"), at).toHaveCount(
        1,
      );
      await expect(
        page.locator(".workspace > .workspace-content"),
        at,
      ).toHaveCount(1);
      // One sidebar: a rail on desktop, behind the menu button on a phone.
      if (width >= 768) {
        await expect(
          page.getByRole("navigation", { name: "Workspace", exact: true }),
        ).toHaveCount(1);
      } else {
        await expect(
          page.getByRole("button", { name: "Toggle Sidebar" }),
          at,
        ).toHaveCount(1);
      }
      await expect(page.locator(".workspace-content"), at).toHaveCSS(
        "row-gap",
        "22.5px",
      );
      const [background, headingInk, tagFill, tagInk] = await Promise.all(
        ["--bone", "--heading-ink", "--tag-fill", "--tag-ink"].map((name) =>
          token(page, name),
        ),
      );
      await expect(page.locator("body")).toHaveCSS(
        "background-color",
        background,
      );
      const title = page.locator(".page-header h1");
      await expect(title, at).toHaveCSS("color", headingInk);
      await expect(title, at).toHaveCSS("font-family", /Futura/);
      for (const tag of await page.locator(".tag, .tag-input .chip").all()) {
        await expect(tag, at).toHaveCSS("background-color", tagFill);
        await expect(tag, at).toHaveCSS("color", tagInk);
      }
      // A dense table's min-content width pushes the whole page sideways
      // unless the grid track is capped and the table scrolls in its own band.
      const overflow = await page.evaluate<number>(
        "document.documentElement.scrollWidth - document.documentElement.clientWidth",
      );
      expect(overflow, `${at} scrolls sideways`).toBeLessThanOrEqual(1);
    }
  }
});

test("groups the to-do filters, projects and composer before the list", async ({
  page,
  request,
}) => {
  await goto(page, "/todos?q=Calibrate+cross-concept+BM25");
  const controls = page.getByRole("region", { name: "List controls" });
  await expect(
    controls.getByRole("searchbox", { name: "Search", exact: true }),
  ).toBeVisible();
  // Projects are a faceted filter in the toolbar, not a chip row.
  await expect(
    controls.getByRole("button", { name: "Project", exact: true }),
  ).toBeVisible();
  // Creating is the list's first row (P8).
  await expect(
    page
      .locator("ul.todo-list")
      .getByRole("link", { name: "New to-do", exact: true }),
  ).toBeVisible();
  const box = await controls.boundingBox();
  const header = await page.locator(".page-header").boundingBox();
  expect(
    (box?.y ?? 1000) - ((header?.y ?? 0) + (header?.height ?? 0)),
  ).toBeLessThan(25);
  expect((await page.locator(".todo-list").boundingBox())?.y).toBeLessThan(500);

  // State toggles sit in the toolbar, above the list and its composer.
  const project = `recording-filters-${crypto.randomUUID().slice(0, 8)}`;
  const done = await create(request, project);
  const doneClaim = await mcp(request, "claim_todo", { id: done.id });
  await mcp(request, "complete_todo", {
    id: done.id,
    token: doneClaim.token,
    summary: "Done for filter coverage.",
  });
  const blocked = await create(request, project);
  const blockedClaim = await mcp(request, "claim_todo", { id: blocked.id });
  await mcp(request, "update_todo", {
    id: blocked.id,
    token: blockedClaim.token,
    blocked_on: "A filter test dependency",
  });

  // Coordinator transitions reach the list through its mirror alarm (ADR-0002).
  await expect(async () => {
    await goto(page, `/todos?project=${project}`);
    await expect(page.getByRole("link", { name: "Show done (1)" })).toBeVisible(
      {
        timeout: 500,
      },
    );
    await expect(
      page.getByRole("link", { name: "Only blocked (1)" }),
    ).toBeVisible({
      timeout: 500,
    });
  }).toPass();

  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await goto(page, `/todos?project=${project}&edit=new`);
    const toolbar = page.locator(".list-toolbar");
    const composer = page.locator(".todo-add");
    const list = page.locator(".todo-list");
    const toolbarBox = await toolbar.boundingBox();
    const composerBox = await composer.boundingBox();
    const listBox = await list.boundingBox();
    expect(toolbarBox && composerBox && listBox).toBeTruthy();
    expect(toolbarBox!.y + toolbarBox!.height).toBeLessThanOrEqual(listBox!.y);
    // The composer opens inside the list, in place of its add row.
    expect(composerBox!.y).toBeGreaterThanOrEqual(listBox!.y);
    expect(composerBox!.y + composerBox!.height).toBeLessThanOrEqual(
      listBox!.y + listBox!.height,
    );
    for (const name of ["Show done (1)", "Only blocked (1)"]) {
      const toggle = toolbar.getByRole("link", { name, exact: true });
      const toggleBox = await toggle.boundingBox();
      expect(toggleBox!.height, `${name} at ${width}px`).toBeGreaterThanOrEqual(
        24,
      );
      expect(
        toggleBox!.x + toggleBox!.width,
        `${name} at ${width}px`,
      ).toBeLessThanOrEqual(width);
    }
  }

  // Done rows are hidden until asked for.
  await expect(page.locator(".todo-list .todo-open")).toHaveCount(1);
  await page.getByRole("link", { name: "Show done (1)" }).click();
  await expect(page.locator(".todo-list .todo-open")).toHaveCount(2);
  await page.getByRole("link", { name: "Hide done (1)" }).click();
  await expect(page.locator(".todo-list .todo-open")).toHaveCount(1);
  await page.getByRole("link", { name: "Only blocked (1)" }).click();
  await expect(page.locator(".todo-list .todo-open")).toHaveText([
    blocked.title,
  ]);
  await page.getByRole("link", { name: "Show every state" }).click();
  await expect(page.locator(".todo-list .todo-open")).toHaveCount(1);
});

test("keeps search URLs consistent through hydration and submits without scripting", async ({
  page,
  browser,
}) => {
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await goto(page, "/todos?q=two+words");
  await expect(page.getByRole("search")).toHaveAttribute("action", "/todos");
  expect(errors.filter((message) => message.includes("hydrated"))).toEqual([]);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const plain = await context.newPage();
    await plain.goto("/todos");
    const search = plain.getByRole("searchbox", {
      name: "Search",
      exact: true,
    });
    await search.fill("two words");
    // The search box is the form's one field, so Enter submits it.
    await search.press("Enter");
    await plain.waitForURL(/q=two\+words/);
    expect(new URL(plain.url()).searchParams.get("q")).toBe("two words");
    await expect(
      plain.getByRole("searchbox", { name: "Search", exact: true }),
    ).toHaveValue("two words");
  } finally {
    await context.close();
  }
});

test("groups skill preview details, bundle and labels with keyboard-accessible search", async ({
  page,
}) => {
  await goto(page, "/skills?add=write");
  const dialog = page.getByRole("dialog", { name: "Add skill", exact: true });
  await dialog
    .getByRole("textbox", { name: "SKILL.md", exact: true })
    .fill(
      "---\nname: ui-preview\ndescription: A complete preview with shared grouping.\nlicense: MIT\n---\n\nInstructions.",
    );
  await dialog.getByRole("button", { name: "Preview", exact: true }).click();
  for (const name of ["Skill details", "Bundle", "Organize and add"]) {
    await expect(
      dialog.getByRole("region", { name, exact: true }),
    ).toBeVisible();
  }
  await expect(
    dialog
      .getByRole("region", { name: "Organize and add" })
      .getByRole("combobox", { name: "Project", exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("navigation", { name: "Where the skill comes from" })
    .getByRole("link", { name: "Search skills.sh" })
    .click();
  const search = dialog.getByRole("searchbox", {
    name: "Find a skill on skills.sh",
  });
  await search.focus();
  await expect(search).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).not.toBeVisible();
});

test("opens a tall dialog at its first controls on a narrow screen", async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await goto(page, "/skills?add=write");
  const dialog = page.getByRole("dialog", { name: "Add skill", exact: true });
  expect(
    await dialog
      .locator(".modal-body")
      .evaluate((element) => Reflect.get(element, "scrollTop")),
  ).toBe(0);
  await expect(
    dialog.getByRole("navigation", { name: "Where the skill comes from" }),
  ).toBeInViewport();
});

test("a phone gives the page at least 90% of its width", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  for (const path of ["/todos", "/memories", "/skills", "/library"]) {
    await goto(page, path);
    const box = await page.locator(".workspace").boundingBox();
    expect(box?.width, path).toBeGreaterThanOrEqual(390 * 0.9);
    expect(box?.x, path).toBeLessThanOrEqual(16);
  }
});

test("empty tag filters align with adjacent input boxes", async ({ page }) => {
  // Faceted filter buttons share the search box's line and height.
  for (const path of ["/todos", "/memories", "/skills"]) {
    await goto(page, path);
    const search = await page
      .locator(".list-toolbar [data-slot=input-group]")
      .boundingBox();
    const facets = page.locator(".list-toolbar [data-facet]");
    expect(await facets.count(), path).toBeGreaterThan(0);
    for (const facet of await facets.all()) {
      const box = await facet.boundingBox();
      expect(Math.abs(box!.height - search!.height), path).toBeLessThanOrEqual(
        1,
      );
      expect(Math.abs(box!.y - search!.y), path).toBeLessThanOrEqual(1);
    }
  }
});
