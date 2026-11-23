import { env } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import {
  appendTranscript,
  MAX_TURN_BYTES,
  mirrorKey,
  readTranscriptTurns,
  TranscriptRefused,
  type TurnInput,
  transcriptRef,
} from "~/concepts/transcripts";
import { MAX_BODY_BYTES } from "~/search/project";
import { search } from "~/search/query";
import { reindex } from "~/search/reindex";

const data = { DB: env.DB, BUNDLES: env.BUNDLES };
const provenance = {
  userId: "local",
  agent: "valise-cli",
  client: "oauth",
  session: null,
};
const session = {
  client: "claude-code",
  device: "laptop",
  sessionId: "9b2f4c3e-0000-4000-8000-000000000001",
  cwd: "/Users/me/code/valise",
  gitBranch: "main",
  project: "valise",
  model: "claude-fable-5-1",
};
const first: TurnInput[] = [
  {
    kind: "human",
    text: "Why does the hedgerow test flake?\nSecond line.",
    at: 1700000000,
  },
  {
    kind: "tool_call",
    toolName: "Bash",
    text: "npm run test:mcp",
    at: 1700000010,
  },
  {
    kind: "tool_error",
    toolName: "Bash",
    text: "exit 1: ZlibError",
    at: 1700000020,
  },
  { kind: "assistant", text: "The brief straddles a second.", at: 1700000030 },
];

afterEach(async () => {
  for (const table of ["search_docs", "transcript_turns", "transcripts"])
    await env.DB.prepare(`DELETE FROM ${table}`).run();
  const listed = await env.BUNDLES.list();
  if (listed.objects.length)
    await env.BUNDLES.delete(listed.objects.map((object) => object.key));
});

async function hits(query: string) {
  return (
    await search(env, { userId: "local", query, concepts: ["transcript"] })
  ).map((hit) => hit.docKey);
}

