import ReactMarkdown, { type Options } from "react-markdown";
import remarkGfm from "remark-gfm";
import { Icon } from "~/components/icon";
import { MentionTitles, TodoMentionCard } from "~/components/todo-mention";
import { TODO_MENTION } from "~/concepts/todo-mentions";

/**
 * Bodies are Markdown written by agents. react-markdown renders to React
 * elements and drops raw HTML by default, so an agent-written body can never
 * become markup in the console.
 *
 * With `tasks`, GFM checkboxes stop being the disabled decoration remark
 * emits and become submit buttons. Each one posts the source line it came
 * from and the state it was rendered in, which `app/concepts/task-list.ts`
 * turns back into one changed line. The caller supplies the surrounding
 * `<form>`; this renders no form of its own, because the body may sit inside
 * one already and a nested form is not markup.
 */
export function Markdown({
  children,
  tasks,
  plugins = [],
}: {
  children: string;
  /** The field name each checkbox posts under. Omit for a read-only body. */
  tasks?: { name: string };
  /**
   * More rehype plugins, after the task-source one; `highlightCode` from
   * `~/components/code-highlight` colours fenced code. A separate module, so
   * pages that do not ask for it do not load its grammars.
   */
  plugins?: NonNullable<Options["rehypePlugins"]>;
}) {
  return (
    <MentionTitles text={children}>
      <div className="prose">
        <ReactMarkdown
          components={{
            // Bodies link out to repos and docs; keep the console page open.
            // A `todo:tdo_…` in the text is a to-do's card, not a link out.
            a: ({ node, ...props }) => {
              const mention = node?.properties?.dataMention;
              return typeof mention === "string" ? (
                <TodoMentionCard id={mention} />
              ) : (
                <a {...props} rel="noreferrer" target="_blank" />
              );
            },
            input: ({ node }) => {
              const properties = node?.properties ?? {};
              const checked = properties.checked === true;
              const line = properties.dataLine;
              if (tasks === undefined || typeof line !== "number") {
                return (
                  <input checked={checked} disabled readOnly type="checkbox" />
                );
              }
              return (
                <button
                  aria-checked={checked}
                  className="task-box"
                  // The visible text is the item beside it, which is a sibling
                  // rather than a label, so the control names itself. APG
                  // checkbox pattern.
                  aria-label={String(properties.dataLabel ?? "Task")}
                  name={tasks.name}
                  role="checkbox"
                  type="submit"
                  value={`${line}:${checked ? "1" : "0"}`}
                >
                  <Icon name="check" size={12} />
                </button>
              );
            },
          }}
          rehypePlugins={[rehypeTaskSource, ...plugins]}
          remarkPlugins={[remarkGfm, remarkTodoMentions]}
        >
          {children}
        </ReactMarkdown>
      </div>
    </MentionTitles>
  );
}

/**
 * A body's opening paragraph as one run of inline text, for a list row's
 * excerpt: emphasis, strong and code keep their marks, and everything else,
 * links and headings and list markers included, is unwrapped to its text.
 * No link survives, because the row is itself a link (P13); no image does,
 * because an excerpt is not where a body loads anything.
 */
export function MarkdownExcerpt({ children }: { children: string }) {
  return (
    <ReactMarkdown
      allowedElements={EXCERPT_ELEMENTS}
      remarkPlugins={[remarkGfm]}
      unwrapDisallowed
    >
      {openingParagraph(children)}
    </ReactMarkdown>
  );
}

const EXCERPT_ELEMENTS = ["strong", "em", "code", "del"];

/** Up to the first blank line, cut near 400 characters on a space. */
function openingParagraph(body: string): string {
  const first = body.trim().split(/\n\s*\n/, 1)[0] ?? "";
  if (first.length <= 400) return first;
  const cut = first.lastIndexOf(" ", 400);
  return `${first.slice(0, cut > 0 ? cut : 400)}…`;
}

type MdastNode = {
  type: string;
  value?: string;
  url?: string;
  data?: { hProperties?: Record<string, unknown> };
  children?: MdastNode[];
};

/** A link the renderer above draws as a to-do's card. */
function mentionNode(id: string): MdastNode {
  return {
    type: "link",
    url: `/todos?open=${encodeURIComponent(id)}`,
    data: { hProperties: { dataMention: id } },
    children: [{ type: "text", value: id }],
  };
}

/**
 * `todo:tdo_…` in running text, or alone in inline code as agents often
 * write it, becomes a mention. Inside a link the id is that link's text and
 * stays it; fenced code is code.
 */
function remarkTodoMentions() {
  return (tree: MdastNode): void => {
    const visit = (node: MdastNode): void => {
      if (!node.children || node.type === "link") return;
      node.children = node.children.flatMap((child) => {
        if (child.type === "inlineCode" && child.value) {
          const whole = child.value.match(TODO_MENTION);
          return whole?.[0] === child.value
            ? [mentionNode(child.value)]
            : [child];
        }
        if (child.type !== "text" || !child.value) {
          visit(child);
          return [child];
        }
        const parts: MdastNode[] = [];
        let at = 0;
        for (const match of child.value.matchAll(TODO_MENTION)) {
          const start = match.index ?? 0;
          if (start > at) {
            parts.push({ type: "text", value: child.value.slice(at, start) });
          }
          parts.push(mentionNode(match[0]));
          at = start + match[0].length;
        }
        if (!parts.length) return [child];
        if (at < child.value.length) {
          parts.push({ type: "text", value: child.value.slice(at) });
        }
        return parts;
      });
    };
    visit(tree);
  };
}

type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
  position?: { start: { line: number } };
};

/**
 * remark positions the `<li>` it parsed but not the checkbox it synthesised,
 * and the checkbox is where the click lands. This copies the item's source
 * line and its text down onto that input, so the renderer above can address
 * and name it without counting anything.
 */
function rehypeTaskSource() {
  return (tree: HastNode): void => {
    walk(tree, (node) => {
      if (node.tagName !== "li") return;
      const line = node.position?.start.line;
      const input = node.children?.find((child) => child.tagName === "input");
      if (line === undefined || input === undefined) return;
      input.properties = {
        ...input.properties,
        dataLine: line,
        dataLabel: textOf(node).trim().slice(0, 120) || "Task",
        disabled: false,
      };
    });
  };
}

function walk(node: HastNode, visit: (node: HastNode) => void): void {
  visit(node);
  for (const child of node.children ?? []) walk(child, visit);
}

/** The item's own words, stopping at a nested list so a parent is not named by its children. */
function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  if (node.tagName === "ul" || node.tagName === "ol") return "";
  return (node.children ?? []).map(textOf).join("");
}
