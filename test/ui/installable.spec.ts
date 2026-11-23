import { expect, goto, signedOut, test } from "./fixtures/session";

test.use({ storageState: signedOut });

test("the console installs from the iPhone share sheet and opens to the to-dos", async ({
  page,
  request,
}) => {
  const manifest = await request.get("/manifest.webmanifest");
  expect(manifest.ok()).toBe(true);
  const body = await manifest.json();
  expect(body.start_url).toBe("/todos");
  expect(body.display).toBe("standalone");
  for (const icon of body.icons) {
    expect((await request.get(icon.src)).ok(), icon.src).toBe(true);
  }

  await goto(page, "/login");
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute(
    "href",
    "/apple-touch-icon.png",
  );
  await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
    "href",
    "/manifest.webmanifest",
  );
});

test("browsers that ask for /favicon.ico by name get an icon, not a 404", async ({
  request,
}) => {
  for (const path of [
    "/favicon.ico",
    "/favicon.svg",
    "/apple-touch-icon.png",
  ]) {
    const response = await request.get(path);
    expect(response.ok(), path).toBe(true);
    expect(response.headers()["content-type"], path).toMatch(/^image\//);
  }
});
