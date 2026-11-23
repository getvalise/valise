import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { build } from "esbuild";
import {
  capture,
  enqueueAssetVectors,
  pull,
  restore,
  status,
  verifySnapshot,
} from "../scripts/backup.mjs";
import { backupSource } from "../scripts/backup-source.mjs";
import {
  applicationModule,
  beforeTableRestore,
  checkTables,
  digest,
  insert,
  literal,
  migrations,
  openDump,
  originals,
  recoverySql,
  restoredRow,
  TABLES,
} from "../scripts/recovery.mjs";
import { drillRunner, readD1Batch } from "./helpers/recovery-drill.mjs";

const payload = Buffer.from("Original\nPDF-like bytes\0\xff", "latin1");
const bundle = Buffer.from("print('historical supporting file')\n");
const legacy = Buffer.from(
  "Member legacy attachment, never registered as an asset\n",
);
const memberOriginal = Buffer.from(
  "Member processed original\nImmutable synthetic bytes\0",
  "utf8",
);
const bytesFor = (key) =>
  key.includes("skv_old")
    ? bundle
    : key.includes("obj_processed_member")
      ? memberOriginal
      : key.includes("obj_member")
        ? legacy
        : payload;
const asset = "ast_00000000-0000-4000-8000-000000000001";
const memberAsset = "ast_00000000-0000-4000-8000-000000000002";

