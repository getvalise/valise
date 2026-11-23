import { capturePage, captureSelection } from "./capture.mjs";
import {
  canAddTodos,
  normalizeTags,
  savedMessage,
  TODO_SCOPE,
  ValiseClient,
} from "./client.mjs";
import { combobox } from "./combobox.mjs";
import { refreshAccess } from "./oauth.mjs";
import {
  connectEndpoint,
  hasCredential,
  hasEndpointAccess,
  readConnection,
} from "./settings.mjs";

const get = (id) => document.getElementById(id);
let vocabulary = { projects: [], tags: [] };
let tabId;
let connection;
let selection;
// What the extractor returned, null when it could not run; `article` is it
// only when it found one.
let found = null;
let article = null;
let pageUrl;
let ready = false;
// The save in progress: "page" for a bookmark or an archive, "highlight".
let running = null;
// The source this popup's page save wrote. Label edits after it revise it.
let saved = null;
let pageAttempted = false;
// Save as: "bookmark" or "todo". The to-do side is "form" until Add to-do,
// then "adding", then "added" or "failed"; "reconnect" when the connection
// cannot add to-dos.
let mode = "bookmark";
let todoSide = "form";
// The labels and note Valise holds for `saved`, or before a save the ones
// chosen so far; edits not yet written queue in `pending`, one write at a
// time.
let labels = { tags: [], project: "", notes: "" };
// The note of the newest source saved at this URL, shown in Note when the
// popup opens; empty when there is none or the check failed.
let savedNote = "";
// Whether Note is open: the Note button opens it, and a saved note starts
// it open. It stays open until the popup closes.
let noteOpen = false;
let pending = [];
let writing = false;
// The page's own tint for the article, in the console's purple at low
// alpha. It lives in the page, not in valise.css, because it paints there.
const HIGHLIGHT_CSS =
  "::highlight(valise-article) { background-color: rgba(91, 42, 134, 0.16); }";
let signInEndpoint;
// Built per save so a refresh in one popup starts from the stored tokens.
const valise = () =>
  new ValiseClient(connection, undefined, () => refreshAccess(chrome));
const showError = (error) => {
  get("error").textContent =
    error.message || "Capture failed. Check Settings and try again.";
  get("error").hidden = false;
};
const fail = (error) => {
  if (error.signedOut) return showSignIn(error.message);
  showError(error);
  get("status").textContent = "Not confirmed saved.";
};

/** The Save as switch stands where the eyebrow is while a page can be saved. */
function showCaptureView(shown) {
  get("capture").hidden = !shown;
  get("mode").hidden = !shown;
  get("eyebrow").hidden = shown;
}

/** A page no extension may read: say so, and offer nothing to save. */
function cannotCapture(message) {
  showCaptureView(false);
  get("error").textContent = message;
  get("error").hidden = false;
  get("status").textContent = "Nothing can be saved from this page.";
}

/** Not connected: offer Connect and nothing that looks like it could save. */
function showSignIn(message) {
  showCaptureView(false);
  get("library").hidden = true;
  get("sign-in-host").textContent = new URL(signInEndpoint).host;
  get("sign-in").hidden = false;
  get("status").textContent = message;
  get("error").hidden = true;
}

/**
 * Runs the bundled extractor in the page's isolated world when the popup
 * opens, and tints what it found on the page until the popup closes. A page
 * it cannot read still saves as the full-page archive, so a failure here is
 * not fatal.
 */
async function previewArticle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      files: ["extract.js"],
    });
    const [previewed] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: () => globalThis.valisePreviewArticle(),
    });
    const found = previewed?.result ?? null;
    if (found?.marked) {
      await chrome.scripting.insertCSS({
        target: { tabId },
        css: HIGHLIGHT_CSS,
      });
      // Held open for the popup's lifetime; closing it clears the tint.
      chrome.tabs.connect(tabId, { name: "valise-preview" });
    }
    return found;
  } catch {
    return null;
  }
}

