import { env, SELF } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import { mintBearerToken } from "~/concepts/tokens";
import { normaliseError, recall, recallTerms } from "~/search/recall";
import { callMcp } from "./fixture-worker";

const db = env.DB;
const tokenEnv = { DB: db, TOKEN_PEPPER: "local-test-token-pepper" };

afterEach(async () => {
  for (const table of [
    "search_docs",
    "hook_configs",
    "hook_recall_injections",
    "mcp_calls",
    "bearer_token_grants",
    "bearer_token_scopes",
    "bearer_tokens",
  ]) {
    await db.prepare(`DELETE FROM ${table}`).run();
  }
  await db
    .prepare("INSERT INTO search_docs_fts(search_docs_fts) VALUES('rebuild')")
    .run();
});

let row = 0;
function doc(
  concept: "memory" | "skill" | "todo" | "source",
  title: string,
  body = "",
  user = "local",
) {
  row += 1;
  const id = `${concept.slice(0, 3)}_${row}`;
  return db
    .prepare(
      `INSERT INTO search_docs (doc_key, user_id, concept, concept_id, project, title, body, tags, updated_at)
       VALUES (?, ?, ?, ?, 'valise', ?, ?, '', 1)`,
    )
    .bind(`${concept}:${id}`, user, concept, id, title, body);
}

/** Enough unrelated notes that a word in a fifth of them reads as common. */
function filler(count: number) {
  return Array.from({ length: count }, (_, i) =>
    doc(
      "memory",
      `Unrelated note ${i}`,
      "the deploy ran fine and nothing else",
    ),
  );
}

async function get(query: string | null, ...scopes: string[]) {
  const { token } = await mintBearerToken(tokenEnv, {
    userId: "local",
    label: "hook",
    scopes,
  });
  const url = new URL("http://localhost/config/recall");
  if (query !== null) url.searchParams.set("q", query);
  return SELF.fetch(
    new Request(url, {
      headers: { host: "localhost", authorization: `Bearer ${token}` },
    }),
  );
}

const MERGE_ERROR =
  "X Pull request is not mergeable: the merge commit cannot be cleanly created.";

describe("recall on a failed command", () => {
  it("splits the query into distinct words of three letters or more", () => {
    expect(recallTerms("X Pull request is NOT not mergeable: 91 the")).toEqual([
      "pull",
      "request",
      "not",
      "mergeable",
      "the",
    ]);
    expect(
      recallTerms(
        "a b c d e f g h i j k l m n o p q r s t".replaceAll(" ", "xx "),
      ),
    ).toHaveLength(12);
  });

  it("returns the note that shares most of the error's words, with its id", async () => {
    await db.batch([
      ...filler(10),
      doc(
        "memory",
        "gh pr merge refuses a pull request that is not mergeable",
        "The merge commit cannot be cleanly created when main moved; rebase first.",
      ),
      doc("memory", "A pull request template", "Use the template."),
    ]);
    const hits = await recall(db, "local", MERGE_ERROR);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      id: expect.stringMatching(/^memory:mem_\d+$/),
      concept: "memory",
      title: "gh pr merge refuses a pull request that is not mergeable",
    });
    expect(hits[0].matched).toBeGreaterThanOrEqual(hits[0].terms * 0.6);
  });

  it("returns nothing for a typo whose words only common notes share", async () => {
    await db.batch([
      ...filler(10),
      doc("memory", "npm run verify gates every push", "Run npm run verify."),
    ]);
    expect(
      await recall(
        db,
        "local",
        'npm error Missing script: "tset" npm error npm error To see a list of scripts, run:',
      ),
    ).toEqual([]);
  });

  it("ignores words that a fifth of the case's notes hold", async () => {
    // "the", "deploy" and "fine" are in every filler note, so a note matching
    // only them is no hit, however many of the query's words they are.
    await db.batch(filler(10));
    expect(await recall(db, "local", "the deploy ran fine")).toEqual([]);
  });

  it("reads only the caller's notes, and never sources or files", async () => {
    await db.batch([
      doc("memory", MERGE_ERROR, "", "someone-else"),
      doc("source", MERGE_ERROR),
    ]);
    expect(await recall(db, "local", MERGE_ERROR)).toEqual([]);
  });

  it("answers over HTTP under search:read, and refuses config:read alone", async () => {
    await db.batch([
      ...filler(10),
      doc("skill", "When a pull request is not mergeable", MERGE_ERROR),
    ]);
    expect((await get(MERGE_ERROR, "config:read")).status).toBe(403);
    expect((await get(null, "search:read")).status).toBe(400);
    expect((await get("x".repeat(501), "search:read")).status).toBe(400);
    const response = await get(MERGE_ERROR, "search:read");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { hits } = (await response.json()) as { hits: { id: string }[] };
    expect(hits.map((hit) => hit.id)).toEqual([
      expect.stringMatching(/^skill:/),
    ]);
  });
});

/** search as the plugin's PostToolUseFailure mcp_tool hook calls it. */
async function hookSearch(error: string, sessionId?: string) {
  const result = await callMcp(
    "tools/call",
    {
      name: "search",
      arguments: {
        query: error,
        hook: "PostToolUseFailure",
        ...(sessionId && { session_id: sessionId }),
      },
    },
    "new-agent",
    undefined,
    { "x-valise-user": "local" },
  );
  expect(result.response.status, result.raw).toBe(200);
  expect(result.value.result.isError, result.raw).not.toBe(true);
  // Claude Code parses the text as hook output, keys it does not know ignored.
  return JSON.parse(
    (result.value.result.content as { text: string }[])[0].text,
  ) as {
    results: unknown[];
    hookSpecificOutput?: { hookEventName: string; additionalContext: string };
  };
}

