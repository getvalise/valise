import type { APIRequestContext, Page } from "@playwright/test";
import {
  installLegacyReviewSettings,
  installPrincipleCards,
  installRankingStop,
  installReviewFixtures,
  installUpkeepRun,
  principleFixtureState,
  removePrincipleFixtures,
  removeRankingStop,
  removeReviewFixtures,
  reviewFixtureState,
  UI_PRINCIPLES,
  UI_REVIEWS,
} from "./fixtures/memory-review.mjs";
import { expect, hydrated, mcp, seed, signIn, test } from "./fixtures/session";

const review = "/memories?tab=review";

/** Model, limits and ranking sit in one Advanced disclosure (J-C); a test that changes them opens it first. */
async function openSettings(page: Page) {
  const settings = page.locator("details", {
    has: page.getByText("Advanced: model, limits and ranking", { exact: true }),
  });
  if (!(await settings.first().evaluate((d) => d.hasAttribute("open"))))
    await page
      .getByText("Advanced: model, limits and ranking", { exact: true })
      .click();
}
const haiku = "anthropic/claude-haiku-5.5";
const sonnet = "anthropic/claude-sonnet-5.5";
const deepseek = "deepseek/deepseek-v4.1-flash-1017";
const offered = [haiku, sonnet, deepseek, "@cf/zai-org/glm-5.3-flash"];
const legacyModels = [
  "@cf/meta/llama-3.1-8b-instruct-fp8",
  "@cf/meta/llama-3.2-3b-instruct",
  "google/gemini-2.5-flash-lite",
];

test.beforeEach(async ({ request, baseURL }) => {
  await seed(request);
  expect(
    (
      await request.post(review, {
        form: { intent: "upkeep", value: "off" },
        headers: { origin: baseURL ?? "" },
      })
    ).ok(),
  ).toBe(true);
  for (const [field, value] of [
    ["overnight", "off"],
    ["enabled", "off"],
    ["model", haiku],
    ["manualMemories", "25"],
    ["upkeepMemories", "50"],
  ])
    expect(
      (
        await request.post(review, {
          form: { intent: "setting", field, value },
          headers: { origin: baseURL ?? "" },
        })
      ).ok(),
    ).toBe(true);
});

test("review settings: consent defaults, keyboard saving, section tabs, and a no-script phone", async ({
  page,
  browser,
  baseURL,
}) => {
  await test.step("drafting is off by default with provider consent and limits", async () => {
    await signIn(page, review);
    await expect(
      page.getByRole("switch", { name: "Allow model reviews" }),
    ).toHaveAttribute("aria-checked", "false");
    // Off, the setup panel holds the consent switch and no check can start (J-C).
    await expect(
      page.getByRole("region", { name: "Set up memory review" }),
    ).toContainText("Claude Haiku 5.5");
    await expect(
      page.getByRole("button", { name: "Check waiting memories" }),
    ).toHaveCount(0);
    await openSettings(page);
    await expect(page.getByLabel("Provider and model")).toHaveValue(haiku);
    const choices = page.getByLabel("Provider and model").locator("option");
    await expect(choices).toHaveCount(4);
    for (const [index, hint] of [
      "Claude Haiku 5.5 (default) — up to $0.0032 per call",
      "Claude Sonnet 5.5 — up to $0.0634 per call",
      "DeepSeek V4.1 Flash 1017 — up to $0.0090 per call",
      "GLM 5.3 Flash — up to $0.0056 per call",
    ].entries()) {
      await expect(choices.nth(index)).toHaveAttribute("value", offered[index]);
      await expect(choices.nth(index)).toContainText(hint);
    }
    await expect(
      page.locator(
        'form:has(input[name="intent"][value="setting"]) input[name="expectedModel"]',
      ),
    ).toHaveCount(1);
    await expect(
      page.locator(
        'form:has(input[name="intent"][value="ranking-setting"]) input[name="expectedModel"]',
      ),
    ).toHaveCount(1);
    // Every limit is in one form with one Save (tdo_cd737945).
    const limits = page.getByRole("form", { name: "Daily limits" });
    await expect(limits.getByRole("button")).toHaveCount(1);

    for (const field of await page.locator('input[name="expectedModel"]').all())
      await expect(field).toHaveValue(haiku);
    await expect(
      page.getByText("Changing model turns reviews and nightly upkeep off", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Nightly upkeep adds summaries that only add to your memories and asks you about the rest.",
        { exact: false },
      ),
    ).toBeVisible();
    await expect(
      page
        .getByRole("navigation", { name: "Workspace", exact: true })
        .getByRole("link", { name: "Memory inbox", exact: true }),
    ).toHaveCount(0);
    await expect(
      page
        .getByRole("navigation", { name: "Memories sections" })
        .getByRole("link", { name: "Review", exact: true }),
    ).toHaveAttribute("aria-current", "page");
    const before = page.url();
    await page.getByRole("switch", { name: "Allow model reviews" }).click();
    await expect(
      page.getByRole("switch", { name: "Allow model reviews" }),
    ).toHaveAttribute("aria-checked", "true");
    expect(page.url()).toBe(before);
    await page.getByRole("switch", { name: "Allow model reviews" }).click();
    await expect(
      page.getByRole("switch", { name: "Allow model reviews" }),
    ).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByRole("button", { name: "Check waiting memories" }),
    ).toHaveCount(0);
  });
  await test.step("keyboard settings, provider saving and the overnight refusal", async () => {
    const toggle = page.getByRole("switch", { name: "Allow model reviews" });
    await toggle.focus();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await openSettings(page);
    await page.getByLabel("Provider and model").selectOption(haiku);
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(page.getByLabel("Provider and model")).toHaveValue(haiku);
    // No provider call: the manual run button is never pressed in this suite.
    // This suite has no provider key, so nightly upkeep cannot be turned on (J-0).
    await expect(
      page.getByRole("switch", { name: "Tidy my memories every night" }),
    ).toBeDisabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
  });
  await test.step("section tabs by keyboard, reloadable, with phone-size targets", async () => {
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 800 });
      const sections = page.getByRole("navigation", {
        name: "Memories sections",
      });
      // Nothing waiting draws no figure. Review fixtures from another test
      // in this worker may still be installed, so read the store first.
      if (
        !(await reviewFixtureState(baseURL ?? "")).groups.some(
          (g: { state: string }) => g.state === "proposal",
        )
      )
        await expect(sections.locator(".subnav-count")).toHaveCount(0);
      for (const link of await sections.getByRole("link").all()) {
        const box = await link.boundingBox();
        expect(box?.height).toBeGreaterThanOrEqual(24);
        expect(box?.width).toBeGreaterThanOrEqual(24);
      }
      await sections
        .getByRole("link", { name: "All memories", exact: true })
        .focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/memories$/);
      await expect(
        sections.getByRole("link", { name: "All memories", exact: true }),
      ).toHaveAttribute("aria-current", "page");
      await sections.getByRole("link", { name: "Review", exact: true }).focus();
      await page.keyboard.press("Enter");
      await expect(page).toHaveURL(/\/memories\?tab=review$/);
      await page.reload();
      await expect(
        page.getByRole("switch", { name: "Allow model reviews" }),
      ).toBeVisible();
      expect(
        await page.evaluate<boolean>(
          "document.documentElement.scrollWidth <= window.innerWidth",
        ),
      ).toBe(true);
      await test.info().attach(`memories-review-${width}px`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: "image/png",
      });
    }
  });
  await test.step("works without scripting and fits a narrow viewport", async () => {
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      viewport: { width: 320, height: 740 },
    });
    const page = await context.newPage();
    await signIn(page, review, false);
    await openSettings(page);
    const picker = page.getByLabel("Provider and model");
    await picker.selectOption(sonnet);
    await page.getByRole("button", { name: "Save provider" }).click();
    await expect(picker).toHaveValue(sonnet);
    await expect(
      page.locator('input[name="expectedModel"]').first(),
    ).toHaveValue(sonnet);
    const toggle = page.getByRole("switch", { name: "Allow model reviews" });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "true");
    await expect(
      page.getByRole("switch", { name: "Tidy my memories every night" }),
    ).toBeDisabled();
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect(
      page.getByRole("button", { name: "Check waiting memories" }),
    ).toHaveCount(0);
    expect(
      await page.evaluate<boolean>(
        "document.documentElement.scrollWidth <= window.innerWidth",
      ),
    ).toBe(true);
    await context.close();
  });
});