const day = (value) => {
  const time = Date.parse(value ?? "");
  return Number.isNaN(time)
    ? null
    : new Date(time).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "short",
        year: "numeric",
        timeZone: "UTC",
      });
};
const names = (list) =>
  list.length <= 2
    ? list.join(" and ")
    : `${list.slice(0, -1).join(", ")} and ${list.at(-1)}`;

/** The article as found: byline facts and the opening lines, or one line. */
function showArticle(previewed) {
  found = previewed;
  article = found?.detected ? found : null;
  get("article").setAttribute("aria-busy", "false");
  get("no-article").hidden = Boolean(article);
  get("save-label").textContent = article ? "Save article" : "Save bookmark";
  // An svg has no `hidden` property, only the attribute.
  get("save-article-icon").toggleAttribute("hidden", !article);
  get("save-bookmark-icon").toggleAttribute("hidden", Boolean(article));
  if (!article) return;
  get("article-byline").textContent = [
    article.authors.length ? `By ${names(article.authors)}` : null,
    article.siteName,
    day(article.published),
    `${article.wordCount.toLocaleString("en-US")} words`,
  ]
    .filter(Boolean)
    .join(" · ");
  get("article-byline").hidden = false;
  const excerpt = article.text.replace(/\s+/g, " ").trim();
  get("article-excerpt").textContent =
    excerpt.length > 280 ? `${excerpt.slice(0, 280)}…` : excerpt;
  get("article-excerpt").hidden = false;
}

const libraryLink = (path) => new URL(path, connection.endpoint).href;

/**
 * Saved state from Valise: the newest saved item at this URL, linked to its
 * reader, and its archive when it has one. `null` is a check that failed,
 * which says so rather than claiming the page is unsaved.
 */
function showSaved(saved) {
  get("saved").hidden = !saved?.length;
  get("not-saved").hidden = saved?.length !== 0;
  get("check-failed").hidden = saved !== null;
  if (!saved?.length) return;
  const [newest] = saved;
  const link = get("saved-link");
  link.textContent = `Saved ${new Date(
    newest.updated_at * 1000,
  ).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  })}`;
  link.href = libraryLink(`/library/read/${newest.id.replace(/^source:/, "")}`);
  const archive = get("archive-link");
  archive.hidden = !newest.archive_asset_id;
  if (newest.archive_asset_id)
    archive.href = libraryLink(
      `/library/archive/${newest.archive_asset_id.replace(/^asset:/, "")}`,
    );
  if (newest.archive_asset_id)
    get("archive-label").textContent = "Archive again";
}

async function checkSaved() {
  try {
    const checked = await valise().checkSaved(pageUrl);
    vocabulary = checked.vocabulary;
    return checked.saved.filter((source) => source.kind !== "reference");
  } catch (error) {
    if (error.signedOut) throw error;
    return null;
  }
}

const applyEdit = (current, edit) =>
  "project" in edit
    ? { ...current, project: edit.project }
    : "notes" in edit
      ? { ...current, notes: edit.notes }
      : {
          ...current,
          tags:
            "add" in edit
              ? normalizeTags([...current.tags, edit.add])
              : current.tags.filter((tag) => tag !== edit.remove),
        };
/** The labels on screen: what Valise holds, with the queued edits applied. */
const shown = () => pending.reduce(applyEdit, labels);

/**
 * One label change. Before a page save it only changes what the save will
 * carry; once one has started, it is queued to revise the saved source.
 */
function edit(change) {
  applyEdit(shown(), change);
  if (!saved && running !== "page") labels = applyEdit(labels, change);
  else pending.push(change);
  renderLabels();
  writeLabels();
}

/**
 * Writes the queued edits in order, each with the revision the last one
 * returned. A refused edit is dropped, so its chip or field reverts.
 */
