import {
  type APIRequestContext,
  type Locator,
  type Page,
  request as requests,
} from "@playwright/test";
import {
  expect,
  mcpCall,
  signIn,
  test,
  goto as visit,
} from "./fixtures/session";

test.use({ trace: "on" });

// Real HTTP MCP transport into the supervisor's isolated store. Distinct client
// contexts/identities, not two wrappers around a shared request context. The
// loopback dev identities are NOT deployed OAuth/real-agent acceptance.
function client(request: APIRequestContext, identity: string) {
  return async (name: string, args: Record<string, unknown>) =>
    (
      await mcpCall(request, name, args, {
        agent: identity,
        client: "j3-browser-journey",
      })
    ).result;
}

const rowFor = (page: Page, id: string) =>
  page
    .locator(".todo-card")
    .filter({ has: page.locator(`input[name=id][value="${id}"]`) });
const openId = (page: Page) => new URL(page.url()).searchParams.get("open");

// The pane's handler calls preventDefault exactly when it navigates, and a
// window listener runs after it, so this records which j/k presses acted
// without waiting on a router commit that may or may not come.
async function recordShortcuts(page: Page) {
  await page.evaluate(`window.__shortcuts = [];
    window.addEventListener("keydown", (event) => {
      if (/^[jk]$/i.test(event.key))
        window.__shortcuts.push(event.key + (event.defaultPrevented ? "+" : "-"));
    });`);
}
const shortcuts = (page: Page) =>
  page.evaluate<string[]>(
    "window.__shortcuts.splice(0, window.__shortcuts.length)",
  );

/** "Add relation" opens a centred modal over the pane; adding closes it. P15. */
async function relate(pane: Locator, label: string, id: string) {
  await pane.getByRole("link", { name: "Add relation", exact: true }).click();
  const modal = pane.page().getByRole("dialog", { name: "Add a relation" });
  await modal.getByRole("combobox", { name: "Relation", exact: true }).click();
  await modal.getByRole("option", { name: new RegExp(`^${label}\\b`) }).click();
  await modal.getByRole("combobox", { name: "To-do", exact: true }).fill(id);
  await modal
    .getByRole("option", { name: new RegExp(id.slice(5, 17)) })
    .click();
  await modal
    .getByRole("button", { name: "Add relation", exact: true })
    .click();
  await expect(modal).toHaveCount(0);
}

