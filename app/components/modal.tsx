import {
  type DragEvent,
  type PointerEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router";
import { useHydrated } from "~/components/editable";
import { Icon } from "~/components/icon";

/**
 * A modal on the native `<dialog>`, so the focus trap, the inert background,
 * and Escape are the platform's behaviour rather than ours.
 *
 * `showModal()` is the only way into the top layer and it only exists on the
 * client. Until hydration an open dialog is rendered with the `open`
 * attribute, so with scripting off it still shows, in the page's flow and
 * without a backdrop (P11). Once hydrated the attribute goes and
 * `showModal()` takes over; removing it fires no `close`, so the caller's
 * state is not told the dialog shut.
 *
 * `size="pane"` is the same element docked on the window's right edge and
 * opened with `show()`, not `showModal()`: no backdrop, no trap, and the page
 * beside it stays live, so a list can be read and worked while one of its
 * items is open. The page narrows to make room rather than running under it;
 * the narrower rows rewrap, so opening and closing hold the pane's row at the
 * height it was clicked at (P4). The platform gives a non-modal dialog no
 * Escape, so the pane listens for it. Its left edge is a resize grip.
 */
export function Modal({
  open,
  title,
  heading,
  onClose,
  children,
  footer,
  onFiles,
  size = "default",
  mobileSheet = false,
  closeHref,
  headerActions,
}: {
  open: boolean;
  /** The accessible name, and the seed for the heading's id. Always a string. */
  title: string;
  /**
   * A heading element to use instead of the plain one — an editable title,
   * say. It replaces the `<h2>` rather than filling it, because an inline
   * editor is a form and a form inside a heading is not markup. The
   * accessible name stays `title`, so a heading mid-edit does not rename the
   * dialog underneath a screen reader.
   */
  heading?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  /**
   * A reading-width detail dialog; small confirmation and editor dialogs stay
   * narrow. A pane docks on the right edge and leaves the page live.
   */
  size?: "default" | "wide" | "pane";
  /**
   * Files dropped anywhere on the dialog, with the element they landed on.
   * Set, the dialog takes a file drag instead of letting the browser open
   * the file in place of the page, and marks itself while one is over it.
   */
  onFiles?: (files: File[], target: unknown) => void;
  /** Opt-in phone sheet; unhydrated panes retain the full-screen native path. */
  mobileSheet?: boolean;
  closeHref?: string;
  headerActions?: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement & { scrollTop: number }>(null);
  const hydrated = useHydrated();
  const [dropping, setDropping] = useState(false);
  const pane = size === "pane";
  const [fullSheet, setFullSheet] = useState(false);
  const sheet = pane && mobileSheet && hydrated;
  const sheetField = useRef<{
    scrollIntoView(options: { block: "nearest"; behavior: "instant" }): void;
  } | null>(null);
  useLayoutEffect(() => {
    // Expansion changes the scrollport after the browser's initial focus scroll.
    if (sheet && fullSheet && window.innerWidth < 768) {
      sheetField.current?.scrollIntoView({
        block: "nearest",
        behavior: "instant",
      });
    }
  }, [sheet, fullSheet]);
  // Opened by the server render, not a click: nothing was clicked to hold.
  const fromServer = useRef(!hydrated);
  // Only a drag carrying files; text dragged between fields stays the
  // browser's.
  const carriesFiles = (event: DragEvent<HTMLDialogElement>) =>
    onFiles !== undefined && event.dataTransfer.types.includes("Files");

  // A layout effect, so the page never paints wide between one pane closing
  // and the next opening.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog === null || !hydrated) return;
    if (open && !dialog.open) {
      if (!pane) dialog.showModal();
      else if (fromServer.current || paneHandoff) dialog.show();
      else holdRow(dialog, () => dialog.show());
      if (pane && mobileSheet) revealAboveSheet(dialog);
      fromServer.current = false;
      // Opening starts at the heading, not a scroll offset restored from the
      // non-modal server render. Edits inside an open dialog keep their place.
      if (body.current) body.current.scrollTop = 0;
    }
    if (!open && dialog.open) closeDialog(dialog, pane);
    if (!pane) return;
    // Another row's pane replacing this one keeps the page narrow, so the
    // row it opens needs no holding: it is where it was clicked.
    return () => {
      if (!dialog.open) return;
      paneHandoff = true;
      queueMicrotask(() => {
        paneHandoff = false;
      });
    };
  }, [open, hydrated, pane, mobileSheet]);

  // Escape anywhere on the page closes the pane, unless it belongs to
  // something nearer: a field being typed in, an editor that cancels on it,
  // or a modal open over the pane (a file preview), which closes first.
  useEffect(() => {
    if (!pane || !open || !hydrated) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as {
        closest?(selectors: string): unknown;
      } | null;
      if (target?.closest?.("input, textarea, select, [contenteditable]")) {
        return;
      }
      if (document.querySelector("dialog:modal")) return;
      if (ref.current) closeDialog(ref.current, true);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [pane, open, hydrated]);

  return (
    <dialog
      // The name, not the heading: a heading mid-edit holds a text field and
      // a pen, and `aria-labelledby` would read the dialog as all three.
      aria-label={title}
      className={`modal${size === "wide" ? " modal-wide" : ""}${pane ? " modal-pane" : ""}${sheet ? " modal-sheet" : ""}${dropping ? " is-dropping" : ""}`}
      data-sheet-height={sheet ? (fullSheet ? "full" : "half") : undefined}
      onFocusCapture={(event) => {
        const target = event.target as unknown as {
          closest?(selector: string): unknown;
          scrollIntoView(options: {
            block: "nearest";
            behavior: "instant";
          }): void;
        };
        if (
          sheet &&
          target.closest?.(
            "input, textarea, select, [contenteditable], [role=textbox], [role=combobox]",
          )
        ) {
          sheetField.current = target;
          setFullSheet(true);
        }
      }}
      // Escape and the close button both land here, so the caller's state
      // follows the element rather than the other way round. React bubbles
      // `close` through its tree although the DOM event does not bubble, so
      // a nested modal shutting (a file preview inside a to-do) would
      // otherwise close this one too.
      onClose={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      open={open && !hydrated}
      // `<dialog>` takes the full viewport as its hit area, so a click that
      // lands on the element itself rather than on a child is the backdrop.
      // A pane has no backdrop: a click on its own padding is just a click.
      onClick={(event) => {
        if (!pane && event.target === event.currentTarget) {
          ref.current?.close();
        }
      }}
      onDragOver={(event) => {
        if (!carriesFiles(event)) return;
        event.preventDefault();
        setDropping(true);
      }}
      // A leave into something outside the dialog, or nowhere (the window,
      // or the drag called off), ends it; a leave between its children does
      // not.
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setDropping(false);
        }
      }}
      onDrop={(event) => {
        setDropping(false);
        if (!carriesFiles(event)) return;
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        if (files.length > 0) onFiles?.(files, event.target);
      }}
      ref={ref}
    >
      {sheet ? <SheetGrip full={fullSheet} onChange={setFullSheet} /> : null}
      <header>
        {heading ?? <h2>{title}</h2>}
        {!hydrated && closeHref ? (
          <Link
            aria-label="Close"
            className="button ghost small stitch-button"
            to={closeHref}
            replace
            preventScrollReset
          >
            <Icon name="close" />
          </Link>
        ) : (
          <button
            aria-label="Close"
            className="ghost small stitch-button"
            onClick={() => {
              if (ref.current) closeDialog(ref.current, pane);
            }}
            type="button"
          >
            <Icon name="close" />
          </button>
        )}
      </header>
      {headerActions}
      <div className="modal-body" ref={body}>
        {children}
      </div>
      {footer ? <footer>{footer}</footer> : null}
      {/* Last in the markup, so opening the pane focuses its content, not
          the grip; it is positioned on the left edge regardless. */}
      {pane ? <PaneGrip /> : null}
    </dialog>
  );
}

