import { localSql } from "./fixtures/asset-processing";
import { expect, goto, mcp, test } from "./fixtures/session";
import { seedTranscripts } from "./fixtures/transcripts";

/*
 * The transcripts contract, docs/design/transcripts.md: a day-grouped list
 * with numbers and tags per session, and a pane that reads as prompts with
 * folded tool runs, open errors, and the tags and subjects the session's
 * Valise calls reached.
 */

const SHOTS = process.env.VALISE_TRANSCRIPT_SHOTS;

async function seed(baseURL: string, request: Parameters<typeof mcp>[0]) {
  const project = `trn-${crypto.randomUUID().slice(0, 8)}`;
  const tag = `area-${crypto.randomUUID().slice(0, 6)}`;
  const todo = await mcp<{ id: string }>(request, "create_todo", {
    title: "Pin the clock in the hedgerow fixture",
    project,
    tags: [tag, "flaky"],
  });
  const memory = await mcp<{ id: string }>(request, "save_memory", {
    type: "decision",
    title: "Specs pin the clock rather than retry",
    body: "A spec that reads the clock twice pins it in its fixture; a retry hides the race.",
    tags: [tag],
  });
  const subject = `sub_${crypto.randomUUID()}`;
  const subjectName = `Reliability ${tag}`;
  await localSql(
    baseURL,
    `INSERT INTO memory_subjects (subject_id,user_id,name,kind,created_at,updated_at)
       VALUES ('${subject}','local','${subjectName}','topic',1,1);
     INSERT INTO memory_subject_members (subject_id,memory_id,asserted_by,confirmed_at,confirmed_by,created_at)
       VALUES ('${subject}','${memory.id.replace(/^memory:/, "")}','person',1,'local',1);`,
  );
  const now = Math.floor(Date.now() / 1000);
  const ids = Array.from({ length: 8 }, () => `trn_${crypto.randomUUID()}`);
  await seedTranscripts(baseURL, "local", [
    {
      id: ids[0],
      title: "Why does the hedgerow spec flake on the second run?",
      project,
      start: now - 3 * 3600,
      prompts: 9,
      mention: [todo.id, memory.id],
    },
    ...ids.slice(1).map((id, index) => ({
      id,
      title: `Synthetic session ${index + 1} about the deploy check`,
      project,
      client: index % 3 === 0 ? "codex" : "claude-code",
      device: index % 2 ? "desktop" : "laptop",
      start: now - (index + 1) * 86_400,
      prompts: 1 + (index % 4),
    })),
  ]);
  return { project, tag, todo, subject, subjectName, linked: ids[0], ids };
}

