import { join } from "node:path";
import {
  type APIRequestContext,
  test as base,
  expect,
  type Page,
} from "@playwright/test";
import {
  MODULES_PATH,
  startServer,
  testSecrets,
  type UiServer,
} from "./server";

export { expect };

export const password = testSecrets().VALISE_ADMIN_PASSWORD;

/** For a test that must start at the sign-in form: `test.use({ storageState: signedOut })`. */
export const signedOut = { cookies: [], origins: [] };

/**
 * Every test gets its worker's own server, and a page that is already signed
 * in. The worker signs in once through the form and every test reuses that
 * session, because sessions live in the worker's own D1.
 */
export const test = base.extend<
  Record<never, never>,
  { server: UiServer; session: string }
>({
  server: [
    async ({}, use, workerInfo) => {
      const root = process.env.VALISE_UI_RUN;
      if (!root) throw new Error("Run the UI suite through playwright test");
      const server = await startServer({
        root,
        worker: workerInfo.workerIndex,
        slot: workerInfo.parallelIndex,
      });
      await use(server);
      await server.stop();
    },
    { scope: "worker", timeout: 90_000 },
  ],
  session: [
    async ({ server, browser }, use, workerInfo) => {
      const context = await browser.newContext({
        baseURL: server.baseURL,
        storageState: signedOut,
      });
      const page = await context.newPage();
      await signInWithPassword(page);
      const file = join(server.state, `session-${workerInfo.workerIndex}.json`);
      await context.storageState({ path: file });
      await context.close();
      await use(file);
    },
    { scope: "worker", timeout: 60_000 },
  ],
  baseURL: async ({ server }, use) => {
    await use(server.baseURL);
  },
  storageState: async ({ session }, use) => {
    await use(session);
  },
});

/**
 * React writes `__reactProps$<id>` onto each node it hydrates, and `<body>`
 * completes after everything inside it. A click that lands before hydration
 * gets the browser's default instead of the app's handler.
 */
export async function hydrated(page: Page): Promise<void> {
  // A string, not a closure: this repo compiles without the DOM lib.
  await page.waitForFunction(
    `Object.keys(document.body).some((key) => key.startsWith("__reactProps$"))`,
  );
}

/** Navigates, then waits for hydration unless the page runs no scripts. */
export async function goto(
  page: Page,
  path: string,
  scripting = true,
): Promise<void> {
  await page.goto(path);
  if (scripting) await hydrated(page);
}

/**
 * The page is already signed in through the worker's session, so this lands
 * on `next` and waits until it is usable.
 */
export async function signIn(
  page: Page,
  next = "/todos",
  scripting = true,
): Promise<void> {
  await goto(page, next, scripting);
}

/** The sign-in form itself, for a page that starts signed out. */
async function signInWithPassword(
  page: Page,
  next = "/todos",
  scripting = true,
): Promise<void> {
  await goto(page, `/login?next=${encodeURIComponent(next)}`, scripting);
  await page.getByLabel("Administrator password").fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  if (scripting) await hydrated(page);
}

type RpcReply = {
  result: {
    isError?: boolean;
    structuredContent: Record<string, any>;
    content?: { type: string; text?: string }[];
  };
};

/** One MCP tool call over the loopback agent header; the parsed JSON-RPC reply. */
export async function mcpCall(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>,
  { agent = "playwright", client = "console-test", headers = {} } = {},
): Promise<RpcReply> {
  const response = await request.post("/mcp", {
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": agent,
      "x-valise-client": client,
      ...headers,
    },
    data: {
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    },
  });
  expect(response.ok()).toBe(true);
  return parseRpc(await response.text());
}

/** A tool call that must succeed; its structured content. */
export async function mcp<T = any>(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown>,
  options?: Parameters<typeof mcpCall>[3],
): Promise<T> {
  const reply = await mcpCall(request, name, args, options);
  expect(reply.result.isError, JSON.stringify(reply.result)).not.toBe(true);
  return reply.result.structuredContent as T;
}

export function parseRpc(raw: string): RpcReply {
  const event = raw
    .split("\n")
    .find((line) => line.startsWith("data:"))
    ?.slice("data:".length)
    .trim();
  return JSON.parse(event || raw) as RpcReply;
}

/** Resets the seed rows; every spec runs this before each test. */
export async function seed(request: APIRequestContext): Promise<void> {
  expect((await request.get("/__dev/seed")).ok()).toBe(true);
}

/** Serves the modules `prepareRun` built, on the page's own origin. */
export async function serveBrowserModules(page: Page): Promise<void> {
  const root = join(process.env.VALISE_UI_RUN ?? "", "modules");
  await page.context().route(`**${MODULES_PATH}**`, (route) =>
    route.fulfill({
      path: join(
        root,
        new URL(route.request().url()).pathname.slice(MODULES_PATH.length),
      ),
    }),
  );
}