async function writeLabels() {
  if (writing || !saved) return;
  writing = true;
  while (pending.length) {
    const [change] = pending;
    const next = applyEdit(labels, change);
    const what =
      "project" in change ? "Project" : "notes" in change ? "Note" : "Tags";
    get("status").textContent = `Saving ${what.toLowerCase()}…`;
    try {
      // Only a note edit sends the note, so a label edit never rewrites a
      // note the save left alone.
      const { notes, ...labelled } = next;
      saved.revision = await valise().updateLabels(
        saved.id,
        saved.revision,
        "notes" in change ? next : labelled,
      );
      labels = next;
      get("error").hidden = true;
      get("status").textContent = `${what} saved.`;
    } catch (error) {
      if (error.signedOut) {
        writing = false;
        return showSignIn(error.message);
      }
      showError(error);
      get("status").textContent = "";
    }
    pending.shift();
    renderLabels();
    if ("project" in change) get("project").value = shown().project;
    if ("notes" in change && get("note").value.trim() !== shown().notes)
      get("note").value = shown().notes;
  }
  writing = false;
}

function addTag(value = get("tag").value) {
  const tag = value.trim();
  if (tag && !shown().tags.includes(tag)) edit({ add: tag });
  get("tag").value = "";
}

function commitProject() {
  const project = get("project").value.trim();
  if (project !== shown().project) edit({ project });
}

function commitNote() {
  const notes = get("note").value.trim();
  if (notes !== shown().notes) edit({ notes });
}

/** Chosen tags are chips, each with a named remove. */
function renderLabels() {
  get("tags").replaceChildren(
    ...shown().tags.map((tag) => {
      const item = document.createElement("li");
      item.className = "chip";
      const name = document.createElement("span");
      name.textContent = tag;
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chip-remove";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove ${tag}`);
      remove.addEventListener("click", () => edit({ remove: tag }));
      item.append(name, remove);
      return item;
    }),
  );
}

/**
 * Shows the chosen side. Once a page save or a to-do add has been tried the
 * switch locks, so the shared project and tags never revise one item while
 * the other is on screen.
 */
function renderMode() {
  const todo = mode === "todo";
  const reconnect = todo && todoSide === "reconnect";
  const tried = todo && todoSide !== "form" && !reconnect;
  // The to-do links the page and its Title field carries the page's title,
  // so the page header would only repeat them at the popup's height limit.
  get("page").hidden = todo;
  get("article").hidden = todo;
  get("selection").hidden = todo || !selection;
  get("note-field").hidden = todo || !noteOpen;
  get("add-note").hidden = noteOpen;
  get("add-note").setAttribute("aria-expanded", String(noteOpen));
  get("bookmark-actions").hidden = todo;
  get("todo-fields").hidden = !todo || reconnect;
  get("todo-reconnect").hidden = !reconnect;
  get("labels").hidden = reconnect;
  get("todo-actions").hidden = !todo || reconnect || todoSide === "added";
  get("todo-added").hidden = !todo || todoSide !== "added";
  get("project-label").textContent = todo ? "Project (required)" : "Project";
  const locked = pageAttempted || tried;
  for (const radio of document.querySelectorAll("input[name=mode]"))
    radio.disabled = locked;
  for (const id of ["todo-title", "todo-description", "project", "tag"])
    get(id).disabled = tried;
  get("add-tag").disabled = tried;
  for (const chip of get("tags").querySelectorAll("button"))
    chip.disabled = tried;
}

/**
 * A save locks the save buttons while it runs. A page save, once tried,
 * keeps its two locked: save_source is not idempotent, and a lost response
 * may have saved, so a second click could write a second source.
 */
function renderButtons() {
  const idle = ready && !running;
  get("save").disabled = !idle || pageAttempted;
  get("archive").disabled = !idle || pageAttempted;
  get("save-selection").disabled = !idle;
  get("add-todo").disabled = !idle || todoSide !== "form";
  // Disabled until the check has filled Note with the saved note.
  get("note").disabled = !ready;
  get("add-note").disabled = !ready;
  renderMode();
}

