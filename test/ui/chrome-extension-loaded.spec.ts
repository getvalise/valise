import type { Page } from "@playwright/test";
import { launchExtension } from "./fixtures/extension";
import { itemDetails, showView } from "./fixtures/library";
import { expect, password, test } from "./fixtures/session";

// Setup handles tokens. Capture only explicit, post-save screenshots.
test.use({ trace: "off", screenshot: "off" });

test("loaded MV3 extension leads with sign-in, connects with OAuth in one click, and saves tagged HTML and selected text to Library", async ({
  baseURL,
}, testInfo) => {
  test.setTimeout(240_000);
  const extension = await launchExtension(testInfo.outputPath("extension"));
  const { context, id, grantHost } = extension;
  try {
    const suffix = Math.random().toString(36).slice(2, 10);
    const title = `Loaded capture ${suffix}`;
    const consolePage = await context.newPage();
    await consolePage.goto(`${baseURL}/login?next=/connections`);
    await consolePage.getByLabel("Administrator password").fill(password);
    await consolePage
      .getByRole("button", { name: "Sign in", exact: true })
      .click();
    // The extension id is derived from its path, so a run that stopped early
    // leaves a grant with this name in the shared local store. Clear those.
    const leftovers = consolePage.locator(".todo-card").filter({
      has: consolePage.getByRole("heading", { name: "Valise capture" }),
    });
    for (let left = await leftovers.count(); left > 0; left--) {
      await leftovers
        .first()
        .getByRole("button", { name: "Revoke OAuth connection" })
        .click();
      await expect(leftovers).toHaveCount(left - 1);
    }
    const article = await context.newPage();
    await article.route("https://capture.example.org/article", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><head><title>${title}</title></head><body><h1>Loaded extension article</h1><p>Before. <span id="quote">A durable selected sentence.</span> After.</p>${"<p>The loaded extension reads this paragraph as part of the article, because it is prose rather than navigation, and it repeats so the article clears the detection floor.</p>".repeat(8)}<input value="private-form-secret"></body></html>`,
      }),
    );
    await article.goto("https://capture.example.org/article");
    async function openPopup(ready = true) {
      const popup = await extension.openPopup(article);
      if (ready)
        await expect(popup.locator("#capture")).toHaveAttribute(
          "aria-busy",
          "false",
        );
      return popup;
    }

    // A fresh install leads with sign-in and offers nothing that could save.
    const fresh = await openPopup(false);
    await expect(fresh.locator("#status")).toHaveText("Not connected.");
    await expect(
      fresh.getByRole("button", { name: "Connect to Valise", exact: true }),
    ).toBeVisible();
    await expect(fresh.locator("#sign-in-host")).toHaveText("app.valise.run");
    await expect(fresh.locator("#capture")).toBeHidden();
    await expect(
      fresh.getByRole("button", {
        name: /^(Save article|Save bookmark|Archive full page)$/,
      }),
    ).toBeHidden();
    await expect(
      fresh.getByRole("link", { name: "Open Library" }),
    ).toBeHidden();
    await fresh.screenshot({ path: testInfo.outputPath("not-connected.png") });
    await fresh.close();

    // Point the extension at the local Worker. An endpoint without tokens is
    // what an expired or revoked grant leaves behind.
    const settings = await context.newPage();
    await settings.goto(`chrome-extension://${id}/settings.html`);
    await expect(settings.locator("#not-connected")).toHaveText(
      "Not connected",
    );
    await expect(settings.locator("#connected")).toBeHidden();
    await expect(
      settings.getByRole("button", { name: "Disconnect", exact: true }),
    ).toBeHidden();
    await settings.evaluate(async (endpoint) => {
      const chrome = (
        globalThis as unknown as {
          chrome: {
            storage: {
              local: { set(values: object): Promise<void> };
            };
          };
        }
      ).chrome;
      await chrome.storage.local.set({ valiseConnection: { endpoint } });
    }, `${baseURL}/mcp`);
    await grantHost();
    const local = new URL(baseURL!).host;
    const consentWindow = () =>
      context.waitForEvent("page", {
        predicate: async (page) => {
          await page.waitForLoadState("domcontentloaded");
          return page.url().startsWith(baseURL!);
        },
      });
    async function approve(consent: Page, screenshot?: string) {
      await expect(consent.getByRole("heading", { level: 1 })).toHaveText(
        "Allow the Chrome extension Valise capture to save captures?",
      );
      await expect(consent.locator(".scope-list code")).toHaveText([
        "todos:write",
        "assets:read",
        "assets:write",
        "sources:write",
      ]);
      await expect(consent.getByText(id, { exact: true })).toBeVisible();
      if (screenshot)
        await consent.screenshot({ path: testInfo.outputPath(screenshot) });
      await consent.getByRole("button", { name: "Allow", exact: true }).click();
    }

    // One click in the popup, which never asks for site access itself: the
    // grant is already there, so the Settings tab it opens runs the real
    // launchWebAuthFlow window on the consent page.
    const signIn = await openPopup(false);
    await expect(signIn.locator("#status")).toContainText(
      "Valise ended this extension's connection",
    );
    await expect(signIn.locator("#sign-in-host")).toHaveText(local);
    const firstConsent = consentWindow();
    await signIn
      .getByRole("button", { name: "Connect to Valise", exact: true })
      .click();
    await approve(await firstConsent, "consent.png");
    // The Settings tab closes itself and returns to the page.
    await expect
      .poll(() =>
        context
          .pages()
          .filter((page) => page.url().includes("/settings.html?connect")),
      )
      .toHaveLength(0);
    await consolePage.goto(`${baseURL}/connections`);
    const connection = consolePage.locator(".todo-card").filter({
      has: consolePage.getByRole("heading", { name: "Valise capture" }),
    });
    await expect(connection).toHaveCount(1);
    await expect(connection.locator(".tag")).toHaveText([
      "assets:read",
      "assets:write",
      "sources:write",
      "todos:write",
    ]);
    await expect(connection).toContainText(`https://${id}.chromiumapp.org/`);

    const popup = await openPopup();
    await expect(popup.locator("#selection")).toBeHidden();
    // Note is closed on an unannotated page: the button sits in the save
    // row, on the same line as the two saves, and opens the field focused.
    const noteButton = popup.getByRole("button", { name: "Note", exact: true });
    await expect(popup.getByRole("textbox", { name: "Note" })).toBeHidden();
    await expect(noteButton).toBeEnabled();
    expect((await noteButton.boundingBox())!.y).toBe(
      (await popup.locator("#save").boundingBox())!.y,
    );
    await noteButton.click();
    await expect(noteButton).toBeHidden();
    await expect(popup.getByRole("textbox", { name: "Note" })).toBeFocused();
    await expect(popup.getByRole("textbox", { name: "Note" })).toHaveValue("");
    await popup
      .getByRole("textbox", { name: "Note" })
      .fill("Read before the harbour meeting.");
    await popup.locator("#tag").fill(suffix);
    await popup
      .getByRole("button", { name: "Archive full page", exact: true })
      .click();
    await expect
      .poll(
        async () =>
          (await popup.locator("#error").isVisible()) ||
          (await popup.locator("#status").innerText()).startsWith(
            "Saved article",
          ),
      )
      .toBe(true);
    await popup.screenshot({
      path: testInfo.outputPath("html-result.png"),
      fullPage: true,
    });
    await expect(popup.locator("#error")).toHaveText("");
    // "Saved article" proves the bundled extractor was injected and ran.
    await expect(popup.locator("#status")).toContainText("Saved article (", {
      timeout: 20_000,
    });
    await popup.screenshot({
      path: testInfo.outputPath("html-saved.png"),
      fullPage: true,
    });
    // After the save, a note edit revises the saved source on blur.
    await popup
      .getByRole("textbox", { name: "Note" })
      .fill("Read before the harbour meeting. Bring the map.");
    await popup.getByRole("textbox", { name: "Note" }).blur();
    await expect(popup.locator("#status")).toHaveText("Note saved.");
    await expect(popup.locator("#error")).toBeHidden();
    await popup.close();
    await article.locator("#quote").selectText();
    const highlight = await openPopup();
    await expect(highlight.locator("#selection-quote")).toHaveText(
      "A durable selected sentence.",
    );
    // The page is saved with a note, so Note starts open, on that note.
    await expect(
      highlight.getByRole("button", { name: "Note", exact: true }),
    ).toBeHidden();
    await expect(highlight.getByRole("textbox", { name: "Note" })).toHaveValue(
      "Read before the harbour meeting. Bring the map.",
    );
    await highlight.locator("#tag").fill(suffix);
    await highlight
      .getByRole("button", { name: "Save highlight", exact: true })
      .click();
    await expect(highlight.locator("#status")).toContainText(
      "Saved the highlight.",
    );
    await highlight.screenshot({
      path: testInfo.outputPath("highlight-saved.png"),
      fullPage: true,
    });
    await highlight.close();

    // The page as a to-do: the title comes from the page, the description
    // says what to do, and the to-do links back to the page.
    const todoPopup = await openPopup();
    await todoPopup.getByText("To-do", { exact: true }).click();
    await expect(todoPopup.locator("#article")).toBeHidden();
    await expect(
      todoPopup.getByRole("button", { name: "Archive full page" }),
    ).toBeHidden();
    await expect(todoPopup.getByLabel("Title")).toHaveValue(title);
    const todoTitle = `Book from ${suffix}`;
    await todoPopup.getByLabel("Title").fill(todoTitle);
    await todoPopup
      .getByLabel("Description")
      .fill("Book an appointment before Friday.");
    await todoPopup.getByRole("button", { name: "Add to-do" }).click();
    await expect(todoPopup.locator("#error")).toHaveText(
      "Choose a project for the to-do.",
    );
    await expect(todoPopup.getByLabel("Project (required)")).toBeFocused();
    await todoPopup.getByLabel("Project (required)").fill(`errands-${suffix}`);
    await todoPopup.getByLabel("Tag", { exact: true }).fill(suffix);
    await todoPopup.getByRole("button", { name: "Add to-do" }).click();
    await expect(todoPopup.locator("#status")).toHaveText("Added the to-do.");
    const added = todoPopup.locator("#todo-added").getByRole("link");
    await expect(added).toHaveText(todoTitle);
    await expect(added).toHaveAttribute(
      "href",
      new RegExp(`^${baseURL}/todos\\?open=todo%3Atdo_`),
    );
    await expect(
      todoPopup.getByRole("radio", { name: "Bookmark" }),
    ).toBeDisabled();
    await expect(todoPopup.getByLabel("Description")).toBeDisabled();
    await todoPopup.screenshot({ path: testInfo.outputPath("todo-added.png") });
    const todoHref = await added.getAttribute("href");
    await todoPopup.close();
    await consolePage.goto(todoHref!);
    const pane = consolePage.getByRole("dialog");
    await expect(pane).toContainText(todoTitle);
    await expect(pane).toContainText("Book an appointment before Friday.");
    await expect(
      pane.getByRole("link", { name: "https://capture.example.org/article" }),
    ).toHaveAttribute("href", "https://capture.example.org/article");
    await expect(pane).toContainText(`errands-${suffix}`);
    await expect(pane).toContainText(suffix);

    // A grant kept from 0.7.0 stores no scopes. The bookmark side still
    // saves; the to-do side asks to reconnect instead of failing.
    await settings.evaluate(async () => {
      const local = (
        globalThis as unknown as {
          chrome: {
            storage: {
              local: {
                get(key: string): Promise<Record<string, any>>;
                set(values: object): Promise<void>;
              };
            };
          };
        }
      ).chrome.storage.local;
      const { valiseConnection } = await local.get("valiseConnection");
      delete valiseConnection.oauth.scopes;
      await local.set({ valiseConnection });
    });
    const upgrade = await openPopup();
    await expect(
      upgrade.getByRole("button", { name: /^Save (article|bookmark)$/ }),
    ).toBeEnabled();
    await upgrade.getByText("To-do", { exact: true }).click();
    await expect(upgrade.locator("#todo-reconnect")).toContainText(
      "Adding to-dos needs one more permission.",
    );
    await expect(upgrade.getByLabel("Description")).toBeHidden();
    await expect(
      upgrade.getByRole("button", { name: "Reconnect to Valise" }),
    ).toBeEnabled();
    await upgrade.screenshot({
      path: testInfo.outputPath("todo-reconnect.png"),
    });
    await upgrade.close();
    await consolePage.goto(`${baseURL}/library`);
    // Preview is a native download link until React attaches its handler.
    // Wait for hydration, as the other interactive console tests do.
    await consolePage.waitForFunction(
      "Object.keys(document.body).some((key) => key.startsWith('__reactProps$'))",
    );
    const cards = consolePage.locator(".library-item").filter({
      has: consolePage.getByRole("heading", {
        name: new RegExp(`^${title}( — Highlight)?$`),
      }),
    });
    // The saved page and the highlight are bookmarks; the snapshot is a
    // document, on the other tab.
    await expect(cards).toHaveCount(2);
    for (const card of await cards.all())
      await expect(card.locator(".library-organization .tag")).toHaveText([
        suffix,
      ]);
    await itemDetails(cards.filter({ hasText: `${title} — Highlight` }));
    await expect(
      cards.filter({ hasText: `${title} — Highlight` }),
    ).toContainText("A durable selected sentence.");
    await expect(
      cards.filter({ hasText: `${title} — Highlight` }),
    ).toContainText("Context before:");
    await expect(
      cards.filter({ hasText: `${title} — Highlight` }),
    ).toContainText("Before.");
    await expect(
      cards.filter({ hasText: `${title} — Highlight` }),
    ).toContainText("After.");
    // The note is on the archived page's source, not on the highlight.
    await expect(
      cards.filter({ hasText: `${title} — Highlight` }),
    ).not.toContainText("Bring the map.");
    const pageCard = cards.filter({ hasNotText: `${title} — Highlight` });
    await itemDetails(pageCard);
    await expect(pageCard).toContainText(
      "Read before the harbour meeting. Bring the map.",
    );
    await showView(consolePage, "Documents");
    await expect(cards).toHaveCount(1);
    await expect(cards.locator(".library-organization .tag")).toHaveText([
      suffix,
    ]);
    await cards
      .getByRole("link", { name: `Preview ${title}`, exact: true })
      .click();
    await expect(consolePage.getByRole("dialog").locator("pre")).toContainText(
      "Loaded extension article",
    );
    await expect(
      consolePage.getByRole("dialog").locator("pre"),
    ).not.toContainText("private-form-secret");
    await consolePage.screenshot({
      path: testInfo.outputPath("library-persisted.png"),
    });

    // A grant revoked in Connections returns the popup to sign-in on open.
    await consolePage.goto(`${baseURL}/connections`);
    await connection
      .getByRole("button", { name: "Revoke OAuth connection" })
      .click();
    await expect(connection).toHaveCount(0);
    // The saved-state check on open is the first call, so the popup finds
    // the ended grant before anything can be saved. Under load that check can
    // fail before it reaches Valise: the popup then says it could not check,
    // keeps the grant, and checks again on the next open. Reopen until one
    // check got an answer; a check that answered without ending the grant
    // still fails below.
    let ended = await openPopup(false);
    for (
      let opened = 1;
      opened < 4 && (await ended.locator("#check-failed").isVisible());
      opened++
    ) {
      await ended.close();
      ended = await openPopup(false);
    }
    await expect(ended.locator("#sign-in")).toBeVisible();
    await expect(ended.locator("#status")).toContainText(
      "expired or was revoked in Connections",
    );
    await expect(ended.locator("#capture")).toBeHidden();
    await ended.screenshot({ path: testInfo.outputPath("grant-ended.png") });
    await ended.close();

    // Settings connects to the endpoint under Advanced without the popup,
    // and Disconnect revokes the grant server-side.
    await settings.bringToFront();
    await settings.reload();
    await expect(settings.locator("#endpoint")).toHaveValue(`${baseURL}/mcp`);
    const secondConsent = consentWindow();
    await settings
      .getByRole("button", { name: "Connect to Valise", exact: true })
      .click();
    await approve(await secondConsent);
    // The connection block names the host, the endpoint and how.
    await expect(settings.locator("#connected")).toContainText(
      `Connected to ${local}`,
    );
    await expect(settings.locator("#connected-endpoint")).toHaveText(
      `${baseURL}/mcp`,
    );
    await expect(settings.locator("#connected-how")).toHaveText(
      "Signed in through Valise",
    );
    await expect(settings.locator("#not-connected")).toBeHidden();
    await expect(
      settings.getByRole("button", { name: "Connect to Valise", exact: true }),
    ).toBeHidden();
    await expect(settings.locator("#error")).toBeHidden();
    await settings.screenshot({ path: testInfo.outputPath("settings.png") });
    // Chrome shrinks an extension page's body to 75%; Settings reads at the
    // console's 15px.
    await expect(settings.locator("#connected-how")).toHaveCSS(
      "font-size",
      "15px",
    );
    await settings
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(settings.locator("#status")).toHaveText(
      "Disconnected. Valise revoked the connection and this browser forgot it.",
    );
    await consolePage.goto(`${baseURL}/connections`);
    await expect(
      consolePage.getByRole("heading", { name: "Valise capture" }),
    ).toHaveCount(0);

    // The Advanced pasted-token path still reports a rejected token.
    await grantHost();
    await settings.bringToFront();
    await settings
      .getByText("Advanced: self-hosted Valise or a pasted token")
      .click();
    await settings.locator("#token").fill("invalid-token-for-acceptance");
    await settings
      .getByRole("button", { name: "Save token", exact: true })
      .click();
    await expect(settings.locator("#token")).toHaveValue("");
    await expect(settings.locator("#connected-how")).toHaveText("Pasted token");
    const rejected = await openPopup();
    await rejected
      .getByRole("button", { name: "Archive full page", exact: true })
      .click();
    await expect(rejected.locator("#error")).toContainText(
      "Valise rejected the token",
    );
    // A tried page save stays locked: a lost response may have saved.
    await expect(
      rejected.getByRole("button", { name: "Archive full page", exact: true }),
    ).toBeDisabled();
    await rejected.screenshot({
      path: testInfo.outputPath("invalid-token.png"),
    });
    await rejected.close();
    await settings.evaluate(async () => {
      const chrome = (
        globalThis as unknown as {
          chrome: {
            permissions: {
              remove(permissions: { origins: string[] }): Promise<boolean>;
            };
          };
        }
      ).chrome;
      await chrome.permissions.remove({ origins: ["http://localhost/*"] });
    });
    const denied = await openPopup(false);
    await expect(denied.locator("#status")).toHaveText(
      "Chrome site access to Valise was removed. Connect again to grant it.",
    );
    await expect(denied.locator("#capture")).toBeHidden();
    await denied.screenshot({
      path: testInfo.outputPath("permission-removed.png"),
    });
    // Connect from the popup leaves the site-access prompt to Settings, a
    // tab that survives losing focus to it, and starts no sign-in there.
    const asking = context.waitForEvent("page", {
      predicate: async (page) => {
        await page.waitForLoadState("domcontentloaded");
        return page.url().includes("/settings.html");
      },
    });
    await denied
      .getByRole("button", { name: "Connect to Valise", exact: true })
      .click();
    const needsAccess = await asking;
    await expect(needsAccess.locator("#status")).toHaveText(
      `Chrome needs site access to ${local}. Choose Connect to Valise to grant it and sign in.`,
    );
    await needsAccess.close();
    await settings
      .getByRole("button", { name: "Disconnect", exact: true })
      .click();
    await expect(settings.locator("#status")).toContainText(
      "Forgotten locally",
    );
  } finally {
    await context.close();
  }
});
