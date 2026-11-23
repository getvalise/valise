/**
 * Self-contained: Chrome serializes this function into the active tab's
 * isolated world, so it may use nothing from module scope.
 */
export async function capturePage() {
  const url = new URL(location.href);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error(
      "Capture supports HTTP(S) pages without URL credentials only.",
    );
  }
  // Fragments often carry OAuth tokens and are not sent to the original server.
  url.hash = "";
  if (url.href.length > 2048)
    throw new Error("The page URL exceeds 2048 characters.");
  const title = (document.title.trim() || url.hostname).slice(0, 500);
  const MiB = 1024 * 1024;

  // Resources: only the types the archive viewer serves, named within the
  // folder by kind and order.
  const contentTypes = {
    png: "image/png",
    jpg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    avif: "image/avif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff2: "font/woff2",
    woff: "font/woff",
    ttf: "font/ttf",
    otf: "font/otf",
  };
  const extensions = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/jpg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "image/avif": "avif",
    "image/svg+xml": "svg",
    "image/x-icon": "ico",
    "image/vnd.microsoft.icon": "ico",
    "font/woff2": "woff2",
    "font/woff": "woff",
    "font/ttf": "ttf",
    "font/otf": "otf",
    "font/sfnt": "ttf",
    "application/font-woff2": "woff2",
    "application/font-woff": "woff",
    "application/x-font-woff": "woff",
    "application/x-font-ttf": "ttf",
    "application/x-font-otf": "otf",
  };
  const resources = [];
  const stored = new Map();
  const counters = { img: 0, font: 0 };
  let reserved = 0;
  let totalBytes = 0;
  let skipped = 0;
  function base64(bytes) {
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000)
      binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
  }
  function request(target) {
    const same = target.origin === location.origin;
    return fetch(target.href, {
      ...(same
        ? { credentials: "same-origin" }
        : { mode: "cors", credentials: "omit" }),
      cache: "force-cache",
      signal: AbortSignal.timeout(20_000),
    });
  }
  /** The stored file name for a resource URL, or null when it was not kept. */
  function store(raw, base) {
    let target;
    try {
      target = new URL(raw, base);
    } catch {
      return Promise.resolve(null);
    }
    if (
      !/^(https?|data):$/.test(target.protocol) ||
      target.username ||
      target.password
    )
      return Promise.resolve(null);
    target.hash = "";
    if (stored.has(target.href)) return stored.get(target.href);
    const pending = (async () => {
      // 100 files per folder: the HTML, page.css and 98 resources.
      if (reserved >= 98) {
        skipped++;
        return null;
      }
      reserved++;
      try {
        const response = await request(target);
        if (!response.ok) throw new Error("not stored");
        const header = (response.headers.get("content-type") ?? "")
          .split(";")[0]
          .trim()
          .toLowerCase();
        let extension = extensions[header];
        // Font servers often answer application/octet-stream.
        const named = /\.(woff2|woff|ttf|otf)$/i.exec(target.pathname);
        if (
          !extension &&
          named &&
          /^(application\/octet-stream)?$/.test(header)
        )
          extension = named[1].toLowerCase();
        if (!extension) throw new Error("not stored");
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (
          !bytes.byteLength ||
          bytes.byteLength > 25 * MiB ||
          totalBytes + bytes.byteLength > 40 * MiB
        )
          throw new Error("not stored");
        totalBytes += bytes.byteLength;
        const kind = contentTypes[extension].startsWith("font/")
          ? "font"
          : "img";
        counters[kind]++;
        const name = `${kind}-${String(counters[kind]).padStart(3, "0")}.${extension}`;
        resources.push({
          name,
          contentType: contentTypes[extension],
          base64: base64(bytes),
        });
        return name;
      } catch {
        reserved--;
        skipped++;
        return null;
      }
    })();
    stored.set(target.href, pending);
    return pending;
  }

  const urlPattern =
    /url\(\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|([^)\s"']*))\s*\)/gi;
  /** CSS with every url() stored and rewritten to its file name. */
  async function rewriteCss(css, base) {
    const found = [...css.matchAll(urlPattern)];
    const names = await Promise.all(
      found.map((match) => {
        const raw = (match[1] ?? match[2] ?? match[3] ?? "").trim();
        if (/^data:/i.test(raw))
          return Promise.resolve(raw.length < 64 * 1024 ? raw : null);
        return raw ? store(raw, base) : Promise.resolve(null);
      }),
    );
    let index = 0;
    return css.replace(urlPattern, () => {
      const name = names[index++];
      return `url(${JSON.stringify(name ?? "")})`;
    });
  }
  async function sheetText(href) {
    try {
      const response = await fetch(href, {
        mode: "cors",
        credentials: "omit",
        cache: "force-cache",
        signal: AbortSignal.timeout(20_000),
      });
      return response.ok ? await response.text() : null;
    } catch {
      return null;
    }
  }
  const importPattern =
    /@import\s+(?:url\(\s*["']?([^"')]+)["']?\s*\)|["']([^"']+)["'])\s*([^;]*);/gi;
  const wrap = (css, media) =>
    media && media !== "all" ? `@media ${media} {\n${css}}\n` : css;
  /**
   * A stylesheet as flat CSS: imports inlined in place, each sheet's url()s
   * resolved against that sheet's own URL. `href` is null for inline sheets.
   */
  async function flatten(sheet, href, media, depth) {
    const base = href ?? document.baseURI;
    let rules = null;
    try {
      rules = sheet?.cssRules ?? null;
    } catch {
      rules = null;
    }
    let imported = "";
    let own = "";
    if (rules) {
      for (const rule of rules) {
        if (rule.type !== 3) own += `${rule.cssText}\n`;
        else if (depth < 4) {
          let next;
          try {
            next = rule.styleSheet?.href ?? new URL(rule.href, base).href;
          } catch {
            continue;
          }
          imported += await flatten(
            rule.styleSheet,
            next,
            rule.media?.mediaText ?? "",
            depth + 1,
          );
        }
      }
    } else {
      // A cross-origin sheet without CORS: read it again with CORS, or skip it.
      const text = href ? await sheetText(href) : null;
      if (text === null) return "";
      const imports = [];
      own = text.replace(importPattern, (_, quoted, bare, condition) => {
        imports.push({
          href: (quoted ?? bare).trim(),
          media: condition.trim(),
        });
        return "";
      });
      for (const item of imports) {
        if (depth >= 4) break;
        let next;
        try {
          next = new URL(item.href, base).href;
        } catch {
          continue;
        }
        imported += await flatten(undefined, next, item.media, depth + 1);
      }
    }
    return wrap(imported + (await rewriteCss(own, base)), media);
  }

  // Never serialize the source tree in place. Raw-text elements can turn text
  // containing closing tags into executable markup when outerHTML is reparsed,
  // and a page can move its head after the body. Own both the document shape
  // and every element/text context in the serialized representation.
  const output = document.implementation.createHTMLDocument("");
  const head = output.head;
  head.replaceChildren();
  const charset = output.createElement("meta");
  charset.setAttribute("charset", "utf-8");
  const policy = output.createElement("meta");
  policy.setAttribute("http-equiv", "Content-Security-Policy");
  policy.setAttribute(
    "content",
    "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; base-uri 'none'; form-action 'none'",
  );
  const heading = output.createElement("title");
  heading.textContent = title;
  head.append(charset, policy, heading);

  const allowed = new Set(
    "a abbr address article aside b bdi bdo blockquote br caption cite code col colgroup dd del details dfn div dl dt em figcaption figure footer h1 h2 h3 h4 h5 h6 header hgroup hr i img ins kbd li main mark menu nav ol p pre q rp rt ruby s samp section small span strong sub summary sup table tbody td tfoot th thead time tr u ul var wbr".split(
      " ",
    ),
  );
  const omitted = new Set(
    "head title script noscript style link meta base iframe frame frameset object embed svg math template".split(
      " ",
    ),
  );
  const fields = new Set(
    "input textarea select button option optgroup datalist output".split(" "),
  );
  // <noscript> is what a page shows without scripts: tag-manager iframes and
  // "enable JavaScript" notices, never the rendered article. It is dropped.
  const rawText = new Set("xmp plaintext noembed noframes".split(" "));
  const attributes = new Set([
    "lang",
    "dir",
    "alt",
    "colspan",
    "rowspan",
    "class",
    "id",
  ]);
  const pending = [];
  function keepStyle(source, target) {
    const style = source.getAttribute("style");
    if (!style) return;
    pending.push(
      rewriteCss(style, document.baseURI).then((css) =>
        target.setAttribute("style", css),
      ),
    );
  }
  function copy(source, parent) {
    if (source.nodeType === 3) {
      parent.append(output.createTextNode(source.data));
      return;
    }
    // Comments, processing instructions, foreign namespaces and metadata are
    // never copied. Unrecognized HTML wrappers may contribute semantic children.
    if (
      source.nodeType !== 1 ||
      source.namespaceURI !== "http://www.w3.org/1999/xhtml"
    )
      return;
    const name = source.localName;
    if (
      omitted.has(name) ||
      source.hasAttribute("hidden") ||
      source.getAttribute("aria-hidden") === "true"
    )
      return;
    if (
      fields.has(name) ||
      (source.hasAttribute("contenteditable") &&
        source.getAttribute("contenteditable").toLowerCase() !== "false")
    ) {
      parent.append(output.createTextNode("[Form field omitted]"));
      return;
    }
    if (rawText.has(name)) {
      // <pre> escapes text on serialization; raw-text source nodes do not.
      const literal = output.createElement("pre");
      literal.textContent = source.textContent;
      parent.append(literal);
      return;
    }
    let target = parent;
    if (allowed.has(name)) {
      target = output.createElement(name);
      for (const attribute of source.attributes) {
        if (attributes.has(attribute.name))
          target.setAttribute(attribute.name, attribute.value);
      }
      keepStyle(source, target);
      if (name === "a" && source.hasAttribute("href")) {
        try {
          const link = new URL(source.getAttribute("href"), document.baseURI);
          if (
            /^https?:$/.test(link.protocol) &&
            !link.username &&
            !link.password
          ) {
            link.hash = "";
            target.setAttribute("href", link.href);
          }
        } catch {
          /* Omit malformed and executable URLs. */
        }
      }
      if (name === "img") {
        for (const size of ["width", "height"])
          if (/^\d+$/.test(source.getAttribute(size) ?? ""))
            target.setAttribute(size, source.getAttribute(size));
        const image = source.currentSrc || source.getAttribute("src");
        if (image) {
          const element = target;
          pending.push(
            store(image, document.baseURI).then((file) => {
              if (file) element.setAttribute("src", file);
            }),
          );
        }
      }
      parent.append(target);
    }
    for (const child of source.childNodes) copy(child, target);
  }
  // Page-wide selectors often hang off <html> and <body> classes.
  for (const [from, to] of [
    [document.documentElement, output.documentElement],
    [document.body, output.body],
  ]) {
    if (!from) continue;
    for (const attribute of ["class", "id"])
      if (from.hasAttribute(attribute))
        to.setAttribute(attribute, from.getAttribute(attribute));
    keepStyle(from, to);
  }
  copy(document.documentElement, output.body);

  let css = "";
  for (const sheet of [
    ...document.styleSheets,
    ...(document.adoptedStyleSheets ?? []),
  ]) {
    if (sheet.disabled) continue;
    css += await flatten(sheet, sheet.href, sheet.media?.mediaText ?? "", 0);
  }
  await Promise.all(pending);
  const encoded = new TextEncoder().encode(css);
  if (
    css.trim() &&
    encoded.byteLength <= 25 * MiB &&
    totalBytes + encoded.byteLength <= 40 * MiB
  ) {
    resources.unshift({
      name: "page.css",
      contentType: "text/css",
      base64: base64(encoded),
    });
    const link = output.createElement("link");
    link.setAttribute("rel", "stylesheet");
    link.setAttribute("href", "page.css");
    head.append(link);
  } else if (css.trim()) skipped++;

  const html = `<!doctype html>\n${output.documentElement.outerHTML}`;
  if (new TextEncoder().encode(html).byteLength > 25 * MiB) {
    throw new Error("The snapshot exceeds Valise's 25 MiB file limit.");
  }
  return {
    title,
    url: url.href,
    html,
    capturedAt: new Date().toISOString(),
    resources,
    skipped,
  };
}

/** Self-contained: Chrome serializes this function into the active tab's isolated world. */
export function captureSelection() {
  const url = new URL(location.href);
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new Error(
      "Capture supports HTTP(S) pages without URL credentials only.",
    );
  }
  url.hash = "";
  if (url.href.length > 2048)
    throw new Error("The page URL exceeds 2048 characters.");
  const selection = window.getSelection();
  const quote = selection?.toString().trim() ?? "";
  if (!quote) return null;
  if (quote.length > 20_000)
    throw new Error("Selections are limited to 20,000 characters.");
  const range = selection.getRangeAt(0);
  // Range offsets on elements count children, not characters. Use ranges so
  // selections crossing inline elements preserve the actual nearby text.
  const ancestor =
    range.commonAncestorContainer.nodeType === Node.TEXT_NODE
      ? range.commonAncestorContainer.parentElement
      : range.commonAncestorContainer;
  const container =
    ancestor.closest("p,li,blockquote,div,article,section,main,body") ??
    ancestor;
  const before = document.createRange();
  before.selectNodeContents(container);
  before.setEnd(range.startContainer, range.startOffset);
  const after = document.createRange();
  after.selectNodeContents(container);
  after.setStart(range.endContainer, range.endOffset);
  return {
    title: (document.title.trim() || url.hostname).slice(0, 500),
    url: url.href,
    quote,
    contextBefore: before.toString().slice(-180),
    contextAfter: after.toString().slice(0, 180),
  };
}
