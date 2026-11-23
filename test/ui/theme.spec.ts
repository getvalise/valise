import type { Locator, Page } from "@playwright/test";
import { expect, goto, seed, test } from "./fixtures/session";

/*
 * The evidence for rules V1–V7 in docs/design/principles.md, on the console's
 * real routes in both themes. Token values are read from the page, never
 * pinned here, so the palette can be tuned without editing a test; what is
 * pinned is the relationship each rule states.
 */

const ROUTES = [
  "/todos",
  "/memories",
  "/skills",
  "/library",
  "/hooks",
  "/connections",
  "/workbench?tab=components",
];

/*
 * In-page helpers, installed before every navigation. A string, not a
 * closure: this repo compiles without the DOM lib. Colours go through a 1×1
 * canvas, so any computed syntax (rgb, oklch, color-mix) comes back as sRGB
 * bytes. The light swatches on /workbench sit inside a dark page on purpose,
 * so `[data-theme-swatches]` is outside every audit.
 */
const HELPERS = `(() => {
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  const cache = new Map();
  const rgba = (c) => {
    if (cache.has(c)) return cache.get(c);
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = c;
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    const v = [d[0], d[1], d[2], d[3] / 255];
    cache.set(c, v);
    return v;
  };
  const lin = (u) => { u /= 255; return u <= 0.04045 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
  const oklch = ([r, g, b]) => {
    r = lin(r); g = lin(g); b = lin(b);
    const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
    const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
    const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
    const h = (Math.atan2(B, A) * 180) / Math.PI;
    return [L, Math.hypot(A, B), h < 0 ? h + 360 : h];
  };
  const over = (top, under) => top.slice(0, 3).map((v, i) => v * top[3] + under[i] * (1 - top[3])).concat(1);
  const ground = (el) => {
    const layers = [];
    for (let n = el; n; n = n.parentElement) {
      const c = rgba(getComputedStyle(n).backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] === 1) break; }
    }
    let out = rgba(getComputedStyle(document.documentElement).backgroundColor);
    for (const layer of layers.reverse()) out = over(layer, out);
    return out;
  };
  const luminance = (c) => {
    const [r, g, b] = c.slice(0, 3).map(lin);
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a, b) => {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const role = (name) => {
    const probe = document.createElement("i");
    probe.style.color = "var(" + name + ")";
    document.body.append(probe);
    const value = getComputedStyle(probe).color;
    probe.remove();
    return rgba(value);
  };
  const same = (a, b, tolerance = 0) => a.every((v, i) => Math.abs(v - b[i]) <= (i === 3 ? 0.01 : tolerance));
  const label = (el, pseudo) =>
    el.tagName.toLowerCase() +
    (typeof el.className === "string" && el.className.trim() ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "") +
    (pseudo || "") +
    ((el.textContent || "").trim() ? " '" + el.textContent.trim().slice(0, 24) + "'" : "");
  const painted = (el) => !el.closest("[data-theme-swatches]") && el.getClientRects().length > 0;
  const COLOUR = /(?:rgba?|oklch|oklab|color-mix|color|lab|lch|hsla?)\\([^()]*(?:\\([^()]*\\)[^()]*)*\\)|#[0-9a-f]{3,8}\\b/gi;
  /* Every colour an element or its pseudo-elements paint, by property. */
  const colours = (el) => {
    const out = [];
    for (const pseudo of [null, "::before", "::after"]) {
      const s = getComputedStyle(el, pseudo);
      if (pseudo && (s.content === "none" || s.content === "normal")) continue;
      if (s.visibility === "hidden" || s.display === "none") continue;
      const props = ["color", "background-color", "box-shadow"];
      for (const side of ["top", "right", "bottom", "left"])
        if (s.getPropertyValue("border-" + side + "-style") !== "none" && parseFloat(s.getPropertyValue("border-" + side + "-width")) > 0)
          props.push("border-" + side + "-color");
      if (s.outlineStyle !== "none" && parseFloat(s.outlineWidth) > 0) props.push("outline-color");
      if (s.textDecorationLine !== "none") props.push("text-decoration-color");
      for (const prop of props)
        for (const value of s.getPropertyValue(prop).match(COLOUR) ?? [])
          out.push({ pseudo, prop, value, rgba: rgba(value) });
    }
    return out;
  };
  window.__valise = { rgba, oklch, ground, ratio, role, same, label, painted, colours, over };
})()`;