test("transcripts read as prompts with folded tools, numbers, tags and subjects", async ({
  page,
  baseURL,
  request,
}) => {
  const seeded = await seed(baseURL ?? "", request);
  await goto(page, `/activity/transcripts?project=${seeded.project}`);

  // Activity's two sections are its SubNav, not a link in the page body.
  await expect(
    page
      .getByRole("navigation", { name: "Activity sections" })
      .getByRole("link", { name: "Transcripts" }),
  ).toHaveAttribute("aria-current", "page");

  // The list: grouped by day, newest start first, with numbers and tags.
  await expect(
    page.getByRole("heading", { level: 2, name: "Today" }),
  ).toBeVisible();
  const today = page.getByRole("list", { name: "Captured sessions, Today" });
  const row = today.locator(".item-row").first();
  await expect(row).toContainText("9 prompts");
  await expect(row).toContainText(/\d+ tool calls/);
  await expect(row).toContainText(/Started \d\d:\d\d/);
  await expect(row.locator(".tag", { hasText: seeded.tag })).toBeVisible();
  await expect(page.locator(".transcript-day")).toHaveCount(8);
  if (SHOTS)
    await page.screenshot({ path: `${SHOTS}/list-1280.png`, fullPage: true });

  // The other order: by each session's latest turn.
  await page.getByRole("button", { name: "Sort sessions" }).click();
  await page.getByRole("menuitem", { name: "Last active" }).click();
  await expect(page).toHaveURL(/sort=last/);
  await expect(today.locator(".item-row").first()).toContainText(
    /Last active \d\d:\d\d/,
  );

  // A date range keeps the sessions active on those days.
  const day = new Date(Date.now() - 3 * 86_400_000).toISOString().slice(0, 10);
  await goto(
    page,
    `/activity/transcripts?project=${seeded.project}&from=${day}&to=${day}`,
  );
  await expect(page.locator(".item-row").first()).toContainText(
    "Synthetic session 3",
  );
  await expect(page.locator(".item-list")).not.toContainText(
    "Synthetic session 1 ",
  );
  await expect(page.locator(".item-list")).not.toContainText("hedgerow");
  await expect(page.locator('[data-facet="date"]')).toContainText(/\d+ \w{3}/);

  // A tag on a row narrows the list to the sessions that reached it.
  await goto(page, `/activity/transcripts?project=${seeded.project}`);
  await row.locator(".tag", { hasText: seeded.tag }).click();
  await expect(page).toHaveURL(new RegExp(`tag=${seeded.tag}`));
  await expect(page.locator(".item-row")).toHaveCount(1);

  // The pane: numbers, chips, section tabs, then the conversation.
  await page
    .getByRole("link", {
      name: "Why does the hedgerow spec flake on the second run?",
    })
    .click();
  const pane = page.getByRole("dialog");
  const numbers = pane.getByRole("definition");
  await expect(numbers.first()).toHaveText("9");
  const links = pane.getByRole("region", { name: "Tags and subjects" });
  await expect(links.locator(".tag", { hasText: seeded.tag })).toBeVisible();
  await expect(
    links.getByRole("link", { name: seeded.subjectName }),
  ).toHaveAttribute("href", `/memories/subjects/${seeded.subject}`);
  const tabs = pane.getByRole("navigation", { name: "Session sections" });
  await expect(tabs.getByRole("link")).toHaveText([
    /To-dos/,
    /Memories/,
    /Files/,
    /Tools/,
    /Prompts/,
    /Details/,
  ]);
  // The first section with something in it is open.
  await expect(tabs.getByRole("link", { name: /To-dos/ })).toHaveAttribute(
    "aria-current",
    "true",
  );
  await expect(
    pane
      .getByRole("region", { name: "To-dos" })
      .getByRole("link", { name: "Pin the clock in the hedgerow fixture" }),
  ).toBeVisible();
  // A tab is a URL; flipping it draws data already on the page.
  const reloads: string[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (
      url.pathname.endsWith(".data") &&
      url.searchParams.get("_routes") !== "root"
    )
      reloads.push(request.url());
  });
  await tabs.getByRole("link", { name: /Prompts/ }).click();
  await expect(page).toHaveURL(/section=prompts/);
  const outline = pane.getByRole("navigation", { name: "Prompts" });
  await expect(outline.locator("li")).toHaveCount(9);
  expect(reloads).toEqual([]);

  const conversation = pane.getByRole("region", { name: "Conversation" });
  await expect(conversation.getByRole("article")).toHaveCount(9);
  await expect(
    conversation.getByRole("heading", { name: /^Prompt 1/ }),
  ).toBeVisible();
  // A task notification is an event line in the first exchange, not a prompt.
  const event = conversation
    .getByRole("article", { name: "Prompt 1" })
    .locator(".transcript-event");
  await expect(event).toContainText(
    'Background task: Background command "Run the full verify gate" completed (exit code 0)',
  );
  await event.locator("summary").click();
  await expect(event).toContainText("Task: b1cubygaz");
  // The exchange's last reply is its answer; the one before it is a note.
  const plainExchange = conversation.getByRole("article", { name: "Prompt 2" });
  await expect(plainExchange.locator(".turn-assistant").first()).toHaveClass(
    /turn-progress/,
  );
  await expect(plainExchange.locator(".turn-assistant").last()).toHaveClass(
    /turn-answer/,
  );
  // A background task starts a stretch of its own: the reply before it
  // answers the prompt, the one after it reports the task.
  const tasked = conversation.getByRole("article", { name: "Prompt 1" });
  await expect(tasked.locator(".turn-answer")).toHaveCount(2);
  // A reply that opens with a list starts it under the speaker, not beside.
  const listed = conversation
    .getByRole("article", { name: "Prompt 2" })
    .locator(".turn-answer");
  const speaker = await listed.locator(".transcript-speaker").boundingBox();
  const list = await listed.locator("ol").boundingBox();
  expect(list?.y ?? 0).toBeGreaterThanOrEqual(
    (speaker?.y ?? 0) + (speaker?.height ?? 0) - 1,
  );
  // System text folds to the names of its sources, each opening to its text.
  const system = conversation
    .getByRole("article", { name: "Prompt 1" })
    .locator("details.transcript-system");
  await expect(system).toHaveCount(1);
  await expect(system).not.toHaveAttribute("open", "");
  await expect(system.locator("> summary")).toContainText(
    "System · System prompt, AGENTS.md",
  );
  await system.locator("> summary").click();
  const agentsFile = system.locator("li details").nth(1);
  await expect(agentsFile.locator("summary")).toHaveAttribute(
    "title",
    "/w/valise/AGENTS.md",
  );
  await agentsFile.locator("summary").click();
  await expect(agentsFile.locator("pre")).toContainText(
    "Valise is one Cloudflare Worker.",
  );
  if (SHOTS) {
    await system.screenshot({ path: `${SHOTS}/system-1280.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    await system.screenshot({ path: `${SHOTS}/system-390.png` });
    await page.setViewportSize({ width: 1280, height: 900 });
  }
  // Thinking is its own folded block, never a reply.
  const thinking = plainExchange.locator("details.transcript-thinking");
  await expect(thinking).toHaveCount(1);
  await expect(thinking).not.toHaveAttribute("open", "");
  await expect(thinking.locator("summary")).toContainText(
    "Thinking · The second run reuses the clock",
  );
  await thinking.locator("summary").click();
  await expect(thinking.locator(".prose")).toContainText("check the fixture");
  // Replies are Markdown: a table, a heading and a highlighted fence.
  const reply = conversation.locator(".turn-assistant").nth(1);
  await expect(reply.locator("table")).toBeVisible();
  await expect(
    reply.getByRole("heading", { name: "What changed" }),
  ).toBeVisible();
  await expect(reply.locator("code.language-ts .hljs-keyword")).toHaveText(
    "const",
  );
  // No turn is drawn with the old quotation rule.
  await expect(conversation.locator(".turn-assistant").first()).toHaveCSS(
    "box-shadow",
    "none",
  );
  // Tool runs fold; a run with a failed call opens by itself.
  const runs = conversation.locator("details.transcript-tools");
  expect(await runs.count()).toBeGreaterThan(8);
  for (const run of await conversation
    .locator("details.transcript-tools:not(.has-errors)")
    .all())
    await expect(run).not.toHaveAttribute("open", "");
  const failed = await conversation
    .locator("details.transcript-tools.has-errors")
    .count();
  for (const run of await conversation
    .locator("details.transcript-tools.has-errors")
    .all())
    await expect(run).toHaveAttribute("open", "");
  if (SHOTS) {
    await page.screenshot({ path: `${SHOTS}/pane-1280.png` });
    await conversation
      .getByRole("heading", { name: /^Prompt 1/ })
      .scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${SHOTS}/pane-conversation-1280.png` });
  }

  // Every line's time is a link to that message alone.
  const firstPrompt = conversation
    .getByRole("article", { name: "Prompt 1" })
    .locator(".turn-human");
  const anchor = await firstPrompt.getAttribute("id");
  await expect(
    firstPrompt.getByRole("link", { name: /^\d\d:\d\d$/ }),
  ).toHaveAttribute(
    "href",
    `/activity/transcripts?open=transcript%3A${seeded.linked}#${anchor}`,
  );
  await expect(
    firstPrompt.getByRole("button", { name: "Copy link to this message" }),
  ).toBeAttached();
  // Every prompt but the last links to the next one.
  await expect(conversation.locator(".transcript-next")).toHaveCount(8);
  const second = await conversation
    .getByRole("article", { name: "Prompt 2" })
    .locator(".turn-human")
    .getAttribute("id");
  await expect(
    conversation
      .getByRole("article", { name: "Prompt 1" })
      .getByRole("link", { name: "Next prompt" }),
  ).toHaveAttribute("href", `#${second}`);
  // An outline entry is a link to that prompt's anchor.
  await outline.getByRole("link").nth(4).click();
  await expect(page).toHaveURL(/#t-\d+$/);

  // Hiding tool calls leaves prompts and replies, and every failed run.
  await pane.getByRole("link", { name: "Hide tool calls" }).click();
  await expect(page).toHaveURL(/tools=hide/);
  await expect(page).toHaveURL(/section=prompts/);
  await expect(
    pane.getByRole("link", { name: "Show tool calls" }),
  ).toBeVisible();
  await expect(
    conversation.locator("details.transcript-tools:not(.has-errors)"),
  ).toHaveCount(0);
  await expect(
    conversation.locator("details.transcript-tools.has-errors"),
  ).toHaveCount(failed);
  await expect(conversation.locator(".turn-assistant").first()).toBeVisible();
  await expect(conversation.locator(".transcript-event")).toHaveCount(0);
  await expect(conversation.locator(".transcript-thinking")).toHaveCount(0);
  await expect(conversation.locator(".transcript-system")).toHaveCount(0);
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/pane-talk-1280.png` });
});

test("transcripts fit 320px, and filter and open without scripts", async ({
  browser,
  baseURL,
  request,
  session,
}) => {
  const seeded = await seed(baseURL ?? "", request);
  const context = await browser.newContext({
    baseURL,
    javaScriptEnabled: false,
    storageState: session,
    viewport: { width: 320, height: 700 },
  });
  const phone = await context.newPage();
  await goto(
    phone,
    `/activity/transcripts?project=${seeded.project}&errors=only`,
    false,
  );
  expect(await phone.locator(".item-row").count()).toBeLessThanOrEqual(8);
  await goto(
    phone,
    `/activity/transcripts?project=${seeded.project}&open=transcript:${seeded.linked}`,
    false,
  );
  await expect(phone.getByRole("dialog")).toContainText("Prompt 1");
  // A section tab is a link, so it opens without scripts too.
  await phone
    .getByRole("navigation", { name: "Session sections" })
    .getByRole("link", { name: "Details" })
    .click();
  await expect(phone).toHaveURL(/section=details/);
  await expect(
    phone.getByRole("region", { name: "Details" }).getByText("Directory"),
  ).toBeVisible();
  expect(
    await phone.evaluate("document.documentElement.scrollWidth <= innerWidth"),
  ).toBe(true);
  if (SHOTS)
    await phone.screenshot({ path: `${SHOTS}/pane-320.png`, fullPage: true });
  await context.close();
});

test("the session list loads more as it scrolls, keeping its filters", async ({
  page,
  baseURL,
}) => {
  const project = `scroll-${crypto.randomUUID().slice(0, 8)}`;
  const now = Math.floor(Date.now() / 1000);
  await seedTranscripts(
    baseURL ?? "",
    "local",
    Array.from({ length: 35 }, (_, index) => ({
      id: `trn_${crypto.randomUUID()}`,
      title: `Scrolled session ${index + 1}`,
      project,
      device: "phone",
      start: now - index * 3600,
      prompts: 1,
    })),
  );
  const filtered = `/activity/transcripts?project=${project}&device=phone`;
  await goto(page, filtered);
  const rows = page.locator(".item-row");
  await expect(rows).toHaveCount(30);
  const progress = page.getByLabel("List progress");
  await expect(progress).toContainText("Showing 30 of 35 sessions");
  // The next page keeps the page's own filters, so it works without scripts.
  const next = new URL(
    (await progress
      .getByRole("link", { name: "Load more" })
      .getAttribute("href")) ?? "",
    "http://x",
  );
  expect(next.searchParams.get("project")).toBe(project);
  expect(next.searchParams.get("device")).toBe("phone");
  expect(next.searchParams.get("page")).toBe("2");
  await progress.scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(35);
  await expect(page).toHaveURL(/page=2/);
  await expect(progress).toContainText("Showing 35 of 35 sessions");
  await expect(progress.getByRole("link", { name: "Load more" })).toHaveCount(
    0,
  );

  // With a session open in the pane, the list beside it still loads more,
  // and the pane stays open.
  await goto(page, filtered);
  await rows.first().locator("a").first().click();
  const pane = page.getByRole("dialog");
  await expect(pane).toBeVisible();
  await expect(rows).toHaveCount(30);
  await progress.scrollIntoViewIfNeeded();
  await expect(rows).toHaveCount(35);
  await expect(page).toHaveURL(/page=2/);
  await expect(page).toHaveURL(/open=transcript/);
  await expect(pane).toBeVisible();
});
