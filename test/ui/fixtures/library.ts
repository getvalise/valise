import type { Locator, Page } from "@playwright/test";
import { expect } from "./session";

/**
 * How long a Library navigation may take to show. The URL changes first; the
 * page commits after React renders it. On 2026-11-08, at load 40 to 50, the
 * loader answered 109 ms after a row click and the row was still closed 5 s
 * later, the default expect timeout, with the new URL already in place.
 */
const committed = { timeout: 15_000 };

/** Switches the Library to one of its two lists through the view tabs. */
export async function showView(page: Page, view: "Bookmarks" | "Documents") {
  await closeAddDialog(page);
  const tab = page
    .getByRole("navigation", { name: "Library view", exact: true })
    .getByRole("link", { name: new RegExp(`^${view} \\(`) });
  if ((await tab.getAttribute("aria-current")) !== "page") await tab.click();
  await expect(tab).toHaveAttribute("aria-current", "page", committed);
}

/**
 * Opens the Upload dialog from the first row of the Documents tab, where the
 * uploaded files then appear. Works with scripting off: both are ordinary links.
 */
export async function addDocuments(page: Page) {
  const dialog = page.getByRole("dialog", { name: "Upload documents" });
  if (await dialog.isVisible()) return dialog;
  await showView(page, "Documents");
  await page
    .getByRole("link", { name: "Upload documents", exact: true })
    .click();
  await expect(dialog).toBeVisible();
  return dialog;
}

/**
 * Opens the Add a bookmark dialog from the first row of the Bookmarks tab. With scripting off
 * the document picker is behind a link; hydrated, it is already there.
 */
export async function addBookmark(page: Page, attach = false) {
  const dialog = page.getByRole("dialog", { name: "Add a bookmark" });
  if (!(await dialog.isVisible())) {
    await showView(page, "Bookmarks");
    await page.getByRole("link", { name: "Add bookmark", exact: true }).click();
    await expect(dialog).toBeVisible();
  }
  const reveal = dialog.getByRole("link", {
    name: "Attach a saved document (optional)",
    exact: true,
  });
  if (attach && (await reveal.count())) await reveal.click();
  return dialog.locator('form:has(input[value="source-create"])');
}

/**
 * Chooses a saved document in an attach picker: the native select before
 * hydration, the server-searched combobox after it.
 */
export async function pickDocument(
  scope: Locator,
  label: string,
  title: string,
) {
  const native = scope.locator("select", {
    has: scope.page().locator("option", { hasText: title }),
  });
  const field = scope.getByRole("combobox", { name: label, exact: true });
  if (await native.count()) {
    await field.selectOption({ label: title });
    return;
  }
  await field.click();
  const page = scope.page();
  await page.getByPlaceholder("Search saved documents").fill(title);
  // An option reads as the title and its file kind.
  await page.getByRole("option").filter({ hasText: title }).first().click();
  await expect(field).toContainText(title);
}

/** Opens an item's details in the pane by clicking its row. */
export async function itemDetails(card: Locator) {
  await closeAddDialog(card.page());
  const details = card.locator(":scope > .library-item-details");
  if ((await details.getAttribute("data-expanded")) !== "true")
    await details
      .locator(":scope > .library-details-link")
      // Document thumbnails now fill the row's left edge and remain their
      // own Preview target. Click the row itself, beyond that 5rem strip.
      .click({ position: { x: 100, y: 2 } });
  await expect(details).toHaveAttribute("data-expanded", "true", committed);
}

/** Closes whichever add dialog is open, so the page behind it is live. */
export async function closeAddDialog(page: Page) {
  for (const name of ["Upload documents", "Add a bookmark"]) {
    const dialog = page.getByRole("dialog", { name, exact: true });
    if (await dialog.isVisible()) {
      await dialog
        .getByRole("button", { name: "Close" })
        .or(dialog.getByRole("link", { name: "Close" }))
        .first()
        .click();
      await expect(dialog).toBeHidden();
    }
  }
  // The dialog hides before the URL drops `add`; a reload before then
  // reopens it over the list.
  await expect(page).not.toHaveURL(/[?&]add=/);
}
