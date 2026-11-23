import { redirect } from "react-router";
import { editTarget } from "~/components/editable";
import {
  CURATED_SKILLS,
  curatedMatches,
  curatedName,
} from "~/concepts/curated-skills";
import { filtersFromRequest, listHref } from "~/concepts/list-filters";
import { infiniteWindow } from "~/concepts/pagination";
import {
  downloadGithubSkill,
  type GithubEnv,
  type GithubImportState,
  type GithubListing,
  type GithubSkill,
  listGithubSkills,
  parseGithubSource,
  parseSkillUrl,
} from "~/concepts/skills-github";
import {
  downloadFromRegistry,
  isFailure,
  type PopularSkill,
  readPopular,
  searchRegistry,
} from "~/concepts/skills-registry";
import {
  type ConsoleActor,
  requireConsoleActor,
  requireSameOriginAction,
} from "~/console/context.server";
import {
  afterSave,
  parseGithubBatch,
  parseSkillChange,
  parseSkillDraft,
  parseSkillEdit,
  parseSkillFieldEdit,
  parseSkillLabels,
  parseSkillName,
} from "~/console/forms.server";
import type { AddRoute } from "~/features/skills/types";
import { skillUri } from "~/mcp/resources";
import { skillToolName } from "~/mcp/tools";
import type { Route } from "../routes/+types/skills";

export async function loader({ context, request }: Route.LoaderArgs) {
  const actor = await requireConsoleActor(context, request);
  const filters = filtersFromRequest(request);
  // Only on a query. An empty box costs no call to anyone else's server.
  const params = new URL(request.url).searchParams;
  // `?add=` is which Add skill route is open: search skills.sh, or write one.
  const addParam = params.get("add");
  const add: AddRoute | null =
    addParam === "search" || addParam === "write" || addParam === "url"
      ? addParam
      : null;
  const pasted = add === "url" ? (params.get("url")?.trim() ?? "") : "";
  const fromUrlPromise =
    pasted === "" ? null : resolvePasted(actor.env, pasted);
  const find = params.get("find")?.trim() ?? "";
  const foundPromise = find === "" ? [] : searchRegistry(actor.env, find);
  // `?open=` names the skill whose dialog is open, so it survives a reload
  // and a link can point at it. A `skill:` id is what search and the logs
  // carry, so it resolves to the name the rest of the page keys on. P3.
  // An open pen names its skill too, so a link to one opens the dialog.
  const open =
    params.get("open") ?? editTarget(params.get("edit") ?? undefined) ?? "";
  const skillsStore = actor.store.skills;
  const opened = open.startsWith("skill:")
    ? await skillsStore.nameForId(open)
    : open || null;
  const previewing = params.get("preview")?.trim() ?? "";
  const downloadPromise =
    previewing === "" ? null : downloadFromRegistry(actor.env, previewing);
  // The console is where a disabled skill is seen and re-enabled, and a
  // deleted one restored, so it is the one surface that lists them. Every
  // agent door filters both out. Deleted rows are counted before they are
  // hidden, so the control that brings them back can say how many. P5.
  const filtered = Object.entries(filters).some(
    ([key, value]) => key !== "page" && Boolean(value),
  );
  // Optional recommendations must not hold the owner's list behind a network
  // timeout. React Router streams this promise; no user data is cached here.
  const popularPromise = filtered
    ? Promise.resolve([])
    : readPopular(actor.env).catch(() => []);
  const [
    counts,
    imported,
    vocabulary,
    facets,
    fromUrl,
    found,
    download,
    onboarding,
  ] = await Promise.all([
    skillsStore.count(filters),
    skillsStore.importedSources(),
    actor.store.vocabulary(),
    actor.store.facets("skill"),
    fromUrlPromise,
    foundPromise,
    downloadPromise,
    actor.store.onboarding.read(),
  ]);
  const window = infiniteWindow(counts.total, filters.page);
  filters.page = window.page > 1 ? window.page : undefined;
  const skills = await skillsStore.list(
    filters,
    filters.showDeleted ? "deleted" : "disabled",
    window,
  );
  const names = [
    ...new Set([
      ...skills.map((skill) => skill.name),
      ...(opened ? [opened] : []),
    ]),
  ];
  // History belongs to the open detail, not thirty invisible dialogs. The
  // list needs only each head's searchable text and bundle count.
  const [selected, versions, heads, usage, upstream] = await Promise.all([
    opened ? skillsStore.get(opened, undefined, "deleted") : null,
    opened ? skillsStore.versions(opened) : [],
    skillsStore.heads(skills.map((skill) => skill.name)),
    skillsStore.usage(names),
    skillsStore.upstream(names),
  ]);
  const enrich = (skill: (typeof skills)[number]) => ({
    ...skill,
    uri: skillUri(skill.name),
    toolName: skillToolName(skill.name),
    usage: usage.get(skill.name) ?? {
      asTool: 0,
      viaGetSkill: 0,
      asResource: 0,
      asPrompt: 0,
      lastSeen: null,
    },
    upstream: upstream.get(skill.name) ?? null,
  });
  return {
    onboarding,
    filters,
    deletedCount: counts.deleted,
    window,
    detail: selected ? { ...enrich(selected), versions } : null,
    add,
    find,
    opened,
    // `?edit=<name>.body` opens the SKILL.md editor in that skill's dialog,
    // the same `<id>.<field>` key the other routes use. P3.
    editing: params.get("edit") ?? "",
    registry: isFailure(found) ? [] : found,
    vocabulary,
    facets,
    pasted,
    // Trending ranks page 0 by last week against its eight-week mean.
    popularSort: (params.get("popular") === "trending"
      ? "trending"
      : "all-time") as "trending" | "all-time",
    popular: popularPromise.then((hits) =>
      rankPopular(hits, params.get("popular") === "trending").map((hit) => ({
        ...hit,
        added: imported.includes(hit.id),
      })),
    ),
    suggestions: CURATED_SKILLS.map((entry) => ({
      ...entry,
      name: curatedName(entry),
      added: imported.some((source) => curatedMatches(entry, source)),
    })),
    github:
      fromUrl !== null && "skill" in fromUrl
        ? {
            ...fromUrl.skill,
            files: fromUrl.skill.files.map((file) => ({
              path: file.path,
              size: file.content.length,
              sha256: "",
            })),
            check: await skillsStore.previewAdd(fromUrl.skill.body),
          }
        : null,
    githubList:
      fromUrl !== null && "listing" in fromUrl
        ? await withImportStates(skillsStore, fromUrl.listing)
        : null,
    registryErrors: [
      ...(fromUrl !== null && "errors" in fromUrl ? fromUrl.errors : []),
      ...(isFailure(found) ? found.errors : []),
      ...(download !== null && isFailure(download) ? download.errors : []),
    ],
    preview:
      download !== null && !isFailure(download)
        ? {
            id: download.id,
            listingUrl: download.listingUrl,
            hash: download.hash,
            files: download.files.map((file) => ({
              path: file.path,
              size: file.content.length,
              sha256: "",
            })),
            check: await skillsStore.previewAdd(download.body),
          }
        : null,
    skills: skills.map((skill) => ({
      ...enrich(skill),
      body: heads.get(skill.name)?.body ?? "",
      files: heads.get(skill.name)?.files ?? 0,
    })),
  };
}

