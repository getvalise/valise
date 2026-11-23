import { execSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  Client,
  StreamableHTTPClientTransport,
} from "@modelcontextprotocol/client";
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
} from "@playwright/test";

export { expect };

export type Member = "A" | "B";
export type ToolResult = {
  isError?: boolean;
  structuredContent?: any;
  content?: { type: string; text?: string }[];
};

export const origin = () => process.env.JOURNEY_ORIGIN as string;
export const label = () => process.env.JOURNEY_LABEL as string;

export function credentials(member: Member) {
  const email = process.env[`JOURNEY_${member}_EMAIL`];
  const password = process.env[`JOURNEY_${member}_PASSWORD`];
  return email && password ? { email, password } : null;
}

/** A short run marker, so every synthetic row this run writes is findable. */
export const runId = `${new Date().toISOString().slice(0, 10)}-${crypto
  .randomUUID()
  .slice(0, 6)}`;

/**
 * Screenshots and observations for one journey, written under
 * docs/testing/evidence/<journey>/<label>/. The record is rewritten after
 * every step, so a failed run still leaves what it reached.
 */
export class Evidence {
  readonly dir: string;
  readonly record: {
    journey: string;
    run: string;
    origin: string;
    label: string;
    runner_commit: string;
    started_at: string;
    steps: { step: string; ok: boolean; detail?: unknown }[];
    fixtures: string[];
    cleanup: string[];
  };

  constructor(journey: string) {
    this.dir = resolve("docs/testing/evidence", journey, label());
    mkdirSync(this.dir, { recursive: true });
    this.record = {
      journey,
      run: runId,
      origin: origin(),
      label: label(),
      runner_commit: execSync("git rev-parse HEAD").toString().trim(),
      started_at: new Date().toISOString(),
      steps: [],
      fixtures: [],
      cleanup: [],
    };
  }

  step(step: string, ok: boolean, detail?: unknown) {
    this.record.steps.push({ step, ok, detail });
    this.flush();
  }

  fixture(id: string) {
    this.record.fixtures.push(id);
    this.flush();
  }

  flush() {
    writeFileSync(
      join(this.dir, "run.json"),
      `${JSON.stringify(this.record, null, 2)}\n`,
    );
  }

  /**
   * One screenshot at the page's current width, after checking the page has
   * no horizontal scroll. A shot of the sign-in page fails, because it would
   * prove nothing about the step.
   */
  async shot(page: Page, name: string) {
    expect(new URL(page.url()).pathname).not.toBe("/login");
    const width = page.viewportSize()?.width ?? 0;
    const overflow = await page.evaluate<number>(
      "document.documentElement.scrollWidth - innerWidth",
    );
    expect(
      overflow,
      `${name} scrolls sideways at ${width}px`,
    ).toBeLessThanOrEqual(0);
    await page.screenshot({
      path: join(this.dir, `${name}-${width}.png`),
      fullPage: true,
    });
  }
}

/** A fresh browser profile signed in as a member through the /login form. */
export async function memberContext(
  browser: Browser,
  member: Member,
  options: { width?: number; javaScriptEnabled?: boolean } = {},
): Promise<{ context: BrowserContext; page: Page }> {
  const width = options.width ?? 1280;
  const phone = width < 600;
  const context = await browser.newContext({
    baseURL: origin(),
    viewport: { width, height: phone ? 780 : 900 },
    hasTouch: phone,
    isMobile: phone,
    javaScriptEnabled: options.javaScriptEnabled ?? true,
  });
  const page = await context.newPage();
  await signIn(page, member, "/todos", options.javaScriptEnabled ?? true);
  return { context, page };
}

export async function signIn(
  page: Page,
  member: Member,
  next = "/todos",
  scripting = true,
) {
  const creds = credentials(member);
  if (!creds) throw new Error(`No credentials for member ${member}`);
  await page.goto(`/login?next=${encodeURIComponent(next)}`);
  if (scripting) await hydrated(page);
  await page.getByLabel("Email", { exact: true }).fill(creds.email);
  await page.getByLabel("Password", { exact: true }).fill(creds.password);
  await page.getByRole("button", { name: "Log in", exact: true }).click();
  await page.waitForURL((url) => url.pathname !== "/login");
  if (scripting) await hydrated(page);
}

export async function hydrated(page: Page): Promise<void> {
  await page.waitForFunction(
    `Object.keys(document.body).some((key) => key.startsWith("__reactProps$"))`,
  );
}

export async function visit(page: Page, path: string, scripting = true) {
  await page.goto(path);
  if (scripting) await hydrated(page);
}

/**
 * Mints a bearer token through the member's own /connections form, the way
 * a person connects a client that has no OAuth. Returns the secret once.
 */
export async function mintToken(
  page: Page,
  tokenLabel: string,
  scopes: readonly string[] | "all" = "all",
): Promise<string> {
  await visit(page, "/connections");
  const form = page.locator("form").filter({
    has: page.getByRole("button", { name: "Create token", exact: true }),
  });
  await form.getByLabel("Label", { exact: true }).fill(tokenLabel);
  const boxes = form.locator('input[name="scope"]');
  for (const box of await boxes.all()) {
    const value = (await box.getAttribute("value")) ?? "";
    if (scopes === "all" || scopes.includes(value)) await box.check();
  }
  await form.getByRole("button", { name: "Create token", exact: true }).click();
  const token = (
    await page.locator(".token-reveal code").textContent()
  )?.trim();
  if (!token?.startsWith("vls_"))
    throw new Error("No token shown after minting");
  return token;
}

/** Revokes every bearer token on /connections whose label starts with prefix. */
export async function revokeTokens(page: Page, prefix: string) {
  await visit(page, "/connections");
  const live = page
    .locator("li.todo-card")
    .filter({ has: page.locator("h3", { hasText: prefix }) })
    .filter({ has: page.getByRole("button", { name: "Revoke token" }) });
  for (let left = await live.count(); left > 0; left--) {
    await live.first().getByRole("button", { name: "Revoke token" }).click();
    await expect(live).toHaveCount(left - 1);
  }
}

/** A real MCP SDK client over streamable HTTP with a bearer token. */
export async function mcpClient(token: string, name: string) {
  const client = new Client({ name, version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(
    new URL("/mcp", origin()),
    { requestInit: { headers: { authorization: `Bearer ${token}` } } },
  );
  await client.connect(transport);
  const call = async (
    tool: string,
    args: Record<string, unknown> = {},
  ): Promise<ToolResult> => {
    try {
      return (await client.callTool({
        name: tool,
        arguments: args,
      })) as ToolResult;
    } catch (error) {
      // A 403 insufficient_scope surfaces as a thrown step-up error, not a
      // tool result. It is still a refusal, so report it as one.
      return {
        isError: true,
        content: [{ type: "text", text: `thrown: ${String(error)}` }],
      };
    }
  };
  const ok = async (tool: string, args: Record<string, unknown> = {}) => {
    const result = await call(tool, args);
    expect(result.isError, `${tool}: ${text(result)}`).not.toBe(true);
    return result.structuredContent;
  };
  return { client, call, ok, close: () => client.close() };
}

export type Mcp = Awaited<ReturnType<typeof mcpClient>>;

export function text(result: ToolResult): string {
  return (result.content ?? []).map((part) => part.text ?? "").join("\n");
}
