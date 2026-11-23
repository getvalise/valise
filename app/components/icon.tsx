import {
  Activity,
  Archive,
  ArchiveRestore,
  ArrowDownUp,
  ArrowUpRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Copy,
  createLucideIcon,
  Download,
  FileText,
  Folder,
  FolderOpen,
  History,
  Info,
  KeyRound,
  Library,
  Link2,
  ListChecks,
  ListFilter,
  LogOut,
  type LucideIcon,
  Minus,
  Moon,
  PanelLeft,
  Paperclip,
  Pencil,
  Plug,
  RotateCw,
  Search,
  Shapes,
  Sparkles,
  Sun,
  Trash2,
  Upload,
  UserRound,
  Users,
  Webhook,
} from "lucide-react";

/**
 * The console's icons, as a closed set.
 *
 * Importing from `lucide-react` at the call site would make the vocabulary
 * whatever each route reached for, which is how a system ends up with three
 * different ticks. The union below is the review surface: adding an icon is a
 * line in this file, and `/workbench` draws every one of them.
 *
 * They are drawn at 16px on a 1.5 stroke rather than lucide's 24 and 2. The
 * whole design language is hairlines, and the default weight sits heavier than
 * every rule on the page next to it.
 */

/*
 * Valise's own glyphs, for the nouns lucide has no drawing of: the clasp on a
 * strap, a claim as a buckled latch, a lease as a strap's holes, the case
 * itself, a memory as a travel sticker, a luggage tag. Same 24-unit box and
 * the same stroke as lucide, drawn to fill about 20 units of it so they sit
 * level beside a lucide icon. The references are in Valise,
 * memory:mem_11a9d8e7-df84-4431-bc73-5883337fd7bf.
 */
const solid = { fill: "currentColor", stroke: "none" };

const Clasp = createLucideIcon("clasp", [
  [
    "path",
    {
      d: "M8.5 7.5H4.5A3.5 3.5 0 0 0 1 11v2a3.5 3.5 0 0 0 3.5 3.5h4M17.5 7.5h2A3.5 3.5 0 0 1 23 11v2a3.5 3.5 0 0 1-3.5 3.5h-2",
      key: "strap",
    },
  ],
  [
    "rect",
    { x: "8.5", y: "3", width: "9", height: "18", rx: "2.5", key: "frame" },
  ],
  ["path", { d: "M12 12h5.5", key: "prong" }],
  ["circle", { cx: "5", cy: "12", r: "1.5", ...solid, key: "hole" }],
]);

const Claimed = createLucideIcon("claimed", [
  ["path", { d: "M9 8H3a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h6", key: "left" }],
  [
    "rect",
    { x: "9", y: "4.5", width: "5", height: "15", rx: "1.75", key: "latch" },
  ],
  [
    "path",
    {
      d: "M14 10h1.5v4H14M15.5 8H21a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-5.5z",
      key: "tongue",
    },
  ],
]);

/* The same latch, the two halves apart at different heights: a gap alone is
   one pixel at 16px and reads as Claimed. */
const Released = createLucideIcon("released", [
  ["path", { d: "M8 5.5H3a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h5", key: "left" }],
  [
    "rect",
    { x: "8", y: "2", width: "5", height: "15", rx: "1.75", key: "latch" },
  ],
  [
    "path",
    {
      d: "M16 12.5h1.5v4H16M17.5 10.5H21a2 2 0 0 1 2 2v4a2 2 0 0 1-2 2h-3.5z",
      key: "tongue",
    },
  ],
]);

/* A strap through its keeper, with the hole in use filled. A rounded tip, so
   it does not read as an arrow. */
const Lease = createLucideIcon("lease", [
  ["path", { d: "M1 7h2.5M7 7h11a5 5 0 0 1 0 10H7M3.5 17H1", key: "strap" }],
  [
    "rect",
    { x: "3.5", y: "4", width: "3.5", height: "16", rx: "1", key: "keeper" },
  ],
  ["circle", { cx: "11.5", cy: "12", r: "1.75", ...solid, key: "used" }],
  ["circle", { cx: "16.5", cy: "12", r: "1.5", key: "free" }],
]);

/*
 * The mark: a solid case with two strap channels, a near-square handle and a
 * V cut through the body. The V is drawn to Futura Bold's geometry (even
 * strokes meeting in a sharp point) rather than set from the font, so
 * it needs no font file. Drawn after Noun Project 2043819, not traced.
 */