async function fixture({ embeddedNul = false } = {}) {
  const schema = await migrations();
  const db = openDump(schema.map((m) => m.sql).join("\n"));
  db.exec(`
    UPDATE users SET email='owner@example.test', password_hash='private-password-hash', email_verified=1,
      verification_token='do-not-replay', verification_expires_at=9999999999 WHERE user_id='local';
    INSERT INTO users(user_id,email,display_name,role,created_at,email_verified) VALUES('member','member@example.test','Member','member',1,1);
    INSERT INTO skills(skill_id,name,user_id,created_at,updated_at,head_version_id) VALUES('skl_owner','sandpiper','local',1,2,'skv_head');
    INSERT INTO skills(skill_id,name,user_id,created_at,updated_at,head_version_id) VALUES('skl_member','sandpiper','member',1,2,'skv_member');
    INSERT INTO skill_versions(version_id,skill_id,version,body_md,body_sha256,created_at,created_by) VALUES
      ('skv_old','skl_owner',1,'old sandpiper','hash',1,'console'),
      ('skv_head','skl_owner',2,'sandpiper recovery owner skill','hash',2,'console'),
      ('skv_member','skl_member',1,'sandpiper recovery member skill','hash',2,'console');
    INSERT INTO memories(memory_id,user_id,memory_type,title,body,source_agent,source_client,created_at,updated_at) VALUES
      ('mem_a','local','reference','Sandpiper owner','unchanged head','drill','console',1,2),
      ('mem_b','local','project','Sandpiper linked','a second note','drill','console',1,2),
      ('mem_foreign','member','reference','Sandpiper member','private foreign content','drill','console',1,2);
    INSERT INTO memory_revisions(revision_id,memory_id,revision,memory_type,title,body,created_at,created_by) VALUES('rev_old','mem_a',1,'reference','Old head','original historic text',1,'drill');
    INSERT INTO memory_links(link_id,from_memory_id,to_memory_id,kind,asserted_by,source_agent,source_client,created_at,confirmed_at,confirmed_by) VALUES('lnk_a','mem_a','mem_b','related','person','drill','console',1,1,'console');
    INSERT INTO memory_subjects(subject_id,user_id,name,kind,description,summary_memory_id,created_at,updated_at) VALUES
      ('sub_a','local','Sandpiper','topic','Owner evidence','mem_a',1,2),
      ('sub_member','member','Private topic','area','Member evidence',NULL,1,2);
    INSERT INTO memory_subject_members(subject_id,memory_id,asserted_by,confirmed_at,confirmed_by,created_at) VALUES
      ('sub_a','mem_b','person',2,'local',2),
      ('sub_member','mem_foreign','person',2,'member',2);
    INSERT INTO todos(todo_id,user_id,title,state,lease_holder,lease_expires_at,fencing_token,mirror_generation,source_agent,created_at,updated_at) VALUES
      ('tdo_claim','local','Sandpiper claimed','claimed','old-agent',9999999999,41,9,'drill',1,2),
      ('tdo_done','local','Sandpiper done','done',NULL,NULL,8,4,'drill',1,2),
      ('tdo_blocked','local','Sandpiper manually blocked','blocked',NULL,NULL,4,2,'drill',1,2),
      ('tdo_member','member','Sandpiper tenant','pending',NULL,NULL,0,0,'drill',1,2);
    UPDATE todos SET project='platform' WHERE todo_id='tdo_done';
    UPDATE todos SET project='integration', blocked_on='Owner approval remains outstanding' WHERE todo_id='tdo_blocked';
    INSERT INTO todo_relations(user_id,from_todo_id,to_todo_id,kind,created_at) VALUES
      ('local','tdo_claim','tdo_done','parent',11),
      ('local','tdo_blocked','tdo_done','parent',12),
      ('local','tdo_claim','tdo_done','depends-on',13),
      ('local','tdo_blocked','tdo_claim','depends-on',14),
      ('local','tdo_blocked','tdo_done','depends-on',15);
    INSERT INTO todo_relation_fences(user_id,token) VALUES
      ('local','00000000-0000-4000-8000-000000000101'),
      ('member','00000000-0000-4000-8000-000000000102');
    INSERT INTO todo_updates(update_id,todo_id,kind,author,token,body,created_at) VALUES('tdu_claim','tdo_claim','claim','old-agent',41,'durable audit',2);
    INSERT INTO todo_comments(comment_id,todo_id,author,source_client,body,created_at) VALUES('tdc_a','tdo_claim','console','console','Sandpiper historical comment',2);
    INSERT INTO hook_configs(user_id,document,updated_at) VALUES('member','{"hooks":[]}',2);
    INSERT INTO assets(asset_id,user_id,title,file_name,content_type,declared_size,source_agent,source_client,upload_token_digest,upload_expires_at,created_at,updated_at) VALUES('ast_pending','member','In flight','unfinished.txt','text/plain',3,'drill','console','old-upload-token',9999999999,1,2);
    INSERT INTO sources(source_id,user_id,kind,title,notes,revision,source_agent,source_client,created_at,updated_at) VALUES('src_a','local','document','Sandpiper document','whole head notes',2,'drill','console',1,2);
    INSERT INTO source_revisions(revision_id,source_id,revision,kind,title,notes,source_agent,source_client,created_at) VALUES
      ('srv_1','src_a',1,'document','Old document','old full notes','drill','console',1),
      ('srv_2','src_a',2,'document','Sandpiper document','whole head notes','drill','console',2);
    INSERT INTO sessions(session_id,user_id,created_at,expires_at) VALUES('old-session','local',1,9999999999);
    INSERT INTO bearer_tokens(token_id,user_id,label,token_digest,created_at) VALUES('old-token','local','old bearer','old-digest',1);
    INSERT INTO invites(invite_id,code,created_by,created_at) VALUES('inv_a','old-invite','local',1);
  `);
  // Wrangler's D1 SQL exporter emits an unparseable quoted literal for NUL.
  // Test recovery's byte handling in the direct SQLite drill, not in the
  // Wrangler export fixture shared by the fresh-install and Workflow drills.
  if (embeddedNul)
    db.prepare(
      "UPDATE memory_subjects SET description=? WHERE subject_id='sub_a'",
    ).run("NUL\0byte");
  db.exec(
    insert("objects", {
      object_id: "obj_a",
      user_id: "local",
      r2_key: "u/local/objects/obj_a",
      name: "original.pdf",
      content_type: "application/pdf",
      size: payload.length,
      sha256: digest(payload),
      created_at: 1,
    }),
  );
  db.exec(
    insert("objects", {
      object_id: "obj_member",
      user_id: "member",
      r2_key: "u/member/objects/obj_member",
      name: "original.pdf",
      content_type: "application/pdf",
      size: legacy.length,
      sha256: digest(legacy),
      created_at: 1,
    }),
  );
  db.exec(
    "INSERT INTO memory_attachments(memory_id,object_id,created_at) VALUES('mem_foreign','obj_member',2)",
  );
  db.exec(`INSERT INTO assets(asset_id,user_id,state,object_id,title,file_name,content_type,declared_size,source_agent,source_client,created_at,updated_at,finalized_at) VALUES('${asset}','local','ready','obj_a','Sandpiper original','original.pdf','application/pdf',${payload.length},'drill','console',1,2,2);
    INSERT INTO source_revision_assets(source_id,revision,asset_id,position) VALUES('src_a',1,'${asset}',0),('src_a',2,'${asset}',0);
    INSERT INTO memory_attachments(memory_id,object_id,created_at) VALUES('mem_a','obj_a',2);
    INSERT INTO todo_attachments(todo_id,object_id,created_at) VALUES('tdo_claim','obj_a',2);`);
  db.prepare(
    "UPDATE skill_versions SET files_json=? WHERE version_id='skv_old'",
  ).run(
    JSON.stringify([
      {
        path: "scripts/historic.py",
        r2Key: "skills/skl_owner/skv_old/scripts/historic.py",
        size: bundle.length,
        sha256: digest(bundle),
      },
    ]),
  );
  processingFixture(db);
  // Review history and coverage are not credentials. Seed human decisions,
  // original model drafts, an edited pending draft, and interrupted inference.
  const reviewSources = JSON.stringify(
    [
      {
        id: "mem_a",
        revision: 2,
        type: "reference",
        title: "Sandpiper owner",
        body: "unchanged head",
      },
      {
        id: "mem_b",
        revision: 1,
        type: "project",
        title: "Sandpiper linked",
        body: "a second note",
      },
    ].map((claim) => {
      const source = {
        ...claim,
        tags: "[]",
        project: null,
        agent: "drill",
        client: "console",
        session: null,
        sessionName: null,
        links: [
          ["lnk_a", "mem_a", "mem_b", "related", "person", 1, null, null],
        ],
      };
      const stamp = JSON.stringify(source);
      return { source, stamp, fingerprint: digest(stamp) };
    }),
  );
  for (const user of ["local", "member"])
    db.exec(
      insert("memory_review_settings", {
        user_id: user,
        enabled: 1,
        overnight: 1,
        auto_apply: 1,
        model:
          user === "local"
            ? "anthropic/claude-haiku-5.5"
            : "@cf/meta/llama-3.2-3b-instruct",
        daily_calls: user === "local" ? 4 : 8,
        daily_microusd: user === "local" ? 40000 : 100000,
        next_run_at: 9999999999,
        lock_token: `old-review-lock-${user}`,
        lock_until: 9999999999,
      }),
    );
  for (const user of ["local", "member"]) {
    db.exec(
      insert("memory_review_ranking", {
        user_id: user,
        enabled: 1,
        revision: 7,
        destination: "hybrid-bge-m3-jev-1.14.0-review1",
        daily_requests: 8,
        daily_microusd: 20000,
        manual_model: "anthropic/claude-haiku-5.5",
      }),
    );
    db.exec(
      insert("memory_review_ranking_budgets", {
        user_id: user,
        day: 20600,
        requests: 3,
        reserved_microusd: 789,
        last_error: "ranking-provider-failed",
      }),
    );
  }
  for (const state of [
    "dismissed",
    "noop",
    "proposal",
    "accepted",
    "running",
    "failed",
  ])
    db.exec(
      insert("memory_review_groups", {
        group_id: `mrg_${state}`,
        user_id: "local",
        fingerprint: digest(`group-${state}-source-revisions`),
        model:
          state === "running"
            ? "anthropic/claude-haiku-5.5"
            : "google/gemini-2.5-flash-lite",
        prompt_version: "memory-review-1",
        sources_json: reviewSources,
        proposal_json:
          state === "running" || state === "failed"
            ? null
            : JSON.stringify({
                kind: state === "noop" ? "noop" : "summary",
                title: "Synthetic review draft",
                body: "Original model synthesis with attribution.",
                why: "Synthetic compatible claims, not a confidence score.",
                evidence: [
                  { id: "mem_a", quote: "unchanged head" },
                  { id: "mem_b", quote: "a second note" },
                ],
              }),
        draft_title: "Synthetic human-reviewed draft",
        draft_body: "Human-edited synthesis; retain source qualifications.",
        state,
        attempts: state === "failed" ? 2 : 1,
        retry_at: state === "running" || state === "failed" ? 9999999999 : 0,
        result_memory_id: state === "accepted" ? "mem_a" : null,
        error:
          state === "running" || state === "failed"
            ? "Prior synthetic provider refusal"
            : null,
        created_at: 5,
        updated_at: 6,
      }),
    );
  for (const [kind, state, value] of [
    ["dismiss", "dismissed", "Human said no"],
    [
      "edit-body",
      "proposal",
      "Human-edited synthesis; retain source qualifications.",
    ],
    ["accept", "accepted", '{"result":"mem_a","supersede":false}'],
  ])
    db.exec(
      insert("memory_review_events", {
        event_id: `mre_${state}`,
        group_id: `mrg_${state}`,
        user_id: "local",
        kind,
        value,
        created_at: 6,
      }),
    );
  db.exec(
    insert("memory_review_budgets", {
      user_id: "local",
      day: 1,
      calls: 4,
      reserved_microusd: 7777,
    }),
  );
  db.exec(
    insert("memory_review_budgets", {
      user_id: "member",
      day: 1,
      calls: 1,
      reserved_microusd: 2222,
    }),
  );
  // mem_a has already been covered. Restore must not recreate the initial
  // all-memory queue through the new destination's memory/link triggers.
  db.exec("DELETE FROM memory_review_pending;");
  db.exec(
    insert("memory_review_pending", {
      memory_id: "mem_b",
      user_id: "local",
      enqueued_at: 71,
    }),
  );
  db.exec(
    insert("memory_review_pending", {
      memory_id: "mem_foreign",
      user_id: "member",
      enqueued_at: 73,
    }),
  );
  return { db, schema };
}

