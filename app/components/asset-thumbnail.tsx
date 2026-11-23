import { useEffect, useRef, useState } from "react";
import { assetThumbnail, thumbnailKind } from "~/lib/document-preview";
import { PREVIEW_LIMITS } from "~/lib/document-preview/limits";

export type AssetThumbnailProps = {
  objectId: string;
  filename: string;
  mime: string;
  title: string;
};

/** Fixed geometry (P4/P6); progressive decoration, never the download control (P11). */
export function AssetThumbnail({
  objectId,
  filename,
  mime,
  title,
}: AssetThumbnailProps) {
  const target = useRef<HTMLSpanElement>(null);
  const kind = thumbnailKind(mime, filename);
  const [shown, setShown] = useState<{ key: string; url: string } | null>(null);
  const key = `${objectId}:${mime}:${filename}`;

  useEffect(() => {
    if (!kind || !target.current) return;
    const controller = new AbortController();
    let url: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started = false;
    const start = () => {
      if (started) return;
      started = true;
      timer = setTimeout(() => controller.abort(), PREVIEW_LIMITS.timeoutMs);
      void assetThumbnail(objectId, kind, controller.signal)
        .then((blob) => {
          if (controller.signal.aborted) return;
          url = URL.createObjectURL(blob);
          setShown({ key, url });
        })
        .catch(() => {
          // Unsupported, expired, oversize and failed previews keep the same placeholder.
        })
        .finally(() => clearTimeout(timer));
    };
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) {
                observer?.disconnect();
                start();
              }
            },
            { rootMargin: "200px" },
          );
    if (observer) observer.observe(target.current);
    else start();
    return () => {
      observer?.disconnect();
      controller.abort();
      clearTimeout(timer);
      if (url) URL.revokeObjectURL(url);
    };
  }, [objectId, kind, key]);

  const url = shown?.key === key ? shown.url : null;
  return (
    <span className="asset-thumbnail" ref={target}>
      {url ? (
        <img
          alt={`Thumbnail of ${title}`}
          decoding="async"
          height={128}
          src={url}
          width={96}
        />
      ) : (
        <span aria-label={`No thumbnail for ${title}`} role="img">
          {kind === "pdf"
            ? "PDF"
            : kind === "epub"
              ? "EPUB"
              : kind === "image"
                ? "Image"
                : "File"}
        </span>
      )}
    </span>
  );
}
