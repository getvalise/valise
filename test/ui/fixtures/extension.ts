import { execFileSync } from "node:child_process";
import { type Browser, chromium, expect, type Page } from "@playwright/test";
import { freePort } from "./server";

/**
 * The real unpacked MV3 extension in a fresh Chromium profile, built into
 * `dir` so parallel workers never share one build. Popups open through
 * `Extensions.triggerAction`, so they are real action popups at their real
 * size, not tabs pointed at popup.html.
 */
export async function launchExtension(dir: string) {
  const debugPort = await freePort();
  execFileSync(process.execPath, ["clients/chrome-extension/build.mjs", dir]);
  const context = await chromium.launchPersistentContext("", {
    channel: "chromium",
    headless: true,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: [
      "--enable-unsafe-extension-debugging",
      `--remote-debugging-port=${debugPort}`,
    ],
  });
  const cdp = await context.browser()!.newBrowserCDPSession();
  const { id } = await cdp.send("Extensions.loadUnpacked", { path: dir });
  let attached: Browser | undefined;

  /**
   * Grant a self-hosted endpoint's host. The management call alone leaves it
   * inactive for an extension with a required host; a request from an
   * extension page, under Playwright's user gesture, then grants it without
   * a prompt.
   */
  async function grantHost(host = "http://localhost/*") {
    const management = await context.newPage();
    await management.goto("chrome://extensions");
    await management.evaluate(
      async ({ id, host }) => {
        await (
          globalThis as unknown as {
            chrome: {
              developerPrivate: {
                addHostPermission(id: string, host: string): Promise<void>;
              };
            };
          }
        ).chrome.developerPrivate.addHostPermission(id, host);
      },
      { id, host },
    );
    await management.close();
    const page = await context.newPage();
    await page.goto(`chrome-extension://${id}/settings.html`);
    expect(
      await page.evaluate(
        (host) =>
          (
            globalThis as unknown as {
              chrome: {
                permissions: {
                  request(p: { origins: string[] }): Promise<boolean>;
                };
              };
            }
          ).chrome.permissions.request({ origins: [host] }),
        host,
      ),
    ).toBe(true);
    await page.close();
  }

  /**
   * Click the toolbar action over `tab` and return the popup page. `url` is
   * the tab's address as Chrome lists it, for an error page Playwright
   * reports as chrome-error://.
   */
  async function openPopup(tab: Page, url = tab.url()) {
    // One attachment at a time: every attachment sets up each target Chrome
    // opens later, so old ones make each popup slower than the last. Close it
    // before the click, not after, so it never holds the new popup half set
    // up. Closing only disconnects; the browser and its pages stay.
    await attached?.close();
    await tab.bringToFront();
    const { targetInfos } = await cdp.send("Target.getTargets", {
      filter: [{ type: "tab" }],
    });
    // An error page is listed under either its URL or chrome-error://.
    const target = targetInfos.find(
      (info) => info.url === url || info.url === tab.url(),
    );
    if (!target)
      throw new Error(
        `No tab target for ${url} in ${JSON.stringify(targetInfos.map((i) => i.url))}`,
      );
    await cdp.send("Extensions.triggerAction", {
      id,
      targetId: target.targetId,
    });
    // Chrome changes the action target from other to page after creation;
    // a fresh CDP attachment discovers it after that transition.
    await expect
      .poll(async () =>
        (await cdp.send("Target.getTargets")).targetInfos.some(
          (info) => info.type === "page" && info.url.endsWith("/popup.html"),
        ),
      )
      .toBe(true);
    // Attaching took 37 s on 2026-11-02 with parallel verifies loading an
    // 8-core Mac, past the 30 s default.
    attached = await chromium.connectOverCDP(`http://localhost:${debugPort}`, {
      timeout: 90_000,
    });
    const popup = attached
      .contexts()[0]
      .pages()
      .find((page) => page.url().endsWith("/popup.html"))!;
    // The popup has started once it is ready to save, asks to sign in, or
    // shows an error. Under the same load that took up to 15 s after
    // attaching, so callers' 5 s assertions raced it.
    await expect(
      popup
        .locator(
          '#capture[aria-busy="false"], #sign-in:not([hidden]), #error:not([hidden])',
        )
        .first(),
    ).toBeAttached({ timeout: 30_000 });
    return popup;
  }

  return { context, id, grantHost, openPopup };
}
