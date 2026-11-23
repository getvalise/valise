import { normalizeEndpoint } from "./settings.mjs";

export const CAPTURE_SCOPES = ["assets:write", "assets:read", "sources:write"];
export const TODO_SCOPE = "todos:write";
export const REQUESTED_SCOPES = [...CAPTURE_SCOPES, TODO_SCOPE];
export const MAX_BYTES = 25 * 1024 * 1024;

export function normalizeTags(tags) {
  const result = [...new Set(tags.map((tag) => tag.trim()).filter(Boolean))];
  if (result.length > 20 || result.some((tag) => tag.length > 100)) {
    throw new Error("Use up to 20 tags, each at most 100 characters.");
  }
  return result;
}

/**
 * The labels a capture carries: tags as a set, and one optional project,
 * created on a miss like a tag.
 */
export function captureLabels({ tags = [], project } = {}) {
  const name = project?.trim();
  if (name && name.length > 200)
    throw new Error("Use a project name of at most 200 characters.");
  return { tags: normalizeTags(tags), ...(name ? { project: name } : {}) };
}

/**
 * The page note a save or an edit carries. `undefined` sends none, so the
 * saved note inherits; a string, empty or not, replaces it.
 */
export function captureNote({ notes } = {}) {
  if (notes === undefined) return {};
  if (typeof notes !== "string") throw new Error("Invalid note.");
  return { notes: notes.trim() };
}

/**
 * Whether this connection may add to-dos. A pasted token's scopes are unknown
 * here, so the server's 403 decides; a 0.7.0 grant stored no scopes.
 */
export function canAddTodos(connection) {
  if (connection?.oauth)
    return (
      Array.isArray(connection.oauth.scopes) &&
      connection.oauth.scopes.includes(TODO_SCOPE)
    );
  return Boolean(connection?.token);
}

export class ValiseClient {
  /**
   * `connection` is a stored connection: a pasted `token`, or the `oauth`
   * tokens from Connect. `refresh` returns a new access token after a 401.
   */
  constructor(connection, fetcher = (...args) => fetch(...args), refresh) {
    this.endpoint = normalizeEndpoint(connection.endpoint);
    this.token = connection.oauth?.accessToken ?? connection.token;
    if (!this.token || /\s/.test(this.token))
      throw new Error("Connect to Valise in Settings first.");
    // Native Window.fetch rejects a ValiseClient receiver. Keep the default
    // call on its global receiver; injected test transports do not expose this.
    this.fetcher = fetcher;
    this.refresh = refresh;
    this.nextId = 1;
  }

