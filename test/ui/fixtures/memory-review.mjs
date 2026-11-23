import { resolve } from "node:path";
import { build } from "esbuild";
import {
  digest,
  insert,
  literal,
  migrations,
  openDump,
  recoverySql,
} from "../../../scripts/recovery.mjs";
import { localQuery, localSql } from "./local-d1.mjs";

const names = [
  "summary",
  "consolidation",
  "dismiss",
  "stale",
  "noscript",
  "noop",
  "failed",
  "subject",
  "subject-native",
  "conflict",
  // Nightly upkeep applied these on its own (J-0); each has a rollup memory to undo.
  ...Array.from({ length: 6 }, (_, i) => `applied-${i}`),
  ...Array.from({ length: 36 }, (_, i) => `volume-${i}`),
];
const applied = (name) => name.startsWith("applied-");
export const UI_REVIEWS = Object.fromEntries(
  names.map((name) => {
    const marker = `uiorchard${name}token`;
    const a = `${marker}: only ripe apples stay cool, never frozen.`;
    const b =
      name === "consolidation"
        ? `${marker}: keep ripe apples cool; do not freeze them.`
        : `${marker}: pears stay dry, according to the grower.`;
    return [
      name,
      {
        groupId: `mrg_ui_review_${name}`,
        title: `Synthetic ${name} review`,
        rollup: `mem_ui_review_${name}_rollup`,
        marker,
        sources: [`mem_ui_review_${name}_a`, `mem_ui_review_${name}_b`],
        bodies: [a, b],
        body:
          name === "consolidation"
            ? `${a}\n\n${b}`
            : `${marker}: Ripe apples stay cool, never frozen. Pears stay dry, according to the grower.`,
      },
    ];
  }),
);

/** An isolated, historical preference fixture, never a provider invocation. */
export async function installLegacyReviewSettings(baseURL, model) {
  if (
    ![
      "@cf/meta/llama-3.1-8b-instruct-fp8",
      "@cf/meta/llama-3.2-3b-instruct",
      "google/gemini-2.5-flash-lite",
      "@cf/zai-org/glm-5.3-flash",
    ].includes(model)
  )
    throw new Error("Expected an exact historical model fixture");
  await localSql(
    baseURL,
    `INSERT INTO memory_review_settings(user_id,model,enabled,overnight)
    VALUES ('local',${literal(model)},1,1) ON CONFLICT(user_id) DO UPDATE SET
    model=excluded.model,enabled=1,overnight=1;`,
  );
}

/**
 * Ranking switched on and stopped at today's derived request count, as a pass
 * records it. Never a provider call; the stop is what the status line reads.
 */
export async function installRankingStop(baseURL, requests) {
  await localSql(
    baseURL,
    `INSERT INTO memory_review_ranking(user_id,destination,enabled,revision)
    VALUES ('local','hybrid-bge-m3-jev-1.14.0-review1',1,1) ON CONFLICT(user_id) DO UPDATE SET enabled=1;
    INSERT INTO memory_review_ranking_budgets(user_id,day,requests,reserved_microusd,last_error,manual_requests)
    VALUES ('local',CAST(unixepoch()/86400 AS INTEGER),${Number(requests)},0,'ranking-daily-limit',${Number(requests)})
    ON CONFLICT(user_id,day) DO UPDATE SET requests=excluded.requests,manual_requests=excluded.manual_requests,last_error=excluded.last_error;`,
  );
}

/** Ranking back off, with today's ranking counter cleared. */
export async function removeRankingStop(baseURL) {
  await localSql(
    baseURL,
    `UPDATE memory_review_ranking SET enabled=0 WHERE user_id='local';
    DELETE FROM memory_review_ranking_budgets WHERE user_id='local';`,
  );
}

/** A finished nightly run, as the minute cron records it (J-0). Never a provider call. */
export async function installUpkeepRun(baseURL, run, nextRunAt) {
  await localSql(
    baseURL,
    `UPDATE memory_review_settings SET last_run_json=${literal(JSON.stringify(run))},
    next_run_at=${Number(nextRunAt)} WHERE user_id='local';`,
  );
}

