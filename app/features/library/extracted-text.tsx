import { Link } from "react-router";
import { Markdown } from "~/components/markdown";
import { Button } from "~/components/ui/button";
import type { readAssetText } from "~/concepts/asset-processing";
import type { Asset } from "~/concepts/assets";
import { withoutRemoteImages } from "~/features/library/presentation";

export function ExtractedText({
  asset,
  extracted,
}: {
  asset: Asset;
  extracted: Awaited<ReturnType<typeof readAssetText>>;
}) {
  return extracted?.text ? (
    <section aria-label="Extracted text" className="grid gap-3">
      <Button
        asChild
        size="sm"
        variant="outline"
        className="justify-self-start"
      >
        <Link to={`/library/read-file/${asset.assetId}`}>
          Open in the reader
        </Link>
      </Button>
      <div className="library-article">
        <Markdown>
          {withoutRemoteImages(extracted.text.slice(0, 2000))}
        </Markdown>
      </div>
      <p className="muted">
        Extracted by {extracted.extractor}.{" "}
        {extracted.truncated ? "Partial extraction, capped at 1 MiB. " : ""}
        {extracted.text.length > 2000
          ? "Excerpt shown; open the reader for all retained text."
          : ""}{" "}
        The original is unchanged.
      </p>
    </section>
  ) : (
    <p className="muted">
      No extracted text yet. Process a supported file to read it here; the
      original remains downloadable.
    </p>
  );
}
