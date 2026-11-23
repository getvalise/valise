import { useEffect, useState } from "react";
import { Icon } from "~/components/icon";
import { Modal } from "~/components/modal";
import { fileSize } from "~/r2/objects";

type PreviewFile = {
  objectId: string;
  name: string;
  contentType: string;
  size: number;
};

/** What the dialog body shows for one file, once its bytes are in. */
type Shown =
  | { kind: "loading" }
  | { kind: "image" | "pdf"; url: string }
  | { kind: "text"; text: string; cut: boolean }
  | { kind: "none" }
  | { kind: "failed" };

/** Past this, a text preview stops and the download link has the rest. */
const TEXT_PREVIEW_CHARS = 100_000;

function previewKind(type: string): "image" | "pdf" | "text" | "none" {
  if (type.startsWith("image/")) return "image";
  if (type === "application/pdf") return "pdf";
  if (type.startsWith("text/") || type === "application/json") return "text";
  return "none";
}

/**
 * One stored file in a modal: the image, the PDF, or the text, and a download
 * link under it. Esc and a backdrop click close it, because `Modal` is a
 * native `<dialog>`.
 *
 * `/files/<id>` sends anything but a raster image as an octet-stream
 * attachment under a sandbox CSP (ADR-0011), so the preview does not frame
 * that URL. It fetches the bytes and types them itself, from the content type
 * recorded at upload, and only for the three kinds that run nothing in this
 * origin: an image goes in an `<img>`, a PDF in the browser's own viewer, and
 * text as a React string in a `<pre>`. Anything else, HTML and SVG-as-a-page
 * included, gets the download link and no preview.
 */
export function FilePreview({
  file,
  onClose,
}: {
  file: PreviewFile;
  onClose: () => void;
}) {
  const href = `/files/${file.objectId}`;
  const kind = previewKind(file.contentType);
  const [shown, setShown] = useState<Shown>(
    kind === "none" ? { kind: "none" } : { kind: "loading" },
  );

  useEffect(() => {
    if (kind === "none") return;
    let url: string | null = null;
    let live = true;
    (async () => {
      try {
        const response = await fetch(href);
        if (!response.ok) throw new Error(String(response.status));
        if (kind === "text") {
          const text = await response.text();
          if (live)
            setShown({
              kind,
              text: text.slice(0, TEXT_PREVIEW_CHARS),
              cut: text.length > TEXT_PREVIEW_CHARS,
            });
          return;
        }
        const blob = new Blob([await response.arrayBuffer()], {
          type: file.contentType,
        });
        if (!live) return;
        url = URL.createObjectURL(blob);
        setShown({ kind, url });
      } catch {
        if (live) setShown({ kind: "failed" });
      }
    })();
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [href, kind, file.contentType]);

  return (
    <Modal
      footer={
        <>
          <span className="attachment-size">{fileSize(file.size)}</span>
          <a className="button small gap-1.5" download={file.name} href={href}>
            <Icon name="download" />
            Download
          </a>
        </>
      }
      onClose={onClose}
      open
      title={file.name}
    >
      {shown.kind === "loading" ? (
        <p className="muted">Loading the preview.</p>
      ) : shown.kind === "image" ? (
        <img alt={file.name} className="file-preview" src={shown.url} />
      ) : shown.kind === "pdf" ? (
        <iframe className="file-preview" src={shown.url} title={file.name} />
      ) : shown.kind === "text" ? (
        <>
          <pre className="file-preview">{shown.text}</pre>
          {shown.cut ? (
            <p className="muted">
              The first {TEXT_PREVIEW_CHARS.toLocaleString("en")} characters.
              Download the file for the rest.
            </p>
          ) : null}
        </>
      ) : shown.kind === "failed" ? (
        <p role="alert">The file could not be loaded. Try the download link.</p>
      ) : (
        <p className="muted">No preview for this kind of file.</p>
      )}
    </Modal>
  );
}
