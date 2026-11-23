import { createExecutionContext, env } from "cloudflare:test";
import { RouterContextProvider } from "react-router";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_REVIEW_SETTINGS,
  type ReviewSource,
  runMemoryReview,
  writeReviewSettings,
} from "~/concepts/memory-review";
import type { ReviewProposal } from "~/concepts/memory-review-model";
import { consoleContext } from "~/console/context.server";
import { action as reviewAction } from "~/console/memory-review.server";
import { createSessionCookie } from "~/lib/auth.server";
import { loader as subjectLoader } from "~/routes/memory-subject";
import { requireBrowserStore } from "~/store/tenant.server";

const settings = { ...env, SESSION_SECRET: "tenant-store-review-secret" };
const OWNER = "local";
const OTHER = "usr_store_review_other";

beforeEach(async () => {
  await env.DB.prepare(
    `INSERT INTO users (user_id, display_name, created_at, email_verified)
     VALUES (?, ?, unixepoch(), 1)`,
  )
    .bind(OTHER, OTHER)
    .run();
});

afterEach(async () => {
  for (const table of [
    "memory_review_events",
    "memory_review_sources",
    "memory_review_groups",
    "memory_review_pending",
    "memory_review_budgets",
    "memory_review_settings",
    "memory_subject_members",
    "memory_subjects",
    "memory_links",
    "memory_revisions",
    "search_docs",
    "vector_pending",
    "memories",
    "mcp_calls",
    "sessions",
  ])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  await env.DB.prepare("DELETE FROM users WHERE user_id = ?").bind(OTHER).run();
});

async function requestFor(userId: string, path: string) {
  // Routing hints in the URL and headers must not choose the tenant.
  const url = `https://valise.test${path}${path.includes("?") ? "&" : "?"}userId=local&shard=other`;
  const cookie = await createSessionCookie(settings, new Request(url), userId);
  return new Request(url, { headers: { cookie, "x-valise-user": "local" } });
}

async function browser(userId: string) {
  return (await requireBrowserStore(settings, await requestFor(userId, "/")))
    .store;
}

function consoleArgs<P extends Record<string, string>>(
  request: Request,
  params: P = {} as P,
) {
  const context = new RouterContextProvider();
  context.set(consoleContext, { env: settings, ctx: createExecutionContext() });
  return {
    context,
    request,
    url: new URL(request.url),
    params,
    pattern: new URL(request.url).pathname,
  };
}

async function post(
  userId: string,
  path: string,
  fields: Record<string, string>,
) {
  const authenticated = await requestFor(userId, path);
  const url = new URL(authenticated.url);
  return new Request(url, {
    method: "POST",
    headers: {
      ...Object.fromEntries(authenticated.headers),
      origin: url.origin,
    },
    body: new URLSearchParams(fields),
  });
}

const fact = (body: string) => ({
  type: "fact",
  title: "Orchard storage review",
  body,
  tags: ["synthetic"],
  project: "review-fixture",
});

const proposal = (input: string): ReviewProposal => {
  const sources = JSON.parse(input) as ReviewSource[];
  return {
    kind: "summary",
    title: "Orchard storage synthesis",
    body: "claimmarker: Store apples cool; keep pears dry.",
    why: "Combines compatible storage claims.",
    evidence: sources.map((s) => ({ id: s.id, quote: s.body.slice(0, 80) })),
  };
};

/** One proposal in OTHER's review inbox, drafted without a provider call. */
async function otherProposal() {
  const other = await browser(OTHER);
  const first = await other.memories.save(fact("claimmarker Apples cool."));
  await other.memories.save(fact("claimmarker Pears dry."));
  await writeReviewSettings(env.DB, OTHER, {
    ...DEFAULT_REVIEW_SETTINGS,
    enabled: true,
    manualMemories: 8,
  });
  const report = await runMemoryReview(env, OTHER, async (_model, input) =>
    proposal(input),
  );
  expect(report.calls).toBe(1);
  const [group] = await other.review.groups();
  if (!group) throw new Error("fixture review produced no group");
  return { other, group, memoryId: first.id.slice("memory:".length) };
}

