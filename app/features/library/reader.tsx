import type { ReactNode } from "react";
import { cn } from "~/lib/utils";

/**
 * The reader: one column at a reading measure, the grotesque at a larger size
 * and looser leading, nothing beside it. Long lines of code and wide tables
 * scroll inside the column, never the page.
 */
export function ReaderArticle({
  lang,
  children,
}: {
  lang?: string;
  children: ReactNode;
}) {
  return (
    <article
      className="mx-auto w-full max-w-[68ch] [overflow-wrap:anywhere]"
      aria-labelledby="reader-title"
      lang={lang}
    >
      {children}
    </article>
  );
}

/** Eyebrow, title, byline lines and the rating, ruled off from the text. */
export function ReaderHeader({
  eyebrow,
  title,
  children,
}: {
  eyebrow: ReactNode;
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <header className="mb-6 border-b border-border pb-4">
      <p className="eyebrow">{eyebrow}</p>
      <h2
        id="reader-title"
        className="mt-1 mb-3 text-[clamp(1.5rem,1.1rem+2vw,2.25rem)] leading-[1.15] text-foreground"
      >
        {title}
      </h2>
      {children}
    </header>
  );
}

/** A byline or links line under the title. */
export function ReaderLine({ children }: { children: ReactNode }) {
  return <p className="mt-0 mb-1 text-muted-foreground">{children}</p>;
}

const proseText = cn(
  "[&_.prose]:text-lg/[1.65] [&_.prose]:text-foreground",
  "[&_.prose>*+*]:mt-[1em]",
  "[&_.prose_:is(h2,h3,h4)]:mt-[1.6em] [&_.prose_:is(h2,h3,h4)]:leading-[1.25]",
  "[&_.prose_blockquote]:ml-0 [&_.prose_blockquote]:border-l-2 [&_.prose_blockquote]:border-border [&_.prose_blockquote]:pl-3 [&_.prose_blockquote]:text-muted-foreground",
  "[&_.prose_:is(pre,table)]:block [&_.prose_:is(pre,table)]:max-w-full [&_.prose_:is(pre,table)]:overflow-x-auto [&_.prose_:is(pre,table)]:[overflow-wrap:normal]",
);

/** The text itself, a named region so it can be found apart from the header. */
export function ReaderBody({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <section aria-label={label} className={proseText}>
      {children}
    </section>
  );
}

/** Where the text came from, under a rule. */
export function ReaderFooter({ children }: { children: ReactNode }) {
  return (
    <footer className="muted mt-6 border-t border-border pt-3">
      {children}
    </footer>
  );
}
