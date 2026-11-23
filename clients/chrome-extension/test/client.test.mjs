import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import {
  CAPTURE_SCOPES,
  canAddTodos,
  MAX_BYTES,
  normalizeTags,
  REQUESTED_SCOPES,
  savedMessage,
  TODO_SCOPE,
  ValiseClient,
} from "../client.mjs";
import {
  DEFAULT_ENDPOINT,
  endpointPermission,
  forgetConnection,
  normalizeEndpoint,
  readConnection,
  saveConnection,
} from "../settings.mjs";

const assetId = "asset:ast_00000000-0000-0000-0000-000000000001";
const sourceId = "source:src_00000000-0000-0000-0000-000000000002";
const snapshot = {
  title: "A wren ☀",
  url: "https://example.org/wren",
  html: "<!doctype html><html><body><h1>Wren ☀</h1></body></html>",
  capturedAt: "2026-10-23T12:00:00.000Z",
  resources: [],
  skipped: 0,
};
const todoId = "todo:tdo_00000000-0000-0000-0000-000000000003";
const connection = {
  endpoint: DEFAULT_ENDPOINT,
  token: "test-only-console-token",
};

const resourceId = (n) =>
  `asset:ast_00000000-0000-0000-0000-${String(100 + n).padStart(12, "0")}`;