function processingFixture(db) {
  db.exec(
    insert("objects", {
      object_id: "obj_processed_member",
      user_id: "member",
      r2_key: "u/member/objects/obj_processed_member",
      name: "processed.pdf",
      content_type: "application/pdf",
      size: memberOriginal.length,
      sha256: digest(memberOriginal),
      created_at: 1,
    }),
  );
  db.exec(
    insert("assets", {
      asset_id: memberAsset,
      user_id: "member",
      state: "ready",
      object_id: "obj_processed_member",
      title: "Member original",
      file_name: "processed.pdf",
      content_type: "application/pdf",
      declared_size: memberOriginal.length,
      source_agent: "drill",
      source_client: "console",
      created_at: 1,
      updated_at: 2,
      finalized_at: 2,
    }),
  );
  db.prepare(
    "UPDATE assets SET description = 'Owner accepted summary' WHERE asset_id = ?",
  ).run(asset);
  // A real grouped container, including an interrupted upload, must survive
  // the two recovery paths without becoming unrelated singleton folders.
  db.prepare(
    "UPDATE asset_folders SET title = 'Member retained file group' WHERE folder_id = ?",
  ).run(memberAsset);
  db.prepare(
    "UPDATE asset_folder_files SET folder_id = ? WHERE asset_id = 'ast_pending'",
  ).run(memberAsset);
  const attempts = [
    ["apr_owner_old", "local", asset, 1, "ready", 1],
    ["apr_owner_current", "local", asset, 2, "ready", 1],
    ["apr_owner_running", "local", asset, 3, "running", 2],
    ["apr_member_current", "member", memberAsset, 1, "ready", 1],
    ["apr_member_queued", "member", memberAsset, 2, "queued", 0],
  ];
  for (const [id, userId, assetId, generation, state, spent] of attempts) {
    const token = state === "running" ? "source-worker-lease" : null;
    const lease = token ? 9999999999 : 0;
    db.exec(
      insert("asset_processing", {
        processing_id: id,
        user_id: userId,
        asset_id: assetId,
        generation,
        processor_version: "drill-extract-v1",
        state,
        created_at: generation,
        finished_at: state === "ready" ? 2 : null,
        attempts: spent,
        lease_token: token,
        lease_until: lease,
      }),
    );
    db.exec(
      insert("asset_processing_admissions", {
        processing_id: id,
        user_id: userId,
        created_at: Math.floor(Date.now() / 1000),
        attempts: spent,
        lease_token: token,
        lease_until: lease,
      }),
    );
  }
  for (const [
    id,
    userId,
    assetId,
    objectId,
    checksum,
    text,
    title,
    summary,
    tag,
  ] of [
    [
      "apr_owner_old",
      "local",
      asset,
      "obj_a",
      digest(payload),
      "obsoleteownerextract prior immutable text",
      "Old proposed title",
      "Prior summary",
      "obsolete-ghost",
    ],
    [
      "apr_owner_current",
      "local",
      asset,
      "obj_a",
      digest(payload),
      "lithicriver owner current extracted passage",
      "Sandpiper original",
      "Owner accepted summary",
      "ghost-owner",
    ],
    [
      "apr_member_current",
      "member",
      memberAsset,
      "obj_processed_member",
      digest(memberOriginal),
      "cobaltcoral member private extracted passage",
      "Member original",
      "Member provisional summary",
      "ghost-member",
    ],
  ]) {
    db.exec(
      insert("asset_processing_outputs", {
        processing_id: id,
        user_id: userId,
        asset_id: assetId,
        object_id: objectId,
        original_sha256: checksum,
        processor_version: "drill-extract-v1",
        extractor: "synthetic-extractor-v1",
        text,
        truncated: 0,
        suggestions_json: JSON.stringify({
          title,
          summary,
          tags: [tag],
          project: null,
        }),
        suggestion_model: "synthetic-model-v1",
        suggestion_error: null,
        created_at: 2,
      }),
    );
  }
  for (const [userId, assetId, id] of [
    ["local", asset, "apr_owner_current"],
    ["member", memberAsset, "apr_member_current"],
  ])
    db.exec(
      insert("asset_processing_heads", {
        user_id: userId,
        asset_id: assetId,
        processing_id: id,
      }),
    );
  for (const [userId, id, field, value, decision] of [
    ["local", "apr_owner_current", "summary", "", "accepted"],
    ["local", "apr_owner_current", "tag", "ghost-owner", "dismissed"],
    ["local", "apr_owner_old", "tag", "obsolete-ghost", "dismissed"],
    ["member", "apr_member_current", "title", "", "accepted"],
    ["member", "apr_member_current", "tag", "ghost-member", "dismissed"],
  ])
    db.exec(
      insert("asset_suggestion_decisions", {
        user_id: userId,
        processing_id: id,
        field,
        value,
        decision,
        created_at: 2,
      }),
    );
  db.exec(
    insert("asset_processing_admissions", {
      processing_id: "apr_deleted_original",
      user_id: "member",
      created_at: Math.floor(Date.now() / 1000),
      attempts: 3,
      lease_token: "source-deleted-lease",
      lease_until: 9999999999,
    }),
  );
  db.exec(
    insert("asset_vector_pending", {
      namespace: "a:source-vector-base",
      user_id: "local",
      processing_id: "apr_owner_current",
      asset_id: asset,
      chunk: 0,
      stamp: "f".repeat(64),
      mutation_id: "source-accepted-not-visibility",
      next_attempt_at: 9999999999,
    }),
  );
  db.exec(
    insert("asset_drain_state", {
      namespace: "a:source-vector-base",
      after_user_id: "member",
      lease_token: "source-drain-lease",
      lease_until: 9999999999,
    }),
  );
}

function dump(db) {
  return TABLES.map(
    (name) =>
      `${db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(name).sql};\n${db
        .prepare(`SELECT * FROM "${name}"`)
        .all()
        .map((row) => insert(name, row))
        .join("\n")}`,
  ).join("\n");
}

