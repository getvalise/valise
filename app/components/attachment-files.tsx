import { useEffect, useRef, useState } from "react";
import { Link, useActionData, useFetcher } from "react-router";
import type { Attachment } from "~/concepts/attachments";
import { fileSize } from "~/r2/objects";
import { useEditMode, useHydrated, useLanded, ViaFetcher } from "./editable";
import { FileDropzone } from "./file-dropzone";
import { FilePreview } from "./file-preview";
import { Icon } from "./icon";
import { Modal } from "./modal";

export type AttachAnswer = {
  attachError?: string;
  id?: string;
  attached?: Attachment[];
  removed?: { id: string; file: Attachment };
};

export function attachKey(id: string): string {
  return `attach.${id}`;
}

/**
 * A concept's files, and one "Add files" line that opens the picker and drop
 * well in a modal: an attachment is more than one value. P7, P8, P11, P15.
 * Once hydrated, choosing files uploads them as a drop does: the pick is the
 * one commit (P2). Attach is the no-script form's submit, and only that.
 */
export function AttachmentFiles({
  id,
  title,
  files,
  back,
  addHref,
  adding,
}: {
  id: string;
  title: string;
  files: Attachment[];
  /** Where every form posts and the modal closes back to: the open pane. */
  back: string;
  addHref: string;
  /** Whether `?edit=` names the add modal. */
  adding: boolean;
}) {
  const fetcher = useFetcher<AttachAnswer>({ key: attachKey(id) });
  const hydrated = useHydrated();
  const actionData = useActionData<AttachAnswer>();
  const form = useRef<HTMLFormElement>(null);
  const { open, start, close } = useEditMode(adding, back);
  const busy = fetcher.state !== "idle";
  const sent = useLanded(fetcher, () => {
    if (!fetcher.data?.attachError) close();
  });
  const [previewing, setPreviewing] = useState<Attachment | null>(null);
  const [remembered, setRemembered] = useState(files);
  useEffect(() => {
    setRemembered((previous) => mergeFiles(previous, files));
  }, [files]);
  const removed = actionData?.removed;
  const shown = mergeFiles(remembered, files);
  if (
    removed?.id === id &&
    !shown.some((file) => file.objectId === removed.file.objectId)
  ) {
    shown.push(removed.file);
  }
  useEffect(() => {
    if (!busy) (form.current as { reset?: () => void } | null)?.reset?.();
  }, [busy]);
  const refused =
    fetcher.data?.attachError ??
    (actionData?.id === id ? actionData.attachError : undefined);
  return (
    <section aria-label={`Files on ${title}`} className="todo-files">
      {shown.length ? (
        <ul className="attachments">
          {shown.map((file) => (
            <li key={file.objectId}>
              <Icon name="file" size={13} />
              <a
                href={`/files/${file.objectId}`}
                onClick={(event) => {
                  if (
                    event.button !== 0 ||
                    event.metaKey ||
                    event.ctrlKey ||
                    event.shiftKey ||
                    event.altKey
                  )
                    return;
                  event.preventDefault();
                  setPreviewing(file);
                }}
                rel="noreferrer"
              >
                {file.name}
              </a>
              <span className="attachment-size">{fileSize(file.size)}</span>
              <FileLinkToggle
                attached={files.some(
                  (current) => current.objectId === file.objectId,
                )}
                back={back}
                file={file}
                id={id}
              />
            </li>
          ))}
        </ul>
      ) : null}
      {previewing ? (
        <FilePreview file={previewing} onClose={() => setPreviewing(null)} />
      ) : null}
      <Link
        className="add-value"
        onClick={start}
        preventScrollReset
        to={addHref}
      >
        <Icon name="add" size={13} /> Add files
      </Link>
      {open ? (
        <Modal closeHref={back} onClose={close} open title="Add files">
          <fetcher.Form
            action={back}
            className="stack attach-file"
            encType="multipart/form-data"
            method="post"
            onSubmit={sent}
            preventScrollReset
            ref={form}
          >
            <ViaFetcher />
            <input name="intent" type="hidden" value="attach" />
            <input name="id" type="hidden" value={id} />
            <FileDropzone
              disabled={busy}
              hint={
                hydrated
                  ? "Or choose files. They attach as soon as they are picked."
                  : "Or choose files to attach."
              }
              key={busy ? "uploading" : "ready"}
              multiple
              onFiles={(files) => {
                if (!files[0]) return;
                const body = new FormData();
                body.set("intent", "attach");
                body.set("id", id);
                body.set("via", "fetcher");
                for (const file of files) body.append("file", file);
                sent();
                fetcher.submit(body, {
                  action: back,
                  method: "post",
                  encType: "multipart/form-data",
                  preventScrollReset: true,
                });
              }}
            />
            {hydrated ? (
              busy ? (
                <p role="status">Attaching…</p>
              ) : null
            ) : (
              <button className="small gap-1.5" type="submit">
                <Icon name="attach" />
                Attach
              </button>
            )}
            {refused ? <p role="alert">{refused}</p> : null}
          </fetcher.Form>
        </Modal>
      ) : refused ? (
        <p role="alert">{refused}</p>
      ) : null}
    </section>
  );
}

function mergeFiles(known: Attachment[], current: Attachment[]): Attachment[] {
  return [
    ...known,
    ...current.filter(
      (file) => !known.some((one) => one.objectId === file.objectId),
    ),
  ];
}

/** Removed rows stay here until closing, with the inverse control. P12. */
function FileLinkToggle({
  attached,
  back,
  file,
  id,
}: {
  attached: boolean;
  back: string;
  file: Attachment;
  id: string;
}) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  return (
    <fetcher.Form
      action={back}
      className="row"
      method="post"
      preventScrollReset
    >
      <ViaFetcher />
      <input name="id" type="hidden" value={id} />
      <input name="objectId" type="hidden" value={file.objectId} />
      <input
        name="intent"
        type="hidden"
        value={attached ? "detach-file" : "restore-file"}
      />
      <button
        aria-label={`${attached ? "Remove" : "Restore"} file ${file.name}`}
        className="ghost small gap-1.5"
        disabled={busy}
        type="submit"
      >
        <Icon name={attached ? "delete" : "restore"} />
        {busy ? "Saving" : attached ? "Remove" : "Restore"}
      </button>
      {!attached ? <span className="muted">Removed; bytes kept</span> : null}
    </fetcher.Form>
  );
}