function server(overrides = {}) {
  const calls = [];
  const begun = new Map();
  let uploads = 0;
  const fetcher = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "error");
    if (init.method === "PUT") {
      const id = `asset:${new URL(url).pathname.slice("/uploads/".length)}`;
      const metadata = begun.get(id);
      assert(metadata, `PUT for an asset that was not begun: ${id}`);
      assert.equal(new URL(url).search, "?token=upload-only");
      assert.equal(init.headers.authorization, undefined);
      assert.equal(init.headers["content-type"], metadata.content_type);
      if (id === assetId)
        assert.deepEqual(init.body, new TextEncoder().encode(snapshot.html));
      const status =
        (metadata.folder
          ? overrides.resourceStatus?.(metadata.file_name)
          : overrides.uploadStatus) || 200;
      if (status !== 200) return new Response(null, { status });
      return Response.json({
        id,
        state: overrides.state || "ready",
        sha256: createHash("sha256").update(init.body).digest("hex"),
        size: init.body.byteLength,
      });
    }
    assert.equal(url, DEFAULT_ENDPOINT);
    assert.equal(init.headers.authorization, `Bearer ${connection.token}`);
    const rpc = JSON.parse(init.body);
    const { name, arguments: args } = rpc.params;
    if (overrides.status)
      return new Response("secret echoed by server", {
        status: overrides.status,
        headers:
          overrides.status === 403
            ? {
                "www-authenticate":
                  overrides.challenge ?? 'Bearer error="insufficient_scope"',
              }
            : {},
      });
    let structuredContent;
    if (name === "upload_asset") {
      const id = uploads++ === 0 ? assetId : resourceId(uploads - 1);
      begun.set(id, args);
      structuredContent = {
        id,
        ...(args.folder ? { folder: args.folder } : {}),
        upload: {
          method: "PUT",
          url:
            (args.folder && overrides.resourceDestination) ||
            overrides.destination ||
            `https://app.valise.run/uploads/${id.slice(6)}?token=upload-only`,
        },
      };
    } else if (name === "save_source" && args.check) {
      structuredContent = {
        saved: overrides.saved ?? [],
        ...(overrides.vocabulary ? { vocabulary: overrides.vocabulary } : {}),
      };
    } else if (name === "save_source") {
      if (overrides.lostSource) throw new Error("Lost response");
      structuredContent = {
        id: sourceId,
        revision: args.expected_revision ? args.expected_revision + 1 : 1,
        ...args,
        assets: (args.asset_ids ?? []).map((id) => ({ id, available: true })),
      };
    } else if (name === "create_todo") {
      structuredContent = overrides.todo ?? {
        id: todoId,
        title: args.title,
        created_at: 1,
        url: `https://app.valise.run/todos?open=${encodeURIComponent(todoId)}`,
      };
    } else assert.fail(`Unexpected tool ${name}`);
    const envelope = {
      jsonrpc: "2.0",
      id: rpc.id,
      result: { structuredContent },
    };
    return overrides.sse
      ? new Response(
          `event: message\r\ndata: ${JSON.stringify(envelope)}\r\n\r\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json(envelope);
  };
  return { calls, fetcher };
}

const tools = (calls) =>
  calls
    .filter(({ init }) => init.method === "POST")
    .map(({ init }) => JSON.parse(init.body).params);

for (const sse of [false, true]) {
  test(`uploads the original and links it with tags (${sse ? "SSE" : "JSON"})`, async () => {
    const { calls, fetcher } = server({ sse });
    const progress = [];
    const saved = await new ValiseClient(connection, fetcher).saveArchive(
      snapshot,
      { tags: [" birds ", "research", "birds"] },
      (message) => progress.push(message),
    );
    assert.deepEqual(saved, {
      assetId,
      sourceId,
      revision: 1,
      article: null,
      authors: [],
      libraryUrl: "https://app.valise.run/library",
      stored: 0,
      missed: 0,
    });
    assert.equal(calls.length, 3);
    const rpc = calls
      .filter(({ init }) => init.method === "POST")
      .map(({ init }) => JSON.parse(init.body).params);
    assert.deepEqual(
      rpc.map(({ name }) => name),
      ["upload_asset", "save_source"],
    );
    assert.deepEqual(rpc[0].arguments.tags, ["birds", "research"]);
    assert.deepEqual(rpc[1].arguments.tags, ["birds", "research"]);
    assert.equal(rpc[0].arguments.project, undefined);
    assert.equal(rpc[1].arguments.project, undefined);
    assert.equal(rpc[0].arguments.size, Buffer.byteLength(snapshot.html));
    assert.equal(
      rpc[0].arguments.sha256,
      createHash("sha256").update(snapshot.html).digest("hex"),
    );
    assert.equal(rpc[0].arguments.content_type, "text/html");
    assert.equal(rpc[0].arguments.expires_in_seconds, undefined);
    assert.match(rpc[0].arguments.description, /inert-dom-v4/);
    assert.match(
      rpc[0].arguments.file_name,
      /^example\.org-[0-9a-f]{12}\.html$/,
    );
    assert.equal(rpc[0].arguments.folder, undefined);
    assert.deepEqual(rpc[1].arguments.asset_ids, [assetId]);
    assert.equal(rpc[1].arguments.kind, "document");
    assert.equal(rpc[1].arguments.url, snapshot.url);
    assert.equal(rpc[1].arguments.notes, undefined); // Do not pretend generated text is user-authored notes.
    assert.deepEqual(progress, ["Uploading the page…", "Saving source…"]);
  });
}

test("limits tags and bytes before creating an upload", async () => {
  assert.deepEqual(normalizeTags([" a ", "a", "", "b"]), ["a", "b"]);
  assert.throws(() => normalizeTags(["x".repeat(101)]), /20 tags/);
  const { calls, fetcher } = server();
  await assert.rejects(
    new ValiseClient(connection, fetcher).saveArchive(snapshot, {
      tags: Array.from({ length: 21 }, (_, i) => `tag${i}`),
    }),
    /20 tags/,
  );
  await assert.rejects(
    new ValiseClient(connection, fetcher).saveArchive(
      { ...snapshot, html: "x".repeat(MAX_BYTES + 1) },
      {},
    ),
    /25 MiB/,
  );
  assert.equal(calls.length, 0);
});

test("authorization errors stop the sequence without reflecting server bodies", async () => {
  assert.deepEqual(CAPTURE_SCOPES, [
    "assets:write",
    "assets:read",
    "sources:write",
  ]);
  assert.deepEqual(REQUESTED_SCOPES, [...CAPTURE_SCOPES, TODO_SCOPE]);
  for (const status of [401, 403]) {
    const { calls, fetcher } = server({ status });
    await assert.rejects(
      new ValiseClient(connection, fetcher).saveArchive(snapshot, {}),
      status === 401 ? /rejected the token/ : /assets:read/,
    );
    assert.equal(calls.length, 1);
  }
  assert.throws(
    () => new ValiseClient({ ...connection, token: "" }),
    /Settings/,
  );
});

test("malformed responses and network errors do not expose reflected secrets", async () => {
  for (const fetcher of [
    async () =>
      new Response("upload-capability-secret invalid-json", {
        headers: { "content-type": "application/json" },
      }),
    async () => {
      throw new Error("network error at ?token=upload-capability-secret");
    },
  ]) {
    await assert.rejects(
      new ValiseClient(connection, fetcher).saveArchive(snapshot, {}),
      (error) => {
        assert(!error.message.includes("upload-capability-secret"));
        return true;
      },
    );
  }
});

test("rejects cross-origin and mismatched transfer URLs before sending bytes", async () => {
  for (const destination of [
    "https://evil.example/uploads/x",
    "https://app.valise.run/not-an-upload",
    `https://user:password@app.valise.run/uploads/${assetId.slice(6)}`,
  ]) {
    const { calls, fetcher } = server({ destination });
    await assert.rejects(
      new ValiseClient(connection, fetcher).saveArchive(snapshot, {}),
      /unexpected upload destination/,
    );
    assert.equal(calls.length, 1);
  }
});