for (const selected of legacyModels) {
  for (const scripted of [true, false]) {
    test(`preserves saved ${selected}, revokes changed-model consent and rejects stale ON (${scripted ? "enhanced" : "native"})`, async ({
      browser,
      baseURL,
      request,
    }) => {
      if (!baseURL) throw new Error("UI baseURL missing");
      await installLegacyReviewSettings(baseURL, selected);
      const before = await reviewFixtureState(baseURL);
      const context = await browser.newContext({
        baseURL,
        javaScriptEnabled: scripted,
        viewport: { width: scripted ? 1280 : 320, height: 800 },
      });
      try {
        const page = await context.newPage();
        await signIn(page, review, scripted);
        await openSettings(page);
        const picker = page.getByLabel("Provider and model");
        await expect(picker).toHaveValue(selected);
        expect(
          await Promise.all(
            (await picker.locator("option").all()).map((option) =>
              option.getAttribute("value"),
            ),
          ),
        ).toEqual([...offered, selected]);
        await expect(picker.locator("option:checked")).toContainText(
          "saved legacy choice",
        );
        await expect(
          page.getByRole("switch", { name: "Allow model reviews" }),
        ).toHaveAttribute("aria-checked", "true");
        // Overnight drafts from before nightly upkeep: drafted, never applied (J-0).
        await expect(
          page.getByText("An earlier setting drafts suggestions at night", {
            exact: false,
          }),
        ).toBeVisible();
        await page.getByRole("button", { name: "Save provider" }).click();
        await expect
          .poll(async () => (await reviewFixtureState(baseURL)).settings)
          .toMatchObject({ model: selected, enabled: 1, overnight: 1 });
        await openSettings(page);
        await picker.selectOption(haiku);
        await page.getByRole("button", { name: "Save provider" }).click();
        await expect(
          page.getByRole("switch", { name: "Allow model reviews" }),
        ).toHaveAttribute("aria-checked", "false");
        // Off, the page is the setup panel again, with nightly upkeep off.
        await expect(
          page.getByRole("switch", { name: "Tidy my memories every night" }),
        ).toHaveAttribute("aria-checked", "false");
        await expect(picker).toHaveValue(haiku);
        await expect(picker.locator("option")).toHaveCount(4);
        const options = { headers: { origin: baseURL } };
        for (const expectedModel of [selected, null]) {
          const form: Record<string, string> = {
            intent: "setting",
            field: "enabled",
            value: "on",
          };
          if (expectedModel !== null) form.expectedModel = expectedModel;
          const stale = await request.post(review, {
            ...options,
            form,
          });
          expect(stale.status()).toBe(409);
          expect(await stale.text()).toContain("Reload review settings");
        }
        expect((await reviewFixtureState(baseURL)).settings).toMatchObject({
          model: haiku,
          enabled: 0,
          overnight: 0,
        });
        const overnight = await request.post("/memories?tab=review", {
          ...options,
          form: {
            intent: "upkeep",
            value: "on",
            expectedModel: selected,
          },
        });
        // A stale nightly opt-in names the old model and is refused (J-0).
        expect(overnight.status()).toBe(409);
        expect(await overnight.text()).toContain("Reload review settings");
        const fresh = await request.post(review, {
          ...options,
          form: {
            intent: "setting",
            field: "enabled",
            value: "on",
            expectedModel: haiku,
          },
        });
        expect(fresh.ok()).toBe(true);
        expect((await reviewFixtureState(baseURL)).settings).toMatchObject({
          model: haiku,
          enabled: 1,
          overnight: 0,
        });
        const off = await request.post(review, {
          ...options,
          form: {
            intent: "setting",
            field: "enabled",
            value: "off",
            expectedModel: selected,
          },
        });
        expect(off.ok()).toBe(true);
        const after = await reviewFixtureState(baseURL);
        expect(after.settings).toMatchObject({
          model: haiku,
          enabled: 0,
          overnight: 0,
        });
        expect(after.budgets).toEqual(before.budgets);
        expect(after.groups).toEqual(before.groups);
        await page.reload();
        await expect(
          page.getByRole("switch", { name: "Allow model reviews" }),
        ).toHaveAttribute("aria-checked", "false");
        expect(
          await page.evaluate(
            "document.documentElement.scrollWidth <= innerWidth",
          ),
        ).toBe(true);
      } finally {
        await context.close();
      }
    });
  }
}

