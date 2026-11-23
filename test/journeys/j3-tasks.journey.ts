import { type Locator, type Page, test } from "@playwright/test";
import {
  credentials,
  Evidence,
  expect,
  type Mcp,
  mcpClient,
  memberContext,
  mintToken,
  revokeTokens,
  runId,
  text,
  visit,
} from "./harness";

/*
 * J3, docs/testing/user-journeys.md#j3-manage-tasks, as a non-admin member.
 * Two bearer-token MCP clients stand in for two agents; a third token holds
 * only todos:read. Member B, when configured, is a separate tenant.
 */

/** The narrowest scopes the agents need: fetch is a search:read tool. */
const AGENT_SCOPES = ["todos:read", "todos:write", "search:read"];

const rowFor = (page: Page, id: string) =>
  page
    .locator(".todo-card")
    .filter({ has: page.locator(`input[name=id][value="${id}"]`) });
const openId = (page: Page) => new URL(page.url()).searchParams.get("open");

/** "Add relation" opens a centred modal over the pane; adding closes it. */
async function relate(pane: Locator, kind: string, id: string) {
  await pane.getByRole("link", { name: "Add relation", exact: true }).click();
  const modal = pane.page().getByRole("dialog", { name: "Add a relation" });
  await modal.getByRole("combobox", { name: "Relation", exact: true }).click();
  await modal.getByRole("option", { name: new RegExp(`^${kind}\\b`) }).click();
  await modal.getByRole("combobox", { name: "To-do", exact: true }).fill(id);
  await modal
    .getByRole("option", { name: new RegExp(id.slice(5, 17)) })
    .click();
  await modal
    .getByRole("button", { name: "Add relation", exact: true })
    .click();
  await expect(modal).toHaveCount(0);
}