test("transfer/finalization failures never create bookmark-only sources", async () => {
  for (const overrides of [{ uploadStatus: 413 }, { state: "pending" }]) {
    const { calls, fetcher } = server(overrides);
    await assert.rejects(
      new ValiseClient(connection, fetcher).saveArchive(snapshot, {}),
      /No source was saved/,
    );
    assert(
      !calls.some(({ init }) =>
        init.body instanceof Uint8Array
          ? false
          : JSON.parse(init.body).params.name === "save_source",
      ),
    );
  }
});

test("a lost source response warns about the existing original, without replay", async () => {
  const { calls, fetcher } = server({ lostSource: true });
  await assert.rejects(
    new ValiseClient(connection, fetcher).saveArchive(snapshot, {}),
    /original is in Library.*source may already exist/,
  );
  assert.equal(calls.length, 3);
});

test("saves a selection as a reference source with the page URL and context", async () => {
  const { calls, fetcher } = server();
  const selection = {
    title: "A wren ☀",
    url: "https://example.org/wren#private-fragment",
    quote: "A selected sentence.",
    contextBefore: "Text before.",
    contextAfter: "Text after.",
  };
  const saved = await new ValiseClient(connection, fetcher).saveHighlight(
    selection,
    { tags: [" birds ", "research", "birds"], project: " coast " },
  );
  assert.deepEqual(saved, {
    sourceId,
    libraryUrl: "https://app.valise.run/library",
  });
  const rpc = calls.map(({ init }) => JSON.parse(init.body).params);
  assert.deepEqual(
    rpc.map(({ name }) => name),
    ["save_source"],
  );
  assert.equal(rpc[0].arguments.kind, "reference");
  assert.equal(rpc[0].arguments.url, "https://example.org/wren");
  assert.equal(rpc[0].arguments.title, "A wren ☀ — Highlight");
  assert.deepEqual(rpc[0].arguments.tags, ["birds", "research"]);
  assert.equal(rpc[0].arguments.project, "coast");
  assert.match(rpc[0].arguments.notes, /A selected sentence\./);
  assert.match(rpc[0].arguments.notes, /Context before:\nText before\./);
  assert.match(rpc[0].arguments.notes, /Context after:\nText after\./);
});

test("refuses empty or oversized highlights before contacting Valise", async () => {
  const { calls, fetcher } = server();
  const client = new ValiseClient(connection, fetcher);
  await assert.rejects(
    client.saveHighlight({ ...snapshot, quote: "  " }, {}),
    /Select text/,
  );
  await assert.rejects(
    client.saveHighlight({ ...snapshot, quote: "x".repeat(20_001) }, {}),
    /Select text/,
  );
  assert.equal(calls.length, 0);
});

function browser(granted = true) {
  const state = {};
  const grants = new Set();
  const removed = [];
  const local = {
    setAccessLevel: async (value) =>
      assert.deepEqual(value, { accessLevel: "TRUSTED_CONTEXTS" }),
    get: async () => state,
    set: async (values) => Object.assign(state, values),
    remove: async (key) => {
      delete state[key];
    },
  };
  return {
    grants,
    removed,
    storage: {
      local,
      get sync() {
        assert.fail("Never use Chrome sync for authentication");
      },
    },
    permissions: {
      request: async ({ origins }) => {
        assert.equal(origins.length, 1);
        if (granted) grants.add(origins[0]);
        return granted;
      },
      remove: async ({ origins }) => {
        // Chrome refuses to remove a permission the manifest requires.
        if (origins.includes("https://app.valise.run/*"))
          throw new Error("You cannot remove required permissions.");
        removed.push(...origins);
        for (const origin of origins) grants.delete(origin);
        return true;
      },
    },
  };
}