const guard = (run) => () => {
  try {
    run();
  } catch (error) {
    showError(error);
  }
};

get("settings").addEventListener("click", () =>
  chrome.runtime.openOptionsPage(),
);
combobox(get("tag"), get("tag-list"), {
  offered: () => vocabulary.tags.filter((tag) => !shown().tags.includes(tag)),
  onPick: (tag) => guard(() => addTag(tag))(),
});
combobox(get("project"), get("project-list"), {
  offered: () => vocabulary.projects,
  onPick: (project) => {
    get("project").value = project;
    guard(commitProject)();
  },
});
get("project").addEventListener("blur", guard(commitProject));
get("add-note").addEventListener("click", () => {
  noteOpen = true;
  renderMode();
  get("note").focus();
});
get("note").addEventListener("blur", guard(commitNote));
get("note").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
    event.preventDefault();
    guard(commitNote)();
  }
});
get("add-tag").addEventListener(
  "click",
  guard(() => addTag()),
);

/**
 * A page save sends the note when there is one to keep or one to clear, so
 * saving again without touching an empty Note leaves Valise's note alone.
 */
const withNote = (carried) =>
  carried.notes || savedNote ? carried : { ...carried, notes: undefined };

async function save(kind, run) {
  if (running || !ready) return;
  try {
    commitProject();
    commitNote();
    addTag();
  } catch (error) {
    return showError(error);
  }
  const carried = shown();
  running = kind;
  if (kind === "page") pageAttempted = true;
  renderButtons();
  get("error").hidden = true;
  try {
    const result = await run(carried);
    get("status").textContent = result.message;
    if (kind === "page") {
      saved = { id: result.sourceId, revision: result.revision };
      showSaved([
        {
          id: result.sourceId,
          updated_at: Date.now() / 1000,
          archive_asset_id: result.assetId,
        },
      ]);
    }
  } catch (error) {
    if (kind === "page") {
      labels = shown();
      pending = [];
    }
    fail(error);
  }
  running = null;
  renderButtons();
  writeLabels();
}

get("save").addEventListener("click", () =>
  save("page", async (carried) => {
    get("status").textContent = article
      ? "Saving the article…"
      : "Saving the bookmark…";
    const result = await valise().saveBookmark(
      { title: get("page-title").textContent, url: pageUrl },
      found,
      withNote(carried),
    );
    return { ...result, message: savedMessage(result) };
  }),
);

get("archive").addEventListener("click", () =>
  save("page", async (carried) => {
    get("status").textContent = "Capturing the page…";
    const [capture] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: capturePage,
    });
    if (!capture?.result)
      throw new Error(
        "Chrome could not capture this page. Try a normal HTTP(S) tab.",
      );
    // The article previewed when the popup opened is the one saved.
    // Captured markup is never inserted into the extension UI.
    const result = await valise().saveArchive(
      { ...capture.result, article },
      withNote(carried),
      (message) => {
        get("status").textContent = message;
      },
    );
    return { ...result, message: savedMessage(result) };
  }),
);

get("save-selection").addEventListener("click", () => {
  if (!selection) return;
  save("highlight", async (carried) => {
    get("status").textContent = "Saving the highlight…";
    await valise().saveHighlight(selection, carried);
    return { message: "Saved the highlight." };
  });
});

for (const radio of document.querySelectorAll("input[name=mode]"))
  radio.addEventListener("change", () => {
    mode = radio.value;
    get("error").hidden = true;
    renderMode();
  });