/** Runs `body` in the page with the helpers as `v`. Returns its JSON value. */
function inPage<T>(page: Page, body: string, arg: unknown = null): Promise<T> {
  return page.evaluate<T>(
    `(() => { const v = window.__valise; const arg = ${JSON.stringify(arg)}; ${body} })()`,
  );
}

const open = goto;

/** Marks one element so an in-page check can find it by `[data-probe]`. */
async function mark(locator: Locator, name: string) {
  await locator.evaluate(
    (node, value) =>
      (
        node as unknown as { setAttribute(key: string, value: string): void }
      ).setAttribute("data-probe", value),
    name,
  );
  return `[data-probe=${name}]`;
}

for (const theme of ["light", "dark"] as const) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page, request, baseURL }) => {
      await seed(request);
      await page
        .context()
        .addCookies([
          { name: "valise_theme", value: theme, url: baseURL ?? "" },
        ]);
      await page.addInitScript(HELPERS);
    });

    test("V1: purple is a fill, its hover is near-black, and purple text is brand ink", async ({
      page,
    }) => {
      for (const path of ROUTES) {
        await open(page, path);
        await expect(page.locator("html")).toHaveClass(
          theme === "dark" ? /\bdark\b/ : /^(?!.*\bdark\b)/,
        );
        // Anything purple on the page: a fill or a rule must be the primary
        // itself, text must be the brand-ink role. No lilac, no tint.
        const strays = await inPage<string[]>(
          page,
          `const primary = v.role("--primary");
           const ink = v.role("--brand-ink");
           const out = [];
           for (const el of document.querySelectorAll("body *")) {
             if (el.closest("svg") || !v.painted(el)) continue;
             for (const c of v.colours(el)) {
               if (c.rgba[3] === 0 || c.prop === "box-shadow") continue;
               const [, chroma, hue] = v.oklch(c.rgba);
               if (chroma < 0.04 || hue < 270 || hue > 330) continue;
               const want = c.prop === "color" || c.prop === "text-decoration-color" ? ink : primary;
               if (!v.same(c.rgba, want, 1)) out.push(v.label(el, c.pseudo) + " " + c.prop + " " + c.value);
             }
           }
           return [...new Set(out)];`,
        );
        expect.soft(strays, `${theme} ${path}`).toEqual([]);
      }

      // Brand ink is purple on the light ground and sand on the dark one.
      await open(page, "/todos");
      const roles = await inPage<{ primary: number[]; ink: number[] }>(
        page,
        `return { primary: v.role("--primary"), ink: v.role("--brand-ink") };`,
      );
      if (theme === "light") expect(roles.ink).toEqual(roles.primary);
      else expect(roles.ink).not.toEqual(roles.primary);
      const word = await inPage<boolean>(
        page,
        `const word = document.querySelector(".masthead-word");
         return v.same(v.rgba(getComputedStyle(word).color), v.role("--brand-ink"));`,
      );
      expect(word).toBe(true);

      // A primary button, native and shadcn, under the pointer.
      const fill = (selector: string) =>
        inPage<{ primary: boolean; hover: boolean }>(
          page,
          `const el = document.querySelector(arg);
           const bg = v.rgba(getComputedStyle(el).backgroundColor);
           return { primary: v.same(bg, v.role("--primary")), hover: v.same(bg, v.role("--primary-hover")) };`,
          selector,
        );
      await open(page, "/connections");
      const create = page.getByRole("button", { name: "Create token" });
      const native = await mark(create, "native");
      await page.mouse.move(0, 0);
      expect(await fill(native)).toEqual({ primary: true, hover: false });
      await create.hover();
      await expect
        .poll(() => fill(native))
        .toEqual({ primary: false, hover: true });

      await open(page, "/workbench?tab=components");
      const shadcn = page
        .getByTestId("specimen")
        .getByRole("button", { name: "Primary", exact: true })
        .and(page.locator("[data-slot=button]"));
      const button = await mark(shadcn, "shadcn");
      await page.mouse.move(0, 0);
      expect(await fill(button)).toEqual({ primary: true, hover: false });
      await shadcn.hover();
      await expect
        .poll(() => fill(button))
        .toEqual({ primary: false, hover: true });

      // A switch that is on is filled with the primary.
      await open(page, "/hooks");
      const on = await inPage<boolean[]>(
        page,
        `return [...document.querySelectorAll('[role=switch][aria-checked=true] .belt-strap')]
           .map((track) => v.same(v.rgba(getComputedStyle(track).backgroundColor), v.role("--primary")));`,
      );
      expect(on.length).toBeGreaterThan(0);
      expect(on.every(Boolean)).toBe(true);
    });

    test("V2 and V4: no grey and no dotted line on any route", async ({
      page,
    }) => {
      for (const path of ROUTES) {
        await open(page, path);
        const found = await inPage<{ grey: string[]; dotted: string[] }>(
          page,
          `const grey = [];
           const dotted = [];
           for (const el of document.querySelectorAll("body *")) {
             if (!v.painted(el)) continue;
             const inSvg = el.closest("svg") && el.tagName.toLowerCase() !== "svg";
             if (!inSvg)
               for (const c of v.colours(el)) {
                 if (c.rgba[3] === 0) continue;
                 const [, chroma] = v.oklch(c.rgba);
                 if (chroma < 0.012) grey.push(v.label(el, c.pseudo) + " " + c.prop + " " + c.value);
               }
             for (const pseudo of [null, "::before", "::after"]) {
               const s = getComputedStyle(el, pseudo);
               if (pseudo && (s.content === "none" || s.content === "normal")) continue;
               for (const side of ["top", "right", "bottom", "left"])
                 if (s.getPropertyValue("border-" + side + "-style") === "dotted" && parseFloat(s.getPropertyValue("border-" + side + "-width")) > 0)
                   dotted.push(v.label(el, pseudo) + " border-" + side);
               if (s.outlineStyle === "dotted" && parseFloat(s.outlineWidth) > 0) dotted.push(v.label(el, pseudo) + " outline");
               if (s.textDecorationStyle === "dotted" && s.textDecorationLine !== "none") dotted.push(v.label(el, pseudo) + " text-decoration");
             }
           }
           return { grey: [...new Set(grey)], dotted: [...new Set(dotted)] };`,
        );
        expect.soft(found.grey, `grey on ${theme} ${path}`).toEqual([]);
        expect.soft(found.dotted, `dotted on ${theme} ${path}`).toEqual([]);
      }
    });

    test("V3: tags are saddle leather, a project is an unboxed folder ahead of them, hover is sand", async ({
      page,
    }) => {
      for (const path of ["/memories", "/skills"]) {
        await open(page, path);
        const row = page
          .locator(".item-row")
          .filter({ has: page.locator(".tag") })
          .filter({ has: page.locator(".project-chip") })
          .first();
        await expect(row, path).toBeVisible();
        await mark(row, "row");
        const facts = await inPage<{
          tagFill: boolean;
          tagInk: boolean;
          chipBorder: string;
          chipFill: number;
          chipFolder: boolean;
          chipFirst: boolean;
        }>(
          page,
          `const row = document.querySelector("[data-probe=row]");
           const tag = row.querySelector(".tag");
           const chip = row.querySelector(".project-chip");
           const t = getComputedStyle(tag);
           const c = getComputedStyle(chip);
           return {
             tagFill: v.same(v.rgba(t.backgroundColor), v.role("--saddle")),
             tagInk: v.same(v.rgba(t.color), v.role("--saddle-foreground")),
             chipBorder: c.borderTopWidth,
             chipFill: v.rgba(c.backgroundColor)[3],
             chipFolder: chip.querySelector("svg.lucide-folder") !== null,
             chipFirst: Boolean(chip.compareDocumentPosition(tag) & 4),
           };`,
        );
        expect(facts, path).toEqual({
          tagFill: true,
          tagInk: true,
          chipBorder: "0px",
          chipFill: 0,
          chipFolder: true,
          chipFirst: true,
        });

        // Hover is the sand accent, not a tint of purple.
        await row.locator(".item-title").hover();
        await expect
          .poll(() =>
            inPage<boolean>(
              page,
              `const bg = v.rgba(getComputedStyle(document.querySelector("[data-probe=row]")).backgroundColor);
               const accent = v.role("--accent");
               return bg[3] > 0 && v.same(bg.slice(0, 3).concat(1), accent, 4);`,
            ),
          )
          .toBe(true);
      }
    });

    test("V4: the stitch runs around the add row and down the desktop pane, not the phone sheet", async ({
      page,
    }) => {
      const stitched = (selector: string) =>
        inPage<boolean>(
          page,
          `const el = document.querySelector(arg);
           if (!el) return false;
           return [null, "::before"].some((pseudo) => {
             const s = getComputedStyle(el, pseudo);
             return s.display !== "none" && s.backgroundImage.includes("url(");
           });`,
          selector,
        );
      for (const path of ["/todos", "/skills", "/library"]) {
        await open(page, path);
        await expect(page.locator(".add-row-link").first()).toBeVisible();
        expect(await stitched(".add-row-link"), path).toBe(true);
      }

      await page.setViewportSize({ width: 1440, height: 900 });
      await open(page, "/todos");
      await page.locator(".todo-open").first().click();
      const pane = page.locator("dialog.modal-pane[open]");
      await expect(pane).toBeVisible();
      expect(await stitched("dialog.modal-pane[open]")).toBe(true);
      await expect(pane).toHaveCSS("border-left-width", "0px");

      await page.setViewportSize({ width: 390, height: 844 });
      await open(page, "/todos");
      await page.locator(".todo-open").first().click();
      await expect(page.locator("dialog.modal-sheet[open]")).toBeVisible();
      expect(await stitched("dialog.modal-pane[open]")).toBe(false);
    });

    test("V5: the display face sets the page title and masthead, the grotesque the items", async ({
      page,
    }) => {
      for (const path of ["/todos", "/memories", "/skills"]) {
        await open(page, path);
        const faces = await inPage<{
          title: string;
          word: string;
          items: string[];
        }>(
          page,
          `const face = (el) => getComputedStyle(el).fontFamily;
           return {
             title: face(document.querySelector(".page-header h1")),
             word: face(document.querySelector(".masthead-word")),
             items: [...document.querySelectorAll(".item-title, .todo-title")].map(face),
           };`,
        );
        const display = await inPage<string>(
          page,
          `return getComputedStyle(document.documentElement).getPropertyValue("--display").split(",")[0].trim();`,
        );
        expect(faces.title, path).toContain(display);
        expect(faces.word, path).toContain(display);
        expect(faces.items.length, path).toBeGreaterThan(0);
        for (const face of faces.items)
          expect(face, path).not.toContain(display);
      }
    });

    test("V6: small text meets AA on its surface and control outlines meet 3:1", async ({
      page,
    }) => {
      for (const path of ROUTES) {
        await open(page, path);
        const failures = await inPage<string[]>(
          page,
          `const out = [];
           for (const el of document.querySelectorAll("body *")) {
             if (el.closest("svg, [aria-hidden=true], .sr-only, :disabled, [aria-disabled=true]") || !v.painted(el)) continue;
             if (![...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())) continue;
             const s = getComputedStyle(el);
             if (s.visibility === "hidden" || Number(s.opacity) < 1) continue;
             const size = parseFloat(s.fontSize);
             if (size >= 24 || (Number(s.fontWeight) >= 700 && size >= 18.66)) continue;
             const ground = v.ground(el);
             const r = v.ratio(v.over(v.rgba(s.color), ground), ground);
             if (r < 4.5) out.push(v.label(el) + " " + r.toFixed(2));
           }
           return [...new Set(out)];`,
        );
        expect.soft(failures, `text on ${theme} ${path}`).toEqual([]);
      }

      // The outline that tells a control from its surface: a text field's
      // border, an outline button's, the to-do circle's, a switch's track.
      for (const path of ["/todos", "/skills", "/hooks", "/connections"]) {
        await open(page, path);
        const failures = await inPage<string[]>(
          page,
          `const out = [];
           const check = (el, ink, what) => {
             const ground = v.ground(el.parentElement);
             const r = v.ratio(v.over(v.rgba(ink), ground), ground);
             if (r < 3) out.push(v.label(el) + " " + what + " " + r.toFixed(2));
           };
           for (const el of document.querySelectorAll(
             "[data-slot=input-group], input:not([type=hidden]):not([type=checkbox]):not([type=file]):not([data-slot=input-group-control]), textarea, select, [data-slot=button][data-variant=outline], button.ghost, .check-circle",
           )) {
             if (!v.painted(el) || el.closest(":disabled")) continue;
             check(el, getComputedStyle(el).borderTopColor, "border");
           }
           for (const el of document.querySelectorAll("[role=switch][aria-checked=false]:not(:disabled) .belt-strap")) {
             if (v.painted(el)) check(el, getComputedStyle(el).backgroundColor, "track");
           }
           return [...new Set(out)];`,
        );
        expect.soft(failures, `outlines on ${theme} ${path}`).toEqual([]);
      }
    });
  });
}