test("settings request only the configured host, keep token local and remove old grants", async () => {
  const chrome = browser();
  await saveConnection(chrome, "http://localhost:5173/mcp", connection.token);
  assert.deepEqual([...chrome.grants], ["http://localhost/*"]);
  await saveConnection(chrome, DEFAULT_ENDPOINT, connection.token);
  assert.deepEqual(await readConnection(chrome), connection);
  // The self-hosted grant goes; the default host is not a runtime grant.
  assert.deepEqual([...chrome.grants], ["https://app.valise.run/*"]);
  await forgetConnection(chrome);
  assert.equal(await readConnection(chrome), null);
  assert.deepEqual(chrome.removed, ["http://localhost/*"]);
});

test("denied endpoint permission stores no token", async () => {
  const chrome = browser(false);
  await assert.rejects(
    saveConnection(chrome, DEFAULT_ENDPOINT, connection.token),
    /Nothing was saved/,
  );
  assert.equal(await readConnection(chrome), null);
});

test("rejects unsafe or ambiguous endpoints", () => {
  assert.equal(
    endpointPermission(DEFAULT_ENDPOINT),
    "https://app.valise.run/*",
  );
  for (const endpoint of [
    "http://example.com/mcp",
    "https://user:pass@example.com/mcp",
    "https://example.com/mcp?token=x",
    "https://example.com/mcp#x",
    "https://example.com/other",
    "file:///mcp",
  ])
    assert.throws(() => normalizeEndpoint(endpoint));
});

test("MV3 grants only the default Valise host, with no background watcher, remote code or synced secret", async () => {
  const manifest = JSON.parse(
    await readFile(new URL("../manifest.json", import.meta.url), "utf8"),
  );
  assert.equal(manifest.manifest_version, 3);
  assert.deepEqual(manifest.permissions, [
    "activeTab",
    "identity",
    "scripting",
    "storage",
  ]);
  // Required, so Connect to app.valise.run never shows a prompt that would
  // close the popup; any other host stays optional and asked for in Settings.
  assert.deepEqual(manifest.host_permissions, ["https://app.valise.run/*"]);
  for (const key of [
    "content_scripts",
    "background",
    "externally_connectable",
    "web_accessible_resources",
  ])
    assert.equal(manifest[key], undefined);
  assert.match(
    manifest.content_security_policy.extension_pages,
    /script-src 'self'/,
  );
  const settings = await readFile(
    new URL("../settings.html", import.meta.url),
    "utf8",
  );
  assert.match(settings, /id="token" type="password"/);
  assert(!settings.includes(connection.token));
});

test("sends the extracted article and its authors with the source", async () => {
  const { calls, fetcher } = server();
  const article = {
    detected: true,
    extractor: "defuddle-0.19",
    wordCount: 418,
    pageWordCount: 504,
    markdown: "The harbour at Wrenmouth…",
    text: "The harbour at Wrenmouth…",
    truncated: false,
    authors: ["Mara Lindqvist", "Tomas Oyelaran"],
    published: "2026-09-14T08:00:00Z",
    siteName: "Coastal Notes",
    canonicalUrl: "https://example.org/wren",
    leadImage: null,
    description: "A ledger.",
    language: "en-GB",
  };
  const saved = await new ValiseClient(connection, fetcher).saveArchive(
    { ...snapshot, article },
    {},
  );
  const source = calls
    .filter(({ init }) => init.method === "POST")
    .map(({ init }) => JSON.parse(init.body).params)
    .find(({ name }) => name === "save_source").arguments;
  assert.deepEqual(source.authors, article.authors);
  assert.equal(source.article.word_count, 418);
  assert.equal(source.article.site_name, "Coastal Notes");
  assert.equal(source.article.markdown, article.markdown);
  assert.equal(source.notes, undefined);
  assert.equal(
    savedMessage(saved),
    "Saved article (418 words, by Mara Lindqvist and Tomas Oyelaran) and archived the page.",
  );
  assert.equal(
    savedMessage({
      article: { detected: false, word_count: 12 },
      authors: [],
      assetId,
      stored: 1,
      missed: 2,
    }),
    "Archived the page with 1 file. 2 could not be kept.",
  );
});

const wrenArticle = {
  detected: true,
  extractor: "defuddle-0.19",
  wordCount: 418,
  pageWordCount: 504,
  markdown: "The harbour at Wrenmouth…",
  text: "The harbour at Wrenmouth…",
  truncated: false,
  authors: ["Mara Lindqvist", "Tomas Oyelaran"],
  published: "2026-09-14T08:00:00Z",
  siteName: "Coastal Notes",
  canonicalUrl: "https://example.org/wren",
  leadImage: null,
  description: "A ledger.",
  language: "en-GB",
};