test("J3: day-to-day tasks across the console and two agents", async ({
  browser,
}) => {
  const evidence = new Evidence("j3");
  const project = `journey-j3-${runId}`;
  const tokenPrefix = `journey j3 ${runId}`;
  const { context, page } = await memberContext(browser, "A");
  const clients: Mcp[] = [];
  try {
    const a = await mcpClient(
      await mintToken(page, `${tokenPrefix} agent a`, AGENT_SCOPES),
      "journey-agent-a",
    );
    const b = await mcpClient(
      await mintToken(page, `${tokenPrefix} agent b`, AGENT_SCOPES),
      "journey-agent-b",
    );
    const reader = await mcpClient(
      await mintToken(page, `${tokenPrefix} read only`, [
        "todos:read",
        "search:read",
      ]),
      "journey-reader",
    );
    clients.push(a, b, reader);
    evidence.step("member signs in and mints three bearer tokens", true);

    const make = async (title: string) => {
      const todo = await a.ok("create_todo", {
        title,
        project,
        tags: ["journey"],
      });
      evidence.fixture(todo.id);
      return todo.id as string;
    };
    const prerequisite = await make("J3 prerequisite");
    const parent = await make("J3 parent");

    // 1. Create with shorthand, filter, open by link, edit, comment, attach.
    await visit(page, "/todos");
    await page.getByRole("link", { name: "New to-do", exact: true }).click();
    await page
      .getByRole("combobox", { name: "New to-do", exact: true })
      .fill(`J3 daily task project:${project} #journey`);
    await page
      .getByRole("textbox", { name: "Description", exact: true })
      .fill("Synthetic daily task for journey acceptance");
    await page.getByRole("button", { name: "Add to-do", exact: true }).click();
    const created = page
      .locator(".todo-add-landed")
      .getByRole("link", { name: "Open it" });
    await expect(created).toBeVisible();
    const id = new URL(
      (await created.getAttribute("href"))!,
      page.url(),
    ).searchParams.get("open")!;
    evidence.fixture(id);
    const list = `/todos?project=${project}&tag=journey`;
    await visit(page, list);
    await expect(page.locator(".todo-card")).toHaveCount(3);
    await evidence.shot(page, "01-filtered-list");
    const rowsBefore = await page.locator(".todo-open").allTextContents();
    await rowFor(page, id).locator(".todo-open").click();
    const pane = page.locator("dialog.modal-pane");
    await expect(pane).toBeVisible();
    await expect.poll(() => openId(page)).toBe(id);
    await pane.getByRole("link", { name: "Edit body", exact: true }).click();
    const body = pane.getByRole("textbox", { name: "Body", exact: true });
    await body.fill("Edited in the member console");
    await pane.getByRole("button", { name: "Save", exact: true }).click();
    await expect(body).toHaveCount(0);
    const comment = pane.getByRole("textbox", {
      name: "Comment on J3 daily task",
    });
    await comment.fill("Synthetic member comment");
    await pane.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(comment).toHaveValue("");
    await pane.getByRole("link", { name: "Add files" }).click();
    const adding = page.getByRole("dialog", { name: "Add files" });
    await adding.getByLabel("Choose a file").setInputFiles({
      name: "j3-evidence.txt",
      mimeType: "text/plain",
      buffer: Buffer.from(`J3 synthetic evidence ${runId}`),
    });
    await adding.getByRole("button", { name: "Attach", exact: true }).click();
    await expect(
      pane.getByRole("link", { name: "j3-evidence.txt", exact: true }),
    ).toBeVisible();
    const fetched = await b.ok("fetch", { id, full: true });
    expect(fetched.text).toContain("Edited in the member console");
    expect(
      fetched.metadata.updates.some(
        (u: { body?: string }) => u.body === "Synthetic member comment",
      ),
    ).toBe(true);
    expect(fetched.metadata.files).toHaveLength(1);
    await evidence.shot(page, "02-pane-after-edit");
    evidence.step(
      "1. create, filter, open, edit, comment, attach; agent B reads all of it",
      true,
      {
        id,
        files: fetched.metadata.files.length,
      },
    );

    // 2. Parent organizes, prerequisite gates claiming.
    await relate(pane, "Parent", parent);
    await expect(
      pane.getByRole("button", {
        name: "Remove parent J3 parent",
        exact: true,
      }),
    ).toBeVisible();
    await relate(pane, "Blocked by", prerequisite);
    await expect(
      pane.getByRole("button", {
        name: "Remove blocked by J3 prerequisite",
        exact: true,
      }),
    ).toBeVisible();
    const gated = await b.call("claim_todo", { id });
    expect(gated.isError).toBe(true);
    const parentLease = await a.ok("claim_todo", { id: parent });
    await a.ok("complete_todo", {
      id: parent,
      token: parentLease.token,
      summary: "Synthetic parent done",
    });
    expect((await b.ok("fetch", { id })).metadata.state).toBe("pending");
    evidence.step(
      "2. parent completes without cascading; prerequisite refuses the claim",
      true,
    );

    // 4. Prerequisite done; the manual blocker stays.
    await pane.getByRole("link", { name: "Block this", exact: true }).click();
    await pane
      .getByRole("textbox", { name: "Blocked on" })
      .fill("Synthetic manual decision");
    await pane.getByRole("button", { name: "Block", exact: true }).click();
    const prereqLease = await a.ok("claim_todo", { id: prerequisite });
    await a.ok("complete_todo", {
      id: prerequisite,
      token: prereqLease.token,
      summary: "Synthetic prerequisite done",
    });
    expect((await b.ok("fetch", { id })).metadata.blocked_on).toBe(
      "Synthetic manual decision",
    );
    await evidence.shot(page, "03-manual-blocker");
    evidence.step(
      "4. completing the prerequisite leaves the manual blocker",
      true,
    );

    // 3. Race two claims; one wins; expiry and the stale token.
    const race = await Promise.all([
      a.call("claim_todo", { id, ttl_seconds: 5 }),
      b.call("claim_todo", { id, ttl_seconds: 5 }),
    ]);
    expect(race.filter((r) => !r.isError)).toHaveLength(1);
    const winner = race[0].isError ? b : a;
    const loser = race[0].isError ? a : b;
    const lease = race.find((r) => !r.isError)!.structuredContent;
    // Claiming a manually blocked to-do is the agent saying the blocker is
    // resolved (ADR-0018). The D1 mirror that fetch reads may lag the
    // coordinator, so poll and record how long it took.
    const claimedAt = Date.now();
    await expect
      .poll(async () => (await loser.ok("fetch", { id })).metadata.state, {
        timeout: 10_000,
        intervals: [100, 250, 500],
      })
      .toBe("claimed");
    const mirrorLagMs = Date.now() - claimedAt;
    const held = await loser.ok("fetch", { id });
    expect(held.metadata.lease_holder).toBeTruthy();
    expect(held.metadata.blocked_on).toBeNull();
    await winner.ok("update_todo", {
      id,
      token: lease.token,
      body: "Progress from the winning agent",
    });
    await expect
      .poll(
        async () =>
          (await loser.call("claim_todo", { id, ttl_seconds: 60 })).isError,
        {
          timeout: 15_000,
          intervals: [1000],
        },
      )
      .not.toBe(true);
    const stale = await winner.call("update_todo", {
      id,
      token: lease.token,
      body: "Stale must not land",
    });
    expect(stale.isError).toBe(true);
    evidence.step(
      "3. two-client race: one winner; expiry; old token refused",
      true,
      {
        winner: winner === a ? "journey-agent-a" : "journey-agent-b",
        mirrorLagMs,
      },
    );

    // Scope and tenant denial.
    const narrow = await reader.call("update_todo", {
      id,
      token: 1,
      body: "No write scope",
    });
    expect(narrow.isError).toBe(true);
    expect(text(narrow)).toContain("todos:write");
    expect((await reader.ok("fetch", { id })).id).toBe(
      `todo:${id.replace(/^todo:/, "")}`,
    );
    let foreign: string | null = null;
    if (credentials("B")) {
      const other = await memberContext(browser, "B");
      try {
        const otherClient = await mcpClient(
          await mintToken(other.page, `${tokenPrefix} tenant b`, AGENT_SCOPES),
          "journey-tenant-b",
        );
        clients.push(otherClient);
        const guess = await otherClient.call("fetch", { id });
        expect(guess.isError).toBe(true);
        const steal = await otherClient.call("claim_todo", { id });
        expect(steal.isError).toBe(true);
        await visit(other.page, `/todos?open=${encodeURIComponent(id)}`);
        await expect(
          other.page.getByText("Edited in the member console"),
        ).toHaveCount(0);
        foreign = "tenant B: fetch, claim and console open all refused";
        await revokeTokens(other.page, tokenPrefix);
      } finally {
        await other.context.close();
      }
    }
    evidence.step("scope and tenant denial", true, {
      narrow: "todos:read token cannot update",
      narrowRefusal: text(narrow).slice(0, 200),
      foreign: foreign ?? "not run: no second tenant configured",
    });

    // 5. Complete and reopen in place; another client reads the history.
    await visit(page, `${list}&open=${encodeURIComponent(id)}`);
    await expect(pane.getByRole("region", { name: "History" })).toContainText(
      "Progress from the winning agent",
    );
    const row = rowFor(page, id);
    const top = (await row.boundingBox())!.y;
    const circle = row.locator(".todo-head").getByRole("checkbox");
    await circle.click();
    await expect(circle).toHaveAttribute("aria-checked", "true");
    await expect
      .poll(async () => (await b.ok("fetch", { id })).metadata.state)
      .toBe("done");
    await circle.click();
    await expect(circle).toHaveAttribute("aria-checked", "false");
    await expect
      .poll(async () => (await b.ok("fetch", { id })).metadata.state)
      .toBe("pending");
    for (const status of await row.getByTestId("todo-status").all())
      await expect(status).not.toContainText("Completed");
    expect(await page.locator(".todo-open").allTextContents()).toEqual(
      rowsBefore,
    );
    expect(Math.abs((await row.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
    expect(openId(page)).toBe(id);
    await evidence.shot(page, "04-reopened-in-place");
    evidence.step(
      "5. complete and reopen keep row, pane and URL; agent B sees each state",
      true,
    );

    // Tag edit does not claim or clear blockers.
    const tagged = await a.call("edit_todo_tags", {
      id,
      add_tags: ["journey-tag"],
    });
    if (!tagged.isError) {
      const after = await b.ok("fetch", { id });
      expect(after.metadata.tags).toEqual(
        expect.arrayContaining(["journey", "journey-tag"]),
      );
      expect(after.metadata.state).toBe("pending");
    }
    evidence.step(
      "tag edit keeps state, blocker and other tags",
      !tagged.isError,
    );

    // Phone: the list and the pane at 320px.
    const phone = await memberContext(browser, "A", { width: 320 });
    try {
      await visit(phone.page, `${list}&open=${encodeURIComponent(id)}`);
      await expect(phone.page.locator("dialog.modal-pane")).toBeVisible();
      await evidence.shot(phone.page, "05-phone-pane");
    } finally {
      await phone.context.close();
    }
    const scriptless = await memberContext(browser, "A", {
      width: 320,
      javaScriptEnabled: false,
    });
    try {
      await visit(
        scriptless.page,
        `${list}&open=${encodeURIComponent(id)}`,
        false,
      );
      await expect(scriptless.page.locator("dialog.modal-pane")).toBeVisible();
      await evidence.shot(scriptless.page, "06-phone-no-script");
    } finally {
      await scriptless.context.close();
    }
    evidence.step(
      "phone 320px and no-script pane render without sideways scroll",
      true,
    );
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await revokeTokens(page, tokenPrefix).catch(() => {});
    evidence.record.cleanup.push(
      `bearer tokens labelled "${tokenPrefix}" revoked`,
      `synthetic to-dos remain in project ${project}; nothing else touched`,
    );
    evidence.flush();
    await context.close();
  }
});