describe("transcripts", () => {
  it("creates a session on its first write, projects it, and mirrors it to R2", async () => {
    const result = await appendTranscript(
      data,
      { ...session, from: 0, turns: first },
      provenance,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.appended).toBe(4);
    expect(result.transcript).toMatchObject({
      client: "claude-code",
      device: "laptop",
      title: "Why does the hedgerow test flake?",
      turnCount: 4,
      firstAt: 1700000000,
      lastAt: 1700000030,
      project: "valise",
      sourceAgent: "valise-cli",
    });
    expect(result.transcript.chainHash).toMatch(/^[0-9a-f]{64}$/);

    const turns = await readTranscriptTurns(
      env.DB,
      result.transcript.transcriptId,
    );
    expect(
      turns.map((turn) => [turn.position, turn.kind, turn.toolName]),
    ).toEqual([
      [0, "human", null],
      [1, "tool_call", "Bash"],
      [2, "tool_error", "Bash"],
      [3, "assistant", null],
    ]);

    // Searchable only when asked for by type; the body carries every turn.
    const key = transcriptRef(result.transcript.transcriptId);
    expect(await hits("hedgerow")).toEqual([key]);
    expect(await hits("ZlibError")).toEqual([key]);
    expect(
      (await search(env, { userId: "local", query: "hedgerow" })).map(
        (hit) => hit.docKey,
      ),
    ).toEqual([]);

    const mirrored = await env.BUNDLES.get(mirrorKey(result.transcript));
    expect(mirrored).not.toBeNull();
    const lines = (await mirrored?.text())
      ?.split("\n")
      .map((l) => JSON.parse(l));
    expect(lines?.[0]).toMatchObject({
      type: "transcript",
      session_id: session.sessionId,
      turn_count: 4,
    });
    expect(lines?.[2]).toMatchObject({
      type: "turn",
      position: 1,
      kind: "tool_call",
      tool_name: "Bash",
    });
  });

  it("replaces a diverged tail when the writer asks, as one history", async () => {
    // What an older distiller sent: no thinking.
    const old = await appendTranscript(
      data,
      { ...session, from: 0, turns: first },
      provenance,
    );
    if (!old.ok) throw new Error("first write failed");
    // A newer one keeps thinking after the prompt, so turn 1 differs.
    const thinking: TurnInput = {
      kind: "thinking",
      text: "Maybe the hedgerow clock",
      at: 1700000005,
    };
    const longer = [first[0], thinking, ...first.slice(1)];
    const refused = await appendTranscript(
      data,
      { ...session, from: 1, turns: longer.slice(1) },
      provenance,
    );
    expect(refused.ok).toBe(false);

    const replaced = await appendTranscript(
      data,
      { ...session, from: 1, replace: true, turns: longer.slice(1) },
      provenance,
    );
    if (!replaced.ok) throw new Error("replace refused");
    expect(replaced.transcript.transcriptId).toBe(old.transcript.transcriptId);
    expect(replaced.transcript.turnCount).toBe(5);
    const held = await readTranscriptTurns(env.DB, old.transcript.transcriptId);
    expect(held.map((turn) => [turn.position, turn.kind])).toEqual([
      [0, "human"],
      [1, "thinking"],
      [2, "tool_call"],
      [3, "tool_error"],
      [4, "assistant"],
    ]);
    // The same session sent whole by the new distiller ends identically.
    const fresh = await appendTranscript(
      data,
      { ...session, sessionId: "fresh", from: 0, turns: longer },
      provenance,
    );
    if (!fresh.ok) throw new Error("fresh write failed");
    expect(replaced.transcript.chainHash).toBe(fresh.transcript.chainHash);
    expect(replaced.transcript.title).toBe(fresh.transcript.title);
    expect(replaced.transcript.firstAt).toBe(fresh.transcript.firstAt);
    // The R2 mirror holds the new history: a header and five turns.
    const mirror = await env.BUNDLES.get(mirrorKey(replaced.transcript));
    expect((await mirror?.text())?.trim().split("\n")).toHaveLength(6);

    // A replace whose overlap agrees is an ordinary resend.
    const again = await appendTranscript(
      data,
      { ...session, from: 1, replace: true, turns: longer.slice(1) },
      provenance,
    );
    expect(again.ok && again.appended).toBe(0);
  });

  it("appends after the held prefix, ignores a resent overlap, and refuses a diverged one", async () => {
    const created = await appendTranscript(
      data,
      { ...session, from: 0, turns: first },
      provenance,
    );
    if (!created.ok) throw new Error("first write failed");

    // A resend after a lost answer: the overlap matches, nothing is added.
    const resent = await appendTranscript(
      data,
      { ...session, from: 2, turns: [first[2], first[3]] },
      provenance,
    );
    expect(resent.ok && resent.appended).toBe(0);

    // The next turn, with an overlap of one.
    const more = await appendTranscript(
      data,
      {
        ...session,
        from: 3,
        turns: [first[3], { kind: "human", text: "Fix it." }],
      },
      provenance,
    );
    expect(more.ok && more.appended).toBe(1);
    expect(more.ok && more.transcript.turnCount).toBe(5);
    expect(more.ok && more.transcript.chainHash).not.toBe(
      created.transcript.chainHash,
    );

    // A diverged history: the writer's turn 3 is not the server's turn 3.
    const diverged = await appendTranscript(
      data,
      {
        ...session,
        from: 3,
        turns: [{ kind: "assistant", text: "Something else." }],
      },
      provenance,
    );
    expect(diverged.ok).toBe(false);
    if (diverged.ok) return;
    expect(diverged.conflict).toMatchObject({
      transcriptId: created.transcript.transcriptId,
      turnCount: 5,
    });
    expect(diverged.conflict?.hashes).toHaveLength(5);

    // A gap: the writer is ahead of the server.
    const gap = await appendTranscript(
      data,
      { ...session, from: 9, turns: [{ kind: "human", text: "Later." }] },
      provenance,
    );
    expect(gap.ok).toBe(false);
    if (gap.ok) return;
    expect(gap.conflict?.turnCount).toBe(5);

    // An unknown session cannot start anywhere but 0.
    const unknown = await appendTranscript(
      data,
      { ...session, sessionId: "other", from: 2, turns: [first[0]] },
      provenance,
    );
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.conflict).toBeNull();

    // Reindex reproduces the projection from the authoritative rows.
    await env.DB.prepare("DELETE FROM search_docs").run();
    const report = await reindex(env, ["transcript"]);
    expect(report.published.transcript).toBe(1);
    expect(await hits("Fix")).toEqual([
      transcriptRef(created.transcript.transcriptId),
    ]);
  });

  it("keeps sessions apart by client, device and id, and caps the projection", async () => {
    const long = "word ".repeat(MAX_BODY_BYTES / 4);
    const a = await appendTranscript(
      data,
      { ...session, from: 0, turns: [{ kind: "human", text: long }] },
      provenance,
    );
    const b = await appendTranscript(
      data,
      {
        ...session,
        device: "desktop",
        from: 0,
        turns: [{ kind: "human", text: "unique-desktop-word" }],
      },
      provenance,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.transcript.transcriptId).not.toBe(b.transcript.transcriptId);
    const { results } = await env.DB.prepare(
      "SELECT length(body) AS size FROM search_docs WHERE concept = 'transcript'",
    ).all<{ size: number }>();
    expect(Math.max(...results.map((row) => row.size))).toBeLessThanOrEqual(
      MAX_BODY_BYTES,
    );
    expect(await hits("unique-desktop-word")).toEqual([
      transcriptRef(b.transcript.transcriptId),
    ]);
  });

  it("refuses what it cannot store", async () => {
    const attempt = (input: Partial<Parameters<typeof appendTranscript>[1]>) =>
      appendTranscript(
        data,
        { ...session, from: 0, turns: first, ...input },
        provenance,
      );
    await expect(attempt({ client: "Claude Code" })).rejects.toThrow(
      TranscriptRefused,
    );
    await expect(attempt({ turns: [] })).rejects.toThrow(/at least one/);
    await expect(
      attempt({ turns: [{ kind: "tool_call", text: "no tool" }] }),
    ).rejects.toThrow(/tool_name/);
    await expect(
      attempt({
        turns: [{ kind: "human", text: "x".repeat(MAX_TURN_BYTES + 1) }],
      }),
    ).rejects.toThrow(/distil/);
    await expect(
      attempt({ turns: [{ kind: "thought" as never, text: "no" }] }),
    ).rejects.toThrow(/kind/);
  });
});
