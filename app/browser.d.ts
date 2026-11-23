/**
 * The browser APIs the console calls, and nothing else.
 *
 * `tsconfig.json` sets `lib: ["ES2022"]` with no DOM, because this is a Worker
 * and pulling the DOM in would let `fetch`, `Response`, and `Headers` resolve
 * to the browser's shapes rather than workerd's. React ships empty stubs for
 * that case — `@types/react/global.d.ts` declares `interface HTMLDialogElement
 * extends HTMLElement {}` with no members — so a component that reaches for an
 * element method does not typecheck until the method is declared.
 *
 * Declaring them one at a time is the point. This file is the list of browser
 * APIs the console depends on, and growing it is a decision somebody reads.
 */

interface HTMLElement {
  /** The combobox asks whether focus left the whole widget or moved inside it. */
  contains(other: unknown): boolean;
  focus(): void;
  /** The pane's grip keeps a drag that leaves it. */
  setPointerCapture(pointerId: number): void;
}

interface HTMLDialogElement extends HTMLElement {
  readonly open: boolean;
  /** The only way into the top layer, and the reason `Modal` needs an effect. */
  showModal(): void;
  /** A pane: open, and out of the top layer, so the page stays live. */
  show(): void;
  close(returnValue?: string): void;
}

interface HTMLInputElement extends HTMLElement {
  value: string;
}

interface HTMLFormElement extends HTMLElement {
  /**
   * The inline editor's Cmd-Enter. `submit()` would skip validation and the
   * submit event React Router listens for; `requestSubmit()` is the one that
   * behaves like pressing the button.
   */
  requestSubmit(submitter?: unknown): void;
  /**
   * An optimistic save reads the posted `value` from its own form in the
   * submit handler, so the row paints it before the fetcher's state does.
   */
  readonly elements: {
    namedItem(name: string): { value?: string } | null;
  };
}

/** Which rows show their sub-tasks in the to-do list, kept across a reload. */
declare const localStorage: {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

/** Files dropped on a to-do's dialog. */
interface DataTransfer {
  readonly types: readonly string[];
  readonly files: ArrayLike<File>;
}

/** A file dropped into a description or comment is linked at the caret. */
interface HTMLTextAreaElement extends HTMLElement {
  value: string;
  readonly selectionStart: number;
  readonly selectionEnd: number;
  setRangeText(
    replacement: string,
    start: number,
    end: number,
    selectionMode: "select" | "start" | "end" | "preserve",
  ): void;
}

/**
 * A pane closes on Escape pressed anywhere, unless a field or a modal over
 * it owns the key.
 */
interface KeyboardEvent {
  readonly key: string;
  readonly defaultPrevented: boolean;
  readonly isComposing: boolean;
  readonly repeat: boolean;
  readonly altKey: boolean;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
}

interface Document {
  /** Processing status polling pauses in background tabs. */
  readonly visibilityState: "visible" | "hidden";
  addEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
  ): void;
  querySelector(selectors: string): unknown;
  /** The pane's chosen width is one custom property on the root. */
  readonly documentElement: {
    readonly style: {
      setProperty(name: string, value: string): void;
      removeProperty(name: string): string;
    };
    /** `dark` on the root selects the Tokyo Night theme. */
    readonly classList: {
      contains(token: string): boolean;
      toggle(token: string, force?: boolean): boolean;
    };
  };
  /** The theme choice and the sidebar's pinned state. */
  cookie: string;
}

/**
 * The pane's width is bounded by the window's; the sidebar listens for its
 * shortcut and its mobile breakpoint.
 */
declare const window: {
  readonly innerWidth: number;
  addEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: KeyboardEvent) => void,
  ): void;
  matchMedia(query: string): {
    readonly matches: boolean;
    addEventListener(type: "change", listener: () => void): void;
    removeEventListener(type: "change", listener: () => void): void;
  };
};
