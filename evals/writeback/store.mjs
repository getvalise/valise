import { localEndpoint } from "./harness.mjs";

/** Independent, SELECT-only observer of a dedicated Local Explorer database. */
export async function observer(endpoint, { quietReads = 6 } = {}) {
  const origin = localEndpoint(endpoint);
  async function json(path, body) {
    const response = await fetch(new URL(path, origin), {
      redirect: "error",
      signal: AbortSignal.timeout(30000),
      ...(body
        ? {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }
        : {}),
    });
    if (!response.ok) throw new Error(`Local observer HTTP ${response.status}`);
    return response.json();
  }
  const databases = await json("/cdn-cgi/local/explorer/api/d1/database");
  const db = databases.result.find((d) => d.name === "DB");
  if (!db) throw new Error("No isolated local DB");
  const sql = async (statement, params = []) => {
    if (!/^SELECT\b/i.test(statement) || statement.includes(";"))
      throw new Error("Observer is SELECT-only");
    const response = await json(
      `/cdn-cgi/local/explorer/api/d1/database/${db.uuid}/raw`,
      { sql: statement, params },
    );
    if (!response.success) throw new Error("Local observer query failed");
    const result = response.result[0].results;
    return result.rows.map((row) =>
      Object.fromEntries(result.columns.map((key, i) => [key, row[i]])),
    );
  };
  return {
    async assertEmpty() {
      // Include deleted rows: never reuse a developer or a prior run's store.
      for (const table of [
        "memories",
        "todos",
        "skills",
        "assets",
        "sources",
      ]) {
        const [row] = await sql(`SELECT COUNT(*) AS n FROM ${table}`);
        if (row.n !== 0)
          throw new Error(`Nonempty ${table}: start a fresh dedicated store`);
      }
    },
    async snapshot(client, protectedIds, project) {
      // Coordinator mirrors trail a claim or completion by a second or two,
      // retried on a one-second alarm. Score only after the rows have held
      // still for three seconds.
      const read = async () => [
        await sql("SELECT * FROM memories ORDER BY memory_id"),
        await sql("SELECT * FROM todos ORDER BY todo_id"),
        await sql(
          "SELECT * FROM search_docs WHERE concept IN ('memory','todo') ORDER BY doc_key",
        ),
        await sql(
          "SELECT * FROM memory_revisions ORDER BY memory_id, revision",
        ),
        await sql(
          "SELECT * FROM todo_updates ORDER BY todo_id, created_at, update_id",
        ),
        await sql(
          "SELECT * FROM todo_comments ORDER BY todo_id, created_at, comment_id",
        ),
      ];
      let rows = await read();
      for (let quiet = 0, i = 0; quiet < quietReads; i++) {
        if (i > 60) throw new Error("Store did not settle within 30 seconds");
        await new Promise((resolve) => setTimeout(resolve, 500));
        const next = await read();
        quiet = JSON.stringify(next) === JSON.stringify(rows) ? quiet + 1 : 0;
        rows = next;
      }
      const [memories, todos, projections, revisions, updates, comments] = rows;
      const result = { memories: [], todos: [], protected: [], outside: [] };
      for (const [concept, rows] of [
        ["memory", memories],
        ["todo", todos],
      ]) {
        for (const row of rows) {
          const id = `${concept}:${row[`${concept}_id`]}`;
          const history = [...updates, ...comments].filter(
            (u) => concept === "todo" && u.todo_id === row.todo_id,
          );
          const versions = revisions.filter(
            (r) => concept === "memory" && r.memory_id === row.memory_id,
          );
          if (protectedIds.includes(id)) {
            result.protected.push({
              id,
              row,
              history,
              versions,
              projection: projections.find((p) => p.doc_key === id) ?? null,
            });
            continue;
          }
          // Other projects only have to stay as they were: a write there is
          // an escaped capture, and it changes this hash.
          if (row.project !== project) {
            result.outside.push({ id, row, history, versions });
            continue;
          }
          const authoritative = await client.call("fetch", { id, full: true });
          const text = [
            row.title,
            row.body,
            ...history.map((u) => u.body),
          ].join("\n");
          const projection = projections.find((p) => p.doc_key === id);
          const search = await client.call("search", {
            query: row.title || row.body.slice(0, 100),
            type: concept,
            project: row.project,
            limit: 100,
          });
          const record = {
            id,
            text,
            project: row.project,
            type: row.memory_type ?? null,
            revision: versions.length
              ? Math.max(...versions.map((r) => r.revision))
              : 0,
            state: row.state ?? null,
            refs: row.refs_json ? JSON.parse(row.refs_json) : [],
            // A stale row with the right ID is insufficient: check current body.
            projectionVisible: Boolean(
              projection &&
                projection.title === row.title &&
                projection.body.includes(row.body) &&
                authoritative.id === id,
            ),
            searchVisible: search.results.some((r) => r.id === id),
            row,
            history,
            versions,
          };
          result[concept === "memory" ? "memories" : "todos"].push(record);
        }
      }
      result.protected.sort((a, b) => a.id.localeCompare(b.id));
      result.outside.sort((a, b) => a.id.localeCompare(b.id));
      return result;
    },
  };
}

export async function seed({ setup, other, project, scenario, catalog = 64 }) {
  const blocked = await setup.call("create_todo", {
    title: "Deploy checksum rollout",
    project,
    body: "Deployment requires vendor-signoff.",
  });
  const blockedClaim = await setup.call("claim_todo", {
    id: blocked.id,
    ttl_seconds: 3600,
  });
  await setup.call("update_todo", {
    id: blocked.id,
    token: blockedClaim.token,
    blocked_on: "vendor-signoff",
  });
  const active = await other.call("create_todo", {
    title: "Unrelated active documentation",
    project,
    body: "Another agent owns this task; do not modify it.",
  });
  const activeClaim = await other.call("claim_todo", {
    id: active.id,
    ttl_seconds: 3600,
  });
  const ids = { blocked: blocked.id, active: active.id };
  if (scenario.seedMatch) {
    ids.memory = (
      await setup.call("save_memory", {
        type: "insight",
        title: "Checksum verification observation",
        project,
        tags: ["checksum"],
        body: "Preliminary observation: checksum output needs investigation; measurement not recorded yet.",
      })
    ).id;
    ids.task = (
      await setup.call("create_todo", {
        title: "Verify checksum rollout",
        project,
        body: "Parser implementation complete; verification details to follow.",
        refs: [{ kind: "file", value: "fixtures/payload.txt" }],
      })
    ).id;
  }
  for (let i = 0; i < catalog; i++) {
    await setup.call("publish_skill", {
      body: `---\nname: synthetic-guide-${i}\ndescription: Synthetic technology ${i} configuration guide; use only for that technology.\n---\nInspect the configuration and record the relevant check. No project history is contained here.`,
      project: "j4-synthetic-catalog",
    });
  }
  return { ids, protectedIds: [blocked.id, active.id], activeClaim };
}