function orderedRows(rows) {
  return rows
    .map((row) => ({ ...row }))
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

async function reviewApplication() {
  const output = await build({
    entryPoints: [resolve("app/concepts/memory-review.ts")],
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    alias: { "~": resolve("app") },
  });
  return import(
    `data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`
  );
}

function scratchDatabase(db) {
  function prepare(sql, values = []) {
    return {
      bind: (...args) => prepare(sql, args),
      first: async () => db.prepare(sql).get(...values) ?? null,
      all: async () => ({ results: db.prepare(sql).all(...values) }),
      run: async () => db.prepare(sql).run(...values),
    };
  }
  return {
    prepare,
    batch: async (statements) => {
      const results = [];
      for (const statement of statements) results.push(await statement.run());
      return results;
    },
  };
}

/** Shared by the scratch serializer test and the real Wrangler restore drill. */
async function assertRestoredTodoGraph(
  query,
  source,
  batch = async (sql) => Promise.all(sql.map(query)),
) {
  const graph =
    "SELECT * FROM todo_relations ORDER BY user_id,from_todo_id,to_todo_id,kind";
  const sourceFences = source
    .prepare("SELECT * FROM todo_relation_fences ORDER BY user_id")
    .all();
  const [edges, blocked, done, parents, prerequisites, fences, ...oldGuards] =
    await batch([
      graph,
      "SELECT blocked_on FROM todos WHERE todo_id='tdo_blocked'",
      "SELECT state FROM todos WHERE todo_id='tdo_done'",
      "SELECT from_todo_id FROM todo_relations r JOIN todos t ON t.todo_id=r.to_todo_id AND t.user_id=r.user_id WHERE r.kind='parent' AND r.to_todo_id='tdo_done' ORDER BY from_todo_id",
      "SELECT r.to_todo_id FROM todo_relations r JOIN todos t ON t.todo_id=r.to_todo_id AND t.user_id=r.user_id WHERE r.from_todo_id='tdo_blocked' AND r.kind='depends-on' AND t.state <> 'done'",
      "SELECT * FROM todo_relation_fences ORDER BY user_id",
      ...sourceFences.map(
        (original) =>
          `SELECT user_id FROM todo_relation_fences WHERE user_id=${literal(original.user_id)} AND token=${literal(original.token)}`,
      ),
    ]);
  assert.deepEqual(
    JSON.parse(JSON.stringify(edges)),
    JSON.parse(JSON.stringify(source.prepare(graph).all())),
  );
  assert.equal(blocked[0].blocked_on, "Owner approval remains outstanding");
  assert.equal(done[0].state, "done");
  assert.deepEqual(parents, [
    { from_todo_id: "tdo_blocked" },
    { from_todo_id: "tdo_claim" },
  ]);
  // There is still an unfinished structured prerequisite. Backup transformations
  // do not complete it, unblock the dependent, or collapse its children to steps.
  assert.deepEqual(prerequisites, [{ to_todo_id: "tdo_claim" }]);
  assert.equal(fences.length, 2);
  for (const fence of fences) {
    const original = source
      .prepare("SELECT * FROM todo_relation_fences WHERE user_id=?")
      .get(fence.user_id);
    assert.deepEqual(fence, restoredRow("todo_relation_fences", original));
    assert.notEqual(fence.token, original.token);
    assert.match(fence.token, /^recovery:[a-f0-9]{64}$/);
    assert.deepEqual(
      oldGuards[sourceFences.findIndex((row) => row.user_id === fence.user_id)],
      [],
    );
  }
}

test("fresh schema restore retains authoritative rows and review decisions without credentials, leases or inference consent", async (t) => {
  const network = t.mock.method(globalThis, "fetch", async () => {
    throw new Error(
      "Recovery must not invoke inference or transmit restored evidence",
    );
  });
  const { db, schema } = await fixture({ embeddedNul: true });
  const fresh = openDump(schema.map((m) => m.sql).join("\n"));
  try {
    checkTables(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all()
        .map((r) => r.name),
    );
    assert.throws(
      () => checkTables([...TABLES, "unclassified_new_table"]),
      /Unclassified/,
    );
    fresh.exec(await recoverySql(db, schema));
    assert.equal(
      network.mock.callCount(),
      0,
      "restore must not make provider requests",
    );
    await assertRestoredTodoGraph(
      async (sql) => JSON.parse(JSON.stringify(fresh.prepare(sql).all())),
      db,
    );
    for (const table of TABLES) {
      const rows = db.prepare(`SELECT * FROM "${table}"`).all();
      const actual = fresh.prepare(`SELECT * FROM "${table}"`).all();
      assert.deepEqual(
        orderedRows(actual),
        orderedRows(rows.map((row) => restoredRow(table, row))),
        table,
      );
    }
    for (const table of [
      "sessions",
      "bearer_tokens",
      "invites",
      "vector_pending",
      "builtin_skill_sync",
      "asset_drain_state",
      "asset_vector_pending",
    ])
      assert.equal(
        fresh.prepare(`SELECT count(*) AS n FROM ${table}`).get().n,
        0,
      );
    assert.equal(
      fresh.prepare("SELECT body FROM memory_revisions").get().body,
      "original historic text",
    );
    assert.equal(
      fresh.prepare("SELECT COUNT(*) AS n FROM source_revision_assets").get().n,
      2,
    );
    assert.equal(
      fresh
        .prepare(
          "SELECT fencing_token,lease_expires_at FROM todos WHERE todo_id='tdo_claim'",
        )
        .get().fencing_token,
      42,
    );
    assert.equal(
      fresh
        .prepare("SELECT lease_expires_at FROM todos WHERE todo_id='tdo_claim'")
        .get().lease_expires_at,
      0,
    );
    const hits = fresh.prepare(
      "SELECT d.doc_key FROM search_docs_fts f JOIN search_docs d ON d.id=f.rowid WHERE search_docs_fts MATCH 'sandpiper' AND d.user_id=? ORDER BY d.doc_key",
    );
    assert.deepEqual(
      hits.all("member").map((r) => r.doc_key),
      ["memory:mem_foreign", "skill:skl_member", "todo:tdo_member"],
    );
    assert.equal(hits.all("local").length, 8);
    assert.deepEqual(fresh.prepare("PRAGMA foreign_key_check").all(), []);
    assert.deepEqual(originals(fresh), originals(db));
    assertProcessingRecovery(fresh);
    for (const user of ["local", "member"]) {
      const settings = fresh
        .prepare("SELECT * FROM memory_review_settings WHERE user_id=?")
        .get(user);
      const previous = db
        .prepare("SELECT * FROM memory_review_settings WHERE user_id=?")
        .get(user);
      assert.equal(
        settings.enabled,
        0,
        "restored evidence needs new transmission consent",
      );
      assert.equal(
        settings.overnight,
        0,
        "nightly charges need a separate fresh opt-in",
      );
      assert.equal(
        settings.auto_apply,
        0,
        "applying without asking needs the same fresh opt-in",
      );
      assert.equal(settings.lock_token, null);
      assert.equal(settings.lock_until, 0);
      assert.equal(settings.next_run_at, 0);
      assert.equal(settings.model, previous.model);
      assert.equal(settings.daily_calls, previous.daily_calls);
      assert.equal(settings.daily_microusd, previous.daily_microusd);
      const ranking = fresh
        .prepare("SELECT * FROM memory_review_ranking WHERE user_id=?")
        .get(user);
      const priorRanking = db
        .prepare("SELECT * FROM memory_review_ranking WHERE user_id=?")
        .get(user);
      assert.equal(
        ranking.enabled,
        0,
        "restored ranking needs independent fresh consent",
      );
      assert.equal(
        ranking.revision,
        priorRanking.revision + 1,
        "stale pre-backup forms cannot re-enable ranking",
      );
      assert.equal(ranking.manual_model, null);
      assert.equal(ranking.destination, priorRanking.destination);
      assert.equal(priorRanking.enabled, 1);
      assert.deepEqual(
        fresh
          .prepare(
            "SELECT * FROM memory_review_ranking_budgets WHERE user_id=?",
          )
          .all(user),
        db
          .prepare(
            "SELECT * FROM memory_review_ranking_budgets WHERE user_id=?",
          )
          .all(user),
        "ranking reservations are never refunded by restore",
      );
      assert.equal(
        previous.enabled,
        1,
        "capture/recovery must not mutate source consent",
      );
    }
    const inference = t.mock.fn(async () => {
      throw new Error(
        "Restored inbox execution must stay off until fresh user consent",
      );
    });
    const application = await reviewApplication();
    assert.equal(
      application.DEFAULT_REVIEW_SETTINGS.model,
      "anthropic/claude-haiku-5.5",
    );
    assert.deepEqual(
      await application.readReviewSettings(
        scratchDatabase(fresh),
        "new-settings-owner",
      ),
      application.DEFAULT_REVIEW_SETTINGS,
    );
    assert.equal(
      fresh
        .prepare(
          "SELECT model FROM memory_review_settings WHERE user_id='local'",
        )
        .get().model,
      "anthropic/claude-haiku-5.5",
    );
    assert.equal(
      fresh
        .prepare(
          "SELECT model FROM memory_review_settings WHERE user_id='member'",
        )
        .get().model,
      "@cf/meta/llama-3.2-3b-instruct",
    );
    const bindings = {
      DB: scratchDatabase(fresh),
      AI: { run: inference },
      OPENROUTER_API_KEY: "synthetic-not-a-real-key",
    };
    // Exercise the real manual/nightly entry points with both providers present,
    // not merely an unconfigured-provider early return. No private/live calls.
    for (const user of ["local", "member"])
      assert.equal(
        (await application.runMemoryReview(bindings, user)).stopped,
        "off",
      );
    assert.deepEqual(await application.overnightMemoryReview(bindings), {
      users: 0,
      calls: 0,
      applied: 0,
      failed: 0,
    });
    assert.equal(inference.mock.callCount(), 0);
    assert.equal(network.mock.callCount(), 0);
    assert.deepEqual(
      orderedRows(fresh.prepare("SELECT * FROM memory_review_sources").all()),
      orderedRows(db.prepare("SELECT * FROM memory_review_sources").all()),
      "derived source history is rebuilt from restored snapshots",
    );
    assert.ok(
      fresh.prepare("SELECT COUNT(*) AS n FROM memory_review_sources").get().n >
        0,
    );
    for (const table of ["memory_subjects", "memory_subject_members"])
      assert.deepEqual(
        fresh.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).all(),
        `${table} identity, tenant and membership survive restore`,
      );
    for (const state of ["dismissed", "noop", "proposal", "accepted", "failed"])
      assert.deepEqual(
        fresh
          .prepare("SELECT * FROM memory_review_groups WHERE group_id=?")
          .get(`mrg_${state}`),
        db
          .prepare("SELECT * FROM memory_review_groups WHERE group_id=?")
          .get(`mrg_${state}`),
        `${state} decision, model draft, fingerprint and evidence survive unchanged`,
      );
    const interrupted = fresh
      .prepare(
        "SELECT * FROM memory_review_groups WHERE group_id='mrg_running'",
      )
      .get();
    assert.equal(interrupted.state, "failed");
    assert.equal(interrupted.model, "anthropic/claude-haiku-5.5");
    assert.equal(
      interrupted.attempts,
      1,
      "a spent attempt is not refunded or silently retried",
    );
    assert.equal(interrupted.retry_at, 0);
    assert.match(
      interrupted.error,
      /Prior synthetic provider refusal; Interrupted review/,
    );
    assert.match(interrupted.error, /Enable reviews explicitly/);
    assert.equal(
      db
        .prepare(
          "SELECT state FROM memory_review_groups WHERE group_id='mrg_running'",
        )
        .get().state,
      "running",
    );
    assert.deepEqual(
      fresh
        .prepare(
          "SELECT memory_id,user_id,enqueued_at FROM memory_review_pending ORDER BY memory_id",
        )
        .all(),
      db
        .prepare(
          "SELECT memory_id,user_id,enqueued_at FROM memory_review_pending ORDER BY memory_id",
        )
        .all(),
      "restore retains exact bounded review progress, not a corpus requeue",
    );
    assert.equal(
      fresh.prepare("SELECT COUNT(*) AS n FROM memory_review_events").get().n,
      3,
    );
    assert.equal(
      fresh
        .prepare(
          "SELECT reserved_microusd FROM memory_review_budgets WHERE user_id='local'",
        )
        .get().reserved_microusd,
      7777,
    );
    for (const text of ["quote ' unicode 袋\nsecond line", "NUL\0byte"])
      assert.equal(
        fresh.prepare(`SELECT hex(${literal(text)}) AS value`).get().value,
        Buffer.from(text).toString("hex").toUpperCase(),
      );
    assert.equal(
      fresh
        .prepare(
          "SELECT hex(description) AS value FROM memory_subjects WHERE subject_id='sub_a'",
        )
        .get().value,
      Buffer.from("NUL\0byte").toString("hex").toUpperCase(),
      "restored text retains bytes after NUL despite node:sqlite truncating decoded TEXT",
    );
  } finally {
    db.close();
    fresh.close();
  }
});