test("saveBookmark with an article is one save_source carrying the article, no upload", async () => {
  const { calls, fetcher } = server();
  const saved = await new ValiseClient(connection, fetcher).saveBookmark(
    { title: " Wrenmouth ", url: "https://example.org/wren#top" },
    wrenArticle,
    { tags: ["harbours"], project: "coast" },
  );
  assert.deepEqual(
    calls.map(({ init }) => JSON.parse(init.body).params.name),
    ["save_source"],
  );
  const bookmark = JSON.parse(calls[0].init.body).params.arguments;
  assert.equal(bookmark.kind, "bookmark");
  assert.equal(bookmark.url, "https://example.org/wren");
  assert.equal(bookmark.title, "Wrenmouth");
  assert.equal(bookmark.asset_ids, undefined);
  assert.deepEqual(bookmark.tags, ["harbours"]);
  assert.equal(bookmark.project, "coast");
  assert.equal(bookmark.article.word_count, 418);
  assert.deepEqual(bookmark.authors, wrenArticle.authors);
  assert.equal(saved.assetId, null);
  assert.equal(saved.sourceId, sourceId);
  assert.equal(saved.revision, 1);
  assert.equal(
    savedMessage(saved),
    "Saved article (418 words, by Mara Lindqvist and Tomas Oyelaran).",
  );
});

test("saveBookmark without an article keeps the extractor's word counts, or sends none", async () => {
  const { calls, fetcher } = server();
  const client = new ValiseClient(connection, fetcher);
  const page = { title: "", url: "https://example.org/tiny" };
  const undetected = {
    ...wrenArticle,
    detected: false,
    markdown: "",
    text: "",
    wordCount: 2,
    pageWordCount: 2,
    authors: [],
  };
  const counted = await client.saveBookmark(page, undetected, {});
  const sent = (index) => JSON.parse(calls[index].init.body).params.arguments;
  assert.equal(sent(0).kind, "bookmark");
  assert.equal(sent(0).title, "example.org");
  assert.equal(sent(0).article.detected, false);
  assert.equal(sent(0).article.page_word_count, 2);
  assert.equal(sent(0).authors, undefined);
  assert.equal(savedMessage(counted), "Saved the bookmark.");

  const bare = await client.saveBookmark(page, null, { tags: ["later"] });
  assert.equal(sent(1).article, undefined);
  assert.deepEqual(sent(1).tags, ["later"]);
  assert.equal(bare.article, null);
  assert.equal(savedMessage(bare), "Saved the bookmark.");

  await assert.rejects(
    client.saveBookmark({ title: "x", url: "file:///etc/passwd" }, null, {}),
    /Invalid captured page URL/,
  );
});

test("a page save carries the note when one is given, and only then", async () => {
  const { calls, fetcher } = server();
  const client = new ValiseClient(connection, fetcher);
  const sent = (index) => JSON.parse(calls[index].init.body).params.arguments;
  await client.saveBookmark(
    { title: "Wren", url: "https://example.org/wren" },
    null,
    { tags: [], notes: "  Ask about the harbour wall.\n" },
  );
  assert.equal(sent(0).notes, "Ask about the harbour wall.");
  // An empty note is sent, so a cleared note clears the saved one.
  await client.saveBookmark(
    { title: "Wren", url: "https://example.org/wren" },
    null,
    { tags: [], notes: "" },
  );
  assert.equal(sent(1).notes, "");
  // No note at all is not sent, so the saved note inherits.
  await client.saveBookmark(
    { title: "Wren", url: "https://example.org/wren" },
    null,
    { tags: [] },
  );
  assert.equal("notes" in sent(2), false);
  await assert.rejects(
    client.saveBookmark(
      { title: "Wren", url: "https://example.org/wren" },
      null,
      { notes: 7 },
    ),
    /Invalid note/,
  );

  const archive = server();
  await new ValiseClient(connection, archive.fetcher).saveArchive(snapshot, {
    tags: [],
    notes: "Keep the map.",
  });
  const source = tools(archive.calls).find(
    (call) => call.name === "save_source",
  );
  assert.equal(source.arguments.notes, "Keep the map.");
  // The note is on the source, never on the archived file.
  const upload = tools(archive.calls).find(
    (call) => call.name === "upload_asset",
  );
  assert.equal("notes" in upload.arguments, false);
});

