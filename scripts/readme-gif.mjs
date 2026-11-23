/**
 * The README's console GIF, from fictional content on an owned local store.
 *
 * Starts the isolated UI test server, writes every row through the real MCP
 * tools on the loopback /mcp surface, captures one 1280x800 light-theme frame
 * per console view, and joins them with ffmpeg's two-pass palette. Frames go
 * to .context/readme-gif/, the GIF to docs/images/valise-console.gif.
 */
import { execFileSync } from "node:child_process";
import { mkdir, rm, stat } from "node:fs/promises";
import { chromium } from "@playwright/test";
import { runUiTestServer } from "./ui-test-server.mjs";

const port = Number(process.env.VALISE_TEST_PORT ?? 4327);
const origin = `http://localhost:${port}`;
const frames = process.env.VALISE_SHOTS_DIR ?? ".context/readme-gif";
const output = "docs/images/valise-console.gif";
const ffmpeg = process.env.FFMPEG ?? "ffmpeg";
const viewport = { width: 1280, height: 800 };
const secondsPerFrame = 2.5;
const gifWidth = Number(process.env.VALISE_GIF_WIDTH ?? 1280);
const gifColors = Number(process.env.VALISE_GIF_COLORS ?? 128);

process.env.VALISE_ADMIN_PASSWORD = "local-readme-gif-password-0001";
process.env.SESSION_SECRET = "local-readme-gif-session-secret-0001";
process.env.TOKEN_PEPPER = "local-readme-gif-token-pepper-0001";

/** Who is calling: one coding-agent session per entry, all fictional. */
const agents = {
  search: {
    agent: "claude-code",
    client: "Claude Code",
    session: "sess-fix-search",
    name: "fix-search",
  },
  rss: {
    agent: "codex",
    client: "Codex",
    session: "sess-rss-dates",
    name: "rss-dates",
  },
  images: {
    agent: "codex",
    client: "Codex",
    session: "sess-hero-images",
    name: "hero-images",
  },
  docs: {
    agent: "claude-code",
    client: "Claude Code",
    session: "sess-auth-docs",
    name: "auth-docs",
  },
  links: {
    agent: "opencode",
    client: "OpenCode",
    session: "sess-link-check",
    name: "link-check",
  },
  ops: {
    agent: "claude-code",
    client: "Claude Code",
    session: "sess-staging-token",
    name: "staging-token",
  },
  planner: {
    agent: "claude-desktop",
    client: "Claude",
    session: "sess-weekly-plan",
    name: "weekly-plan",
  },
};

const skills = [
  {
    project: "valise",
    tags: ["git", "writing"],
    body: `---
name: release-notes
description: Write release notes from the merged pull requests since the last tag. Use when cutting a release or when asked what changed.
---

List the pull requests merged since the last tag with \`git log --merges\`.
Group them by what a user notices: new, changed, fixed. One line each, in
the user's words, never the branch name.`,
  },
  {
    tags: ["review", "git"],
    body: `---
name: review-pr
description: Review a pull request for correctness first, then for tests, then for naming. Use when asked to review a diff or a PR number.
---

Read the whole diff before commenting. Report bugs with the line and the
input that breaks it. Style notes go last, and only when they change meaning.`,
  },
  {
    tags: ["writing", "architecture"],
    body: `---
name: write-adr
description: Record an architecture decision as a short ADR with context, decision and consequences. Use when a choice will be questioned later.
---

One decision per file in docs/adr/, numbered. State the forces, the
decision in one sentence, and what it makes harder.`,
  },
  {
    tags: ["testing"],
    body: `---
name: test-first
description: Write the failing test before the fix. Use for any bug with a reproducible input.
---

Reproduce the bug as a test, watch it fail for the right reason, then fix
the code until it passes. Never weaken the assertion to get green.`,
  },
  {
    project: "garden-site",
    tags: ["web", "performance"],
    body: `---
name: image-pipeline
description: Convert, resize and compress site images to WebP with JPEG fallbacks. Use when adding photos to the garden site.
---

Run \`npm run images\` after adding files under assets/photos/. Widths are
800 and 1600; anything wider is a mistake in the source.`,
  },
];

const subjectSeeds = [
  {
    name: "Search ranking",
    kind: "topic",
    description: "How results are scored across skills, memories and to-dos.",
  },
  {
    name: "garden-site deploys",
    kind: "area",
    description: "Build, preview and release of the garden site.",
  },
  {
    name: "Working preferences",
    kind: "profile",
    description: "How I want agents to work in my repositories.",
  },
];