/** Read authoritative consent/accounting, not optimistic browser switch state. */
export async function reviewFixtureState(baseURL) {
  const [settings] = localQuery(
    baseURL,
    "SELECT model,enabled,overnight,auto_apply,manual_memories,upkeep_memories FROM memory_review_settings WHERE user_id='local'",
  );
  const budgets = localQuery(
    baseURL,
    "SELECT day,calls,reserved_microusd FROM memory_review_budgets WHERE user_id='local' ORDER BY day",
  );
  const groups = localQuery(
    baseURL,
    "SELECT group_id,model,state FROM memory_review_groups WHERE user_id='local' ORDER BY group_id",
  );
  return { settings: settings ?? null, budgets, groups };
}

export async function installReviewFixtures(baseURL) {
  const schema = await migrations();
  const source = openDump(schema.map((m) => m.sql).join("\n"));
  const projected = openDump(schema.map((m) => m.sql).join("\n"));
  try {
    const output = await build({
      entryPoints: [resolve("app/concepts/memory-review.ts")],
      bundle: true,
      write: false,
      platform: "node",
      format: "esm",
      alias: { "~": resolve("app") },
    });
    const application = await import(
      `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
    );
    const prepare = (sql, args = []) => ({
      bind: (...values) => prepare(sql, values),
      first: async () => source.prepare(sql).get(...args) ?? null,
    });
    for (const [index, name] of names.entries()) {
      const fixture = UI_REVIEWS[name];
      for (let n = 0; n < 2; n++)
        source.exec(
          insert("memories", {
            memory_id: fixture.sources[n],
            user_id: "local",
            memory_type: "fact",
            title: name.startsWith("volume-")
              ? `Kestrel field note ${name} — attributed transport guidance with a deliberately long subject and a narrow pilot-only qualification (${n + 1})`
              : `Synthetic ${name} source ${n + 1}`,
            body: fixture.bodies[n],
            tags_json: '["memory-inbox-browser-fixture"]',
            project: "synthetic-memory-inbox-ui",
            source_agent: name.startsWith("volume-")
              ? "https://example.test/oauth/agent/long-client-metadata-document.json"
              : "synthetic-ui-fixture",
            source_client: "playwright",
            source_session: "synthetic-memory-inbox",
            created_at: 1,
            updated_at: 1,
          }),
        );
      const snapshots = await Promise.all(
        fixture.sources.map((id) =>
          application.reviewSnapshot({ prepare }, "local", id),
        ),
      );
      if (name === "summary")
        for (const [i, snapshot] of snapshots.entries())
          snapshot.selection = {
            via: i === 0 ? "starting-memory" : "keyword-match",
            anchorId: fixture.sources[0],
          };
      const proposal = application.validateReviewProposal(
        {
          kind:
            name === "noop"
              ? "noop"
              : name === "consolidation"
                ? "consolidation"
                : name === "conflict"
                  ? "contradiction"
                  : "summary",
          title: name === "conflict" ? "" : fixture.title,
          body: name === "conflict" ? "" : fixture.body,
          why: "Synthetic browser fixture: compatible claims retain qualifications and source attribution.",
          evidence: fixture.sources.map((id, n) => ({
            id,
            quote: fixture.bodies[n],
          })),
        },
        snapshots,
      );
      source.exec(
        insert("memory_review_groups", {
          group_id: fixture.groupId,
          user_id: "local",
          fingerprint: digest(`ui-fixture:${name}`),
          model: "@cf/meta/llama-3.1-8b-instruct-fp8",
          prompt_version: "memory-review-1",
          sources_json: JSON.stringify(snapshots),
          proposal_json: name === "failed" ? null : JSON.stringify(proposal),
          draft_title: proposal.title,
          draft_body: proposal.body,
          state:
            name === "noop" || name === "failed"
              ? name
              : applied(name)
                ? "accepted"
                : "proposal",
          error: name === "failed" ? "invalid-evidence" : null,
          result_memory_id: applied(name) ? fixture.rollup : null,
          applied_by: applied(name) ? "auto" : null,
          created_at: name.startsWith("volume-") ? 90 - index : 100 + index,
          updated_at: name.startsWith("volume-") ? 90 - index : 100 + index,
        }),
      );
      if (applied(name))
        source.exec(
          insert("memories", {
            memory_id: fixture.rollup,
            user_id: "local",
            memory_type: "reference",
            title: fixture.title,
            body: `${fixture.body}\n\nApplied automatically by nightly memory upkeep; no person checked it.`,
            tags_json: '["rollup"]',
            project: "synthetic-memory-inbox-ui",
            source_agent: "valise:memory-upkeep",
            source_client: "nightly",
            source_session: null,
            created_at: 3,
            updated_at: 3,
          }),
        );
      if (name === "subject")
        source.exec(
          insert("memory_review_groups", {
            group_id: "mrg_ui_review_previous",
            user_id: "local",
            fingerprint: digest("ui-previous"),
            model: "@cf/meta/llama-3.1-8b-instruct-fp8",
            prompt_version: "memory-review-1",
            sources_json: JSON.stringify(snapshots),
            proposal_json: JSON.stringify({
              kind: "noop",
              title: "",
              body: "",
              why: "Synthetic earlier comparison.",
              evidence: [],
            }),
            draft_title: "",
            draft_body: "",
            state: "noop",
            created_at: 2,
            updated_at: 2,
          }),
        );
    }
    // Rebuild using application code; copy only our synthetic rows/projections,
    // never the scratch bootstrap account or other suite data.
    projected.exec(await recoverySql(source, schema));
    const statements = [];
    for (const table of ["memories", "memory_review_groups", "search_docs"])
      for (const original of projected
        .prepare(`SELECT * FROM ${table}`)
        .all()) {
        const row = { ...original };
        if (table === "search_docs") delete row.id;
        statements.push(insert(table, row));
      }
    statements.push(
      `DELETE FROM memory_review_pending WHERE memory_id IN (${Object.values(
        UI_REVIEWS,
      )
        .flatMap((f) => [...f.sources, f.rollup])
        .map(literal)
        .join(",")});`,
    );
    await localSql(
      baseURL,
      `PRAGMA defer_foreign_keys=TRUE;\n${statements.join("\n")}`,
    );
  } finally {
    source.close();
    projected.close();
  }
}

export async function removeReviewFixtures(baseURL) {
  const ids = Object.values(UI_REVIEWS).flatMap((f) => f.sources);
  const groups = Object.values(UI_REVIEWS)
    .map((f) => literal(f.groupId))
    .concat(literal("mrg_ui_review_previous"))
    .join(",");
  const owned = `SELECT value FROM json_each(${literal(JSON.stringify(ids))}) UNION SELECT result_memory_id FROM memory_review_groups WHERE group_id IN (${groups}) AND result_memory_id IS NOT NULL`;
  await localSql(
    baseURL,
    `PRAGMA defer_foreign_keys=TRUE;
    DELETE FROM memory_subject_members WHERE subject_id IN (SELECT json_extract(value,'$.subject') FROM memory_review_events WHERE group_id IN (${groups}) AND kind='accept');
    DELETE FROM memory_subjects WHERE subject_id IN (SELECT json_extract(value,'$.subject') FROM memory_review_events WHERE group_id IN (${groups}) AND kind='accept');
    DELETE FROM search_docs WHERE concept = 'memory' AND concept_id IN (${owned});
    DELETE FROM memory_review_events WHERE group_id IN (${groups});
    DELETE FROM memory_links WHERE from_memory_id IN (${owned}) OR to_memory_id IN (${owned});
    DELETE FROM memory_attachments WHERE memory_id IN (${owned});
    DELETE FROM memory_revisions WHERE memory_id IN (${owned});
    DELETE FROM vector_pending WHERE memory_id IN (${owned});
    DELETE FROM vector_snapshots WHERE memory_id IN (${owned});
    DELETE FROM memory_review_pending WHERE memory_id IN (${owned});
    DELETE FROM memories WHERE memory_id IN (${owned});
    DELETE FROM memory_review_groups WHERE group_id IN (${groups});`,
  );
}

/** Three evidence memories from two sessions in two projects (J-E's evidence rule). */
const PRINCIPLE_EVIDENCE = [
  ["mem_ui_principle_0", "Verify takes a machine-wide lock", "valise", "s1"],
  ["mem_ui_principle_1", "Playwright runs share build/", "valise", "s2"],
  ["mem_ui_principle_2", "The stash stack is shared", "stash-tool", "s2"],
];
export const UI_PRINCIPLES = {
  adopt: {
    id: "prn_ui_adopt",
    rule: "Design every shared script for parallel agents, not one.",
  },
  reject: {
    id: "prn_ui_reject",
    rule: "Prefer short sessions over long ones.",
  },
};

/** A finished reflection with two principle cards, as the nightly step writes them. Never a provider call. */
export async function installPrincipleCards(baseURL) {
  const evidence = JSON.stringify(
    PRINCIPLE_EVIDENCE.map(([id, title, project, session]) => ({
      id,
      revision: 1,
      lesson:
        "Concurrent workers sharing mutable state corrupt each other's output.",
      title,
      project,
      session,
    })),
  );
  const memories = PRINCIPLE_EVIDENCE.map(
    ([id, title, project, session]) =>
      `INSERT INTO memories(memory_id,user_id,memory_type,title,body,tags_json,project,source_agent,source_client,source_session,created_at,updated_at)
      VALUES (${literal(id)},'local','insight',${literal(title)},${literal(`${title}: parallel agents overwrote each other.`)},'["synthetic"]',${literal(project)},'ui-fixture','mcp',${literal(session)},unixepoch(),unixepoch());`,
  ).join("\n");
  const card = (id, rule, kind, text) =>
    `INSERT INTO memory_principles(principle_id,user_id,reflection_id,state,rule,applies_when,mechanism,exceptions,change_kind,change_text,evidence_json,counter_json,model,prompt_version,created_at,updated_at)
    VALUES (${literal(id)},'local','rfl_ui','proposal',${literal(rule)},'A script or resource is used by more than one agent session at once.','Concurrent workers corrupt shared mutable state.','A script only one person ever runs.',${literal(kind)},${literal(text)},${literal(evidence)},'[]','anthropic/claude-haiku-5.5','memory-reflection-1',unixepoch(),unixepoch());`;
  await localSql(
    baseURL,
    `${memories}
    INSERT INTO memory_reflections(reflection_id,user_id,requested_by,since,calls,proposed,ended,created_at,finished_at)
    VALUES ('rfl_ui','local','schedule',0,3,2,'done',unixepoch(),unixepoch());
    ${card(UI_PRINCIPLES.adopt.id, UI_PRINCIPLES.adopt.rule, "agents", "Add to Rules: anything parallel agents share needs a lock, isolation or an explicit order.")}
    ${card(UI_PRINCIPLES.reject.id, UI_PRINCIPLES.reject.rule, "none", "")}`,
  );
}

export async function removePrincipleFixtures(baseURL) {
  const results =
    "SELECT result_memory_id FROM memory_principles WHERE user_id='local' AND result_memory_id IS NOT NULL";
  const todos =
    "SELECT result_todo_id FROM memory_principles WHERE user_id='local' AND result_todo_id IS NOT NULL";
  const owned = `SELECT value FROM json_each(${literal(JSON.stringify(PRINCIPLE_EVIDENCE.map(([id]) => id)))}) UNION ${results}`;
  await localSql(
    baseURL,
    `PRAGMA defer_foreign_keys=TRUE;
    DELETE FROM search_docs WHERE concept = 'todo' AND concept_id IN (${todos});
    DELETE FROM todos WHERE todo_id IN (${todos});
    DELETE FROM search_docs WHERE concept = 'memory' AND concept_id IN (${owned});
    DELETE FROM memory_links WHERE from_memory_id IN (${owned}) OR to_memory_id IN (${owned});
    DELETE FROM vector_pending WHERE memory_id IN (${owned});
    DELETE FROM vector_snapshots WHERE memory_id IN (${owned});
    DELETE FROM memory_review_pending WHERE memory_id IN (${owned});
    DELETE FROM memories WHERE memory_id IN (${owned});
    DELETE FROM memory_principles WHERE user_id='local';
    DELETE FROM memory_reflections WHERE user_id='local';`,
  );
}

/** Where each card stands and what adopting wrote. */
export async function principleFixtureState(baseURL) {
  const principles = localQuery(
    baseURL,
    `SELECT p.principle_id, p.state, p.reason, m.memory_type, m.title, t.title AS todo
    FROM memory_principles p LEFT JOIN memories m ON m.memory_id = p.result_memory_id
    LEFT JOIN todos t ON t.todo_id = p.result_todo_id WHERE p.user_id='local' ORDER BY p.principle_id`,
  );
  const links = localQuery(
    baseURL,
    `SELECT from_memory_id, kind, asserted_by FROM memory_links WHERE to_memory_id IN
    (SELECT result_memory_id FROM memory_principles WHERE user_id='local') ORDER BY from_memory_id`,
  );
  return { principles, links };
}