test("refuses a new legacy selection and stops missing OpenRouter before accounting or draft admission", async ({
  page,
  request,
  baseURL,
}) => {
  if (!baseURL) throw new Error("UI baseURL missing");
  await signIn(page, review);
  await openSettings(page);
  const picker = page.getByLabel("Provider and model");
  // This ordinary suite has no optional OpenRouter key. Fail here rather than ever probing a configured provider.
  await expect(picker.locator("option:checked")).toContainText(
    "not configured",
  );
  await expect(
    page.getByText("Ask the operator to configure OPENROUTER_API_KEY", {
      exact: false,
    }),
  ).toBeVisible();
  const before = await reviewFixtureState(baseURL);
  for (const selected of legacyModels) {
    const refused = await request.post("/memories?tab=review", {
      headers: { origin: baseURL },
      form: { intent: "setting", field: "model", value: selected },
    });
    expect(refused.status()).toBe(409);
    expect(await refused.text()).toContain(
      "Legacy choices can only be retained unchanged",
    );
  }
  await page.getByRole("switch", { name: "Allow model reviews" }).click();
  await expect(
    page.getByRole("switch", { name: "Allow model reviews" }),
  ).toHaveAttribute("aria-checked", "true");
  await expect(
    page.getByRole("button", { name: "Check waiting memories" }),
  ).toBeDisabled();
  const refused = await request.post("/memories?tab=review", {
    headers: { origin: baseURL },
    form: { intent: "run", via: "fetcher" },
  });
  expect(refused.ok()).toBe(true);
  expect(await refused.text()).toContain("OPENROUTER_API_KEY");
  const after = await reviewFixtureState(baseURL);
  expect(after.settings).toMatchObject({
    model: haiku,
    enabled: 1,
    overnight: 0,
  });
  expect(after.budgets).toEqual(before.budgets);
  expect(after.groups).toEqual(before.groups);
  await page.getByRole("switch", { name: "Allow model reviews" }).click();
  await expect(
    page.getByRole("switch", { name: "Allow model reviews" }),
  ).toHaveAttribute("aria-checked", "false");
});

async function searchIds(
  request: APIRequestContext,
  marker: string,
): Promise<string[]> {
  const response = await request.get(
    `/__dev/search?q=${marker}&concept=memory&user=local&limit=100`,
  );
  expect(response.ok()).toBe(true);
  const body = await response.json();
  return body.hits.map((hit: { docKey: string }) => hit.docKey);
}

async function openReview(
  page: Page,
  fixture: (typeof UI_REVIEWS)["summary"],
  scripting = true,
) {
  await page.goto(`/memories?tab=review&open=${fixture.groupId}`);
  if (scripting) await hydrated(page);
  const card = page.locator("li.item-row").filter({
    has: page.getByRole("link", { name: fixture.title, exact: true }),
  });
  await expect(
    card.getByRole("region", { name: "Source evidence" }),
  ).toBeVisible();
  return card;
}