function hookConfig(document: object) {
  return db
    .prepare(
      "INSERT INTO hook_configs (user_id, document, updated_at) VALUES ('local', ?, 1)",
    )
    .bind(JSON.stringify(document));
}

describe("search as the failed-command hook", () => {
  it("keeps the error-shaped lines and drops what differs between runs", () => {
    expect(
      normaliseError(
        "Exit code 1\nError: Cannot find module '/Users/x/app/foo.js'\n    at Module._resolve (node:internal/modules:1023:15)",
      ),
    ).toBe("Error: Cannot find module");
    expect(
      normaliseError(
        "Exit code 1\nfetching https://app.valise.run/mcp\nrequest failed after 1500ms on port 8787",
      ),
    ).toBe("request failed after on port");
    // No error-shaped line: the last three lines stand in.
    expect(normaliseError("Exit code 1\none\ntwo\nthree\nfour")).toBe(
      "two three four",
    );
  });

  it("answers in the hook's shape with the hits' ids, from an error longer than a model's query", async () => {
    await db.batch([
      ...filler(10),
      doc("skill", "When a pull request is not mergeable", MERGE_ERROR),
    ]);
    const answer = await hookSearch(
      `Exit code 1\n${"progress line\n".repeat(100)}${MERGE_ERROR} #91`,
    );
    expect(answer.results).toEqual([]);
    expect(answer.hookSpecificOutput?.hookEventName).toBe("PostToolUseFailure");
    expect(answer.hookSpecificOutput?.additionalContext).toMatch(
      /^This command failed\. Valise holds notes that share most of this error's words\. Fetch the one that fits before trying something else:\n- skill:\S+ When a pull request is not mergeable$/,
    );
  });

  it("says nothing below the bar, and follows the owner's hook config", async () => {
    await db.batch(filler(10));
    expect(
      await hookSearch("Exit code 127\nzsh: command not found: tset"),
    ).toEqual({ results: [] });

    await db.batch([
      doc("skill", "When a pull request is not mergeable", MERGE_ERROR),
      hookConfig({
        "recall-on-error": { enabled: false },
        custom: [
          { event: "PostToolUseFailure", text: "Check the runbook." },
          { event: "PostToolUseFailure", text: "Off.", enabled: false },
          { event: "Stop", text: "Not this event." },
        ],
      }),
    ]);
    expect(await hookSearch(MERGE_ERROR)).toEqual({
      results: [],
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: "Check the runbook.",
      },
    });
  });

  it("injects an error once a session, and three errors a session at most", async () => {
    const errors = ["alpha", "bravo", "charlie", "delta"].map(
      (word) => `fatal: ${word} widget refused the frobnicate request`,
    );
    await db.batch([
      ...filler(30),
      ...errors.map((error, i) => doc("memory", `Note ${i}`, error)),
      hookConfig({
        custom: [{ event: "PostToolUseFailure", text: "Check the runbook." }],
      }),
    ]);
    const injected = (answer: Awaited<ReturnType<typeof hookSearch>>) =>
      answer.hookSpecificOutput?.additionalContext.startsWith(
        "This command failed.",
      ) ?? false;

    // The same error twice: the second run, line numbers aside, is silent,
    // though the owner's custom entry still follows every failure.
    expect(injected(await hookSearch(`${errors[0]} at line 12`, "s1"))).toBe(
      true,
    );
    const again = await hookSearch(`${errors[0]} at line 40`, "s1");
    expect(again).toEqual({
      results: [],
      hookSpecificOutput: {
        hookEventName: "PostToolUseFailure",
        additionalContext: "Check the runbook.",
      },
    });

    // A fourth distinct error in one session injects nothing.
    expect(injected(await hookSearch(errors[1], "s1"))).toBe(true);
    expect(injected(await hookSearch(errors[2], "s1"))).toBe(true);
    expect(injected(await hookSearch(errors[3], "s1"))).toBe(false);

    // Another session has its own count and its own errors.
    expect(injected(await hookSearch(errors[0], "s2"))).toBe(true);
    expect(injected(await hookSearch(errors[3], "s2"))).toBe(true);

    // Without session_id there is no gate, as before the plugin sent one.
    expect(injected(await hookSearch(errors[0]))).toBe(true);
    expect(injected(await hookSearch(errors[0]))).toBe(true);

    // A skipped call is still one row in the call log. ADR-0006.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const { n } = (await db
      .prepare("SELECT count(*) AS n FROM mcp_calls WHERE tool = 'search'")
      .first<{ n: number }>())!;
    expect(n).toBe(9);
  });

  it("records nothing below the bar, and prunes a day-old session's rows", async () => {
    await db.batch([
      ...filler(10),
      doc("memory", "Merge note", MERGE_ERROR),
      db.prepare(
        "INSERT INTO hook_recall_injections (user_id, session_id, fingerprint, created_at) VALUES ('local', 'old', 'f', 1)",
      ),
    ]);
    expect(
      await hookSearch("Exit code 127\nzsh: command not found: tset", "s1"),
    ).toEqual({ results: [] });
    expect(
      (await hookSearch(MERGE_ERROR, "s1")).hookSpecificOutput,
    ).toBeDefined();
    const rows = await db
      .prepare(
        "SELECT session_id FROM hook_recall_injections ORDER BY session_id",
      )
      .all<{ session_id: string }>();
    expect(rows.results.map((row) => row.session_id)).toEqual(["s1"]);
  });

  it("still holds a model's query to 500 characters", async () => {
    const result = await callMcp(
      "tools/call",
      { name: "search", arguments: { query: "x".repeat(501) } },
      "new-agent",
      undefined,
      { "x-valise-user": "local" },
    );
    expect(result.value.result.isError).toBe(true);
  });
});
