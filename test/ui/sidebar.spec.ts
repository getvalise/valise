import { expect, goto, test } from "./fixtures/session";

/*
 * The rail opens over the page on hover and on keyboard focus. Opening it
 * moves nothing: not the page beside it (P4), and not the icons in it, so the
 * thing under the pointer stays under the pointer.
 */
test("the icon rail opens over the page without moving the page or its icons", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await goto(page, "/todos");
  const sidebar = page.locator('[data-slot="sidebar"]');
  // Strings, not closures: this repo compiles without the DOM lib.
  const icons = () =>
    page.evaluate<number[][]>(
      `[...document.querySelectorAll('[data-slot="sidebar"] svg.icon')].map((icon) => {
        const box = icon.getBoundingClientRect();
        return [box.left, box.top];
      })`,
    );
  const contentLeft = () =>
    page.evaluate<number>(
      `document.querySelector(".workspace").getBoundingClientRect().left`,
    );

  await page.mouse.move(800, 400);
  await expect(sidebar).toHaveAttribute("data-collapsible", "icon");
  const before = { icons: await icons(), content: await contentLeft() };

  await page.mouse.move(20, 300);
  await expect(sidebar).toHaveAttribute("data-peeking", "true");
  await expect(
    page.getByRole("link", { name: "Memories", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(300); // the width transition is 200ms
  expect(await icons()).toEqual(before.icons);
  expect(await contentLeft()).toBe(before.content);

  await page.mouse.move(800, 400);
  await expect(sidebar).toHaveAttribute("data-collapsible", "icon");

  // Focus opens it too, and leaving it closes it.
  await page.getByRole("link", { name: "Memories", exact: true }).focus();
  await expect(sidebar).toHaveAttribute("data-peeking", "true");
  expect(await contentLeft()).toBe(before.content);
});