test("J3: create/filter, keyboard review, console evidence, two-client claim boundaries and reopen in place", async ({
  page,
  baseURL,
}, info) => {
  test.setTimeout(90_000);
  const contextA = await requests.newContext({ baseURL });
  const contextB = await requests.newContext({ baseURL });
  const a = client(contextA, "j3-agent-a");
  const b = client(contextB, "j3-agent-b");
  const project = `j3-${crypto.randomUUID().slice(0, 8)}`;
  const fixtures: string[] = [];
  try {
    const make = async (title: string) => {
      const result = await a("create_todo", {
        title,
        project,
        tags: ["journey"],
      });
      expect(result.isError).not.toBe(true);
      fixtures.push(result.structuredContent.id);
      return result.structuredContent.id as string;
    };
    const prerequisite = await make("J3 prerequisite");
    const parent = await make("J3 parent");
    await signIn(page);
    await visit(page, "/todos");
    await page.getByRole("link", { name: "New to-do", exact: true }).click();
    await page
      .getByRole("combobox", { name: "New to-do", exact: true })
      .fill(`J3 daily task project:${project} #journey`);
    await page
      .getByRole("textbox", { name: "Description", exact: true })
      .fill("Synthetic daily task evidence");
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    const created = page
      .locator(".todo-add-landed")
      .getByRole("link", { name: "Open it" });
    await expect(created).toBeVisible();
    const id = new URL(
      (await created.getAttribute("href"))!,
      baseURL,
    ).searchParams.get("open")!;
    fixtures.push(id);
    // With done rows shown: the agent completes the parent and the
    // prerequisite below, and the reopen check compares every row.
    const list = `/todos?project=${project}&tag=journey&done=show`;
    await visit(page, list);
    await expect(page.locator(".todo-card")).toHaveCount(3);
    const rowsBefore = await page.locator(".todo-open").allTextContents();
    await rowFor(page, id).locator(".todo-open").click();
    // A router Link click returns before its loader commits the opened pane.
    // Assert the actual review surface before sending its keyboard command.
    const pane = page.locator("dialog.modal-pane");
    await expect(pane).toBeVisible();
    await expect(rowFor(page, id).locator(".todo-open")).toHaveAttribute(
      "aria-current",
      "true",
    );
    await expect(
      pane.getByRole("link", { name: "j Next", exact: true }),
    ).toHaveAttribute("href", new RegExp(encodeURIComponent(parent)));
    const historyLength = await page.evaluate<number>("history.length");
    await recordShortcuts(page);
    await page.keyboard.press("j");
    await expect.poll(() => openId(page)).toBe(parent);
    await expect(pane).toHaveAccessibleName("J3 parent");
    await expect(rowFor(page, parent)).toHaveClass(/is-open/);
    await info.attach("desktop-after-j.png", {
      body: await page.screenshot(),
      contentType: "image/png",
    });
    await page.keyboard.press("k");
    await expect.poll(() => openId(page)).toBe(id);
    await expect(rowFor(page, id)).toHaveClass(/is-open/);
    expect(await page.evaluate("history.length")).toBe(historyLength);
    await page.keyboard.press("Control+j");
    await page.keyboard.press("Shift+J");
    await page.keyboard.press("k"); // first result does not wrap
    expect(await shortcuts(page)).toEqual(["j+", "k+", "j-", "J-", "k-"]);
    expect(openId(page)).toBe(id);
    await pane.getByRole("link", { name: "Edit body", exact: true }).click();
    const body = pane.getByRole("textbox", { name: "Body", exact: true });
    await body.fill("Edited across console and MCP: ");
    await body.press("j");
    await body.press("k");
    await expect(body).toHaveValue("Edited across console and MCP: jk");
    expect(await shortcuts(page)).toEqual(["j-", "k-"]);
    expect(openId(page)).toBe(id);
    await pane.getByRole("button", { name: "Save", exact: true }).click();
    await expect(body).toHaveCount(0);
    const comment = pane.getByRole("textbox", {
      name: "Comment on J3 daily task",
    });
    await comment.fill("Synthetic console comment jk");
    await pane.getByRole("button", { name: "Close", exact: true }).focus();
    await page.keyboard.press("j"); // blurred draft must survive, too
    expect(await shortcuts(page)).toEqual(["j-"]);
    expect(openId(page)).toBe(id);
    await expect(comment).toHaveValue("Synthetic console comment jk");
    await pane.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(comment).toHaveValue("");
    await pane.getByRole("link", { name: "Add files" }).click();
    const adding = page.getByRole("dialog", { name: "Add files" });
    await adding.getByLabel("Choose a file").setInputFiles({
      name: "j3-evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("J3 synthetic evidence"),
    });
    await expect(
      pane.getByRole("link", { name: "j3-evidence.txt", exact: true }),
    ).toBeVisible();
    const fetched = (await b("fetch", { id, full: true })).structuredContent;
    expect(fetched.text).toContain("Edited across console and MCP: jk");
    expect(
      fetched.metadata.updates.some(
        (u: { body?: string }) => u.body === "Synthetic console comment jk",
      ),
    ).toBe(true);
    expect(fetched.metadata.files).toHaveLength(1);
    await relate(pane, "Parent", parent);
    await expect(
      pane.getByRole("button", {
        name: "Remove parent J3 parent",
        exact: true,
      }),
    ).toBeVisible();
    await relate(pane, "Blocked by", prerequisite);
    await expect(
      pane.getByRole("button", {
        name: "Remove blocked by J3 prerequisite",
        exact: true,
      }),
    ).toBeVisible();
    expect((await b("claim_todo", { id })).isError).toBe(true);
    // A parent may finish without its child. Dependency completion cannot
    // silently clear an independently recorded manual blocker.
    const parentLease = (await a("claim_todo", { id: parent }))
      .structuredContent;
    await a("complete_todo", {
      id: parent,
      token: parentLease.token,
      summary: "Synthetic parent complete",
    });
    expect((await b("fetch", { id })).structuredContent.metadata.state).toBe(
      "pending",
    );
    await pane.getByRole("link", { name: "Block this", exact: true }).click();
    await pane
      .getByRole("textbox", { name: "Blocked on" })
      .fill("Independent synthetic manual decision");
    await pane.getByRole("button", { name: "Block", exact: true }).click();
    const prereqLease = (await a("claim_todo", { id: prerequisite }))
      .structuredContent;
    await a("complete_todo", {
      id: prerequisite,
      token: prereqLease.token,
      summary: "Synthetic prerequisite complete",
    });
    expect(
      (await b("fetch", { id })).structuredContent.metadata.blocked_on,
    ).toBe("Independent synthetic manual decision");
    const race = await Promise.all([
      a("claim_todo", { id, ttl_seconds: 5 }),
      b("claim_todo", { id, ttl_seconds: 5 }),
    ]);
    expect(race.filter((r) => !r.isError)).toHaveLength(1);
    const winner = race[0].isError ? b : a;
    const loser = race[0].isError ? a : b;
    const lease = race.find((r) => !r.isError)!.structuredContent;
    await winner("update_todo", {
      id,
      token: lease.token,
      body: "Cross-client progress observed",
    });
    await expect
      .poll(
        async () =>
          (await loser("claim_todo", { id, ttl_seconds: 60 })).isError,
        { timeout: 10_000, intervals: [1000] },
      )
      .not.toBe(true);
    expect(
      (
        await winner("update_todo", {
          id,
          token: lease.token,
          body: "Stale must not land",
        })
      ).isError,
    ).toBe(true);
    await visit(page, `${list}&open=${encodeURIComponent(id)}`);
    await expect(pane.getByRole("region", { name: "History" })).toContainText(
      "Cross-client progress observed",
    );
    const row = rowFor(page, id);
    const top = (await row.boundingBox())!.y;
    const circle = row.locator(".todo-head").getByRole("checkbox");
    await circle.click();
    await expect(circle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(
        async () => (await b("fetch", { id })).structuredContent.metadata.state,
      )
      .toBe("done");
    await circle.click();
    await expect(circle).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(
        async () => (await b("fetch", { id })).structuredContent.metadata.state,
      )
      .toBe("pending");
    // A reopened to-do does not keep reading as completed.
    for (const status of await row.getByTestId("todo-status").all())
      await expect(status).not.toContainText("Completed");
    expect(await page.locator(".todo-open").allTextContents()).toEqual(
      rowsBefore,
    );
    expect(Math.abs((await row.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
    expect(openId(page)).toBe(id);
  } finally {
    await info.attach("j3-fixtures.json", {
      contentType: "application/json",
      body: Buffer.from(
        JSON.stringify({
          project,
          fixtures,
          clients: ["j3-agent-a", "j3-agent-b"],
          origin: baseURL,
          cleanup: "isolated supervisor state removed on exit",
          proof:
            "local browser + two HTTP MCP contexts; no real-device or deployed OAuth proof",
        }),
      ),
    });
    await contextA.dispose();
    await contextB.dispose();
  }
});

for (const width of [320, 390])
  test(`J3 phone emulation ${width}px: half/full sheet, drag alternative, focus and list handoff`, async ({
    browser,
    request,
    baseURL,
  }, info) => {
    const a = client(request, "j3-mobile-fixture");
    const project = `j3-phone-${width}-${crypto.randomUUID().slice(0, 6)}`;
    const ids: string[] = [];
    for (const title of ["J3 phone older", "J3 phone newer"])
      ids.push(
        (
          await a("create_todo", {
            title,
            project,
            body: "Synthetic phone draft",
          })
        ).structuredContent.id,
      );
    const context = await browser.newContext({
      baseURL,
      viewport: { width, height: 844 },
      hasTouch: true,
      isMobile: true,
      reducedMotion: "reduce",
    });
    try {
      const page = await context.newPage();
      await signIn(page);
      await visit(page, `/todos?project=${project}`);
      const row = rowFor(page, ids[1]);
      await row.scrollIntoViewIfNeeded();
      await page.evaluate("window.scrollBy(0, 180)");
      await row.locator(".todo-open").click();
      const pane = page.locator("dialog.modal-pane");
      await expect(pane).toHaveAttribute("data-sheet-height", "half");
      const sheetBox = (await pane.boundingBox())!;
      expect(sheetBox.height).toBeCloseTo(422, 0);
      // The tapped row stays in sight above the half sheet, not under it.
      const opened = (await row.boundingBox())!;
      expect(opened.y).toBeGreaterThanOrEqual(0);
      expect(opened.y + opened.height).toBeLessThanOrEqual(sheetBox.y + 1);
      await expect(pane.locator(".pane-grip")).toBeHidden();
      await info.attach(`sheet-half-${width}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      const grip = pane.getByRole("button", {
        name: "Expand to-do sheet",
        exact: true,
      });
      expect((await grip.boundingBox())!.height).toBeGreaterThanOrEqual(24);
      await grip.focus();
      await page.keyboard.press("Enter");
      await expect(pane).toHaveAttribute("data-sheet-height", "full");
      expect((await pane.boundingBox())!.y).toBeGreaterThan(0);
      await info.attach(`sheet-full-${width}.png`, {
        body: await page.screenshot(),
        contentType: "image/png",
      });
      await pane
        .getByRole("button", { name: "Show half-height to-do sheet" })
        .click();
      await expect(pane).toHaveAttribute("data-sheet-height", "half");
      await pane.getByRole("link", { name: "Edit body" }).click();
      const body = pane.getByRole("textbox", { name: "Body", exact: true });
      await expect(body).toBeFocused();
      await expect(pane).toHaveAttribute("data-sheet-height", "full");
      await body.fill("Mobile edited jk");
      await pane.getByRole("button", { name: "Save", exact: true }).click();
      await expect(body).toHaveCount(0);
      await pane
        .getByRole("button", { name: "Show half-height to-do sheet" })
        .click();
      const comment = pane.getByRole("textbox", {
        name: "Comment on J3 phone newer",
      });
      await comment.fill("Mobile comment");
      await expect(comment).toBeFocused();
      await expect(pane).toHaveAttribute("data-sheet-height", "full");
      await pane.getByRole("button", { name: "Comment", exact: true }).click();
      await expect(comment).toHaveValue("");
      const gripBox = (await pane.locator(".sheet-grip").boundingBox())!;
      await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 12);
      await page.mouse.down();
      await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + 100, {
        steps: 5,
      });
      await page.mouse.up();
      await expect(pane).toHaveAttribute("data-sheet-height", "half");
      // Scroll the independent list above the sheet, then tap another row.
      await page.evaluate(
        `document.querySelector('.todo-list').scrollIntoView()`,
      );
      await rowFor(page, ids[0]).locator(".todo-open").click();
      await expect(pane).toHaveAccessibleName("J3 phone older");
      await expect(pane).toHaveAttribute("data-sheet-height", "half");
      await expect(pane.locator(".todo-title .pen")).toHaveCSS("opacity", "1");
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await pane.getByRole("button", { name: "Close", exact: true }).click();
      await expect(pane).toHaveCount(0);
      const fetched = (await a("fetch", { id: ids[1] })).structuredContent;
      expect(fetched.text).toBe("Mobile edited jk");
      expect(
        fetched.metadata.updates.some(
          (u: { body?: string }) => u.body === "Mobile comment",
        ),
      ).toBe(true);
      await info.attach("phone-emulation.json", {
        contentType: "application/json",
        body: Buffer.from(
          JSON.stringify({ ids, project, width, physicalDevice: false }),
        ),
      });
    } finally {
      await context.close();
    }
  });

test("J3 native 320px: full-screen fallback, next link, edit/comment and close", async ({
  browser,
  request,
  baseURL,
}) => {
  const a = client(request, "j3-native-fixture");
  const project = `j3-native-${crypto.randomUUID().slice(0, 6)}`;
  const older = (
    await a("create_todo", {
      title: "J3 native older",
      project,
      body: "Native original",
    })
  ).structuredContent.id;
  const newer = (await a("create_todo", { title: "J3 native newer", project }))
    .structuredContent.id;
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    viewport: { width: 320, height: 844 },
  });
  try {
    const page = await context.newPage();
    await signIn(page, "/todos", false);
    await visit(
      page,
      `/todos?project=${project}&open=${encodeURIComponent(newer)}`,
      false,
    );
    const pane = page.locator("dialog.modal-pane");
    await expect(pane.locator(".sheet-grip")).toHaveCount(0);
    expect((await pane.boundingBox())!.height).toBeGreaterThan(800);
    await pane.getByRole("link", { name: "j Next", exact: true }).click();
    expect(openId(page)).toBe(older);
    await pane.getByRole("link", { name: "Edit body", exact: true }).click();
    await pane
      .getByRole("textbox", { name: "Body", exact: true })
      .fill("Native changed");
    await pane.getByRole("button", { name: "Save", exact: true }).click();
    await pane
      .getByRole("textbox", { name: "Comment on J3 native older" })
      .fill("Native comment");
    await pane.getByRole("button", { name: "Comment", exact: true }).click();
    const fetched = (await a("fetch", { id: older })).structuredContent;
    expect(fetched.text).toBe("Native changed");
    expect(
      fetched.metadata.updates.some(
        (u: { body?: string }) => u.body === "Native comment",
      ),
    ).toBe(true);
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await pane.getByRole("link", { name: "Close", exact: true }).click();
    await expect(pane).toHaveCount(0);
    expect(new URL(page.url()).searchParams.get("project")).toBe(project);
  } finally {
    await context.close();
  }
});
