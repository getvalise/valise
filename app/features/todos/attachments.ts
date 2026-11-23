import { useRef } from "react";
import { useFetcher } from "react-router";
import { type AttachAnswer, attachKey } from "~/components/attachment-files";
import { useLanded } from "~/components/editable";
import { type Attachment } from "~/concepts/attachments";
import { servedInline } from "~/r2/objects";

/**
 * Files dropped on a to-do's dialog attach to it, as in Todoist. Dropped into
 * the description editor or the comment box, they are also linked there at
 * the caret: an image as `![name](/files/<id>)`, which the Markdown renders
 * inline, anything else as a link. A placeholder holds the spot while the
 * upload runs, so typing on meanwhile cannot move where the link lands.
 *
 * Drops queue behind one another on one fetcher, the same one the picker in
 * Files uses, because a second submit on a busy fetcher drops the first
 * answer and with it the placeholder's link. The bytes take the picker's
 * path: the `attach` intent, R2 and the objects row (ADR-0011). The picker
 * is still there without scripts (P11).
 */
export function useDropAttach(
  todoId: string,
  back: string,
): (files: File[], target: unknown) => void {
  const fetcher = useFetcher<AttachAnswer>({ key: attachKey(todoId) });
  const queue = useRef<Drop[]>([]);
  const send = (drop: Drop) => {
    const form = new FormData();
    form.set("intent", "attach");
    form.set("id", todoId);
    form.set("via", "fetcher");
    for (const file of drop.files) form.append("file", file);
    landed();
    fetcher.submit(form, {
      action: back,
      encType: "multipart/form-data",
      method: "post",
      preventScrollReset: true,
    });
  };
  const landed = useLanded(fetcher, () => {
    const done = queue.current.shift();
    if (done?.field) {
      const links = (fetcher.data?.attached ?? []).map(fileMarkdown);
      swapText(done.field, done.marker, links.join("\n"));
    }
    const next = queue.current[0];
    if (next) send(next);
  });
  return (files, target) => {
    const field = markdownField(target);
    const marker = `[Attaching ${files.map((file) => file.name).join(", ")}…]`;
    if (field) insertText(field, marker);
    queue.current.push({ files, field, marker });
    if (queue.current.length === 1) send(queue.current[0]);
  };
}

type Drop = {
  files: File[];
  /** The text field the drop landed in, if it is one that takes Markdown. */
  field: HTMLTextAreaElement | null;
  /** What holds the link's place in it until the upload answers. */
  marker: string;
};

/** The description editor or the comment box, if that is where it landed. */
function markdownField(target: unknown): HTMLTextAreaElement | null {
  const element = target as {
    tagName?: string;
    closest?: (selector: string) => unknown;
  } | null;
  if (element?.tagName !== "TEXTAREA") return null;
  return element.closest?.(".todo-body, .todo-comment")
    ? (target as HTMLTextAreaElement)
    : null;
}

function insertText(field: HTMLTextAreaElement, text: string): void {
  const before = field.value.slice(0, field.selectionStart);
  // Its own line, so the link is not glued to a word either side of it.
  const lead = before === "" || before.endsWith("\n") ? "" : "\n";
  field.setRangeText(
    `${lead}${text}\n`,
    field.selectionStart,
    field.selectionEnd,
    "end",
  );
  field.focus();
}

/** The placeholder out, the links in; the placeholder's line goes if none came. */
function swapText(field: HTMLTextAreaElement, marker: string, text: string) {
  const at = field.value.indexOf(marker);
  if (at < 0) return;
  const end =
    text === "" && field.value[at + marker.length] === "\n"
      ? at + marker.length + 1
      : at + marker.length;
  field.setRangeText(text, at, end, "preserve");
}

/** How a description or comment links the file: an image shows inline. */
function fileMarkdown(file: Attachment): string {
  const label = file.name.replace(/[[\]\\]/g, "\\$&");
  const href = `/files/${file.objectId}`;
  return servedInline(file.contentType)
    ? `![${label}](${href})`
    : `[${label}](${href})`;
}