test("updateLabels sends a note only when one is given", async () => {
  const { calls, fetcher } = server();
  const client = new ValiseClient(connection, fetcher);
  await client.updateLabels(sourceId, 1, {
    tags: ["harbours"],
    project: "coast",
    notes: " Nests in May. ",
  });
  assert.deepEqual(tools(calls)[0].arguments, {
    id: sourceId,
    expected_revision: 1,
    notes: "Nests in May.",
    tags: ["harbours"],
    project: "coast",
  });
  await client.updateLabels(sourceId, 2, { tags: ["harbours"] });
  assert.equal("notes" in tools(calls)[1].arguments, false);
});

test("updateLabels writes tags and project as the next revision of the saved source", async () => {
  const { calls, fetcher } = server();
  const client = new ValiseClient(connection, fetcher);
  assert.equal(
    await client.updateLabels(sourceId, 1, {
      tags: ["harbours", " birds "],
      project: "coast",
    }),
    2,
  );
  assert.deepEqual(tools(calls), [
    {
      name: "save_source",
      arguments: {
        id: sourceId,
        expected_revision: 1,
        tags: ["harbours", "birds"],
        project: "coast",
      },
    },
  ]);
  // An empty project clears it; nothing else is sent, so the rest inherits.
  assert.equal(
    await client.updateLabels(sourceId, 2, { tags: [], project: " " }),
    3,
  );
  assert.deepEqual(tools(calls)[1].arguments, {
    id: sourceId,
    expected_revision: 2,
    tags: [],
    project: null,
  });
  await assert.rejects(
    client.updateLabels("source:nonsense", 1, { tags: [] }),
    /Invalid saved source/,
  );
  await assert.rejects(
    client.updateLabels(sourceId, 0, { tags: [] }),
    /Invalid saved source/,
  );
  // A stale revision is refused by Valise, not retried or overwritten.
  await assert.rejects(
    new ValiseClient(connection, server({ status: 409 }).fetcher).updateLabels(
      sourceId,
      1,
      { tags: ["late"] },
    ),
    /save_source failed/,
  );
});

const resource = (name, contentType, text) => ({
  name,
  contentType,
  base64: Buffer.from(text).toString("base64"),
});

