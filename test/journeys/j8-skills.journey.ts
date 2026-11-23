import { test } from "@playwright/test";
import {
  credentials,
  Evidence,
  expect,
  type Mcp,
  mcpClient,
  memberContext,
  mintToken,
  origin,
  revokeTokens,
  runId,
  text,
  visit,
} from "./harness";

/*
 * J8, docs/testing/user-journeys.md#j8-author-and-use-skills, as a non-admin
 * member. The hook step reads what a new session is told: the SessionStart
 * entries in the MCP server instructions.
 */

/**
 * What a fresh session is told at SessionStart: the MCP server instructions,
 * which carry every enabled SessionStart entry. The plugin's hook no longer
 * syncs the document with a bearer token (ADR-0004, 2026-11-04).
 */
async function sessionStart(token: string): Promise<string> {
  const fresh = await mcpClient(token, "journey-session");
  try {
    return fresh.client.getInstructions() ?? "";
  } finally {
    await fresh.close();
  }
}

const skillBody = (name: string, line: string) => `---
name: ${name}
description: Synthetic journey skill. Use when a J8 acceptance run asks for the journey checklist.
---

# Journey checklist

${line}
`;

test("J8: write, version, publish, install and use a skill across clients", async ({
  browser,
}) => {
  const evidence = new Evidence("j8");
  const name = `journey-skill-${runId.slice(-6)}`;
  const tokenPrefix = `journey j8 ${runId}`;
  const { context, page } = await memberContext(browser, "A");
  const clients: Mcp[] = [];
  try {
    const authorToken = await mintToken(page, `${tokenPrefix} author`, [
      "skills:read",
      "skills:write",
      "config:read",
      "config:write",
    ]);
    const author = await mcpClient(authorToken, "journey-author");
    clients.push(author);
    const before = (await author.ok("list_skills")).skills.length as number;

    // 1. Write a skill in the console and add it through its preview.
    await visit(page, "/skills?add=write");
    const dialog = page.getByRole("dialog", { name: "Add skill", exact: true });
    await dialog
      .getByRole("textbox", { name: "SKILL.md", exact: true })
      .fill(skillBody(name, "Version one says: check the fixture."));
    await dialog.getByRole("button", { name: "Preview", exact: true }).click();
    await expect(dialog.getByText(name).first()).toBeVisible();
    await evidence.shot(page, "01-write-preview");
    await dialog
      .getByRole("button", { name: "Add skill", exact: true })
      .click();
    await expect
      .poll(async () => (await author.ok("list_skills")).skills.length)
      .toBe(before + 1);
    evidence.fixture(`skill:${name}`);
    evidence.step("1. write SKILL.md in the console, preview, add", true, {
      name,
    });

    // 2. A second version over MCP with a bundle file; v1 stays readable.
    const v2 = await author.ok("publish_skill", {
      body: skillBody(name, "Version two says: check the fixture twice."),
      files: [{ path: "notes/checklist.md", content: `- step one ${runId}\n` }],
    });
    expect(v2.version ?? v2.skill?.version).toBe(2);
    const head = await author.ok("get_skill", { name });
    expect(JSON.stringify(head)).toContain("check the fixture twice");
    const first = await author.ok("get_skill", { name, version: 1 });
    expect(JSON.stringify(first)).toContain("Version one says");
    expect(JSON.stringify(first)).not.toContain("twice");
    await visit(page, `/skills?open=${encodeURIComponent(name)}`);
    const detail = page.getByRole("dialog", { name, exact: true });
    await expect(
      detail.getByRole("button", { name: "v1", exact: true }),
    ).toBeVisible();
    await expect(
      detail.getByRole("button", { name: "v2", exact: true }),
    ).toBeVisible();
    await evidence.shot(page, "02-two-versions");
    evidence.step("2. publish v2 with a bundle file; v1 unchanged", true);

    // Suggestions belong to adding a skill, not to the list, and are for
    // the member, not notes to the curator.
    await visit(page, "/skills");
    await expect(
      page.getByRole("region", { name: "Suggested skills" }),
    ).toHaveCount(0);
    // 3. Import preview: nothing installs until the person adds it.
    const counted = (await author.ok("list_skills")).skills.length;
    await visit(page, "/skills?add=search");
    const add = page.getByRole("dialog", { name: "Add skill", exact: true });
    const suggested = add.getByRole("region", { name: "Suggested skills" });
    for (const region of await suggested.all())
      await expect(region).not.toContainText("Placeholder");
    const suggestion = suggested.getByRole("link").first();
    let previewed = "no suggestion shown";
    if ((await suggestion.count()) > 0) {
      previewed = (await suggestion.textContent())?.trim() ?? "";
      await suggestion.click();
      await page.waitForLoadState("networkidle");
      await evidence.shot(page, "03-import-preview");
    }
    expect((await author.ok("list_skills")).skills.length).toBe(counted);
    evidence.step("3. import preview installs nothing", true, { previewed });

    // 4. A fresh client finds it, reads it, sees it as a tool and a prompt.
    const fresh = await mcpClient(
      await mintToken(page, `${tokenPrefix} fresh`, [
        "skills:read",
        "search:read",
      ]),
      "journey-fresh-client",
    );
    clients.push(fresh);
    const listed = (await fresh.ok("list_skills")).skills.find(
      (skill: { name: string }) => skill.name === name,
    );
    expect(listed?.version).toBe(2);
    const found = await fresh.ok("search", {
      query: "journey checklist fixture",
    });
    expect(JSON.stringify(found)).toContain(name);
    const file = await fresh.ok("read_skill_file", {
      name,
      path: "notes/checklist.md",
    });
    expect(file.text).toContain(runId);
    const tools = (await fresh.client.listTools()).tools.map(
      (tool) => tool.name,
    );
    const prompts = (await fresh.client.listPrompts()).prompts.map(
      (p) => p.name,
    );
    expect(tools.some((tool) => tool.includes(name))).toBe(true);
    expect(prompts.some((prompt) => prompt.includes(name))).toBe(true);
    evidence.step(
      "4. fresh client: list, search, read file, tool and prompt",
      true,
      {
        tool: tools.find((tool) => tool.includes(name)),
        prompt: prompts.find((prompt) => prompt.includes(name)),
      },
    );

    // 5. A hook edit reaches what a new session is told.
    const hookText = `Journey hook ${runId}: synthetic SessionStart line.`;
    const added = await author.ok("edit_hook", {
      action: "add",
      event: "SessionStart",
      text: hookText,
    });
    const hookId =
      added.entry?.id ??
      (await author.ok("list_hooks")).entries.find(
        (entry: { text: string }) => entry.text === hookText,
      )?.id;
    expect(hookId).toBeTruthy();
    expect(await sessionStart(authorToken)).toContain(hookText);
    await author.ok("edit_hook", { action: "remove", id: hookId });
    expect(await sessionStart(authorToken)).not.toContain(hookText);
    evidence.step(
      "5. edit_hook add and remove reach a new session's instructions",
      true,
      {
        hookId,
      },
    );

    // 6. Disable, then delete, from the console.
    await visit(page, `/skills?q=${encodeURIComponent(name)}`);
    const row = page.locator("tr, li").filter({
      has: page.getByRole("link", { name, exact: true }),
    });
    const toggle = row.getByRole("switch", { name: `${name} enabled` });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () =>
        (await fresh.ok("list_skills")).skills.some(
          (skill: { name: string }) => skill.name === name,
        ),
      )
      .toBe(false);
    const disabledGet = await fresh.call("get_skill", { name });
    expect(disabledGet.isError).toBe(true);
    await evidence.shot(page, "04-disabled");
    await row.getByRole("checkbox", { name: `Select ${name}` }).check();
    await page.getByRole("button", { name: "Delete", exact: true }).click();
    await expect(page.getByRole("link", { name, exact: true })).toHaveCount(0);
    evidence.step(
      "6. disable hides it from a client; delete removes the row",
      true,
      {
        disabledGet: text(disabledGet).slice(0, 160),
      },
    );

    // Same name, other tenant.
    let foreign = "not run: no second tenant configured";
    if (credentials("B")) {
      const other = await memberContext(browser, "B");
      try {
        const b = await mcpClient(
          await mintToken(other.page, `${tokenPrefix} tenant b`, [
            "skills:read",
            "skills:write",
          ]),
          "journey-tenant-b",
        );
        clients.push(b);
        await b.ok("publish_skill", {
          body: skillBody(name, "Tenant B's own text."),
        });
        const theirs = await b.ok("get_skill", { name });
        expect(JSON.stringify(theirs)).toContain("Tenant B's own text.");
        expect(JSON.stringify(theirs)).not.toContain("check the fixture");
        expect((await fresh.call("get_skill", { name })).isError).toBe(true);
        foreign = "tenant B published the same name and sees only its own body";
        await revokeTokens(other.page, tokenPrefix);
      } finally {
        await other.context.close();
      }
    }
    evidence.step("same-name skills stay per tenant", true, { foreign });

    // Phone width: the list and the add dialog.
    const phone = await memberContext(browser, "A", { width: 320 });
    try {
      await visit(phone.page, "/skills");
      await evidence.shot(phone.page, "05-phone-list");
      await visit(phone.page, "/skills?add=write");
      await evidence.shot(phone.page, "06-phone-write");
    } finally {
      await phone.context.close();
    }
    evidence.step("phone 320px list and write dialog fit", true);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await revokeTokens(page, tokenPrefix).catch(() => {});
    evidence.record.cleanup.push(
      `bearer tokens labelled "${tokenPrefix}" revoked`,
      `skill ${name} deleted from the console (restorable under Show deleted)`,
      "hook entry added by the run removed",
    );
    evidence.flush();
    await context.close();
  }
});
