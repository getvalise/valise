/** Deterministic console captures on an owned local database and registry. */
import { mkdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { chromium } from "@playwright/test";
import { runUiTestServer } from "./ui-test-server.mjs";

const port = Number(process.env.VALISE_TEST_PORT ?? 4322);
const origin = `http://localhost:${port}`;
const out = process.env.VALISE_SHOTS_DIR ?? ".context/ui-consistency";
const controller = new AbortController();
const registry = createServer((request, response) => {
  response.setHeader("content-type", "application/json");
  const url = new URL(request.url, "http://localhost");
  response.end(
    JSON.stringify(
      url.pathname === "/api/search"
        ? {
            skills: [
              {
                source: "vercel-labs/skills",
                skillId: "find-skills",
                name: "find-skills",
                installs: 1200,
              },
            ],
          }
        : url.pathname.startsWith("/api/download/")
          ? {
              hash: "ui-fixture-digest",
              files: [
                {
                  path: "SKILL.md",
                  contents:
                    "---\nname: find-skills\ndescription: Find a reusable skill for the task at hand.\nlicense: MIT\n---\n\nRead references/guide.md only when needed.",
                },
                { path: "references/guide.md", contents: "Supporting detail." },
              ],
            }
          : { skills: [] },
    ),
  );
});
await new Promise((resolve) => registry.listen(0, "127.0.0.1", resolve));
process.env.VALISE_UI_REGISTRY_URL = `http://127.0.0.1:${registry.address().port}`;
process.env.VALISE_ADMIN_PASSWORD = "local-playwright-password-0001";
process.env.SESSION_SECRET = "local-playwright-session-secret-0001";
process.env.TOKEN_PEPPER = "local-playwright-token-pepper-0001";
const server = runUiTestServer({ port, signal: controller.signal });
let browser;
try {
  await mkdir(out, { recursive: true });
  await Promise.race([
    waitForServer(),
    server.then(() => {
      throw new Error("Capture server exited before becoming ready");
    }),
  ]);
  await fetch(`${origin}/__dev/seed`);
  const logged = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": "ui-consistency-capture",
      "x-valise-client": "ui-fixture-client-with-a-long-session-label",
      "x-valise-session": "ui-consistency-capture",
      "x-valise-session-name":
        "ui-consistency-capture-with-a-long-session-label",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: "capture",
      method: "tools/call",
      params: {
        name: "list_ready",
        arguments: { project: "valise" },
        _meta: {
          "io.modelcontextprotocol/clientInfo": {
            name: "ui-fixture-client-with-a-long-name",
            version: "1.0.0",
          },
        },
      },
    }),
  });
  if (!logged.ok)
    throw new Error("Could not populate the Connections session fixture");
  browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`${origin}/login?next=/todos`);
  await page
    .getByLabel("Administrator password")
    .fill(process.env.VALISE_ADMIN_PASSWORD);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.getByRole("heading", { name: "To-dos", exact: true }).waitFor();
  const measurements = [];
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 900 });
    for (const [name, path] of [
      ["todos", "/todos"],
      ["memories", "/memories"],
      ["skills", "/skills"],
      ["connections", "/connections"],
      ["hooks", "/hooks"],
      ["workbench", "/workbench?tab=components"],
      [
        "add-skill",
        "/skills?add=search&find=find-skills&preview=vercel-labs%2Fskills%2Ffind-skills",
      ],
    ]) {
      await page.goto(`${origin}${path}`);
      await page.waitForLoadState("networkidle");
      if (name === "connections") {
        await page
          .getByRole("cell", {
            name: "ui-fixture-client-with-a-long-name 1.0.0",
            exact: true,
          })
          .waitFor();
      }
      if (name === "add-skill") {
        await page.getByRole("region", { name: "Skill preview" }).waitFor();
      }
      await page.screenshot({
        path: `${out}/${name}-${width}.png`,
        fullPage: name !== "add-skill",
      });
      measurements.push(
        await page.evaluate(
          ({ name, width }) => ({
            name,
            width,
            pageWidth: document.documentElement.scrollWidth,
            modalScroll: document.querySelector("dialog[open] .modal-body")
              ?.scrollTop,
            header: document
              .querySelector(".page-header")
              ?.getBoundingClientRect()
              .toJSON(),
            filters: document
              .querySelector(".filters")
              ?.getBoundingClientRect()
              .toJSON(),
            list: document
              .querySelector(".todo-list")
              ?.getBoundingClientRect()
              .toJSON(),
          }),
          { name, width },
        ),
      );
    }
  }
  await writeFile(
    `${out}/measurements.json`,
    `${JSON.stringify(measurements, null, 2)}\n`,
  );
  if (
    measurements.some(
      (row) => row.pageWidth > row.width || (row.modalScroll ?? 0) > 1,
    )
  ) {
    throw new Error(
      "Capture found horizontal overflow or a dialog opening below its first controls",
    );
  }
  console.log(`14 captures and measurements in ${out}`);
} finally {
  await browser?.close();
  controller.abort();
  registry.close();
  await server;
}

async function waitForServer() {
  for (let attempt = 0; attempt < 120; attempt++) {
    try {
      if ((await fetch(`${origin}/health`)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error("Capture server did not start within 60 seconds");
}