describe("tenant-bound memory review and subjects", () => {
  it("binds review settings, groups, events and history to one owner", async () => {
    const owner = await browser(OWNER);
    const emptyCounts = await owner.review.count();
    const { other, group, memoryId } = await otherProposal();

    expect(await owner.review.groups()).toEqual([]);
    expect(await owner.review.count()).toEqual(emptyCounts);
    expect(await other.review.count()).not.toEqual(emptyCounts);
    expect(await owner.review.group(group.group_id)).toBeNull();
    expect(await owner.review.events(group.group_id)).toEqual([]);
    expect(await owner.review.sourceHistory(memoryId, group.group_id)).toEqual(
      await owner.review.sourceHistory("mem_missing", group.group_id),
    );
    expect((await owner.review.settings()).enabled).toBe(false);
    expect(await owner.review.overnightReady(group.model)).toBe(false);
    expect(await other.review.overnightReady(group.model)).toBe(true);
    expect(await other.review.group(group.group_id)).toMatchObject({
      state: "proposal",
    });
  });

  it("refuses draft edits, dismissal and acceptance of another tenant's proposal", async () => {
    const { other, group } = await otherProposal();
    const owner = await browser(OWNER);
    const before = await other.review.group(group.group_id);

    await expect(
      owner.review.editDraft(
        group.group_id,
        "title",
        "stolen",
        group.draft_title ?? "",
      ),
    ).rejects.toThrow(/No editable proposal/);
    await expect(owner.review.dismiss(group.group_id, false)).rejects.toThrow(
      /No proposal/,
    );
    await expect(
      owner.review.accept(group.group_id, {
        draftTitle: "stolen",
        draftBody: "stolen",
      }),
    ).rejects.toThrow(/No proposal/);
    expect(await other.review.group(group.group_id)).toEqual(before);
    expect(await other.review.events(group.group_id)).toEqual([]);
    expect(await owner.memories.count()).toBe(0);
  });

  it("answers a review run anchored on another tenant's memory as not found", async () => {
    const { memoryId } = await otherProposal();
    const response = await reviewAction(
      consoleArgs(
        await post(OWNER, "/memories?tab=review", {
          intent: "run",
          memory: memoryId,
          via: "fetcher",
        }),
      ),
    );
    expect(response).toMatchObject({
      data: { error: expect.stringMatching(/cannot be found/) },
      init: { status: 409 },
    });
  });

  it("binds subjects, members and summaries to one owner", async () => {
    const owner = await browser(OWNER);
    const other = await browser(OTHER);
    const { id } = await other.subjects.create({
      name: "Orchard",
      kind: "topic",
      description: "Member subject",
    });
    const theirs = await other.memories.save(fact("claimmarker Member."));
    const mine = await owner.memories.save(fact("claimmarker Owner."));
    const theirMemory = theirs.id.slice("memory:".length);
    const myMemory = mine.id.slice("memory:".length);
    expect(await other.subjects.changeMember(id, theirMemory, "add")).toBe(
      true,
    );

    expect((await owner.subjects.list()).rows).toEqual([]);
    expect(await owner.subjects.choices()).toEqual([]);
    expect(await owner.subjects.get(id)).toBeNull();
    expect((await owner.subjects.members(id)).rows ?? []).toEqual([]);
    expect(await owner.subjects.edit(id, "name", "stolen")).toBe(false);
    expect(await owner.subjects.changeMember(id, myMemory, "add")).toBe(false);
    expect(await owner.subjects.changeMember(id, theirMemory, "remove")).toBe(
      false,
    );
    expect(await owner.subjects.setSummary(id, myMemory)).toBe(false);
    expect(await owner.subjects.setDeleted(id, true)).toBe(false);
    expect(await owner.subjects.findByName("Orchard")).toBeNull();
    expect(await owner.subjects.createSummary(id, "stolen summary")).toBeNull();
    // Nor can the subject's owner pull another tenant's memory in.
    expect(await other.subjects.changeMember(id, myMemory, "add")).toBe(false);

    expect(await other.subjects.get(id)).toMatchObject({
      name: "Orchard",
      summaryId: null,
      count: 1,
    });
    expect(await owner.memories.count()).toBe(1);

    await expect(
      subjectLoader(
        consoleArgs(await requestFor(OWNER, `/memories/subjects/${id}`), {
          subjectId: id,
        }),
      ),
    ).rejects.toMatchObject({ status: 404 });
  });
});