const Valise = createLucideIcon("valise", [
  [
    "path",
    {
      d: "M3 7H21A1 1 0 0 1 22 8V20A1 1 0 0 1 21 21H3A1 1 0 0 1 2 20V8A1 1 0 0 1 3 7ZM5.6 7H6.7V21H5.6ZM17.3 7H18.4V21H17.3ZM8.1 9.6H10.35L12 14.55L13.65 9.6H15.9L12 18.4Z",
      fillRule: "evenodd",
      ...solid,
      key: "case",
    },
  ],
  [
    "path",
    {
      d: "M8.5 7V4.1A0.6 0.6 0 0 1 9.1 3.5H14.9A0.6 0.6 0 0 1 15.5 4.1V7H13.9V5.1H10.1V7Z",
      ...solid,
      key: "handle",
    },
  ],
]);

/* A travel sticker, peeling: a memory of a place. */
const Sticker = createLucideIcon("sticker", [
  ["path", { d: "M22 12A10 10 0 1 0 12 22", key: "edge" }],
  ["path", { d: "M12 22c0-5.5 4.5-10 10-10L12 22z", key: "peel" }],
  ["path", { d: "M5.5 15l4-5.5 4 5.5", key: "peak" }],
  ["circle", { cx: "15", cy: "7.5", r: "1.5", key: "sun" }],
]);

const LuggageTag = createLucideIcon("luggage-tag", [
  [
    "path",
    { d: "M1.5 12 7.5 4.5h13a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2h-13z", key: "tag" },
  ],
  ["circle", { cx: "8", cy: "12", r: "2", key: "eyelet" }],
  ["path", { d: "M13 9.5h6M13 14.5h4", key: "lines" }],
]);

/*
 * Close and add as stitches: two threads with a slight arc, crossed. Every
 * close and every + in the console is one of these. They draw a little
 * heavier than the set, as thread does beside a hairline.
 */
const thread = { strokeWidth: 2.25, strokeLinecap: "round" } as const;

const StitchClose = createLucideIcon("stitch-close", [
  ["path", { d: "M6.75 6.75Q12.6 11.4 17.25 17.25", ...thread, key: "a" }],
  ["path", { d: "M17.25 6.75Q11.4 12.6 6.75 17.25", ...thread, key: "b" }],
]);

const StitchAdd = createLucideIcon("stitch-add", [
  ["path", { d: "M12 5.75Q11.3 12 12 18.25", ...thread, key: "a" }],
  ["path", { d: "M5.75 12Q12 12.7 18.25 12", ...thread, key: "b" }],
]);

const ICONS = {
  search: Search,
  filter: ListFilter,
  add: StitchAdd,
  remove: Minus,
  check: Check,
  edit: Pencil,
  close: StitchClose,
  expand: ChevronRight,
  expanded: ChevronDown,
  copy: Copy,
  external: ArrowUpRight,
  delete: Trash2,
  refresh: RotateCw,
  lease: Lease,
  token: KeyRound,
  file: FileText,
  folder: Folder,
  folderOpen: FolderOpen,
  info: Info,
  alert: CircleAlert,
  download: Download,
  upload: Upload,
  clasp: Clasp,
  claimed: Claimed,
  released: Released,
  valise: Valise,
  memory: Sticker,
  tag: LuggageTag,
  todos: ListChecks,
  skills: Sparkles,
  library: Library,
  activity: Activity,
  connections: Plug,
  hooks: Webhook,
  workbench: Shapes,
  people: Users,
  account: UserRound,
  signOut: LogOut,
  light: Sun,
  dark: Moon,
  sidebar: PanelLeft,
  sort: ArrowDownUp,
  archive: Archive,
  restore: ArchiveRestore,
  history: History,
  link: Link2,
  attach: Paperclip,
} satisfies Record<string, LucideIcon>;

export type IconName = keyof typeof ICONS;

export const ICON_NAMES = Object.keys(ICONS) as IconName[];

/* Stroke weights that differ from the set's 1.5; the mark is solid. */
const WEIGHT: Partial<Record<IconName, number>> = {};

/**
 * Decorative by default. An icon that carries meaning on its own takes a
 * `label`, which turns it into an `img` role with that accessible name.
 */
export function Icon({
  name,
  label,
  size = 16,
}: {
  name: IconName;
  label?: string;
  size?: number;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      absoluteStrokeWidth
      aria-hidden={label ? undefined : true}
      aria-label={label}
      className="icon"
      role={label ? "img" : undefined}
      size={size}
      strokeWidth={WEIGHT[name] ?? 1.5}
    />
  );
}