get("add-todo").addEventListener("click", async () => {
  if (running || !ready || todoSide !== "form") return;
  try {
    commitProject();
    addTag();
  } catch (error) {
    return showError(error);
  }
  const carried = shown();
  if (!carried.project) {
    showError(new Error("Choose a project for the to-do."));
    return get("project").focus();
  }
  running = "todo";
  todoSide = "adding";
  renderButtons();
  get("error").hidden = true;
  get("status").textContent = "Adding the to-do…";
  try {
    const todo = await valise().createTodo({
      title: get("todo-title").value,
      url: pageUrl,
      description: get("todo-description").value,
      ...carried,
    });
    todoSide = "added";
    get("todo-link").textContent = todo.title;
    get("todo-link").href = todo.url;
    get("status").textContent = "Added the to-do.";
  } catch (error) {
    if (error.insufficientScope === TODO_SCOPE) {
      // A 403 means create_todo never ran, so nothing was added.
      todoSide = "reconnect";
      get("status").textContent = "";
    } else {
      todoSide = "failed";
      fail(error);
      if (!error.signedOut)
        get("status").textContent =
          "Not confirmed added. Check To-dos before adding again.";
    }
  }
  running = null;
  renderButtons();
});

async function openConnect() {
  get("error").hidden = true;
  try {
    // No site-access request here: its prompt takes focus and Chrome closes
    // the popup with it, ending this script. The default host is granted by
    // the manifest; Settings, a tab, asks for any other one and signs in.
    const next = new URL(chrome.runtime.getURL("settings.html"));
    next.searchParams.set("connect", "1");
    if (tabId) next.searchParams.set("return", String(tabId));
    await chrome.tabs.create({ url: next.href });
    window.close();
  } catch (error) {
    get("error").textContent = error.message;
    get("error").hidden = false;
  }
}

get("connect").addEventListener("click", openConnect);
get("reconnect").addEventListener("click", openConnect);

async function start() {
  connection = await readConnection(chrome);
  signInEndpoint = connectEndpoint(connection);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab?.id;
  if (!hasCredential(connection))
    return showSignIn(
      connection
        ? "Valise ended this extension's connection. Connect again to keep saving."
        : "Not connected.",
    );
  if (!(await hasEndpointAccess(chrome, connection.endpoint)))
    return showSignIn(
      "Chrome site access to Valise was removed. Connect again to grant it.",
    );
  get("library").href = libraryLink("/library");
  get("library").hidden = false;
  if (!tab?.id || !/^https?:\/\//.test(tab.url || ""))
    return cannotCapture(
      "Open a normal web page to save it. Chrome's own pages, such as chrome://extensions, cannot be read by an extension.",
    );
  get("page-title").textContent = tab.title || "Active page";
  get("todo-title").value = tab.title || "";
  if (!canAddTodos(connection)) todoSide = "reconnect";
  const url = new URL(tab.url);
  url.hash = "";
  pageUrl = url.href;
  get("page-host").textContent = url.host;
  let capturedSelection;
  try {
    [capturedSelection] = await chrome.scripting.executeScript({
      target: { tabId },
      world: "ISOLATED",
      func: captureSelection,
    });
  } catch {
    return cannotCapture(
      "Chrome does not let extensions read this page, so it cannot be saved. The Chrome Web Store and other protected pages are off limits.",
    );
  }
  showCaptureView(true);
  get("status").textContent = "Finding the article…";
  get("check-host").textContent = new URL(connection.endpoint).host;
  const [previewed, check] = await Promise.all([
    previewArticle(tabId),
    checkSaved(),
  ]);
  showArticle(previewed);
  showSaved(check);
  savedNote =
    typeof check?.[0]?.notes === "string" ? check[0].notes.trim() : "";
  labels = { ...labels, notes: savedNote };
  get("note").value = savedNote;
  noteOpen = savedNote !== "";
  renderLabels();
  if (capturedSelection?.result) {
    selection = capturedSelection.result;
    get("selection-quote").textContent = selection.quote;
  }
  ready = true;
  renderButtons();
  get("status").textContent = "";
  get("capture").setAttribute("aria-busy", "false");
}

try {
  await start();
} catch (error) {
  fail(error);
}
