import { useState } from "react";
import { Link, useFetcher } from "react-router";
import { useLanded, ViaFetcher } from "~/components/editable";
import { type DiffLine, foldDiff } from "~/concepts/line-diff";
import { type SkillEditReview } from "~/concepts/skills";
import type { Skill } from "./types";

export type EditResult =
  | { review: SkillEditReview }
  | { editErrors: string[]; draft: string };

/**
 * SKILL.md and nothing else, P2: project and tags are their own fields, and
 * the bundle rides along unchanged. Review is a post that writes nothing, so
 * the diff is the server's comparison against the head and works before
 * hydration. Publish posts the reviewed body from a hidden field, not the
 * textarea, so what lands is what the diff showed.
 */
export function SkillEditor({
  skill,
  edit,
  cancelHref,
}: {
  skill: Skill;
  edit: EditResult | null;
  cancelHref: string;
}) {
  const fetcher = useFetcher<EditResult | { saved: true }>();
  edit =
    fetcher.data && !("saved" in fetcher.data)
      ? fetcher.data
      : fetcher.data
        ? null
        : edit;
  const head = skill.versions.find((version) => version.isHead);
  const review = edit !== null && "review" in edit ? edit.review : null;
  const errors = edit !== null && "editErrors" in edit ? edit.editErrors : [];
  const draft =
    review?.body ??
    (edit !== null && "draft" in edit ? edit.draft : (head?.body ?? ""));
  // Typing after a review makes the diff stale, so its publish goes away
  // until the next review.
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const landed = useLanded(fetcher, () => setBusy(null));
  const submitting = (intent: string) => {
    setBusy(intent);
    setStale(false);
    landed();
  };

  return (
    <>
      {fetcher.data && "saved" in fetcher.data && busy === null ? (
        <p role="status">
          Published version {skill.version}.{" "}
          <Link preventScrollReset to={cancelHref}>
            Back to skill
          </Link>
        </p>
      ) : null}
      <p className="muted">
        Publishing writes v{(head?.version ?? skill.version) + 1}. The bundle,
        project and tags stay as they are, and the name is fixed: it is the
        skill's identity.
        {skill.source
          ? ` The source stays ${skill.source}, so this head will read as edited here.`
          : ""}
      </p>

      {review !== null && !stale ? (
        review.unchanged ? (
          <p className="warn">
            Nothing to publish: this SKILL.md matches v{review.version}.
          </p>
        ) : (
          <>
            <p className="eyebrow">Changes against v{head?.version}</p>
            <DiffView lines={review.diff} />
            <fetcher.Form
              className="row skill-publish"
              method="post"
              onSubmit={() => submitting("edit")}
              preventScrollReset
            >
              <ViaFetcher />
              <input name="skill" type="hidden" value={skill.name} />
              <input name="body" type="hidden" value={review.body} />
              <button
                disabled={busy !== null}
                name="intent"
                type="submit"
                value="edit"
              >
                {busy === "edit"
                  ? "Publishing…"
                  : `Publish version ${review.version}`}
              </button>
            </fetcher.Form>
          </>
        )
      ) : null}

      <fetcher.Form
        className="stack"
        method="post"
        onSubmit={() => submitting("review-edit")}
        preventScrollReset
      >
        <ViaFetcher />
        <input name="skill" type="hidden" value={skill.name} />
        <label>
          SKILL.md
          <textarea
            defaultValue={draft}
            // A new review resets the field to what was reviewed.
            key={draft}
            disabled={busy !== null}
            name="body"
            onChange={() => setStale(true)}
            required
            rows={18}
          />
        </label>
        {errors.length > 0 ? <p role="alert">{errors.join(" ")}</p> : null}
        <div className="row">
          <button
            className={review !== null && !stale ? "ghost" : undefined}
            disabled={busy !== null}
            name="intent"
            onClick={() => setStale(false)}
            type="submit"
            value="review-edit"
          >
            {busy === "review-edit" ? "Reviewing…" : "Review changes"}
          </button>
          <Link className="cancel" preventScrollReset to={cancelHref}>
            Cancel
          </Link>
        </div>
      </fetcher.Form>
    </>
  );
}

export function DiffView({ lines }: { lines: DiffLine[] }) {
  return (
    // A diff has no ids and never reorders, so the index is the key.
    <pre className="diff">
      {foldDiff(lines).map((line, index) =>
        line.op === "fold" ? (
          <span className="fold" key={index}>
            {`… ${line.count} unchanged ${line.count === 1 ? "line" : "lines"}\n`}
          </span>
        ) : (
          <span className={line.op} key={index}>
            {`${line.op === "add" ? "+" : line.op === "del" ? "-" : " "} ${line.text}\n`}
          </span>
        ),
      )}
    </pre>
  );
}