/** A native button is the single-pointer alternative to dragging (WCAG 2.5.7). */
function SheetGrip({
  full,
  onChange,
}: {
  full: boolean;
  onChange: (full: boolean) => void;
}) {
  const start = useRef<number | null>(null);
  const dragged = useRef(false);
  return (
    <button
      type="button"
      className="sheet-grip"
      aria-label={full ? "Show half-height to-do sheet" : "Expand to-do sheet"}
      aria-expanded={full}
      onClick={() => {
        if (!dragged.current) onChange(!full);
        dragged.current = false;
      }}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        start.current = event.clientY;
        dragged.current = false;
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerUp={(event) => {
        if (
          start.current !== null &&
          Math.abs(event.clientY - start.current) > 40
        ) {
          onChange(event.clientY < start.current);
          dragged.current = true;
        }
        start.current = null;
      }}
      onPointerCancel={() => {
        start.current = null;
        dragged.current = false;
      }}
    ></button>
  );
}

/** Set while one pane hands over to the next within a single commit. */
let paneHandoff = false;

/**
 * Run `change`, then scroll so the element holding `dialog` (its row) sits
 * as high in the viewport as before. Opening or closing a pane changes the
 * page's width; the rows rewrap, and without this the one just clicked moves
 * under the pointer. The browser's own scroll anchoring may pick another
 * node, so the row is measured rather than trusted to it.
 */
function holdRow(dialog: HTMLDialogElement, change: () => void) {
  // This repo compiles without the DOM lib; these are the two calls it needs.
  const row = (dialog as unknown as { parentElement: Measured | null })
    .parentElement;
  const before = row?.getBoundingClientRect().top;
  change();
  if (!row || before === undefined) return;
  const moved = row.getBoundingClientRect().top - before;
  if (moved !== 0)
    (window as unknown as Scrollable).scrollBy({
      top: moved,
      behavior: "instant",
    });
}