test("V6 and P10: switch and checkbox targets are at least 24px", async ({
  page,
  request,
}) => {
  await seed(request);
  const small: string[] = [];
  for (const path of [
    "/todos",
    "/skills",
    "/hooks",
    "/workbench?tab=components",
  ]) {
    await goto(page, path);
    // A target is the control's own box or the 24px ::after some draw around
    // a smaller mark; a native checkbox in a label is the label's.
    small.push(
      ...(await page.evaluate<string[]>(`(() => {
        const out = [];
        for (const el of document.querySelectorAll("[role=switch], [role=checkbox], input[type=checkbox]")) {
          if (!el.getClientRects().length) continue;
          const own = el.getBoundingClientRect();
          const after = getComputedStyle(el, "::after");
          const pseudo = after.content !== "none" && after.position === "absolute"
            ? [parseFloat(after.width) || 0, parseFloat(after.height) || 0] : [0, 0];
          const label = el.closest("label")?.getBoundingClientRect();
          const width = Math.max(own.width, pseudo[0], label?.width ?? 0);
          const height = Math.max(own.height, pseudo[1], label?.height ?? 0);
          if (width < 23.5 || height < 23.5)
            out.push(location.pathname + " " + (el.getAttribute("aria-label") || el.className || el.tagName) + " " + Math.round(width) + "x" + Math.round(height));
        }
        return out;
      })()`)),
    );
  }
  expect(small).toEqual([]);
});

test("P10: a switch toggles by pointer, Space and Enter, and a disabled one does not", async ({
  page,
  request,
}) => {
  await seed(request);
  await goto(page, "/workbench?tab=components");
  const switches = page
    .getByTestId("specimen")
    .filter({ hasText: "Renew lease" });
  const control = switches.getByRole("switch", { name: "Renew lease" });
  await expect(control).toBeChecked();
  await control.click();
  await expect(control).not.toBeChecked();
  await control.press("Space");
  await expect(control).toBeChecked();
  await control.press("Enter");
  await expect(control).not.toBeChecked();

  const locked = switches.getByRole("switch", { name: "Managed by policy" });
  await expect(locked).toBeDisabled();
  await locked.click({ force: true });
  await expect(locked).toBeChecked();

  // The real setting on /hooks, toggled and put back.
  await goto(page, "/hooks");
  const real = page.getByRole("switch", {
    name: "Recall reminder enabled",
    exact: true,
  });
  const before = await real.getAttribute("aria-checked");
  await real.click();
  await expect(real).not.toHaveAttribute("aria-checked", before ?? "");
  await real.press("Space");
  await expect(real).toHaveAttribute("aria-checked", before ?? "");
});