const memories = [
  {
    by: "search",
    type: "decision",
    title: "Done to-dos rank at 0.6 weight so skills surface first",
    body: "Chosen after ten saved queries put stale to-dos above the matching skill. Pending to-dos keep full weight. Evidence in app/search/query.ts.",
    tags: ["search", "ranking"],
    project: "valise",
    subjects: ["Search ranking"],
  },
  {
    by: "search",
    type: "insight",
    title: "Repeated phrases in a to-do body inflate its BM25 score",
    body: "A body that repeats the query phrase four times outscored a skill whose description matched exactly. Field weights, not body length, decide this.",
    tags: ["search", "bm25"],
    project: "valise",
    subjects: ["Search ranking"],
  },
  {
    by: "planner",
    type: "reference",
    title: "Saved ranking queries live in evals/queries.json",
    body: "Ten queries with the expected first result. Rerun them after any change to weights.",
    tags: ["search", "evals"],
    project: "valise",
    subjects: ["Search ranking"],
  },
  {
    by: "images",
    type: "fact",
    title: "Preview deploys for garden-site expire after 7 days",
    body: "The host deletes preview builds a week after the last push to the branch. Link to main for anything that has to last.",
    tags: ["deploy", "hosting"],
    project: "garden-site",
    subjects: ["garden-site deploys"],
  },
  {
    by: "rss",
    type: "episode",
    title: "The spring release went out with a broken RSS feed",
    body: "Feed readers rejected pubDate in non-English locales for two days before a reader emailed hello@example.com. Now covered by a feed validation step in CI.",
    tags: ["rss", "incident"],
    project: "garden-site",
    subjects: ["garden-site deploys"],
  },
  {
    by: "planner",
    type: "preference",
    title: "Open pull requests ready for review, never as drafts",
    body: "Run the full test suite before opening, then open it ready. A draft PR sits unseen.",
    tags: ["git", "workflow"],
    subjects: ["Working preferences"],
  },
  {
    by: "planner",
    type: "preference",
    title: "Use pnpm in new projects, npm where a lockfile already exists",
    body: "Never mix lockfiles in one repository.",
    tags: ["tooling"],
    subjects: ["Working preferences"],
  },
  {
    by: "docs",
    type: "fact",
    title: "acme-docs builds with Docusaurus 3 and deploys from main",
    body: "Every merge to main publishes docs.example.com within five minutes. Versioned docs live under versioned_docs/.",
    tags: ["docs", "deploy"],
    project: "acme-docs",
    subjects: [],
  },
];

const sources = [
  {
    kind: "bookmark",
    title: "Okapi BM25: a practical guide to field weighting",
    url: "https://blog.example.com/bm25-field-weights",
    notes:
      "Why per-field weights beat body-length normalisation for short documents. Section 3 is the part that applies to to-dos.",
    project: "valise",
    tags: ["search", "ranking"],
    authors: ["Ada Rivers"],
  },
  {
    kind: "bookmark",
    title: "RFC 822 date format, with examples",
    url: "https://docs.example.com/rfc822-dates",
    notes:
      "The pubDate format RSS readers expect. Day and month names in English, always.",
    project: "garden-site",
    tags: ["rss"],
  },
  {
    kind: "reference",
    title: "Leases and Fencing in Practice, chapter 3",
    notes: "Leases and fencing tokens, the model behind claiming a to-do.",
    tags: ["architecture", "concurrency"],
    authors: ["Sam Okafor"],
  },
  {
    kind: "bookmark",
    title: "Docusaurus versioning guide",
    url: "https://docs.example.com/docusaurus/versioning",
    notes:
      "How versioned_docs and the version dropdown work, for the v2 auth pages.",
    project: "acme-docs",
    tags: ["docs"],
  },
  {
    kind: "bookmark",
    title: "Companion planting chart for small vegetable beds",
    url: "https://garden.example.com/companion-planting",
    notes: "Source for the spring planting guide page.",
    project: "garden-site",
    tags: ["content", "gardening"],
  },
];

