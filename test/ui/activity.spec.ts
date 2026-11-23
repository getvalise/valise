import { localSql } from "./fixtures/asset-processing";
import { expect, goto, mcp, test } from "./fixtures/session";

// J9: what changed while I was away, read from the writes themselves.
test("activity lists what agents changed, by session, and links to each item", async ({
  page,
  request,
}) => {
  const project = `trail-${crypto.randomUUID().slice(0, 8)}`;
  const todo = await mcp(
    request,
    "create_todo",
    { title: "Trail ui task", project },
    { agent: "trail-agent", client: "trail-client" },
  );
  const lease = await mcp(
    request,
    "claim_todo",
    { id: todo.id },
    { agent: "trail-agent", client: "trail-client" },
  );
  await mcp(
    request,
    "complete_todo",
    { id: todo.id, token: lease.token, summary: "Trail ui task done." },
    { agent: "trail-agent", client: "trail-client" },
  );

  await goto(page, `/activity?project=${project}`);
  await expect(page.getByTestId("activity-outcomes")).toContainText(
    "1 to-do completed, 1 to-do created",
  );
  const run = page.getByRole("region", { name: /^trail-agent/ });
  await expect(run).toContainText("3 changes");
  await expect(run.locator(".activity-event")).toHaveText([
    /^completed Trail ui task · Trail ui task done\./,
    /^claimed Trail ui task/,
    /^created Trail ui task/,
  ]);
  // Each change is a one-line item-list row that says its kind with an icon.
  const rows = run.locator(".item-list > .activity-event");
  await expect(rows).toHaveCount(3);
  await expect(rows.getByRole("img", { name: "To-do" })).toHaveCount(3);
  for (const row of await rows.all()) {
    expect((await row.boundingBox())!.height).toBeLessThanOrEqual(36);
  }
  await run.getByRole("link", { name: "Trail ui task" }).first().click();
  await expect(page).toHaveURL(
    new RegExp(`/todos\\?open=${encodeURIComponent(todo.id)}`),
  );

  // The filters are a native GET form, and the day narrows to one UTC day.
  await goto(page, "/activity?day=2000-01-01");
  await expect(page.getByText("Nothing was saved")).toBeVisible();
});

test("activity fits 320px and works without scripts", async ({
  browser,
  baseURL,
  request,
  session,
}) => {
  const project = `trail-phone-${crypto.randomUUID().slice(0, 6)}`;
  await mcp(request, "create_todo", {
    title: "A long synthetic trail title that has to wrap on a phone screen",
    project,
  });
  await mcp(request, "save_memory", {
    type: "decision",
    title: "A memory beside the to-do in the trail",
    body: "So the trail shows two kinds.",
    project,
    tags: ["trail"],
  });
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    storageState: session,
    viewport: { width: 320, height: 700 },
  });
  const page = await context.newPage();
  await goto(page, "/activity", false);
  await page.getByLabel("Project").fill(project);
  await page.getByRole("button", { name: "Show", exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`project=${project}`));
  await expect(page.locator(".activity-event")).toHaveCount(2);
  await expect(
    page.locator(".activity-event").getByRole("img", { name: "Memory" }),
  ).toHaveCount(1);
  expect(
    await page.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).toBe(true);
  await context.close();
});

test("transcripts under Activity open a bounded, linkable conversation", async ({
  page,
  baseURL,
  browser,
  session,
}) => {
  const id = `trn_${crypto.randomUUID()}`;
  const other = `trn_${crypto.randomUUID()}`;
  const row = (key: string, user: string, title: string) =>
    `INSERT INTO transcripts (transcript_id,user_id,client,device,session_id,title,turn_count,chain_hash,source_agent,source_client,created_at,updated_at)
     VALUES ('${key}','${user}','claude-code','laptop','session-${key}','${title}',401,'','cli','cli',1000,1000);`;
  await localSql(
    baseURL ?? "",
    [
      row(id, "local", "Synthetic review conversation"),
      row(other, "other-account", "Private conversation"),
      ...Array.from(
        { length: 401 },
        (_, i) =>
          `INSERT INTO transcript_turns (transcript_id,position,kind,text,hash)
       VALUES ('${id}',${i},'${i ? "assistant" : "human"}','Synthetic turn ${i}','hash-${i}');`,
      ),
    ].join("\n"),
  );
  await goto(page, "/activity");
  await page
    .getByRole("navigation", { name: "Activity sections" })
    .getByRole("link", { name: "Transcripts" })
    .click();
  await expect(
    page.getByRole("list", { name: "Captured sessions" }),
  ).toContainText("Synthetic review conversation");
  await expect(
    page.getByRole("list", { name: "Captured sessions" }),
  ).not.toContainText("Private conversation");
  await page
    .getByRole("link", { name: "Synthetic review conversation" })
    .click();
  await expect(page.getByRole("dialog")).toContainText("Synthetic turn 0");
  await expect(page.locator(".transcript-turn")).toHaveCount(400);
  await page.getByRole("link", { name: "Later turns" }).click();
  await expect(page.locator(".transcript-turn")).toHaveCount(1);
  await expect(page.getByRole("dialog")).toContainText("Synthetic turn 400");
  const response = await page.request.get(
    `/activity/transcripts?open=transcript:${other}`,
  );
  expect(response.status()).toBe(404);

  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    storageState: session,
    viewport: { width: 320, height: 700 },
  });
  const phone = await context.newPage();
  await goto(phone, `/activity/transcripts?open=transcript:${id}`, false);
  await expect(phone.getByRole("dialog")).toContainText("Synthetic turn 0");
  expect(
    await phone.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).toBe(true);
  await context.close();
});
