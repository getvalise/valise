import { type MouseEvent, useRef, useState } from "react";
import { data, Form, Link, redirect, useNavigation } from "react-router";
import { ApplicationShell, Card, Field } from "~/components/ui";
import { Button } from "~/components/ui/button";
import { MAX_PASTE_BYTES, savableUrl } from "~/concepts/source-paste";
import { SourceRefused, sourceIdOf, sourceRef } from "~/concepts/sources";
import {
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import { tagsOf } from "~/console/forms.server";
import type { Route } from "./+types/save";

/**
 * Save a link from any signed-in browser: `/save?url=…&title=…`. With
 * `clipboard=1` the Save tap reads an article from the clipboard. The iPhone
 * Shortcut posts to `/capture` instead (workers/capture.ts). ADR-0015,
 * amendments of 2026-10-30 and 2026-11-02.
 */

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const params = new URL(request.url).searchParams;
  const savedId = sourceIdOf(params.get("saved") ?? "");
  if (savedId) {
    const source = await actor.store.sources.get(savedId);
    if (source)
      return {
        saved: {
          sourceId: source.sourceId,
          title: source.title,
          words: Number(params.get("words") ?? 0),
          article: params.get("article") === "1",
          clipboard: params.get("clipboard") === "1",
        },
      };
  }
  const url = params.get("url")?.trim() ?? "";
  return {
    form: {
      url: savableUrl(url) ? url : null,
      given: url,
      title: params.get("title")?.trim() ?? "",
      clipboard: params.get("clipboard") === "1",
    },
  };
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  if (Number(request.headers.get("content-length")) > MAX_PASTE_BYTES + 65536)
    return data(
      { error: "The copied article is over 3 MB. Save the link without it." },
      { status: 413 },
    );
  const form = await request.formData();
  const url = String(form.get("url") ?? "").trim();
  if (!savableUrl(url))
    return data({ error: "Only http and https links can be saved." }, 400);
  try {
    const { source, pasted } = await actor.store.sources.captureBookmark({
      url,
      title: String(form.get("title") ?? ""),
      notes: String(form.get("notes") ?? ""),
      tags: tagsOf(String(form.get("tags") ?? "")),
      pasted: String(form.get("pasted") ?? ""),
    });
    const outcome = new URLSearchParams({
      saved: source.sourceId,
      words: String(pasted.wordCount),
      article: pasted.article ? "1" : "0",
      clipboard: form.get("clipboard") === "1" ? "1" : "0",
    });
    return redirect(`/save?${outcome}`);
  } catch (error) {
    if (error instanceof SourceRefused)
      return data({ error: error.message }, { status: 409 });
    throw error;
  }
}

export default function Save({ loaderData, actionData }: Route.ComponentProps) {
  return (
    <ApplicationShell title="Save to Library">
      {"saved" in loaderData && loaderData.saved ? (
        <Saved {...loaderData.saved} />
      ) : "form" in loaderData && loaderData.form ? (
        <SaveForm {...loaderData.form} error={actionData?.error ?? null} />
      ) : null}
    </ApplicationShell>
  );
}

function SaveForm({
  url,
  given,
  title,
  clipboard,
  error,
}: {
  url: string | null;
  given: string;
  title: string;
  clipboard: boolean;
  error: string | null;
}) {
  const form = useRef<HTMLFormElement>(null);
  const pasted = useRef<HTMLTextAreaElement>(null);
  const [reading, setReading] = useState(false);
  const [manual, setManual] = useState(false);
  const navigation = useNavigation();
  const busy = reading || navigation.state !== "idle";
  if (!url)
    return (
      <Card className="editor max-w-xl">
        <h2>No link to save</h2>
        <p className="muted">
          {given
            ? `"${given}" is not an http or https link.`
            : "Add ?url= with the link to save it. On an iPhone, the Valise Capture Shortcut on Connections saves without this page."}
        </p>
      </Card>
    );

  // Safari lets a page read the clipboard only inside a tap, so the Save tap
  // reads it and then submits. Safari may refuse or return nothing, so an
  // empty read opens a field to paste into by hand, which always works.
  async function save(event: MouseEvent<HTMLButtonElement>) {
    if (!clipboard || manual || !pasted.current) return;
    event.preventDefault();
    setReading(true);
    let text = "";
    try {
      const { navigator } = globalThis as unknown as {
        navigator: { clipboard: { readText(): Promise<string> } };
      };
      text = await navigator.clipboard.readText();
    } catch {
      text = "";
    }
    setReading(false);
    if (!text.trim()) {
      setManual(true);
      return;
    }
    pasted.current.value = text;
    form.current?.requestSubmit();
  }

  return (
    <Card className="editor max-w-xl">
      <Form className="stack" method="post" ref={form}>
        <p className="break-all text-sm">{url}</p>
        <input name="url" type="hidden" value={url} />
        {clipboard ? <input name="clipboard" type="hidden" value="1" /> : null}
        <Field defaultValue={title} label="Title" name="title" />
        <Field label="Tags" name="tags" placeholder="Comma separated" />
        <Field label="Note" name="notes" rows={3} />
        <label hidden={!manual}>
          Article text
          <textarea name="pasted" ref={pasted} rows={6} />
        </label>
        {clipboard ? (
          <p className="muted text-sm">
            {manual
              ? "Safari did not hand over the clipboard. Paste the article into the Article text box, then Save. Save without it to keep only the link."
              : "Save reads the article the shortcut copied. Allow Paste when Safari asks."}
          </p>
        ) : null}
        {error ? (
          <p className="error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="row">
          <Button disabled={busy} onClick={save} type="submit">
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      </Form>
    </Card>
  );
}

function Saved({
  sourceId,
  title,
  words,
  article,
  clipboard,
}: {
  sourceId: string;
  title: string;
  words: number;
  article: boolean;
  clipboard: boolean;
}) {
  const count = words.toLocaleString("en-US");
  return (
    <Card className="editor max-w-xl">
      <h2>Saved</h2>
      <div className="stack">
        <p>{title}</p>
        <p className="muted">
          {article
            ? `With the article you pasted, ${count} words.`
            : clipboard
              ? `The text held ${count} words, too few for an article, so only the link was saved. Valise fetches the page itself unless the site blocks it.`
              : "Valise fetches the page itself in the next few minutes, unless the site blocks it."}
        </p>
        <div className="row">
          {article ? (
            <Link to={`/library/read/${sourceId}`}>Read it</Link>
          ) : null}
          <Link
            to={`/library?details=${encodeURIComponent(sourceRef(sourceId))}`}
          >
            Open in Library
          </Link>
        </div>
      </div>
    </Card>
  );
}
