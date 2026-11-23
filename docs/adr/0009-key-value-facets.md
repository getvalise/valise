# 0009. Key-value facets are a convention over the tag array, and reserved keys route to their columns

Date: 2026-10-17
Status: accepted

## Context

A to-do needs a priority. The obvious move is a `priority` column, and it is
the wrong one: the next request is a severity, then a sprint, then an estimate,
and each is a migration and a tool-description change for a field most callers
will never set. Valise's whole argument is that an agent and a person share one
store, so the store cannot keep asking a schema owner for permission to record
something.

The ask is an open set of key-value facets — `priority:1`, `area:search`,
`sprint:12` — that any user or agent can invent, filter on, and have another
client understand, without Valise ruling on the vocabulary.

**The data model already supports this.** Measured on a dev server on
2026-10-17, by seeding three to-dos over MCP with the facets written as
ordinary tags and filtering with the `search` tool's `tags` argument:

```
tags=["priority:1"]   -> 1: urgent thing
tags=["priority:2"]   -> 1: later thing
tags=["area:search"]  -> 2: urgent thing, later thing
tags=["priority:10"]  -> 1: decoy          (not matched by priority:1)
```

Two mechanisms make that work, both already in the tree. `app/search/project.ts`
space-joins `tags_json` into `search_index.tags`, and `buildSearchStatement`
filters with a padded whole-tag LIKE — `(' ' || si.tags || ' ') LIKE ('% ' || ?
|| ' %')`. A colon is an ordinary character to that predicate, so `priority:1`
and `priority:10` are different tags rather than a prefix match. And
`literalMatchQuery` quotes every MATCH term, which matters more than it looks:
unquoted, `priority:1` is FTS5's own column-filter syntax and fails with `no
such column: priority`. The quoting that exists for a different reason happens
to close that hole.

So the question was never storage. It is what the grammar does with keys that
already have a home, and how exact the matching really is.

`project` has a home. It is an indexed column on `skills`, `memories` and
`todos`, and ADR-0001 was amended from five projection columns to six
specifically so a project filter stays a column predicate instead of a join
back to the authoritative table. `type` on a memory and `state` on a to-do are
the same shape: real columns, with `MEMORY_TYPES` steering writers through the
tool descriptions and the coordinator owning every `state` transition per
ADR-0002.

## Decision

**A facet is a tag with a colon in it. There is no facets table and no
migration.** `tags_json` stays authoritative and stays an array of strings;
`priority:1` is one of those strings. An agent writing `tags: ["priority:1"]`
today already gets exact filtering, which is the strongest argument available:
the feature's storage half shipped before anyone asked for it.

Rejected: a `facets(doc_key, key, value)` table. It would give indexed
`GROUP BY` for the autocomplete counts, but `tags_json` remains authoritative
either way, so the table is a *second* derived projection that every write path
has to keep inside its ADR-0001 batch and that `reindex --all` has to rebuild.
That is a standing cost against a counting query over a store this size.
Revisit when the vocabulary query shows up slow in the logs, not before.

**Reserved keys route to their columns, never to the tag array.** The grammar
accepts `project:`, `type:` and `state:` because one syntax is the point, but
it writes them where those values already live. Storing `project:valise` as a
tag as well would give two sources of truth and two filter paths — the
`search_index.project` column predicate and the tag LIKE — that can disagree,
and the disagreement would be silent. A reserved key that cannot be routed,
such as `state:` on a memory, is a validation error rather than a tag, because
falling back to a tag is how the two-sources-of-truth case gets in anyway.

**The parser is narrow, and bare words stay bare.** A token becomes a facet
only when it matches `^[a-z][a-z0-9_-]*:` with no whitespace before the colon.
The key is lowercased and trimmed; the split is on the *first* colon, so
`url:https://example.com` keeps its value intact. Everything else is a plain
tag. Without that rule `TODO:fix` becomes a facet and a pasted URL becomes a
key, and the vocabulary fills with garbage that autocomplete then suggests.