function assertProcessingRecovery(db) {
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM asset_processing WHERE state IN ('queued','running') OR lease_token IS NOT NULL OR lease_until <> 0",
      )
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM asset_processing WHERE state='failed' AND error_code='restored_interrupted' AND finished_at IS NULL",
      )
      .get().n,
    2,
  );
  assert.equal(
    db
      .prepare(
        "SELECT attempts FROM asset_processing_admissions WHERE processing_id='apr_deleted_original'",
      )
      .get().attempts,
    3,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM asset_processing_admissions WHERE lease_token IS NOT NULL OR lease_until <> 0",
      )
      .get().n,
    0,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM asset_suggestion_decisions WHERE decision='dismissed'",
      )
      .get().n,
    3,
  );
  assert.equal(
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM asset_suggestion_decisions WHERE decision='accepted'",
      )
      .get().n,
    2,
  );
  const lexical = db.prepare(
    "SELECT d.doc_key FROM search_docs_fts f JOIN search_docs d ON d.id=f.rowid WHERE search_docs_fts MATCH ? AND d.user_id=?",
  );
  assert.deepEqual(
    lexical.all("lithicriver", "local").map((row) => row.doc_key),
    [`asset:${asset}`],
  );
  assert.deepEqual(lexical.all("lithicriver", "member"), []);
  assert.deepEqual(
    lexical.all("cobaltcoral", "member").map((row) => row.doc_key),
    [`asset:${memberAsset}`],
  );
  assert.deepEqual(lexical.all("cobaltcoral", "local"), []);
  assert.deepEqual(lexical.all("obsoleteownerextract", "local"), []);
  assert.equal(
    db
      .prepare(
        "SELECT text FROM asset_processing_outputs WHERE processing_id='apr_owner_old'",
      )
      .get().text,
    "obsoleteownerextract prior immutable text",
  );
  assert.equal(
    db.prepare("SELECT description FROM assets WHERE asset_id=?").get(asset)
      .description,
    "Owner accepted summary",
  );
  assert.equal(
    db.prepare("SELECT title FROM assets WHERE asset_id=?").get(memberAsset)
      .title,
    "Member original",
  );
}

test("processing recovery refuses corrupted owner/checksum/decision/budget provenance instead of dropping history", async () => {
  for (const mutation of [
    "UPDATE asset_processing_outputs SET user_id='member' WHERE processing_id='apr_owner_current'",
    "UPDATE asset_processing_outputs SET original_sha256='wrong' WHERE processing_id='apr_owner_current'",
    "UPDATE asset_processing_heads SET user_id='member' WHERE processing_id='apr_owner_current'",
    "UPDATE asset_suggestion_decisions SET user_id='member' WHERE processing_id='apr_owner_current'",
    "UPDATE asset_processing_admissions SET attempts=3 WHERE processing_id='apr_owner_current'",
  ]) {
    const { db, schema } = await fixture();
    try {
      db.exec(mutation);
      await assert.rejects(recoverySql(db, schema), /inconsistent ownership/);
    } finally {
      db.close();
    }
  }
});