const todos = [
  {
    key: "rank",
    project: "valise",
    title: "Rank skills above stale to-dos in search",
    tags: ["search", "priority:2"],
    body: `For \`deploy checklist\`, a done to-do outranks the \`release-notes\` skill that answers it. Done to-dos should lose weight; pending ones keep theirs.

- [x] Reproduce with the ten saved queries
- [x] Add a weight for done to-dos in the ranking
- [ ] Add a test that pins the skill as first result
- [ ] Note the weight in the search ADR

**Done when** the skill ranks first for all ten queries and a test holds it there.`,
    refs: [
      { kind: "repo", value: "example/valise" },
      { kind: "file", value: "app/search/query.ts" },
      { kind: "doc", value: "docs/adr/0001-search.md" },
      { kind: "issue", value: "https://github.com/example/valise/issues/42" },
    ],
  },
  {
    key: "export",
    project: "valise",
    title: "Add a Markdown export to the memories page",
    tags: ["console", "priority:3"],
    body: "One file per memory, front matter for type, tags and subjects.",
  },
  {
    key: "token",
    project: "valise",
    title: "Rotate the staging API token",
    body: "The current token was shared in a screen recording. Issue a new one, update the CI secret, revoke the old one.",
    tags: ["ops", "priority:1"],
    refs: [{ kind: "doc", value: "docs/operations/staging.md" }],
  },
  {
    key: "rss",
    project: "garden-site",
    title: "Fix the RSS feed's pubDate format",
    body: "Feed readers outside English locales reject the dates. Use RFC 822 regardless of locale.",
    tags: ["rss", "bug"],
    refs: [{ kind: "file", value: "src/feed.ts" }],
  },
  {
    key: "webp",
    project: "garden-site",
    title: "Serve hero images as WebP",
    body: "The home page ships 2.4 MB of JPEG. Keep JPEG as the fallback for old browsers.",
    tags: ["performance"],
  },
  {
    key: "guide",
    project: "garden-site",
    title: "Write the spring planting guide page",
    body: "One page, three bed layouts, a sowing calendar. Sources are saved in the library.",
    tags: ["content"],
  },
  {
    key: "auth",
    project: "acme-docs",
    title: "Document the v2 authentication flow",
    body: "Cover the authorization code flow, token refresh and the error table. Readers are integrators, not maintainers.",
    tags: ["docs", "auth"],
    refs: [{ kind: "file", value: "docs/auth/v2.md" }],
  },
  {
    key: "links",
    project: "acme-docs",
    title: "Fix links flagged by the link checker",
    body: "The nightly check reports 14 broken links, mostly pages moved in the restructure.",
    tags: ["docs", "bug"],
  },
  {
    key: "search-box",
    project: "acme-docs",
    title: "Add a search box to the docs sidebar",
    body: "Search within the current version only. Results under the box, no separate page.",
    tags: ["docs", "ui"],
  },
];