/**
 * A pasted URL: a skills.sh link goes to the search route's own preview, a
 * GitHub folder or SKILL.md to one skill, a bare repository to its list.
 */
async function resolvePasted(
  env: GithubEnv,
  pasted: string,
): Promise<
  { skill: GithubSkill } | { listing: GithubListing } | { errors: string[] }
> {
  const target = parseSkillUrl(pasted);
  if ("errors" in target) return target;
  if (target.kind === "skills.sh") {
    const skillId = target.id.split("/")[2];
    throw redirect(
      `/skills?${new URLSearchParams({ add: "search", find: skillId, preview: target.id })}`,
    );
  }
  if (target.scope === "repo") {
    const listing = await listGithubSkills(
      env,
      target.owner,
      target.repo,
      target.ref,
    );
    return "errors" in listing ? listing : { listing };
  }
  const skill = await downloadGithubSkill(
    env,
    target.owner,
    target.repo,
    target.ref,
    target.path,
  );
  return "errors" in skill ? skill : { skill };
}

/** Each listed skill with where it stands: new, already added, or taken. */
async function withImportStates(
  skills: ConsoleActor["store"]["skills"],
  listing: GithubListing,
) {
  const states = await skills.classifyGithub(
    listing.owner,
    listing.repo,
    listing.groups.flatMap((group) => group.skills),
  );
  return {
    ...listing,
    groups: listing.groups.map((group) => ({
      ...group,
      skills: group.skills.map((skill) => ({
        ...skill,
        state: states.get(skill.path) ?? ("new" as GithubImportState),
      })),
    })),
  };
}

const POPULAR_SHOWN = 20;

function rankPopular(hits: PopularSkill[], trending: boolean): PopularSkill[] {
  const ranked = trending
    ? [...hits].sort((a, b) => (b.trend ?? 0) - (a.trend ?? 0))
    : hits;
  return ranked.slice(0, POPULAR_SHOWN);
}