  async tool(name, args) {
    const id = this.nextId++;
    let response = await this.post(name, args, id);
    // A 401 means the call never ran, so one retry with a fresh token is safe.
    if (response.status === 401 && this.refresh) {
      this.token = await this.refresh();
      response = await this.post(name, args, id);
    }
    if (!response.ok) {
      if (response.status === 401)
        throw new Error(
          "Valise rejected the token. Reconnect or replace it in Settings; it may have expired or been revoked.",
        );
      const challenge = response.headers.get("www-authenticate") ?? "";
      if (response.status === 403 && challenge.includes("insufficient_scope")) {
        const scope = /(?:^|[\s,])scope="([^"]*)"/.exec(challenge)?.[1] ?? null;
        throw Object.assign(
          new Error(
            scope === TODO_SCOPE
              ? "This connection cannot add to-dos. Reconnect to Valise to allow it."
              : `The token needs ${CAPTURE_SCOPES.join(", ")}. Check its scopes in Connections.`,
          ),
          { insufficientScope: scope },
        );
      }
      if (response.status === 403)
        throw new Error(
          "Valise denied this request (HTTP 403). Check the endpoint and its browser-origin policy.",
        );
      throw new Error(`Valise ${name} failed (HTTP ${response.status}).`);
    }
    let envelopes;
    try {
      const raw = await response.text();
      // The stateless Worker may answer either a JSON envelope or an SSE message.
      envelopes = response.headers
        .get("content-type")
        ?.includes("text/event-stream")
        ? raw.split(/\r?\n\r?\n/).flatMap((event) => {
            const data = event
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).trimStart())
              .join("\n");
            return data ? [JSON.parse(data)] : [];
          })
        : [JSON.parse(raw)];
    } catch {
      throw new Error(
        `Valise ${name} returned an unreadable response. Check Library before retrying.`,
      );
    }
    const envelope = envelopes.find((message) => message.id === id);
    if (
      !envelope ||
      envelope.error ||
      envelope.result?.isError ||
      !envelope.result?.structuredContent
    ) {
      // Do not display arbitrary server bodies: they can reflect credentials or capability URLs.
      throw new Error(
        `Valise ${name} was refused or returned an invalid response. Check the Library before trying again.`,
      );
    }
    return envelope.result.structuredContent;
  }

  async post(name, args, id) {
    try {
      return await this.fetcher(this.endpoint, {
        method: "POST",
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(60_000),
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
          "mcp-protocol-version": "2025-11-25",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name, arguments: args },
        }),
      });
    } catch {
      throw new Error(
        `Valise ${name} could not be reached. Check the endpoint and its site permission; check Library before retrying.`,
      );
    }
  }

  /**
   * One verified file: upload_asset, the PUT to its same-origin capability,
   * and a ready asset whose size and SHA-256 match what was sent. `folder`
   * names an asset whose folder the file joins.
   */
  async upload({ fileName, contentType, bytes, folder, ...text }) {
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
      throw new Error("Each file must be between 1 byte and 25 MiB.");
    const sha256 = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    ]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const begun = await this.tool("upload_asset", {
      file_name: fileName,
      content_type: contentType,
      size: bytes.byteLength,
      sha256,
      ...text,
      ...(folder ? { folder } : {}),
    });
    if (!/^asset:ast_[0-9a-f-]{36}$/.test(begun.id))
      throw new Error("Valise returned an invalid asset id.");
    let destination;
    try {
      destination = new URL(begun.upload.url);
    } catch {
      throw new Error(
        "Valise returned an invalid upload destination. No bytes were sent.",
      );
    }
    if (
      destination.origin !== new URL(this.endpoint).origin ||
      destination.username ||
      destination.password ||
      destination.hash ||
      destination.pathname !== `/uploads/${begun.id.slice(6)}` ||
      begun.upload.method !== "PUT"
    )
      throw new Error(
        "Valise returned an unexpected upload destination. No bytes were sent.",
      );
    let uploaded;
    try {
      uploaded = await this.fetcher(destination.href, {
        method: "PUT",
        headers: { "content-type": contentType },
        body: bytes,
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new Error(
        "The transfer was interrupted. No source was saved. Check endpoint site permission and reopen the popup to try again.",
      );
    }
    if (!uploaded.ok)
      throw new Error(
        `The upload failed (HTTP ${uploaded.status}). No source was saved.`,
      );
    let asset;
    try {
      asset = await uploaded.json();
    } catch {
      asset = {};
    }
    if (
      asset.id !== begun.id ||
      asset.state !== "ready" ||
      asset.sha256 !== sha256 ||
      asset.size !== bytes.byteLength
    )
      throw new Error(
        "Valise did not verify the uploaded original. No source was saved.",
      );
    return asset.id;
  }

  /**
   * The archive is one folder: the HTML first, as its representative, then
   * every resource joining the HTML's folder, then the source linking only
   * the HTML. A resource that does not arrive is counted, not fatal.
   */
  async saveArchive(snapshot, labels, onProgress = () => {}) {
    const labelled = captureLabels(labels);
    const note = captureNote(labels);
    const page = new URL(snapshot.url);
    if (
      !/^https?:$/.test(page.protocol) ||
      page.username ||
      page.password ||
      page.href.length > 2048
    )
      throw new Error("Invalid captured page URL.");
    const title = snapshot.title.trim().slice(0, 500) || page.hostname;
    const bytes = new TextEncoder().encode(snapshot.html);
    if (!bytes.byteLength || bytes.byteLength > MAX_BYTES)
      throw new Error("Snapshot must be between 1 byte and 25 MiB.");
    const resources = snapshot.resources ?? [];
    onProgress("Uploading the page…");
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
    const prefix = [...digest.slice(0, 6)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const assetId = await this.upload({
      fileName: `${page.hostname
        .toLowerCase()
        .replace(/[^a-z0-9.-]/g, "-")
        .slice(0, 80)}-${prefix}.html`,
      contentType: "text/html",
      bytes,
      title,
      ...labelled,
      description: `Chrome HTML snapshot (inert-dom-v4), captured ${snapshot.capturedAt}. Original URL: ${page.href}. Scripts and form fields omitted; the stylesheet, images and fonts the page used are kept beside it in this folder. This file is the archive original; the extracted article, when one was found, is on the linked source.`,
    });
    let stored = 0;
    let missed = snapshot.skipped ?? 0;
    let next = 0;
    let done = 0;
    const worker = async () => {
      while (next < resources.length) {
        const resource = resources[next++];
        try {
          await this.upload({
            fileName: resource.name,
            contentType: resource.contentType,
            bytes: Uint8Array.from(atob(resource.base64), (c) =>
              c.charCodeAt(0),
            ),
            folder: assetId,
          });
          stored++;
        } catch {
          missed++;
        }
        onProgress(`Uploading files… ${++done} of ${resources.length}`);
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    onProgress("Saving source…");
    let source;
    try {
      source = await this.tool("save_source", {
        kind: "document",
        title,
        url: page.href,
        ...note,
        ...labelled,
        asset_ids: [assetId],
        ...articleArguments(snapshot.article),
      });
    } catch {
      throw new Error(
        `The original is in Library as ${assetId}, but source saving was not confirmed. Check Library before saving again; the source may already exist.`,
      );
    }
    if (
      !/^source:src_[0-9a-f-]{36}$/.test(source.id) ||
      !Number.isInteger(source.revision) ||
      !source.assets?.some(
        (linked) => linked.id === assetId && linked.available,
      )
    )
      throw new Error(
        "Source linking was not confirmed. Check Library before saving again.",
      );
    return {
      assetId,
      sourceId: source.id,
      revision: source.revision,
      article: source.article ?? null,
      authors: source.authors ?? [],
      libraryUrl: new URL("/library", this.endpoint).href,
      stored,
      missed,
    };
  }

  /**
   * What Valise already holds at this URL, newest first, and the owner's
   * most used projects and tags. Writes nothing.
   */
  async checkSaved(pageUrl) {
    const url = new URL(pageUrl);
    url.hash = "";
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 2048
    )
      throw new Error("Invalid page URL.");
    const result = await this.tool("save_source", {
      check: true,
      url: url.href,
    });
    if (!Array.isArray(result.saved))
      throw new Error("Valise returned an invalid saved state.");
    const words = (list) =>
      Array.isArray(list)
        ? list.filter((word) => typeof word === "string")
        : [];
    return {
      saved: result.saved,
      vocabulary: {
        projects: words(result.vocabulary?.projects),
        tags: words(result.vocabulary?.tags),
      },
    };
  }

  /**
   * One save_source, no upload: a bookmark with the page's labels and, when
   * the extractor ran, its article row. A detected article's text is then the
   * saved copy; an undetected one still keeps the page's word counts.
   */
  async saveBookmark(page, article, labels) {
    const labelled = captureLabels(labels);
    const note = captureNote(labels);
    const url = new URL(page.url);
    if (
      !/^https?:$/.test(url.protocol) ||
      url.username ||
      url.password ||
      url.href.length > 2048
    )
      throw new Error("Invalid captured page URL.");
    url.hash = "";
    const title = page.title.trim().slice(0, 500) || url.hostname;
    const source = await this.tool("save_source", {
      kind: "bookmark",
      title,
      url: url.href,
      ...note,
      ...labelled,
      ...articleArguments(article),
    });
    if (
      !/^source:src_[0-9a-f-]{36}$/.test(source.id) ||
      !Number.isInteger(source.revision) ||
      (article?.detected && !source.article)
    )
      throw new Error(
        "Valise did not confirm the saved bookmark. Check Library before trying again.",
      );
    return {
      assetId: null,
      sourceId: source.id,
      revision: source.revision,
      article: source.article ?? null,
      authors: source.authors ?? [],
      libraryUrl: new URL("/library", this.endpoint).href,
    };
  }

  /**
   * Replaces a saved source's tags and project, and its note when one is
   * given, as a new revision. Omitted fields inherit, so nothing else
   * changes; a stale `revision` is refused.
   * Returns the revision written, the next one to expect.
   */
  async updateLabels(sourceId, revision, labels) {
    if (
      !/^source:src_[0-9a-f-]{36}$/.test(sourceId) ||
      !Number.isInteger(revision) ||
      revision < 1
    )
      throw new Error("Invalid saved source.");
    const { tags, project } = captureLabels(labels);
    const source = await this.tool("save_source", {
      id: sourceId,
      expected_revision: revision,
      ...captureNote(labels),
      tags,
      project: project ?? null,
    });
    if (
      source.id !== sourceId ||
      !Number.isInteger(source.revision) ||
      source.revision < revision
    )
      throw new Error(
        "Valise did not confirm the change. Reopen the popup to see what is saved.",
      );
    return source.revision;
  }

  /**
   * One create_todo for the page. The page rides as a url ref; one longer
   * than a ref value allows goes on the body's last line instead.
   */
  async createTodo({ title, url, description, project, tags = [] }) {
    const page = new URL(url);
    if (
      !/^https?:$/.test(page.protocol) ||
      page.username ||
      page.password ||
      page.href.length > 2048
    )
      throw new Error("Invalid captured page URL.");
    page.hash = "";
    const name = project?.trim() ?? "";
    if (!name) throw new Error("Choose a project for the to-do.");
    if (name.length > 200)
      throw new Error("Use a project name of at most 200 characters.");
    const labels = normalizeTags(tags);
    const notes = description?.trim() ?? "";
    if (notes.length > 16 * 1024)
      throw new Error("Use a description of at most 16,384 characters.");
    const inRef = page.href.length <= 500;
    const body = inRef
      ? notes
      : [notes, `Page: ${page.href}`].filter(Boolean).join("\n\n");
    const heading = title?.trim().slice(0, 500) || page.hostname;
    const todo = await this.tool("create_todo", {
      title: heading,
      project: name,
      ...(labels.length ? { tags: labels } : {}),
      ...(body ? { body } : {}),
      ...(inRef ? { refs: [{ kind: "url", value: page.href }] } : {}),
    });
    if (
      typeof todo.id !== "string" ||
      !/^todo:tdo_[0-9a-f-]{36}$/.test(todo.id)
    )
      throw new Error(
        "Valise did not confirm the to-do. Check To-dos before trying again.",
      );
    return {
      id: todo.id,
      title: typeof todo.title === "string" ? todo.title : heading,
      url:
        consoleLink(todo.url, this.endpoint) ??
        new URL(`/todos?open=${encodeURIComponent(todo.id)}`, this.endpoint)
          .href,
    };
  }

  async saveHighlight(selection, labels) {
    const labelled = captureLabels(labels);
    const page = new URL(selection.url);
    if (
      !/^https?:$/.test(page.protocol) ||
      page.username ||
      page.password ||
      page.href.length > 2048
    )
      throw new Error("Invalid captured page URL.");
    page.hash = "";
    const quote = selection.quote.trim();
    if (!quote || quote.length > 20_000)
      throw new Error("Select text between 1 and 20,000 characters.");
    const title = selection.title.trim().slice(0, 500) || page.hostname;
    const notes = [
      "Captured text selection from the page.",
      "",
      "Selected text:",
      quote,
      "",
      ...(selection.contextBefore
        ? ["Context before:", selection.contextBefore, ""]
        : []),
      ...(selection.contextAfter
        ? ["Context after:", selection.contextAfter, ""]
        : []),
    ].join("\n");
    const source = await this.tool("save_source", {
      kind: "reference",
      title: `${title} — Highlight`.slice(0, 500),
      url: page.href,
      notes,
      ...labelled,
    });
    if (
      !/^source:src_[0-9a-f-]{36}$/.test(source.id) ||
      source.kind !== "reference" ||
      source.url !== page.href
    )
      throw new Error(
        "Valise did not confirm the saved highlight. Check Library before trying again.",
      );
    return {
      sourceId: source.id,
      libraryUrl: new URL("/library", this.endpoint).href,
    };
  }
}

function consoleLink(value, endpoint) {
  if (typeof value !== "string") return null;
  try {
    const link = new URL(value);
    return /^https?:$/.test(link.protocol) &&
      link.origin === new URL(endpoint).origin
      ? link.href
      : null;
  } catch {
    return null;
  }
}

/** The extracted article as save_source arguments, or nothing without one. */
export function articleArguments(article) {
  if (!article) return {};
  return {
    ...(article.authors?.length ? { authors: article.authors } : {}),
    article: {
      detected: article.detected,
      markdown: article.markdown,
      text: article.text,
      truncated: article.truncated,
      word_count: article.wordCount,
      page_word_count: article.pageWordCount,
      extractor: article.extractor,
      published: article.published,
      site_name: article.siteName,
      canonical_url: article.canonicalUrl,
      lead_image: article.leadImage,
      description: article.description,
      language: article.language,
    },
  };
}

/** What the popup says once a capture is saved. */
export function savedMessage(result) {
  const article = result.article;
  const names = result.authors ?? [];
  const by =
    names.length === 0
      ? ""
      : `, by ${names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`}`;
  const saved = article?.detected
    ? `Saved article (${article.word_count.toLocaleString("en-US")} words${by})`
    : null;
  if (!result.assetId) return saved ? `${saved}.` : "Saved the bookmark.";
  const files = result.stored
    ? ` with ${result.stored} ${result.stored === 1 ? "file" : "files"}`
    : "";
  const missed = result.missed ? ` ${result.missed} could not be kept.` : "";
  return saved
    ? `${saved} and archived the page${files}.${missed}`
    : `Archived the page${files}.${missed}`;
}