/**
 * On a phone the pane is a bottom sheet, and holding a row tapped in the lower
 * half would leave it under the sheet it opened. Scroll by the overlap only,
 * so the open row sits on the sheet's edge, still visible and marked.
 */
function revealAboveSheet(dialog: HTMLDialogElement) {
  if (window.innerWidth >= 768) return;
  const row = (dialog as unknown as { parentElement: Bounded | null })
    .parentElement;
  if (!row) return;
  const hidden =
    row.getBoundingClientRect().bottom -
    (dialog as unknown as Bounded).getBoundingClientRect().top;
  if (hidden > 0)
    (window as unknown as Scrollable).scrollBy({
      top: hidden,
      behavior: "instant",
    });
}

type Measured = { getBoundingClientRect(): { top: number } };
type Bounded = { getBoundingClientRect(): { top: number; bottom: number } };
type Scrollable = {
  scrollBy(options: { top: number; behavior: "instant" }): void;
};

function closeDialog(dialog: HTMLDialogElement, pane: boolean) {
  if (pane) holdRow(dialog, () => dialog.close());
  else dialog.close();
}

const PANE_WIDTH = "valise:pane-width";

/*
 * The bounds the stylesheet clamps the pane to, in px at the 15px root:
 * 22rem, 36rem or 45% of the window by default, and 70% of the window. The
 * stylesheet's clamp is the authority; these keep the keyboard steps and the
 * separator's announced value inside it.
 */
const PANE_MIN = 22 * 15;
const paneMax = () => Math.round(window.innerWidth * 0.7);
const paneDefault = () =>
  Math.min(36 * 15, Math.round(window.innerWidth * 0.45));

/**
 * The chosen width, set on the root before the first paint. The grip's effect
 * reads the same key only after hydration, so a reload painted the default
 * width and then moved the divider to the stored one a frame later. Inlined in
 * the document head next to the theme script; it clamps as `apply` does.
 */
export const PANE_WIDTH_SCRIPT = `(function(){try{var w=Number(localStorage.getItem("${PANE_WIDTH}"));if(w>0){w=Math.min(Math.round(innerWidth*0.7),Math.max(${PANE_MIN},Math.round(w)));document.documentElement.style.setProperty("--pane-chosen",w+"px")}}catch(e){}})()`;

/**
 * The pane's left edge, as a separator a person can drag: nothing drawn, the
 * resize cursor on hover. Arrow keys step it 16px, Shift 64px; a double click forgets the
 * chosen width. The width is a per-browser preference, not something one
 * sends, so it lives in localStorage rather than the URL (P3), and it is one
 * custom property on the root, read by the pane's width.
 */
function PaneGrip() {
  const [width, setWidth] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  // APG's window splitter names both bounds; the upper one is the window's.
  const [max, setMax] = useState<number>();

  const apply = (px: number | null, keep: boolean) => {
    const style = document.documentElement.style;
    if (px === null) {
      style.removeProperty("--pane-chosen");
      localStorage.removeItem(PANE_WIDTH);
      setWidth(null);
      return;
    }
    const clamped = Math.min(paneMax(), Math.max(PANE_MIN, Math.round(px)));
    style.setProperty("--pane-chosen", `${clamped}px`);
    if (keep) localStorage.setItem(PANE_WIDTH, String(clamped));
    setWidth(clamped);
  };

  useEffect(() => {
    const stored = Number(localStorage.getItem(PANE_WIDTH));
    if (stored > 0) apply(stored, false);
    setMax(paneMax());
  }, []);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = event.shiftKey ? 64 : 16;
    const from = width ?? paneDefault();
    const next = {
      ArrowLeft: from + step,
      ArrowRight: from - step,
      Home: paneMax(),
      End: PANE_MIN,
    }[event.key];
    if (next === undefined) return;
    event.preventDefault();
    apply(next, true);
  };

  return (
    // A separator with a value is a focusable widget in ARIA, so it takes
    // the keyboard as well as the pointer. Captured, the pointer keeps
    // reporting to the grip however far it is dragged.
    <div
      aria-label="Resize the pane"
      aria-orientation="vertical"
      aria-valuemax={max}
      aria-valuemin={PANE_MIN}
      aria-valuenow={width ?? undefined}
      className={`pane-grip${dragging ? " is-dragging" : ""}`}
      onDoubleClick={() => apply(null, false)}
      onKeyDown={onKeyDown}
      onPointerCancel={() => setDragging(false)}
      onPointerDown={(event: PointerEvent<HTMLDivElement>) => {
        if (event.button !== 0) return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        setDragging(true);
      }}
      onPointerMove={(event) => {
        if (dragging) apply(window.innerWidth - event.clientX, true);
      }}
      onPointerUp={() => setDragging(false)}
      role="separator"
      tabIndex={0}
    >
      {/* A line, not a handle: shadcn's resizable edge. */}
      <span aria-hidden="true" className="pane-grip-line" />
    </div>
  );
}