**No vocabulary is enforced, and drift is shown rather than prevented.**
`priority:1`, `priority:high` and `priority:P1` can all exist. The console
offers keys and values from what the store actually holds, with counts, which
is the `listMemoryTypes` pattern already shipped on `/memories` — it shows the
vocabulary as written, drift included. A suggestion list with `priority:1 (12)`
and `priority:high (1)` makes the fork visible at the moment someone is about
to widen it, which is the only correction mechanism that survives contact with
an open set.

**Free-text search stays loose, and the `tags` filter is the exact one.**
`search("priority:1")` as free text also matches a document tagged `priority`
and `1`, because FTS5 phrase matching is token adjacency rather than whole-tag
equality — the tokenizer splits on the colon and `porter` stems what is left.
Accepted as-is. Fixing it means projecting facets into their own FTS column,
which is a schema change and a trigger change for a decoy that requires someone
to have written `priority` and `1` as two adjacent tags. The tool descriptions
point at the `tags` argument for exact filtering.

## Amendments

- 2026-10-18, project rollups. The server reads one tag convention of its
  own: a memory tagged `rollup` with `project` set is that project's rollup,
  and its `covers_up_to:YYYY-MM-DD` facet says how far it reaches.
  `GET /config/brief` names the newest non-deleted rollup per listed project
  as `valise (overview memory:<id>, covers up to <date>)`. `rollup` is a
  plain tag, not a reserved key, because it has no column to route to and a
  rollup is an ordinary memory in every other respect. The date is a facet
  rather than a body line so the brief can print it without parsing prose.
  The brief prints the first `covers_up_to:` tag verbatim, without a format
  check.
  The `capture-this` skill writes one only when the user asks. Cases
  `startup-brief-rollup` and `startup-brief-no-rollup`.

- 2026-11-03, `@project`. The console's one-line grammar reads `@name` as
  `project:name`: the owner wrote "… @valise" on a to-do from `/todos` and
  expected it to file the project, and the line kept it as a title word.
  `@` then a name that starts and ends on a letter or digit
  (`app/concepts/quick-add.ts`, `AT_PROJECT`), so an address such as
  `a@b.dev`, a bare `@`, or a sentence's closing `@valise.` stays in the
  title. It routes through the same reserved-key path as `project:`, so
  `@a @b` is the same contradiction error as `project:a project:b`, and
  `@` at the caret offers the store's projects. `@` is not reserved for
  people: ADR-0016's accounts do not assign to-dos, and when they do, that
  is the decision that reopens this. The MCP tools take `project` as an
  argument and never parse `@`.

## Consequences

Gained: an open facet system with no migration, no new write path, and no new
thing for `reindex --all` to rebuild. Any client that can set a tag can set a
facet, including every agent already connected and every client that never
updates. Filtering is exact today.

Given up: indexed facet aggregation. Counting the distinct keys and values is
`json_each` over `tags_json` per concept, a scan rather than an index seek.
That is the price of not keeping a second projection honest, and it is the
first thing to revisit if the suggestion query gets slow.

Also given up: any guarantee that two agents mean the same thing by
`priority:1`. That is deliberate — the alternative is Valise owning a
vocabulary, which is the thing this decision exists to avoid — but it means a
facet is a convention between the people and agents using one store, not a
contract the server enforces. The counts in the suggestion list are the only
pressure toward agreement.

Made harder: changing the reserved set later. Promoting a facet key to a column
is a migration plus a rewrite of every tag already written under that key;
demoting a column to a facet is worse, because `search_index.project` is a
column predicate several callers depend on. Pick the reserved set once.

Inherited: ADR-0003 makes a tool description a product surface with an eval
behind it. Teaching this convention in `create_todo`, `save_memory` and
`search` is a description change, so `npm run evals` reruns and the fill rates
are read before merge. That, not the schema, is the real cost of this decision.

ADR-0001's rule is untouched: `tags_json` is authoritative, `search_index` is
derived, and every write that changes searchable content still pairs with its
projection statement in one `db.batch`. A facet changes what a tag *means*, not
where it lives.