const controller = new AbortController();
const server = runUiTestServer({ port, signal: controller.signal });
let browser;
try {
  await rm(frames, { recursive: true, force: true });
  await mkdir(frames, { recursive: true });
  await mkdir("docs/images", { recursive: true });
  await Promise.race([
    waitForServer(),
    server.then(() => {
      throw new Error("Capture server exited before becoming ready");
    }),
  ]);
  const opened = await seed();

  browser = await chromium.launch();
  const context = await browser.newContext({
    viewport,
    colorScheme: "light",
    deviceScaleFactor: 1,
    reducedMotion: "reduce",
  });
  const page = await context.newPage();
  // Vite optimizes dependencies on the first page load and may reload once.
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`${origin}/login?next=/todos`);
      await page.waitForLoadState("networkidle");
      await page
        .getByLabel("Administrator password")
        .fill(process.env.VALISE_ADMIN_PASSWORD);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page
        .getByRole("heading", { name: "To-dos", exact: true })
        .waitFor({ timeout: 20_000 });
      break;
    } catch (error) {
      if (attempt === 3) throw error;
    }
  }

  const shots = [
    ["1-todos", "/todos?done=show"],
    ["2-todo-detail", `/todos?open=${encodeURIComponent(opened)}`],
    ["3-memories", "/memories"],
    ["4-skills", "/skills"],
    ["5-library", "/library"],
  ];
  const only = process.env.VALISE_GIF_FRAMES?.split(",");
  const chosen = only
    ? shots.filter(([name]) => only.some((key) => name.startsWith(key)))
    : shots;
  for (const [name, path] of chosen) {
    await page.goto(`${origin}${path}`);
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${frames}/${name}.png` });
  }
  await makeGif(chosen.map(([name]) => `${frames}/${name}.png`));
  const { size } = await stat(output);
  console.log(
    `${chosen.length} frames in ${frames}; ${output} is ${(size / 1024 / 1024).toFixed(2)} MB`,
  );
} finally {
  await browser?.close();
  controller.abort();
  await server;
}

/** Writes the fictional account and returns the to-do the detail frame opens. */
async function seed() {
  // Skills first, so the list reads oldest to newest like a real account.
  for (const skill of skills)
    await tool(agents.planner, "publish_skill", skill);

  const subjects = {};
  for (const subject of subjectSeeds) {
    const saved = await tool(agents.planner, "save_subject", subject);
    subjects[subject.name] = saved.id;
  }
  for (const { subjects: names, by, ...memory } of memories) {
    await tool(agents[by], "save_memory", {
      ...memory,
      ...(names.length
        ? { subjects: names.map((name) => subjects[name]) }
        : {}),
    });
  }

  for (const source of sources)
    await tool(agents.planner, "save_source", source);

  const ids = {};
  for (const { key, ...todo } of todos) {
    ids[key] = (await tool(agents.planner, "create_todo", todo)).id;
  }

  // Done work, closed by the session that did it.
  for (const [key, by, summary] of [
    [
      "webp",
      "images",
      "Hero images are WebP at 1600 px with JPEG fallbacks; the home page dropped from 2.4 MB to 610 KB.",
    ],
    [
      "links",
      "links",
      "Fixed 14 broken links: 11 moved pages, 3 removed anchors. The link checker is clean on main.",
    ],
  ]) {
    const { token } = await tool(agents[by], "claim_todo", { id: ids[key] });
    await tool(agents[by], "complete_todo", { id: ids[key], token, summary });
  }

  // Waiting on someone outside the agents.
  {
    const { token } = await tool(agents.ops, "claim_todo", { id: ids.token });
    await tool(agents.ops, "update_todo", {
      id: ids.token,
      token,
      blocked_on: "Staging admin access from ops@example.com",
      body: "The rotation script is ready on branch `chore/rotate-staging-token`. It needs an admin on the staging account to approve the new key.",
      summary: "Waiting on staging admin access from ops@example.com.",
    });
  }

  // In flight, with progress the agents reported.
  {
    const { token } = await tool(agents.rss, "claim_todo", {
      id: ids.rss,
      ttl_seconds: 3600,
    });
    await tool(agents.rss, "update_todo", {
      id: ids.rss,
      token,
      body: "The feed writes dates with `toLocaleDateString`, so readers in other locales get unparseable `pubDate` values. Switching to RFC 822 in `src/feed.ts`.",
      summary: "Found the cause: locale-formatted pubDate in src/feed.ts.",
    });
  }
  {
    const { token } = await tool(agents.docs, "claim_todo", {
      id: ids.auth,
      ttl_seconds: 7200,
    });
    await tool(agents.docs, "update_todo", {
      id: ids.auth,
      token,
      body: "Drafted the sequence diagram and the token refresh section in `docs/auth/v2.md`. Next: the error table.",
      summary:
        "Sequence diagram and refresh section drafted; error table next.",
    });
  }
  {
    const { token } = await tool(agents.search, "claim_todo", {
      id: ids.rank,
      ttl_seconds: 5400,
    });
    await tool(agents.search, "update_todo", {
      id: ids.rank,
      token,
      body: "Reproduced it: for `deploy checklist` the stale to-do scores 7.9 and the `release-notes` skill 6.2, because the to-do repeats the phrase in its body four times.",
      summary: "Reproduced: a stale to-do outranks the release-notes skill.",
    });
    await tool(agents.search, "update_todo", {
      id: ids.rank,
      token,
      body: "Added a 0.6 weight for done to-dos in `app/search/query.ts`. The skill now ranks first for all ten saved queries; writing the test next.",
      summary:
        "Done to-dos weighted 0.6; the skill ranks first for 10 of 10 queries.",
    });
  }
  return ids.rank;
}

async function tool(who, name, args) {
  const response = await fetch(`${origin}/mcp`, {
    method: "POST",
    headers: {
      accept: "application/json, text/event-stream",
      "content-type": "application/json",
      "mcp-protocol-version": "2025-11-25",
      "x-valise-agent": who.agent,
      "x-valise-client": who.client,
      "x-valise-session": who.session,
      "x-valise-session-name": who.name,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: crypto.randomUUID(),
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await response.text();
  if (!response.ok) throw new Error(`${name}: ${response.status} ${raw}`);
  const line = raw.split("\n").find((entry) => entry.startsWith("data:"));
  const message = JSON.parse(line ? line.slice(5) : raw);
  const result = message.result;
  if (message.error || result?.isError) {
    throw new Error(`${name}: ${JSON.stringify(message.error ?? result)}`);
  }
  return (
    result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}")
  );
}

/** Two-pass palette, so flat console colours stay flat instead of dithered. */
async function makeGif(paths) {
  const inputs = paths.flatMap((path) => [
    "-loop",
    "1",
    "-t",
    String(secondsPerFrame),
    "-i",
    path,
  ]);
  const scale =
    gifWidth === viewport.width ? "" : `scale=${gifWidth}:-1:flags=lanczos,`;
  const concat = `${paths.map((_, i) => `[${i}:v]`).join("")}concat=n=${paths.length}:v=1:a=0,fps=1/${secondsPerFrame},${scale}split[a][b];[a]palettegen=max_colors=${gifColors}:stats_mode=full[p];[b][p]paletteuse=dither=none`;
  execFileSync(
    ffmpeg,
    [
      "-y",
      "-loglevel",
      "error",
      ...inputs,
      "-filter_complex",
      concat,
      "-loop",
      "0",
      output,
    ],
    { stdio: "inherit" },
  );
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