test("atomic capture, retention, failure status, stale age, locks, integrity and source guards", async () => {
  const root = await mkdtemp(join(tmpdir(), "valise-backup-unit-"));
  const { db, schema } = await fixture();
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify(configFor("source")));
  const backupRoot = join(root, "backups");
  const run = async (args) => {
    if (args.includes("SELECT name FROM d1_migrations ORDER BY name"))
      return JSON.stringify([
        { results: schema.map(({ name }) => ({ name })) },
      ]);
    if (args[0] === "d1" && args[1] === "execute")
      return JSON.stringify([{ results: TABLES.map((name) => ({ name })) }]);
    if (args[0] === "d1") {
      await writeFile(args[args.indexOf("--output") + 1], dump(db));
      return "";
    }
    await writeFile(args[args.indexOf("--file") + 1], bytesFor(args[3]));
    return "";
  };
  try {
    await capture({
      root: backupRoot,
      config,
      target: "--local",
      keep: 1,
      run,
    });
    let report = await status(backupRoot);
    assert.equal(report.healthy, true);
    const first = report.snapshot;
    assert.equal(
      (await status(backupRoot, 26, Date.now() + 27 * 3600_000)).healthy,
      false,
    );
    await assert.rejects(
      capture({
        root: backupRoot,
        config,
        target: "--local",
        keep: 1,
        run: async () => {
          throw new Error("synthetic provider failure");
        },
      }),
      /synthetic/,
    );
    report = await status(backupRoot);
    assert.equal(report.state, "failed");
    assert.equal(report.snapshot, first);
    await verifySnapshot(join(backupRoot, first));
    await capture({
      root: backupRoot,
      config,
      target: "--local",
      keep: 1,
      run,
    });
    report = await status(backupRoot);
    assert.notEqual(report.snapshot, first);
    assert.equal(
      (await readdir(backupRoot)).filter((name) => name.startsWith("snapshot-"))
        .length,
      1,
    );
    const snapshot = join(backupRoot, report.snapshot);
    await assert.rejects(
      restore({
        dir: snapshot,
        config,
        target: "--remote",
        confirmation: "recovery-source",
        run,
      }),
      /new worker/,
    );
    const newConfig = join(root, "new.json");
    await writeFile(newConfig, JSON.stringify(configFor("destination")));
    await assert.rejects(
      enqueueAssetVectors({
        dir: snapshot,
        config: newConfig,
        target: "--remote",
        confirmation: "recovery-destination",
        namespace: "source-vector-base",
        run: async () => {
          throw new Error("D1 must not be called");
        },
      }),
      /reuse the source vector namespace/,
    );
    for (const changes of [
      { vars: { VALISE_RERANK: "hybrid" } },
      {
        vars: {
          VALISE_RERANK: "off",
          VALISE_VECTOR_NAMESPACE: "already-enabled",
        },
      },
      {
        vectorize: [{ binding: "VECTOR_INDEX", index_name: "attached-index" }],
      },
    ]) {
      const unsafe = join(root, "unsafe.json");
      await writeFile(
        unsafe,
        JSON.stringify({ ...configFor("destination"), ...changes }),
      );
      await assert.rejects(
        enqueueAssetVectors({
          dir: snapshot,
          config: unsafe,
          target: "--remote",
          confirmation: "recovery-destination",
          namespace: "fresh-assets-v1",
          run: async () => {
            throw new Error("D1 must not be called");
          },
        }),
        /lexical\/off mode/,
      );
    }
    await assert.rejects(
      restore({
        dir: snapshot,
        config: newConfig,
        target: "--remote",
        confirmation: "wrong",
        run,
      }),
      /Confirm/,
    );
    await assert.rejects(
      restore({
        dir: snapshot,
        config: newConfig,
        target: "--remote",
        confirmation: "recovery-destination",
        run,
      }),
      /uninitialized/,
    );
    await mkdir(join(backupRoot, ".backup-lock"));
    assert.equal((await status(backupRoot)).healthy, false);
    await assert.rejects(
      capture({ root: backupRoot, config, target: "--local", run }),
      /EEXIST/,
    );
    await rm(join(backupRoot, ".backup-lock"), { recursive: true });
    await assert.rejects(
      capture({ root: backupRoot, config: newConfig, target: "--local", run }),
      /another installation/,
    );
    const manifest = await verifySnapshot(snapshot);
    await writeFile(
      join(snapshot, manifest.originals[0].file),
      "corrupted original",
    );
    await assert.rejects(verifySnapshot(snapshot), /checksum mismatch/);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("restore retries a transient R2 failure, never a D1 import, and still checks every original", async () => {
  const root = await mkdtemp(join(tmpdir(), "valise-backup-retry-"));
  const { db, schema } = await fixture();
  const config = join(root, "config.json");
  await writeFile(config, JSON.stringify(configFor("source")));
  const destination = join(root, "destination.json");
  await writeFile(destination, JSON.stringify(configFor("destination")));
  const backupRoot = join(root, "backups");
  const source = async (args) => {
    if (args.includes("SELECT name FROM d1_migrations ORDER BY name"))
      return JSON.stringify([
        { results: schema.map(({ name }) => ({ name })) },
      ]);
    if (args[0] === "d1" && args[1] === "execute")
      return JSON.stringify([{ results: TABLES.map((name) => ({ name })) }]);
    if (args[0] === "d1") {
      await writeFile(args[args.indexOf("--output") + 1], dump(db));
      return "";
    }
    await writeFile(args[args.indexOf("--file") + 1], bytesFor(args[3]));
    return "";
  };
  /** A fresh destination: empty D1, an R2 bucket kept in memory. */
  const fresh = ({ failPuts = 0, failImport = false } = {}) => {
    const bucket = new Map();
    const calls = { put: 0, get: 0, import: 0, waits: [] };
    const run = async (args) => {
      if (args[0] === "r2" && args[2] === "put") {
        calls.put++;
        if (calls.put <= failPuts)
          throw new Error("Wrangler r2 object failed (1)");
        bucket.set(args[3], await readFile(args[args.indexOf("--file") + 1]));
        return "";
      }
      if (args[0] === "r2" && args[2] === "get") {
        calls.get++;
        await writeFile(
          args[args.indexOf("--file") + 1],
          bucket.get(args[3]) ?? "",
        );
        return "";
      }
      if (args[1] === "migrations") return "";
      if (args.includes("--file")) {
        calls.import++;
        if (failImport) throw new Error("Wrangler d1 execute failed (1)");
        return "";
      }
      return JSON.stringify([{ results: [] }]);
    };
    const wait = async (attempt) => {
      calls.waits.push(attempt);
    };
    return { run, wait, calls, bucket };
  };
  try {
    await capture({
      root: backupRoot,
      config,
      target: "--local",
      run: source,
    });
    const dir = join(backupRoot, (await status(backupRoot)).snapshot);
    const manifest = await verifySnapshot(dir);
    const restoreWith = ({ run, wait }) =>
      restore({
        dir,
        config: destination,
        target: "--remote",
        confirmation: "recovery-destination",
        run,
        wait,
      });

    // The first put answers R2's 500; the second lands and reads back.
    const flaky = fresh({ failPuts: 1 });
    const result = await restoreWith(flaky);
    assert.equal(result.originals, manifest.originals.length);
    assert.equal(flaky.calls.put, manifest.originals.length + 1);
    assert.equal(flaky.calls.get, manifest.originals.length);
    assert.deepEqual(flaky.calls.waits, [1]);
    assert.equal(flaky.calls.import, 1);
    for (const original of manifest.originals)
      assert.equal(
        digest(flaky.bucket.get(`recovery-destination/${original.key}`)),
        original.sha256,
      );

    // A put that keeps failing stops after four attempts, before any rows.
    const down = fresh({ failPuts: Infinity });
    await assert.rejects(restoreWith(down), /failed \(1\) after 4 attempts/);
    assert.equal(down.calls.put, 4);
    assert.deepEqual(down.calls.waits, [1, 2, 3]);
    assert.equal(down.calls.import, 0);

    // The SQL import is not idempotent, so a failed one is not repeated.
    const broken = fresh({ failImport: true });
    await assert.rejects(restoreWith(broken), /d1 execute failed/);
    assert.equal(broken.calls.import, 1);
    assert.deepEqual(broken.calls.waits, []);
  } finally {
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

function configFor(name) {
  return {
    name: `recovery-${name}`,
    compatibility_date: "2026-07-14",
    d1_databases: [
      {
        binding: "DB",
        database_name: `recovery-${name}`,
        database_id:
          name === "source"
            ? "00000000-0000-4000-8000-000000000001"
            : "00000000-0000-4000-8000-000000000002",
        migrations_dir: resolve("drizzle"),
      },
    ],
    r2_buckets: [
      { binding: "BUNDLES", bucket_name: `recovery-${name}` },
      ...(name === "source"
        ? [{ binding: "BACKUPS", bucket_name: "recovery-backups" }]
        : []),
    ],
    kv_namespaces: [
      {
        binding: "OAUTH_KV",
        id: name === "source" ? "0".repeat(32) : "1".repeat(32),
      },
    ],
    vars: {
      VALISE_RERANK: "lexical",
      VALISE_VECTOR_NAMESPACE: name === "source" ? "source-vector-base" : "",
    },
  };
}

/** Migrate the source D1 and load the fixture's rows and originals. */
async function seedSource({ wrangler, stage, root, config, db }) {
  await stage("source-migrations", () =>
    wrangler([
      "d1",
      "migrations",
      "apply",
      "DB",
      "--config",
      config,
      "--local",
    ]),
  );
  const seed = join(root, "seed.sql");
  const sourceRows = TABLES.flatMap((table) => [
    ...beforeTableRestore(table),
    ...db
      .prepare(`SELECT * FROM ${table}`)
      .all()
      .map((row) => insert(table, row)),
  ]);
  for (const table of ["asset_vector_pending", "asset_drain_state"])
    sourceRows.push(
      ...db
        .prepare(`SELECT * FROM ${table}`)
        .all()
        .map((row) => insert(table, row)),
    );
  await writeFile(
    seed,
    `PRAGMA defer_foreign_keys=TRUE;\n${sourceRows.join("\n")}`,
  );
  await stage("source-seed", () =>
    wrangler([
      "d1",
      "execute",
      "DB",
      "--config",
      config,
      "--local",
      "--file",
      seed,
    ]),
  );
  await stage("source-originals", async () => {
    for (const original of originals(db)) {
      const file = join(root, "upload");
      await writeFile(file, bytesFor(original.key));
      await wrangler([
        "r2",
        "object",
        "put",
        `recovery-source/${original.key}`,
        "--config",
        config,
        "--local",
        "--file",
        file,
      ]);
    }
  });
}

/** The restored D1 matches the fixture under the documented transformations. */
async function assertRestored({ wrangler, stage, root, destination, db }) {
  const batch = (statements) =>
    readD1Batch(wrangler, destination, root, statements);
  const query = async (sql) => (await batch([sql]))[0];
  await stage("restored-assertions", async () => {
    const lexicalCases = [
      ["lithicriver", "local", asset],
      ["cobaltcoral", "member", memberAsset],
    ];
    const [hits, processing, pending, drain, ...lexical] = await batch([
      "SELECT d.doc_key,d.user_id FROM search_docs_fts f JOIN search_docs d ON d.id=f.rowid WHERE search_docs_fts MATCH 'sandpiper' AND d.user_id='member' ORDER BY d.doc_key",
      "SELECT COUNT(*) AS n FROM asset_processing WHERE state IN ('queued','running') OR lease_token IS NOT NULL OR lease_until <> 0",
      "SELECT COUNT(*) AS n FROM asset_vector_pending",
      "SELECT COUNT(*) AS n FROM asset_drain_state",
      ...lexicalCases.flatMap(([term, userId]) => [
        `SELECT d.doc_key FROM search_docs_fts f JOIN search_docs d ON d.id=f.rowid WHERE search_docs_fts MATCH ${literal(term)} AND d.user_id=${literal(userId)}`,
        `SELECT d.doc_key FROM search_docs_fts f JOIN search_docs d ON d.id=f.rowid WHERE search_docs_fts MATCH ${literal(term)} AND d.user_id=${literal(userId === "local" ? "member" : "local")}`,
      ]),
    ]);
    await assertRestoredTodoGraph(query, db, batch);
    assert.deepEqual(
      hits.map((r) => r.doc_key),
      ["memory:mem_foreign", "skill:skl_member", "todo:tdo_member"],
    );
    const tables = await batch(TABLES.map((table) => `SELECT * FROM ${table}`));
    for (const [index, table] of TABLES.entries()) {
      const actual = tables[index];
      assert.deepEqual(
        orderedRows(actual),
        orderedRows(
          db
            .prepare(`SELECT * FROM ${table}`)
            .all()
            .map((r) => restoredRow(table, r)),
        ),
        table,
      );
    }
    assert.equal(processing[0].n, 0);
    assert.equal(pending[0].n, 0);
    assert.equal(drain[0].n, 0);
    for (const [index, [, , expected]] of lexicalCases.entries()) {
      const own = lexical[index * 2];
      assert.deepEqual(
        own.map((row) => row.doc_key),
        [`asset:${expected}`],
      );
      assert.deepEqual(lexical[index * 2 + 1], []);
    }
  });
  return { batch, query };
}

/** Every original reads back from the destination bucket with its checksum. */
async function assertRestoredOriginals({
  wrangler,
  stage,
  root,
  destination,
  db,
}) {
  await stage("destination-originals", async () => {
    for (const original of originals(db)) {
      const file = join(root, "download");
      await wrangler([
        "r2",
        "object",
        "get",
        `recovery-destination/${original.key}`,
        "--config",
        destination,
        "--local",
        "--file",
        file,
      ]);
      assert.equal(digest(await readFile(file)), original.sha256);
    }
  });
}

test("Wrangler fresh-install drill: D1 export + original R2 bytes → new D1/R2, checksums and FTS", {
  timeout: 360_000,
}, async (t) => {
  const runtime = drillRunner(t.signal);
  const { run: wrangler, stage } = runtime;
  const root = await mkdtemp(join(tmpdir(), "valise-recovery-drill-"));
  const { db } = await fixture();
  try {
    const config = join(root, "source", "wrangler.json");
    const destination = join(root, "destination", "wrangler.json");
    for (const [path, name] of [
      [config, "source"],
      [destination, "destination"],
    ]) {
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify(configFor(name)));
    }
    await seedSource({ wrangler, stage, root, config, db });
    const backupRoot = join(root, "backups");
    await stage("capture", () =>
      capture({ root: backupRoot, config, target: "--local", run: wrangler }),
    );
    const snapshot = join(backupRoot, (await status(backupRoot)).snapshot);
    const result = await stage("restore", () =>
      restore({
        dir: snapshot,
        config: destination,
        target: "--local",
        confirmation: "recovery-destination",
        run: wrangler,
      }),
    );
    assert.equal(result.search, "rebuilt");
    assert.equal(result.originals, 4);
    assert.match(result.memoryReviews, /^disabled;/);
    const { batch, query } = await assertRestored({
      wrangler,
      stage,
      root,
      destination,
      db,
    });
    const enqueued = await stage("enqueue", () =>
      enqueueAssetVectors({
        dir: snapshot,
        config: destination,
        target: "--local",
        confirmation: "recovery-destination",
        namespace: "restored-assets-v1",
        run: wrangler,
      }),
    );
    assert.equal(enqueued.outputs, 2);
    assert.equal(enqueued.delivered, false);
    assert.equal(enqueued.visibilityVerified, false);
    const vectorRows = await query(
      "SELECT namespace,user_id,processing_id,stamp,mutation_id,attempts,lease_until FROM asset_vector_pending ORDER BY user_id",
    );
    assert.equal(vectorRows.length, 2);
    for (const row of vectorRows) {
      assert.equal(row.namespace, "a:restored-assets-v1");
      assert.equal(row.mutation_id, null);
      assert.equal(row.attempts, 0);
      assert.equal(row.lease_until, 0);
      assert.notEqual(row.stamp, "f".repeat(64));
    }
    const repeated = await stage("repeat-enqueue", () =>
      enqueueAssetVectors({
        dir: snapshot,
        config: destination,
        target: "--local",
        confirmation: "recovery-destination",
        namespace: "restored-assets-v1",
        run: wrangler,
      }),
    );
    assert.equal(repeated.queuedChunks, 0);
    assert.equal(
      (await query("SELECT COUNT(*) AS n FROM asset_vector_pending"))[0].n,
      2,
    );
    const unchangedTables = [
      "assets",
      "asset_processing",
      "asset_processing_outputs",
      "asset_processing_heads",
      "asset_suggestion_decisions",
      "asset_processing_admissions",
    ];
    const unchanged = await batch(
      unchangedTables.map((table) => `SELECT * FROM ${table}`),
    );
    for (const [index, table] of unchangedTables.entries())
      assert.deepEqual(
        orderedRows(unchanged[index]),
        orderedRows(
          db
            .prepare(`SELECT * FROM ${table}`)
            .all()
            .map((row) => restoredRow(table, row)),
        ),
        table,
      );
    await assertRestoredOriginals({ wrangler, stage, root, destination, db });
    await assert.rejects(
      restore({
        dir: snapshot,
        config: destination,
        target: "--local",
        confirmation: "recovery-destination",
        run: wrangler,
      }),
      /fresh config-relative/,
    );
    console.log(
      `Recovery drill: ${TABLES.length} classified recovery tables, two tenants, parent/dependency graph + retained manual blocker + invalidated operation tokens, historical bundle + asset originals + unregistered attachment, immutable processing history, accepted/dismissed decisions, spent admissions, review decisions/coverage/progress with opt-ins reset, checksums, tenant FTS and provider-free fresh vector enqueue verified; no remote resources used.`,
    );
  } finally {
    await runtime.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Workflow drill: the scheduled backup's R2 snapshot pulls, verifies and restores into fresh D1/R2", {
  timeout: 360_000,
}, async (t) => {
  const runtime = drillRunner(t.signal);
  const { run: wrangler, stage } = runtime;
  const root = await mkdtemp(join(tmpdir(), "valise-workflow-drill-"));
  const { db } = await fixture();
  try {
    const config = join(root, "source", "wrangler.json");
    const destination = join(root, "destination", "wrangler.json");
    for (const [path, name] of [
      [config, "source"],
      [destination, "destination"],
    ]) {
      await mkdir(resolve(path, ".."), { recursive: true });
      await writeFile(path, JSON.stringify(configFor(name)));
    }
    await seedSource({ wrangler, stage, root, config, db });
    const startedAt = "2026-10-25T03:23:00.000Z";
    const snapshot = `snapshot-${startedAt.replaceAll(":", "-")}-00000000-0000-4000-8000-0000000000aa`;
    // The Workflow's own step function against the source's local D1/R2, the
    // same persisted state Wrangler --local reads. Steps round-trip through
    // JSON as the Workflow engine stores them.
    const run = await stage("workflow-capture", async () => {
      const { getPlatformProxy } = await import("wrangler");
      const proxy = await getPlatformProxy({
        configPath: config,
        persist: { path: join(root, "source", ".wrangler", "state", "v3") },
      });
      try {
        const { runBackup } = await applicationModule("app/backup/snapshot.ts");
        const names = [];
        const step = {
          async do(name, work) {
            assert.ok(!names.includes(name), `step names are unique: ${name}`);
            names.push(name);
            const value = await work();
            return value === undefined
              ? value
              : JSON.parse(JSON.stringify(value));
          },
          async sleep() {},
        };
        const result = await runBackup(
          proxy.env,
          step,
          { snapshot, startedAt },
          {
            source: backupSource(config),
            migrations: (await migrations()).map(({ name, sha256 }) => ({
              name,
              sha256,
            })),
            keep: 30,
          },
        );
        // Rerunning a published run's steps is a no-op, not a second copy.
        names.length = 0;
        await runBackup(
          proxy.env,
          step,
          { snapshot, startedAt },
          {
            source: backupSource(config),
            migrations: (await migrations()).map(({ name, sha256 }) => ({
              name,
              sha256,
            })),
            keep: 30,
          },
        );
        return result;
      } finally {
        await proxy.dispose();
      }
    });
    assert.equal(run.originals, 4);
    const pulled = join(root, "pulled");
    const result = await stage("pull", () =>
      pull({ snapshot, dir: pulled, config, target: "--local", run: wrangler }),
    );
    assert.equal(result.rehearsed, true);
    const manifest = await verifySnapshot(pulled);
    assert.equal(manifest.target, "worker");
    assert.equal(manifest.source.bucket, "recovery-source");
    assert.deepEqual(
      manifest.originals.map((o) => o.sha256),
      originals(db).map((o) => o.sha256),
    );
    const restored = await stage("restore", () =>
      restore({
        dir: pulled,
        config: destination,
        target: "--local",
        confirmation: "recovery-destination",
        run: wrangler,
      }),
    );
    assert.equal(restored.originals, 4);
    await assertRestored({ wrangler, stage, root, destination, db });
    await assertRestoredOriginals({ wrangler, stage, root, destination, db });
    console.log(
      `Workflow drill: scheduled-backup steps wrote ${TABLES.length} classified tables and 4 originals to local R2; pull verified and rehearsed it; restore into fresh D1/R2 matched rows, tenant FTS and checksums.`,
    );
  } finally {
    await runtime.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});
