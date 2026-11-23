import { test } from "@playwright/test";
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
  visit,
} from "./harness";

/*
 * J9, docs/testing/user-journeys.md#j9-see-what-my-agents-did, as a
 * non-admin member: two agents work while the person is away, then the
 * person reads /activity.
 */

test("J9: see what my agents did while I was away", async ({ browser }) => {
  const evidence = new Evidence("j9");
  const project = `journey-j9-${runId}`;
  const tokenPrefix = `journey j9 ${runId}`;
  const { context, page } = await memberContext(browser, "A");
  const clients: Mcp[] = [];
  try {
    const a = await mcpClient(
      await mintToken(page, `${tokenPrefix} agent a`, ["todos:write"]),
      "journey-agent-a",
    );
    const b = await mcpClient(
      await mintToken(page, `${tokenPrefix} agent b`, [
        "memories:write",
        "skills:write",
      ]),
      "journey-agent-b",
    );
    clients.push(a, b);

    // While away: agent A finishes one to-do and leaves one blocked.
    const done = await a.ok("create_todo", {
      title: "J9 finished task",
      project,
    });
    const blocked = await a.ok("create_todo", {
      title: "J9 blocked task",
      project,
    });
    evidence.fixture(done.id);
    evidence.fixture(blocked.id);
    const lease = await a.ok("claim_todo", { id: done.id });
    await a.ok("update_todo", {
      id: done.id,
      token: lease.token,
      body: "Halfway: the synthetic fixture loads.",
    });
    await a.ok("complete_todo", {
      id: done.id,
      token: lease.token,
      summary: "Synthetic task finished.",
    });
    const blockLease = await a.ok("claim_todo", { id: blocked.id });
    await a.ok("update_todo", {
      id: blocked.id,
      token: blockLease.token,
      blocked_on: "Waiting on a synthetic decision.",
    });
    // Agent B saves a memory and publishes a skill.
    const memory = await b.ok("save_memory", {
      title: "J9 synthetic decision: fixtures stay synthetic.",
      body: "Synthetic memory written by the J9 journey.",
      type: "decision",
      project,
      tags: ["journey"],
    });
    evidence.fixture(memory.id);
    const skill = `journey-j9-${runId.slice(-6)}`;
    await b.ok("publish_skill", {
      body: `---\nname: ${skill}\ndescription: Synthetic J9 skill. Use only in the J9 journey.\n---\n\nSynthetic.\n`,
      project,
    });
    evidence.fixture(`skill:${skill}`);
    evidence.step("agents A and B write while the person is away", true);

    // The person comes back.
    await visit(page, "/activity");
    await expect(
      page.getByRole("link", { name: "Activity", exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("link", { name: "Workbench", exact: true }),
    ).toHaveCount(0);
    await visit(page, `/activity?project=${project}`);
    const outcomes = page.getByTestId("activity-outcomes");
    await expect(outcomes).toContainText("1 to-do completed");
    await expect(outcomes).toContainText("2 to-dos created");
    await expect(outcomes).toContainText("1 to-do blocked");
    await expect(outcomes).toContainText("1 memory saved");
    await expect(outcomes).toContainText("1 skill version published");
    const runs = page.locator(".activity-run");
    const byAgent = async (label: string) =>
      runs.filter({ hasText: label }).locator(".activity-event").count();
    expect(await byAgent(`${tokenPrefix} agent a`)).toBeGreaterThanOrEqual(7);
    expect(await byAgent(`${tokenPrefix} agent b`)).toBe(2);
    await evidence.shot(page, "01-trail");
    evidence.step("the trail leads with outcomes and groups by agent", true, {
      outcomes: await outcomes.textContent(),
    });

    // Each line goes to its item.
    await page
      .locator(".activity-event")
      .filter({ hasText: "completed J9 finished task" })
      .getByRole("link", { name: "J9 finished task" })
      .click();
    await expect(page.locator("dialog.modal-pane")).toContainText(
      "J9 finished task",
    );
    await visit(page, `/activity?project=${project}`);
    await page
      .locator(".activity-event")
      .filter({ hasText: "saved J9 synthetic decision" })
      .getByRole("link")
      .first()
      .click();
    await expect(
      page.getByText("J9 synthetic decision: fixtures stay synthetic.").first(),
    ).toBeVisible();
    evidence.step("trail lines open the to-do and the memory", true);

    // A day with nothing in it says so.
    await visit(page, `/activity?day=2000-01-01&project=${project}`);
    await expect(page.getByText("Nothing was saved")).toBeVisible();
    evidence.step("an empty day says so", true);

    // The raw call log is owner-only, enforced on the server.
    const workbench = await page.goto("/workbench?tab=logs");
    expect(workbench?.status()).toBeGreaterThanOrEqual(400);
    await expect(page.getByText(`${tokenPrefix} agent a`)).toHaveCount(0);
    evidence.step("a member cannot open the workbench logs", true, {
      status: workbench?.status(),
    });

    let foreign = "not run: no second tenant configured";
    if (credentials("B")) {
      const other = await memberContext(browser, "B");
      try {
        await visit(other.page, `/activity?project=${project}`);
        await expect(other.page.getByText("Nothing was saved")).toBeVisible();
        await visit(other.page, "/activity");
        await expect(other.page.getByText("J9 finished task")).toHaveCount(0);
        foreign = "tenant B's trail shows none of A's writes";
      } finally {
        await other.context.close();
      }
    }
    evidence.step("trail is tenant-private", true, { foreign });

    for (const scripting of [true, false]) {
      const phone = await memberContext(browser, "A", {
        width: 320,
        javaScriptEnabled: scripting,
      });
      try {
        await visit(phone.page, `/activity?project=${project}`, scripting);
        await expect(
          phone.page.locator(".activity-event").first(),
        ).toBeVisible();
        await evidence.shot(
          phone.page,
          scripting ? "02-phone" : "03-phone-no-script",
        );
      } finally {
        await phone.context.close();
      }
    }
    evidence.step("phone 320px with and without scripts", true);
  } finally {
    for (const client of clients) await client.close().catch(() => {});
    await revokeTokens(page, tokenPrefix).catch(() => {});
    evidence.record.cleanup.push(
      `bearer tokens labelled "${tokenPrefix}" revoked`,
      `synthetic to-dos, memory and skill remain in project ${project}`,
    );
    evidence.flush();
    await context.close();
  }
});
