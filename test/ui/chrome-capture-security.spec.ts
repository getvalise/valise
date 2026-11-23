import { expect, test } from "@playwright/test";
import { capturePage } from "../../clients/chrome-extension/capture.mjs";

for (const rawName of ["xmp", "plaintext", "noembed", "noframes", "noscript"]) {
  test(`standalone capture safely reparses ${rawName} breakout text with a moved head`, async ({
    page,
    context,
  }) => {
    const sourceUrl = "https://capture-security.example/article";
    await page.route(sourceUrl, (route) =>
      route.fulfill({
        contentType: "text/html; charset=utf-8",
        body: "<!doctype html><html><head><title>Article</title></head><body><article><h1>Semantic article</h1><p>Keep this paragraph ☀</p></article></body></html>",
      }),
    );
    await page.route("https://snapshot-exfil.example/**", (route) =>
      route.abort(),
    );
    await page.goto(sourceUrl);
    // Browser-only fixture code stays a string: this repo typechecks against
    // Workers globals rather than importing DOM globals into every Worker test.
    await page.evaluate(`(() => {
      const name = ${JSON.stringify(rawName)};
      const attack =
        '<script>window.snapshotExecuted=true;fetch("https://snapshot-exfil.example/script")</script><img src="https://snapshot-exfil.example/image" onerror="window.snapshotExecuted=true">';
      const node = document.createElement(name);
      node.textContent = '</' + name + '>' + attack + '<' + name + '>';
      // A custom wrapper and programmatically invalid table nesting exercise
      // parser repair as well as the raw-text serializer's closing-tag escape.
      const wrapper = document.createElement("custom-article");
      const table = document.createElement("table");
      const nested = document.createElement("div");
      nested.append(node);
      table.append(nested);
      wrapper.append(table);
      document.body.append(wrapper);
      const paragraph = document.createElement("p");
      paragraph.setAttribute("lang", 'en">' + attack + '<p lang="');
      paragraph.textContent = '</p>' + attack + '<p>';
      paragraph.setAttribute("style", 'background:url("https://snapshot-exfil.example/style")');
      document.body.append(paragraph);
      document.title = '</title>' + attack + '<title>';
      // The source tree is attacker-controlled, including head/body order.
      document.documentElement.append(document.head);
    })()`);
    const snapshot = await page.evaluate(capturePage);
    expect(snapshot.html).toMatch(
      /^<!doctype html>\n<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy"/,
    );
    expect(snapshot.html).toContain("Keep this paragraph ☀");
    expect(snapshot.html).not.toMatch(
      /<(?:script|xmp|plaintext|noembed|noframes|noscript|iframe)(?:\s|>)/i,
    );
    expect(snapshot.html).toContain("&lt;script&gt;");
    // A resource that could not be stored leaves no reference to its origin.
    expect(snapshot.html).not.toContain("snapshot-exfil.example/style");
    expect(snapshot.resources).toEqual([]);

    // Also remove our own CSP to prove structural safety independently of its
    // placement or browser enforcement. Only trusted generated metadata is cut.
    const withoutCsp = snapshot.html.replace(
      /<meta http-equiv="Content-Security-Policy"[^>]*>/,
      "",
    );
    expect(withoutCsp).not.toBe(snapshot.html);
    for (const [mode, html] of [
      ["with CSP", snapshot.html],
      ["without CSP", withoutCsp],
    ]) {
      await test.step(mode, async () => {
        const offline = await context.newPage();
        const snapshotUrl = "https://saved-snapshot.example/capture.html";
        const requests: string[] = [];
        offline.on("request", (request) => {
          if (new URL(request.url()).origin !== new URL(snapshotUrl).origin)
            requests.push(request.url());
        });
        await offline.route("**/*", (route) =>
          route.request().url() === snapshotUrl
            ? route.fulfill({ contentType: "text/html", body: html })
            : route.abort(),
        );
        await offline.goto(snapshotUrl);
        await offline.waitForTimeout(50);
        expect(
          await offline.evaluate("window.snapshotExecuted"),
        ).toBeUndefined();
        await expect(
          offline.locator(
            "script,xmp,plaintext,noembed,noframes,noscript,iframe,object,embed",
          ),
        ).toHaveCount(0);
        await expect(offline.locator("h1")).toHaveText("Semantic article");
        // <noscript> is dropped with its content; the others keep it literal.
        if (rawName === "noscript")
          await expect(offline.locator("pre")).toHaveCount(0);
        else
          await expect(offline.locator("pre")).toContainText(
            `</${rawName}><script>`,
          );
        expect(requests).toEqual([]);
        await offline.close();
      });
    }
  });
}