test.describe("evidence-backed human review", () => {
  test.beforeAll(async ({ baseURL }) => {
    if (!baseURL) throw new Error("UI baseURL missing");
    await installReviewFixtures(baseURL);
  });
  test.afterAll(async ({ baseURL }) => {
    if (baseURL) await removeReviewFixtures(baseURL);
  });

  test("the Review section carries the waiting-question count on every Memories page", async ({
    page,
    baseURL,
  }) => {
    if (!baseURL) throw new Error("UI baseURL missing");
    // Other tests in this worker decide fixtures, so the expected figure is
    // read from the store rather than assumed.
    const waiting = async () =>
      (await reviewFixtureState(baseURL)).groups.filter(
        (g: { state: string }) => g.state === "proposal",
      ).length;
    const expected = await waiting();
    expect(expected).toBeGreaterThan(0);
    for (const [path, width] of [
      ["/memories", 1280],
      ["/memories/subjects", 1280],
      [review, 1280],
      ["/memories", 390],
    ] as const) {
      await page.setViewportSize({ width, height: 800 });
      await signIn(page, path);
      const link = page
        .getByRole("navigation", { name: "Memories sections" })
        .getByRole("link", { name: "Review", exact: true });
      await expect(link).toBeVisible();
      await expect(link).toHaveAccessibleDescription(
        expected === 1 ? "1 question waiting" : `${expected} questions waiting`,
      );
      await expect(link.locator(".subnav-count")).toHaveText(String(expected));
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await test.info().attach(`memories-sections-${width}px${path}`, {
        body: await page
          .getByRole("navigation", { name: "Memories sections" })
          .screenshot(),
        contentType: "image/png",
      });
    }
  });

  test("reads source history and accepts a selected subset into a stable subject", async ({
    page,
  }) => {
    await signIn(page, review);
    await openReview(page, UI_REVIEWS.subject);
    await page
      .getByRole("link", { name: "Previous reviews (1)", exact: true })
      .first()
      .click();
    const history = page.getByRole("dialog", { name: /Previous reviews:/ });
    await expect(history.getByRole("table")).toBeVisible();
    await expect(history).toContainText("Compared only");
    await expect(history).toContainText("same evidence");
    await page.screenshot({
      path: test.info().outputPath("review-source-history-1280.png"),
    });
    await page.setViewportSize({ width: 320, height: 900 });
    const decisionTable = history.getByRole("region", {
      name: "Previous review decisions",
      exact: true,
    });
    await decisionTable.focus();
    await decisionTable.press("ArrowRight");
    await expect
      .poll(() =>
        decisionTable.evaluate((node) =>
          Number(Reflect.get(node, "scrollLeft")),
        ),
      )
      .toBeGreaterThan(0);
    await decisionTable.evaluate((node) =>
      Reflect.set(node, "scrollLeft", Reflect.get(node, "scrollWidth")),
    );
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("review-source-history-320.png"),
    });
    await page.setViewportSize({ width: 1280, height: 900 });
    await history.getByRole("button", { name: "Close", exact: true }).click();
    await page
      .getByRole("link", {
        name: "Accept and organize as subject",
        exact: true,
      })
      .click();
    const modal = page.getByRole("dialog", {
      name: "Accept and organize as subject",
      exact: true,
    });
    await modal
      .getByRole("textbox", { name: "New subject name", exact: true })
      .fill("UI review subject — Kestrel pilot transport");
    await modal
      .getByRole("checkbox", {
        name: "Synthetic subject source 2",
        exact: true,
      })
      .uncheck();
    await modal
      .getByRole("checkbox", {
        name: /Make the accepted memory the current summary/,
      })
      .check();
    await modal
      .getByRole("button", { name: "Accept and organize", exact: true })
      .focus();
    await page.screenshot({
      path: test.info().outputPath("review-subject-primary-1280.png"),
    });
    await modal
      .getByRole("button", { name: "Accept and organize", exact: true })
      .click();
    await expect(
      page.getByRole("link", { name: "Open subject", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Accept new memory", exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: "Open subject", exact: true }).click();
    await expect(
      page.getByRole("heading", {
        name: "UI review subject — Kestrel pilot transport",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByText(UI_REVIEWS.subject.body, { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "Synthetic subject source 1",
        exact: true,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", {
        name: "Synthetic subject source 2",
        exact: true,
      }),
    ).toHaveCount(0);
  });

  test("subject organization retains a native 320px form and never authorizes ranking", async ({
    page,
    browser,
    baseURL,
  }) => {
    const native = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: 320, height: 900 },
      storageState: await page.context().storageState(),
    });
    try {
      const phone = await native.newPage();
      await signIn(phone, review, false);
      await openReview(phone, UI_REVIEWS["subject-native"], false);
      await phone
        .getByRole("link", {
          name: "Accept and organize as subject",
          exact: true,
        })
        .click();
      const modal = phone.getByRole("dialog", {
        name: "Accept and organize as subject",
        exact: true,
      });
      await modal
        .getByRole("textbox", { name: "New subject name", exact: true })
        .fill("UI review subject native pilot");
      await modal
        .getByRole("checkbox", {
          name: /Make the accepted memory the current summary/,
        })
        .check();
      await modal
        .getByRole("button", { name: "Accept and organize", exact: true })
        .scrollIntoViewIfNeeded();
      expect(
        await phone.evaluate(
          "document.documentElement.scrollWidth<=innerWidth",
        ),
      ).toBe(true);
      await phone.screenshot({
        path: test.info().outputPath("review-subject-primary-320.png"),
      });
      await modal
        .getByRole("button", { name: "Accept and organize", exact: true })
        .click();
      await expect(
        phone.getByRole("link", { name: "Open subject", exact: true }),
      ).toBeVisible();
      await phone.goto(`${baseURL}${review}`);
      await openSettings(phone);
      const ranking = phone.getByRole("switch", {
        name: "Allow Workers AI + Jev candidate ranking",
        exact: true,
      });
      await expect(ranking).toHaveAttribute("aria-checked", "false");
    } finally {
      await native.close();
    }
  });

  test("a first-time reader can understand the process, inspect no-change history and distinguish a failed review", async ({
    page,
    request,
    baseURL,
  }) => {
    await signIn(page, review);
    await expect(
      page.getByText("and asks you where they conflict.", {
        exact: false,
      }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "No change suggested", exact: true }),
    ).toHaveCount(0);
    await expect(page.locator("li.item-row")).toHaveCount(30);
    // A failure is not a question: it is listed under All activity (J-0).
    await expect(
      page.getByRole("link", { name: "Review could not finish", exact: true }),
    ).toHaveCount(0);
    await page.getByText("How memory review works", { exact: true }).click();
    await expect(
      page.getByText("accepting keeps the originals", {
        exact: false,
      }),
    ).toBeVisible();
    await openSettings(page);
    // A person sets counts; money is an admin's cap and has no field here
    // (ADR-0012, 2026-11-04 limits).
    const limits = page.getByRole("form", { name: "Daily limits" });
    await expect(limits.locator("input:not([type=hidden])")).toHaveCount(2);
    await expect(limits.getByLabel(/USD/)).toHaveCount(0);
    await expect(page.getByLabel(/USD/)).toHaveCount(0);
    const byHand = page.getByLabel("Memories checked by hand a day (1–100)");
    await expect(byHand).toHaveValue("25");
    await expect(
      page.getByLabel("Memories checked each night (1–200)"),
    ).toHaveValue("50");
    await byHand.fill("40");
    await page.getByRole("button", { name: "Save limits" }).click();
    await expect
      .poll(
        async () =>
          (await reviewFixtureState(baseURL!)).settings?.manual_memories,
      )
      .toBe(40);
    // One Save posts both counts, but writes only what changed, and refuses a
    // form whose shown value is no longer current (P2).
    const stale = await request.post(review, {
      headers: { origin: baseURL! },
      form: {
        intent: "limits",
        expectedModel: haiku,
        manualMemories: "3",
        wasManualMemories: "7",
        upkeepMemories: "50",
        wasUpkeepMemories: "50",
      },
    });
    expect(stale.status()).toBe(409);
    expect((await reviewFixtureState(baseURL!)).settings?.manual_memories).toBe(
      40,
    );
    for (const value of ["0", "101", "2.5", "NaN"]) {
      const refused = await request.post(review, {
        headers: { origin: baseURL! },
        form: { intent: "setting", field: "manualMemories", value },
      });
      expect(refused.status()).toBe(409);
    }
    // The money fields a person could post before are gone, not ignored.
    const moneyForms: Record<string, string>[] = [
      { intent: "setting", field: "dailyUsd", value: "0.5" },
      { intent: "setting", field: "dailyMicrousd", value: "500000" },
      {
        intent: "ranking-setting",
        field: "dailyMicrousd",
        value: "100000",
        revision: "0",
        destination: "x",
        expectedModel: haiku,
      },
    ];
    for (const form of moneyForms) {
      const refused = await request.post(review, {
        headers: { origin: baseURL! },
        form,
      });
      expect(refused.status()).toBe(400);
    }
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(review);
      await page.evaluate("window.scrollTo(0,0)");
      await expect(
        page.getByRole("link", { name: UI_REVIEWS.summary.title, exact: true }),
      ).toBeVisible();
      expect(
        await page.evaluate<boolean>(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await test.info().attach(`review-default-${width}`, {
        body: await page.screenshot({
          path: test.info().outputPath(`review-default-${width}.png`),
          fullPage: false,
        }),
        contentType: "image/png",
      });
    }
    await page.getByRole("link", { name: "All activity", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Review could not finish", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(
        "The model's source quotes or references could not be verified.",
      ),
    ).toBeVisible();
    await page
      .getByRole("link", { name: "No change suggested", exact: true })
      .click();
    await expect(page).toHaveURL(/view=all/);
    await expect(
      page.getByRole("region", { name: "Source evidence" }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "Accept new memory" }),
    ).toHaveCount(0);
    await page
      .getByText("Model response and review history", { exact: true })
      .click();
    await expect(
      page.getByText("Original model response", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText("No human edits or decisions recorded.", { exact: true }),
    ).toBeVisible();
  });

  test("a long proposed body shows its first lines until asked for the rest", async ({
    page,
  }) => {
    const fixture = UI_REVIEWS["volume-5"];
    await signIn(page, review);
    const card = await openReview(page, fixture);
    await card.getByRole("link", { name: "Edit draft body" }).click();
    const lines = Array.from(
      { length: 24 },
      (_, i) => `- ${fixture.marker} line ${i + 1}: a proposed fact.`,
    );
    await card
      .getByRole("textbox", { name: "Draft body" })
      .fill(lines.join("\n"));
    await card.getByRole("button", { name: "Save", exact: true }).click();
    const more = card.getByText("Show the full text", { exact: true });
    await expect(more).toBeVisible();
    const last = card.getByText(lines.at(-1)!.slice(2), { exact: true });
    const region = card.getByRole("region", { name: "Proposed new memory" });
    const clipped = async () =>
      (await last.boundingBox())!.y >
      (await region.boundingBox())!.y + (await region.boundingBox())!.height;
    await more.click();
    await expect(card.getByText("Show less", { exact: true })).toBeVisible();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toBeInViewport();
    expect(await clipped()).toBe(false);
  });
  test("edits an evidence card and accepts a compatible summary without suppressing originals", async ({
    page,
    request,
  }) => {
    const fixture = UI_REVIEWS.summary;
    await signIn(page, review);
    const card = await openReview(page, fixture);
    await expect(card).toContainText("synthetic-ui-fixture");
    const pane = card.getByRole("dialog");
    await expect(pane).toHaveClass(/modal-pane/);
    const paneBox = await pane.boundingBox();
    const rowBox = await card.boundingBox();
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(
      (paneBox?.x ?? 0) + 1,
    );
    await expect(card).toContainText("Revision 1");
    await expect(card).toContainText("Selected as: keyword search match");
    await expect(card.locator("blockquote")).toHaveCount(2);
    await expect(card.locator("blockquote").first()).toHaveText(
      fixture.bodies[0],
    );
    await expect(card.getByRole("checkbox")).toHaveCount(0);
    await card.getByRole("link", { name: "Edit draft body" }).click();
    const draft = `${fixture.marker}: Human-edited summary: ripe apples stay cool, never frozen; pears stay dry, according to the grower.`;
    await card.getByRole("textbox", { name: "Draft body" }).fill(draft);
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByRole("textbox", { name: "Draft body" })).toHaveCount(
      0,
    );
    await expect(card).toContainText(draft);
    await card
      .getByText("Model response and review history", { exact: true })
      .click();
    await expect(
      card.getByText("Original model response", { exact: true }),
    ).toBeVisible();
    // Saved model output is not rewritten by the human draft edit.
    await expect(card.locator("pre").first()).toContainText(fixture.body);
    await expect(card.locator("pre").first()).not.toContainText(draft);
    await expect(card).toContainText("edit-body");
    await card
      .getByText("Model response and review history", { exact: true })
      .click();
    const before = page.url();
    await card.getByRole("button", { name: "Accept new memory" }).focus();
    await test.info().attach("review-primary-action", {
      body: await page.screenshot({
        path: test.info().outputPath("review-primary-action.png"),
        fullPage: false,
      }),
      contentType: "image/png",
    });
    await page.keyboard.press("Enter");
    await expect(card.locator(".pill")).toHaveText("Accepted");
    expect(page.url()).toBe(before);
    const accepted = card.getByRole("link", { name: "Open accepted memory" });
    await expect(accepted).toBeVisible();
    const id = new URL(
      (await accepted.getAttribute("href")) ?? "",
      "http://localhost",
    ).searchParams.get("open");
    expect(id).toMatch(/^memory:mem_/);
    const receipt = await mcp(request, "fetch", { id });
    expect(JSON.stringify(receipt)).toContain(draft);
    expect(JSON.stringify(receipt)).toContain("Human-approved summary");
    expect(JSON.stringify(receipt)).toContain("synthetic-ui-fixture");
    // That the originals stay searchable is test/d1/memory-review.worker.test.ts.
  });

  test("requires the separate retained-truth judgment before consolidation can supersede originals", async ({
    page,
    request,
  }) => {
    const fixture = UI_REVIEWS.consolidation;
    await signIn(page, review);
    const card = await openReview(page, fixture);
    await card
      .getByText("Also replace the originals in search", { exact: true })
      .click();
    await card.getByLabel(/Also supersede the contributing originals/).check();
    await card.getByRole("button", { name: "Accept new memory" }).click();
    await expect(card.getByRole("alert")).toContainText("retained truth");
    await expect(card.locator(".pill")).toHaveText("Waiting");
    expect(await searchIds(request, fixture.marker)).toEqual(
      expect.arrayContaining(fixture.sources.map((s) => `memory:${s}`)),
    );
    await card
      .getByLabel(/I checked that the draft retains everything still true/)
      .focus();
    await page.keyboard.press("Space");
    await card.getByRole("button", { name: "Accept new memory" }).click();
    await expect(card.locator(".pill")).toHaveText("Accepted");
    const hits = await searchIds(request, fixture.marker);
    expect(hits).toHaveLength(1);
    for (const source of fixture.sources)
      expect(hits).not.toContain(`memory:${source}`);
  });

  test("dismisses and reopens in place with the original evidence and draft retained", async ({
    page,
  }) => {
    const fixture = UI_REVIEWS.dismiss;
    await signIn(page, review);
    const card = await openReview(page, fixture);
    const index = (
      await page.locator("li.item-row").allTextContents()
    ).findIndex((text) => text.includes(fixture.title));
    const before = page.url();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached = () => {};
    const posted = new Promise<void>((resolve) => {
      reached = resolve;
    });
    await page.route("**/memories.data?**", async (route) => {
      if (route.request().method() === "POST") {
        reached();
        await held;
      }
      await route.continue();
    });
    await card.getByRole("button", { name: "Dismiss proposal" }).focus();
    await page.keyboard.press("Enter");
    try {
      await posted;
      await expect(card.getByRole("status")).toHaveText("Working…");
      await expect(
        card.getByRole("button", { name: "Dismiss proposal" }),
      ).toBeDisabled();
      expect(page.url()).toBe(before);
    } finally {
      release();
    }
    await expect(card.locator(".pill")).toHaveText("Dismissed");
    await page.unroute("**/memories.data?**");
    expect(page.url()).toBe(before);
    expect(
      (await page.locator("li.item-row").allTextContents()).findIndex((text) =>
        text.includes(fixture.title),
      ),
    ).toBe(index);
    await card.getByRole("button", { name: "Reopen proposal" }).click();
    await expect(card.locator(".pill")).toHaveText("Waiting");
    await expect(card).toContainText(fixture.body);
    await expect(card.locator("blockquote")).toHaveCount(2);
    expect(
      (await page.locator("li.item-row").allTextContents()).findIndex((text) =>
        text.includes(fixture.title),
      ),
    ).toBe(index);
  });

  test("refuses a stale source without losing the edited draft or applying a memory", async ({
    page,
    request,
  }) => {
    const fixture = UI_REVIEWS.stale;
    await signIn(page, review);
    const card = await openReview(page, fixture);
    await card.getByRole("link", { name: "Edit draft body" }).click();
    const draft = `${fixture.marker}: Preserve this human draft through a stale-source refusal.`;
    await card.getByRole("textbox", { name: "Draft body" }).fill(draft);
    await card.getByRole("button", { name: "Save", exact: true }).click();
    await expect(card.getByRole("textbox", { name: "Draft body" })).toHaveCount(
      0,
    );
    await mcp(request, "edit_memory", {
      id: `memory:${fixture.sources[0]}`,
      body: `${fixture.marker}: New explicit qualification; only ripe apples, and do not freeze them.`,
    });
    await card.getByRole("button", { name: "Accept new memory" }).click();
    await expect(card.getByRole("alert")).toContainText(
      "source revision changed",
    );
    await expect(card.locator(".pill")).toHaveText("Waiting");
    await expect(card).toContainText(draft);
    await expect(
      card.getByRole("link", { name: "Open accepted memory" }),
    ).toHaveCount(0);
    expect(await searchIds(request, fixture.marker)).toHaveLength(2);
    await page.reload();
    await expect(card).toContainText(draft);
  });

  test("J-A morning skim: status, draft-first pane, next waiting suggestion and hide decided", async ({
    page,
    request,
    baseURL,
  }) => {
    const allow = await request.post(review, {
      headers: { origin: baseURL! },
      form: {
        intent: "setting",
        field: "enabled",
        value: "on",
        expectedModel: haiku,
      },
    });
    expect(allow.ok()).toBe(true);
    await signIn(page, review);
    const status = page.getByRole("region", { name: "Review status" });
    await expect(status).toContainText(/\d+ questions for you/);
    await expect(status).toContainText(
      "Checks by hand with OpenRouter · Claude Haiku 5.5",
    );
    // This suite has no provider key: the check is visible and cannot start.
    await expect(
      status.getByRole("button", { name: "Check waiting memories" }),
    ).toBeDisabled();
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(review);
      await expect(page.locator("li.item-row")).toHaveCount(30);
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`consolidation-default-${width}.png`),
      });
    }
    const fixture = UI_REVIEWS["volume-2"];
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const card = await openReview(page, fixture);
      const decision = card.getByRole("region", { name: "Decision" });
      const accept = decision.getByRole("button", {
        name: "Accept new memory",
      });
      await expect(accept).toBeVisible();
      // The decision sits between the draft and its evidence (P1, P13).
      const draftBox = await card
        .getByRole("region", { name: "Proposed new memory" })
        .boundingBox();
      const decisionBox = await decision.boundingBox();
      const evidenceBox = await card
        .getByRole("region", { name: "Source evidence" })
        .boundingBox();
      expect(draftBox!.y).toBeLessThan(decisionBox!.y);
      expect(decisionBox!.y).toBeLessThan(evidenceBox!.y);
      // The action and its source memories lead, then why, then the text (tdo_91bc11e8).
      const doing = card.getByRole("region", {
        name: "What this suggestion does",
      });
      await expect(doing).toContainText(/memories?\b.*The originals stay\./);
      await expect(doing.getByRole("listitem")).not.toHaveCount(0);
      const whyBox = await card
        .getByRole("region", { name: "Why" })
        .boundingBox();
      expect((await doing.boundingBox())!.y).toBeLessThan(whyBox!.y);
      expect(whyBox!.y).toBeLessThan(draftBox!.y);
      await expect(card.getByText(/^Revision 1 ·/).first()).toBeHidden();
      await accept.scrollIntoViewIfNeeded();
      await accept.focus();
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`consolidation-primary-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const card = await openReview(page, fixture);
    const index = (
      await page.locator("li.item-row").allTextContents()
    ).findIndex((text) => text.includes(fixture.title));
    await card.getByRole("button", { name: "Dismiss proposal" }).click();
    await expect(card.locator(".pill")).toHaveText("Dismissed");
    const next = card.getByRole("link", { name: /^Next waiting suggestion: / });
    await expect(next).toBeVisible();
    const nextTitle = (await next.textContent())!.replace(
      "Next waiting suggestion: ",
      "",
    );
    await next.click();
    await expect(page).not.toHaveURL(new RegExp(fixture.groupId));
    const following = page.locator("li.item-row").filter({
      has: page.getByRole("link", { name: nextTitle, exact: true }),
    });
    await expect(following.getByRole("dialog")).toBeVisible();
    await expect(following.locator(".pill")).toHaveText("Waiting");
    // The decided row kept its place (P4, P5).
    expect(
      (await page.locator("li.item-row").allTextContents()).findIndex((text) =>
        text.includes(fixture.title),
      ),
    ).toBe(index);
    await page.goto(review);
    const hide = page.getByRole("link", { name: /^Hide decided \(\d+\)$/ });
    await hide.click();
    await expect(page).toHaveURL(/decided=hide/);
    await expect(
      page.getByRole("link", { name: /^Show decided \(\d+\)$/ }),
    ).toBeVisible();
    await expect(
      page.locator("li.item-row .pill", { hasText: /Accepted|Dismissed/ }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: fixture.title, exact: true }),
    ).toHaveCount(0);
    await page.getByRole("link", { name: /^Show decided \(\d+\)$/ }).click();
    await expect(
      page.getByRole("link", { name: fixture.title, exact: true }),
    ).toBeVisible();
  });

  test("J-0 nightly upkeep: last run in words, questions first, applied results with Undo", async ({
    page,
    request,
    baseURL,
  }) => {
    const on = await request.post(review, {
      headers: { origin: baseURL! },
      form: { intent: "upkeep", value: "on", expectedModel: haiku },
    });
    expect(on.ok()).toBe(true);
    expect((await reviewFixtureState(baseURL!)).settings).toMatchObject({
      enabled: 1,
      overnight: 1,
      auto_apply: 1,
      upkeep_memories: 50,
    });
    const started = Date.UTC(2026, 10, 4, 2, 0) / 1000;
    await installUpkeepRun(
      baseURL!,
      {
        startedAt: started,
        finishedAt: started + 840,
        passes: 4,
        scanned: 31,
        calls: 7,
        applied: 6,
        questions: 1,
        failed: 0,
        lessons: 120,
        lessonCalls: 8,
        ended: "done",
      },
      Date.UTC(2099, 0, 1, 2, 0) / 1000,
    );
    await signIn(page, review);
    const status = page.getByRole("region", { name: "Review status" });
    await expect(status).toContainText(
      "Nightly upkeep is on with OpenRouter · Claude Haiku 5.5",
    );
    await expect(status).toContainText(
      "Last run, 4 Nov, 02:00 UTC: compared 31 memories, added 6 summaries, left 1 question for you, wrote 120 lesson lines. Nothing else is waiting.",
    );
    // J-E: lesson-line coverage, a count only; the lines themselves stay out of view.
    await expect(status).toContainText(
      /Lesson lines: \d+ of \d+ memor(y|ies) read, \d+ with a lesson that carries beyond its project\./,
    );
    await expect(status).toContainText("Next run: 1 Jan, 02:00 UTC.");
    await expect(
      status.getByRole("switch", { name: "Tidy my memories every night" }),
    ).toHaveAttribute("aria-checked", "true");
    const views = page.getByRole("navigation", { name: "Review views" });
    await expect(
      views.getByRole("link", { name: /^Questions \(\d+\)$/ }),
    ).toHaveAttribute("aria-current", "page");
    const appliedLink = views.getByRole("link", {
      name: "Applied automatically (6)",
    });
    await expect(appliedLink).toBeVisible();
    // Questions: a conflict reads as one, named by its two memories.
    const conflict = page.getByRole("link", {
      name: "Conflict: Synthetic conflict source 1 vs Synthetic conflict source 2",
      exact: true,
    });
    await expect(conflict).toBeVisible();
    await expect(
      page.locator("li.item-row .pill", { hasText: /^Applied$/ }),
    ).toHaveCount(0);
    for (const width of [1280, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(review);
      await expect(status).toBeVisible();
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`upkeep-default-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    await appliedLink.click();
    await expect(page).toHaveURL(/view=applied/);
    await expect(page.locator("li.item-row")).toHaveCount(6);
    await expect(
      page.locator("li.item-row .pill", { hasText: /^Applied$/ }),
    ).toHaveCount(6);
    const fixture = UI_REVIEWS["applied-2"];
    const order = await page.locator("li.item-row").allTextContents();
    const index = order.findIndex((text) => text.includes(fixture.title));
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(
        `/memories?tab=review&view=applied&open=${fixture.groupId}`,
      );
      await hydrated(page);
      const card = page.locator("li.item-row").filter({
        has: page.getByRole("link", { name: fixture.title, exact: true }),
      });
      await expect(card).toContainText(
        "Nightly upkeep wrote one new summary memory from",
      );
      const undo = card.getByRole("button", {
        name: "Undo: archive the added memory",
      });
      await expect(undo).toBeVisible();
      await expect(
        card.getByRole("link", { name: "Open added memory" }),
      ).toBeVisible();
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`upkeep-applied-${width}.png`),
      });
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    const card = page.locator("li.item-row").filter({
      has: page.getByRole("link", { name: fixture.title, exact: true }),
    });
    await card
      .getByRole("button", { name: "Undo: archive the added memory" })
      .click();
    await expect(card.locator(".pill")).toHaveText("Undone");
    await expect(card).toContainText("Undone. The added memory is archived");
    await expect(
      card.getByRole("link", { name: "Open added memory" }),
    ).toHaveCount(0);
    // The undone row keeps its place (P4, P12).
    expect(
      (await page.locator("li.item-row").allTextContents()).findIndex((text) =>
        text.includes(fixture.title),
      ),
    ).toBe(index);
    expect(
      (await reviewFixtureState(baseURL!)).groups.find(
        (g: { group_id: string }) => g.group_id === fixture.groupId,
      ),
    ).toMatchObject({ state: "dismissed" });
    // Turning it off leaves checks by hand.
    await page.goto(review);
    await hydrated(page);
    await status
      .getByRole("switch", { name: "Tidy my memories every night" })
      .click();
    await expect(status).toContainText(
      "Checks by hand with OpenRouter · Claude Haiku 5.5",
    );
    expect((await reviewFixtureState(baseURL!)).settings).toMatchObject({
      enabled: 1,
      overnight: 0,
      auto_apply: 0,
    });
  });

  test("J-B check one memory: the memory pane links to its own suggestions and the check stays bounded", async ({
    page,
    request,
    baseURL,
  }) => {
    const fixture = UI_REVIEWS["volume-3"];
    const memory = fixture.sources[0];
    await signIn(page, `/memories?open=memory%3A${memory}`);
    const line = page.getByRole("link", {
      name: "Memory review: in 1 suggestion",
      exact: true,
    });
    await expect(line).toBeVisible();
    await line.click();
    await expect(page).toHaveURL(new RegExp(`memory=${memory}`));
    const here = page.getByRole("region", { name: "This memory" });
    await expect(here).toContainText("Suggestions that include");
    await expect(page.locator("li.item-row")).toHaveCount(1);
    await expect(
      page.getByRole("link", { name: fixture.title, exact: true }),
    ).toBeVisible();
    // Reviews off: no check, and the consent switch is on the page (P8).
    await expect(
      here.getByRole("button", { name: "Check this memory now" }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("region", { name: "Set up memory review" }),
    ).toBeVisible();
    await page.getByRole("switch", { name: "Allow model reviews" }).click();
    const check = here.getByRole("button", { name: "Check this memory now" });
    await expect(check).toBeVisible();
    await expect(check).toBeDisabled();
    await expect(
      page.getByRole("button", { name: "Check waiting memories" }),
    ).toHaveCount(0);
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 900 });
      expect(
        await page.evaluate(
          "document.documentElement.scrollWidth <= innerWidth",
        ),
      ).toBe(true);
      await page.screenshot({
        path: test.info().outputPath(`consolidation-memory-${width}.png`),
      });
    }
    const before = await reviewFixtureState(baseURL!);
    // Native post: the plain outcome survives the redirect in ?ran=.
    const native = await request.post(`/memories?tab=review&memory=${memory}`, {
      headers: { origin: baseURL! },
      form: { intent: "run", memory },
      maxRedirects: 0,
    });
    expect(native.status()).toBe(302);
    const location = new URL(native.headers().location, baseURL);
    expect(location.searchParams.get("memory")).toBe(memory);
    expect(location.searchParams.get("ran")).toBe("0.0.0.other");
    await page.goto(location.pathname + location.search);
    await expect(page.getByRole("status").first()).toHaveText(
      "The check stopped early. Nothing was applied.",
    );
    const missing = await request.post(review, {
      headers: { origin: baseURL! },
      form: { intent: "run", memory: "mem_absent", via: "fetcher" },
    });
    expect(missing.status()).toBe(409);
    expect(await missing.text()).toContain("cannot be found");
    const after = await reviewFixtureState(baseURL!);
    expect(after.budgets).toEqual(before.budgets);
    expect(after.groups).toEqual(before.groups);
    await page.goto(`${review}&memory=mem_absent`);
    await expect(
      page.getByRole("region", { name: "This memory" }).getByRole("alert"),
    ).toContainText("cannot be found");
    await expect(page.locator("li.item-row")).toHaveCount(0);
  });

  test("reviews a real evidence card end-to-end without scripts at 320px", async ({
    browser,
    baseURL,
    request,
  }) => {
    const context = await browser.newContext({
      baseURL,
      javaScriptEnabled: false,
      viewport: { width: 320, height: 740 },
    });
    try {
      const page = await context.newPage();
      const fixture = UI_REVIEWS.noscript;
      await signIn(page, review, false);
      await page
        .getByRole("navigation", { name: "Memories sections" })
        .getByRole("link", { name: "All memories", exact: true })
        .click();
      await page
        .getByRole("navigation", { name: "Memories sections" })
        .getByRole("link", { name: "Review", exact: true })
        .click();
      // A no-script editor link keeps both the selected card and list depth.
      await page.goto(
        `${review}&limit=60&open=${fixture.groupId}&edit=${fixture.groupId}.body`,
      );
      expect(new URL(page.url()).searchParams.get("limit")).toBe("60");
      await expect(
        page.getByRole("textbox", { name: "Draft body" }),
      ).toBeVisible();
      const card = page.locator("li.item-row").filter({
        has: page.getByRole("link", { name: fixture.title, exact: true }),
      });
      const draft = `${fixture.marker}: Native-form human summary keeps the grower's attribution and ripe-fruit qualification.`;
      await card.getByRole("textbox", { name: "Draft body" }).fill(draft);
      await card.getByRole("button", { name: "Save", exact: true }).click();
      await expect(card).toContainText(draft);
      expect(new URL(page.url()).searchParams.get("limit")).toBe("60");
      expect(new URL(page.url()).searchParams.get("edit")).toBeNull();
      await card.getByRole("button", { name: "Dismiss proposal" }).click();
      await expect(card.locator(".pill")).toHaveText("Dismissed");
      await card.getByRole("button", { name: "Reopen proposal" }).click();
      await card.getByRole("button", { name: "Accept new memory" }).click();
      await expect(card.locator(".pill")).toHaveText("Accepted");
      expect(new URL(page.url()).searchParams.get("tab")).toBe("review");
      expect(new URL(page.url()).searchParams.get("limit")).toBe("60");
      expect(
        await page.evaluate<boolean>(
          "document.documentElement.scrollWidth <= window.innerWidth",
        ),
      ).toBe(true);
      expect(await searchIds(request, fixture.marker)).toHaveLength(3);
      await test.info().attach("memories-review-native-320px", {
        body: await page.screenshot({
          path: test.info().outputPath("review-native-320.png"),
          fullPage: false,
        }),
        contentType: "image/png",
      });
    } finally {
      await context.close();
    }
  });
});