test("uploads every resource into the HTML's folder, verified, and links only the HTML", async () => {
  const { calls, fetcher } = server();
  const resources = [
    resource("page.css", "text/css", 'body{background:url("img-001.png")}'),
    resource("img-001.png", "image/png", "png bytes"),
    resource("img-002.jpg", "image/jpeg", "jpeg bytes"),
    resource("font-001.woff2", "font/woff2", "woff2 bytes"),
    resource("img-003.gif", "image/gif", "gif bytes"),
  ];
  const saved = await new ValiseClient(connection, fetcher).saveArchive(
    { ...snapshot, resources, skipped: 0 },
    { tags: ["birds"], project: "coast" },
  );
  assert.equal(saved.stored, 5);
  assert.equal(saved.missed, 0);
  const rpc = tools(calls);
  // The HTML goes first and alone; the source comes last.
  assert.equal(rpc[0].name, "upload_asset");
  assert.equal(rpc[0].arguments.content_type, "text/html");
  assert.equal(rpc.at(-1).name, "save_source");
  assert.deepEqual(rpc.at(-1).arguments.asset_ids, [assetId]);
  // The project labels the HTML and the source, never a resource.
  assert.equal(rpc[0].arguments.project, "coast");
  assert.equal(rpc.at(-1).arguments.project, "coast");
  const members = rpc.filter(
    ({ name, arguments: args }) => name === "upload_asset" && args.folder,
  );
  assert.deepEqual(
    members.map(({ arguments: args }) => args.file_name).sort(),
    resources.map(({ name }) => name).sort(),
  );
  for (const { arguments: args } of members) {
    const sent = resources.find(({ name }) => name === args.file_name);
    const bytes = Buffer.from(sent.base64, "base64");
    assert.equal(args.folder, assetId);
    assert.equal(args.content_type, sent.contentType);
    assert.equal(args.size, bytes.byteLength);
    assert.equal(args.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(args.tags, undefined);
    assert.equal(args.project, undefined);
  }
  // Every resource PUT went to its own capability, after the HTML's.
  const puts = calls.filter(({ init }) => init.method === "PUT");
  assert.equal(puts.length, 6);
  assert.equal(new URL(puts[0].url).pathname, `/uploads/${assetId.slice(6)}`);
});

test("a resource that fails or is refused is counted as missed, not fatal", async () => {
  const { calls, fetcher } = server({
    resourceStatus: (name) => (name === "img-002.jpg" ? 500 : 200),
  });
  const saved = await new ValiseClient(connection, fetcher).saveArchive(
    {
      ...snapshot,
      resources: [
        resource("page.css", "text/css", "p{}"),
        resource("img-001.png", "image/png", "png"),
        resource("img-002.jpg", "image/jpeg", "jpeg"),
        // Empty bytes are refused before any call.
        resource("img-003.gif", "image/gif", ""),
      ],
      skipped: 3,
    },
    [],
  );
  assert.equal(saved.stored, 2);
  // Two refused here, three the capture could not keep.
  assert.equal(saved.missed, 5);
  assert.equal(saved.sourceId, sourceId);
  assert.equal(
    tools(calls).filter(
      ({ arguments: args }) => args.file_name === "img-003.gif",
    ).length,
    0,
  );
  assert.equal(
    savedMessage(saved),
    "Archived the page with 2 files. 5 could not be kept.",
  );
});

test("a resource upload pointed off-origin sends no bytes and is missed", async () => {
  const { calls, fetcher } = server({
    resourceDestination: "https://evil.example/uploads/x",
  });
  const saved = await new ValiseClient(connection, fetcher).saveArchive(
    { ...snapshot, resources: [resource("img-001.png", "image/png", "png")] },
    {},
  );
  assert.equal(saved.stored, 0);
  assert.equal(saved.missed, 1);
  assert(
    !calls.some(({ url }) => String(url).startsWith("https://evil.example")),
  );
});

test("checkSaved asks save_source without writing and returns what is saved", async () => {
  const saved = [
    {
      id: sourceId,
      kind: "document",
      title: "A wren",
      revision: 2,
      updated_at: 1793366241,
      notes: "Nests under the harbour wall.",
      archive_asset_id: assetId,
    },
  ];
  const vocabulary = { projects: ["coast"], tags: ["harbours", "birds"] };
  const { calls, fetcher } = server({ saved, vocabulary });
  assert.deepEqual(
    await new ValiseClient(connection, fetcher).checkSaved(
      "https://example.org/wren#private-fragment",
    ),
    { saved, vocabulary },
  );
  const rpc = tools(calls);
  assert.deepEqual(rpc, [
    {
      name: "save_source",
      arguments: { check: true, url: "https://example.org/wren" },
    },
  ]);
  await assert.rejects(
    new ValiseClient(connection, fetcher).checkSaved("file:///etc/passwd"),
    /Invalid page URL/,
  );
  // A server without a vocabulary still answers the saved state.
  assert.deepEqual(
    await new ValiseClient(connection, server({ saved }).fetcher).checkSaved(
      "https://example.org/wren",
    ),
    { saved, vocabulary: { projects: [], tags: [] } },
  );
});

test("an insufficient scope names the scope Valise asked for", async () => {
  const challenge = (scope) =>
    `Bearer resource_metadata="https://app.valise.run/.well-known/oauth-protected-resource/mcp", scope="${scope}", error="insufficient_scope"`;
  const cases = [
    [
      challenge("todos:write"),
      "todos:write",
      "This connection cannot add to-dos. Reconnect to Valise to allow it.",
    ],
    [
      challenge("sources:write"),
      "sources:write",
      "The token needs assets:write, assets:read, sources:write. Check its scopes in Connections.",
    ],
    [
      'Bearer error="insufficient_scope"',
      null,
      "The token needs assets:write, assets:read, sources:write. Check its scopes in Connections.",
    ],
  ];
  for (const [header, scope, message] of cases) {
    const { fetcher } = server({ status: 403, challenge: header });
    await assert.rejects(
      new ValiseClient(connection, fetcher).createTodo({
        url: "https://example.org/x",
        project: "valise",
      }),
      (error) => {
        assert.equal(error.message, message);
        assert.equal(error.insufficientScope, scope);
        return true;
      },
    );
  }
});

test("canAddTodos trusts an OAuth grant's scopes and leaves a pasted token to the server", () => {
  const oauth = (scopes) => ({
    endpoint: DEFAULT_ENDPOINT,
    oauth: { accessToken: "a", refreshToken: "r", clientId: "c", scopes },
  });
  assert.equal(canAddTodos(oauth([...REQUESTED_SCOPES])), true);
  assert.equal(canAddTodos(oauth([...CAPTURE_SCOPES])), false);
  assert.equal(canAddTodos(oauth(undefined)), false);
  assert.equal(canAddTodos(connection), true);
  assert.equal(canAddTodos(null), false);
});

test("createTodo sends the page as a url ref, with labels and description", async () => {
  const { calls, fetcher } = server();
  const created = await new ValiseClient(connection, fetcher).createTodo({
    title: "  Read the wren paper  ",
    url: "https://example.org/wren#section",
    description: "  Check the second figure.  ",
    project: " birds ",
    tags: ["reading", " reading", ""],
  });
  assert.deepEqual(tools(calls), [
    {
      name: "create_todo",
      arguments: {
        title: "Read the wren paper",
        project: "birds",
        tags: ["reading"],
        body: "Check the second figure.",
        refs: [{ kind: "url", value: "https://example.org/wren" }],
      },
    },
  ]);
  assert.deepEqual(created, {
    id: todoId,
    title: "Read the wren paper",
    url: `https://app.valise.run/todos?open=${encodeURIComponent(todoId)}`,
  });
});

test("createTodo omits empty tags and body, and falls back to the hostname", async () => {
  const { calls, fetcher } = server();
  await new ValiseClient(connection, fetcher).createTodo({
    title: "  ",
    url: "https://example.org/x",
    project: "valise",
  });
  assert.deepEqual(tools(calls)[0].arguments, {
    title: "example.org",
    project: "valise",
    refs: [{ kind: "url", value: "https://example.org/x" }],
  });
});

test("createTodo puts a URL too long for a ref on the body's last line", async () => {
  const url = `https://example.org/${"a".repeat(600)}`;
  for (const [description, body] of [
    ["Look at this.", `Look at this.\n\nPage: ${url}`],
    [undefined, `Page: ${url}`],
  ]) {
    const { calls, fetcher } = server();
    await new ValiseClient(connection, fetcher).createTodo({
      title: "Long",
      url,
      description,
      project: "valise",
    });
    const args = tools(calls)[0].arguments;
    assert.equal(args.body, body);
    assert.equal("refs" in args, false);
  }
});

test("createTodo refuses bad input before contacting Valise", async () => {
  const { calls, fetcher } = server();
  const client = new ValiseClient(connection, fetcher);
  const page = { title: "T", url: "https://example.org/x", project: "valise" };
  for (const [todo, message] of [
    [{ ...page, project: "  " }, /Choose a project for the to-do\./],
    [{ ...page, project: undefined }, /Choose a project for the to-do\./],
    [{ ...page, project: "p".repeat(201) }, /at most 200 characters/],
    [{ ...page, url: "ftp://example.org/x" }, /Invalid captured page URL/],
    [
      { ...page, url: "https://u:p@example.org/x" },
      /Invalid captured page URL/,
    ],
    [
      { ...page, url: `https://example.org/${"a".repeat(2048)}` },
      /Invalid captured page URL/,
    ],
    [{ ...page, description: "d".repeat(16 * 1024 + 1) }, /at most 16,384/],
    [
      { ...page, tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      /20 tags/,
    ],
  ])
    await assert.rejects(client.createTodo(todo), message);
  assert.equal(calls.length, 0);
});

test("createTodo refuses an unconfirmed id and links only to the endpoint's console", async () => {
  const page = { title: "T", url: "https://example.org/x", project: "valise" };
  for (const todo of [{ id: "todo:nope", title: "T" }, { title: "T" }]) {
    const { fetcher } = server({ todo });
    await assert.rejects(
      new ValiseClient(connection, fetcher).createTodo(page),
      /^Error: Valise did not confirm the to-do\. Check To-dos before trying again\.$/,
    );
  }
  const fallback = `https://app.valise.run/todos?open=${encodeURIComponent(todoId)}`;
  for (const url of [
    undefined,
    "https://evil.example/todos",
    "javascript:alert(1)",
    "not a url",
  ]) {
    const { fetcher } = server({ todo: { id: todoId, title: "T", url } });
    const created = await new ValiseClient(connection, fetcher).createTodo(
      page,
    );
    assert.equal(created.url, fallback);
  }
  const { fetcher } = server({
    todo: {
      id: todoId,
      title: "T",
      url: "https://app.valise.run/todos?open=x",
    },
  });
  assert.equal(
    (await new ValiseClient(connection, fetcher).createTodo(page)).url,
    "https://app.valise.run/todos?open=x",
  );
});