export async function action({ context, request }: Route.ActionArgs) {
  requireSameOriginAction(request);
  const actor = await requireConsoleActor(context, request);
  const form = await request.formData();

  const intent = form.get("intent");
  const importing = form.get("import");
  if (typeof importing === "string") {
    return importSkill(actor, importing, parseSkillLabels(form));
  }

  // The source names the commit, so what publishes is what was previewed.
  if (intent === "import-github") {
    const pinned = parseGithubSource(String(form.get("source") ?? ""));
    if (pinned === null) {
      throw new Response("Not a GitHub source.", { status: 400 });
    }
    const got = await downloadGithubSkill(
      actor.env,
      pinned.owner,
      pinned.repo,
      pinned.sha,
      pinned.path,
    );
    if ("errors" in got) return { importErrors: got.errors };
    const published = await actor.store.skills.publish(
      { body: got.body, files: got.files, ...parseSkillLabels(form) },
      { source: got.source, sourceHash: got.hash },
    );
    if ("errors" in published) return { importErrors: published.errors };
    return redirect(`/skills?open=${encodeURIComponent(published.name)}`);
  }

  // Every ticked skill of one listing, at the commit the listing read.
  if (intent === "import-github-batch") {
    const report = await actor.store.skills.importGithub(
      parseGithubBatch(form),
      parseSkillLabels(form),
    );
    if ("errors" in report) return { importErrors: report.errors };
    return { githubImport: report };
  }

  // A written SKILL.md is checked before it is added, the same preview an
  // import gets, so a frontmatter error shows beside the text that has it.
  if (intent === "preview-write") {
    return {
      draft: await actor.store.skills.previewAdd(parseSkillDraft(form)),
    };
  }
  if (intent === "add") {
    const body = parseSkillDraft(form);
    const published = await actor.store.skills.publish({
      body,
      ...parseSkillLabels(form),
      files: [],
    });
    if ("errors" in published) {
      return {
        draft: {
          ...(await actor.store.skills.previewAdd(body)),
          errors: published.errors,
        },
      };
    }
    return redirect(`/skills?open=${encodeURIComponent(published.name)}`);
  }

  // An edit is two posts: one that checks and diffs without writing, and one
  // that publishes what was reviewed.
  if (intent === "skill-field") {
    const edit = parseSkillFieldEdit(form);
    const found = await actor.store.skills.setLabels(edit.name, edit.patch);
    if (!found) throw new Response("Skill not found.", { status: 404 });
    return afterSave(
      form,
      listHref("/skills", filtersFromRequest(request), { open: edit.name }),
    );
  }

  if (intent === "review-edit" || intent === "edit") {
    let edit;
    try {
      edit = parseSkillEdit(form);
    } catch (error) {
      if (!(error instanceof Response)) throw error;
      return {
        editErrors: [await error.text()],
        draft: String(form.get("body") ?? ""),
      };
    }
    if (intent === "review-edit") {
      const review = await actor.store.skills.reviewEdit(edit.name, edit.body);
      return "errors" in review
        ? { editErrors: review.errors, draft: edit.body }
        : { review };
    }
    const edited = await actor.store.skills.edit(edit.name, edit.body);
    if ("errors" in edited) {
      return { editErrors: edited.errors, draft: edit.body };
    }
    return afterSave(
      form,
      listHref("/skills", filtersFromRequest(request), { open: edit.name }),
    );
  }

  if (intent === "check-upstream") {
    const name = parseSkillName(form);
    const checked = await actor.store.skills.checkUpstream(name);
    if (checked.errors.length > 0) {
      return { upstreamErrors: checked.errors };
    }
    return afterSave(
      form,
      listHref("/skills", filtersFromRequest(request), { open: name }),
    );
  }

  if (intent === "change") {
    const { change, names } = parseSkillChange(form);
    // Update goes to the network, so it is its own report rather than a row
    // flip: what was published, what was held, what failed.
    if (change === "update") {
      return {
        updated: await actor.store.skills.update(names),
      };
    }
    const report = await actor.store.skills.change(names, change);
    // A stale selection is a report, not a route error that discards the
    // console. Other selected rows may already have changed, so revalidate.
    // From the dialog, back to it, unless the skill just left the list.
    const open = new URL(request.url).searchParams.get("open");
    const filters = filtersFromRequest(request);
    if (form.get("via") === "fetcher") return { saved: true, change, report };
    if (open !== null && report.skipped.length === 0) {
      const gone = change === "delete" && !filters.showDeleted;
      return redirect(
        listHref("/skills", filters, { open: gone ? undefined : open }),
      );
    }
    return { change, report };
  }

  throw new Response("Unknown skill action.", { status: 400 });
}

/**
 * An import is a normal publish that knows where it came from, so it gets the
 * projection write, the immutable version, and the head move for free.
 */
async function importSkill(
  actor: ConsoleActor,
  id: string,
  labels: { project: string | undefined; tags: string[] | undefined },
) {
  const downloaded = await downloadFromRegistry(actor.env, id);
  if (isFailure(downloaded)) return { importErrors: downloaded.errors };
  const published = await actor.store.skills.publish(
    { body: downloaded.body, files: downloaded.files, ...labels },
    { source: downloaded.id, sourceHash: downloaded.hash },
  );
  if ("errors" in published) return { importErrors: published.errors };
  return redirect(`/skills?open=${encodeURIComponent(published.name)}`);
}