// The owner saw "0 of 8 model calls" beside a ranking stop on 2026-11-04. A
// ranking stop now sits beside the ranking count it hit (ADR-0012, limits).
test("a ranking stop shows the ranking count it hit, not only memory checks", async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page, review);
  const on = await request.post(review, {
    headers: { origin: baseURL! },
    form: {
      intent: "setting",
      field: "enabled",
      value: "on",
      expectedModel: haiku,
    },
  });
  expect(on.ok()).toBe(true);
  await installRankingStop(baseURL!, 50);
  try {
    await page.goto(review);
    const status = page.getByRole("region", { name: "Review status" });
    await expect(status).toContainText("Today: 0 of 25 memory checks by hand.");
    await expect(status).toContainText(
      "Candidate ranking today: 50 of 50 requests by hand.",
    );
    await expect(status).toContainText(
      "Candidate ranking stopped: Today's ranking requests, two for each memory checked, are used up.",
    );
  } finally {
    await removeRankingStop(baseURL!);
  }
});

test("J-E this week's lessons: read a principle card's evidence, adopt it reworded with a to-do, and mark another not a rule", async ({
  page,
  request,
  baseURL,
}) => {
  await removePrincipleFixtures(baseURL!);
  const on = await request.post(review, {
    headers: { origin: baseURL! },
    form: { intent: "upkeep", value: "on", expectedModel: haiku },
  });
  expect(on.ok()).toBe(true);
  await installPrincipleCards(baseURL!);
  try {
    await signIn(page, review);
    const lessons = page.getByRole("region", { name: "This week's lessons" });
    // The cards lead the tab, above the housekeeping status.
    const top = async (name: string) =>
      (await page.getByRole("region", { name }).boundingBox())!.y;
    expect(await top("This week's lessons")).toBeLessThan(
      await top("Review status"),
    );
    const card = lessons.getByRole("article", {
      name: UI_PRINCIPLES.adopt.rule,
    });
    await expect(card).toContainText(
      "Applies when: A script or resource is used by more than one agent session at once.",
    );
    await expect(card).toContainText(
      "3 memories in 2 projects, from 2 sessions",
    );
    await expect(
      card.getByRole("link", { name: "The stash stack is shared" }),
    ).toBeVisible();
    await expect(card).toContainText(
      "Add to the agent instructions: Add to Rules: anything parallel agents share needs a lock",
    );
    await expect(lessons).toContainText(
      "Cards use memory evidence only; agent transcripts are not read.",
    );
    await card.getByText("Evidence, mechanism and exceptions").click();
    await expect(card).toContainText(
      "Mechanism: Concurrent workers corrupt shared mutable state.",
    );
    await expect(card).toContainText(
      "Drafted by OpenRouter · Claude Haiku 5.5",
    );
    await page.screenshot({
      path: test.info().outputPath("principle-cards-1280.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 320, height: 900 });
    expect(
      await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
    ).toBe(true);
    await page.screenshot({
      path: test.info().outputPath("principle-cards-320.png"),
      fullPage: true,
    });
    await page.setViewportSize({ width: 1280, height: 900 });

    const reworded = "Design every shared script for N parallel agents.";
    await card
      .getByRole("textbox", { name: "Rule, as it will be saved" })
      .fill(reworded);
    await expect(
      card.getByRole("checkbox", { name: "Also file a to-do for the change" }),
    ).toBeChecked();
    await card.getByRole("button", { name: "Adopt", exact: true }).click();
    await expect(
      lessons.getByRole("article", { name: UI_PRINCIPLES.adopt.rule }),
    ).toHaveCount(0);
    await lessons.getByText("Adopted principles (1)").click();
    await expect(
      lessons.getByRole("link", { name: reworded, exact: true }),
    ).toBeVisible();

    const other = lessons.getByRole("article", {
      name: UI_PRINCIPLES.reject.rule,
    });
    await expect(
      other.getByRole("checkbox", { name: "Also file a to-do for the change" }),
    ).toHaveCount(0);
    await other.getByText("Not a rule", { exact: true }).first().click();
    await other
      .getByRole("textbox", { name: /Why not/ })
      .fill("Too general to act on.");
    await other
      .getByRole("button", { name: "Not a rule", exact: true })
      .click();
    await expect(other).toHaveCount(0);
    await expect(lessons).toContainText(
      "Marked not a rule: 1. The next reflection reads them and does not propose them again.",
    );

    const state = await principleFixtureState(baseURL!);
    expect(state.principles).toEqual([
      {
        principle_id: UI_PRINCIPLES.adopt.id,
        state: "adopted",
        reason: null,
        memory_type: "decision",
        title: reworded,
        todo: `Apply principle: ${reworded}`,
      },
      {
        principle_id: UI_PRINCIPLES.reject.id,
        state: "rejected",
        reason: "Too general to act on.",
        memory_type: null,
        title: null,
        todo: null,
      },
    ]);
    expect(state.links).toEqual(
      ["mem_ui_principle_0", "mem_ui_principle_1", "mem_ui_principle_2"].map(
        (from_memory_id) => ({
          from_memory_id,
          kind: "part-of",
          asserted_by: "person",
        }),
      ),
    );
  } finally {
    await removePrincipleFixtures(baseURL!);
  }
});
