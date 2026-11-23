# Review captured claims

Use the three `capture-*` cases in `cases.json` to check memory classification.
Their automatic score checks the type, project, required fields, and skill read.
Read each row's `args.title` and `args.body` in the run JSON for the rest.

For `capture-human-decision`, check these conditions:

- The title states the layout rule, not that work shipped.
- The first body line puts shared steps on the hub and source-specific steps in
  each source guide. A "When" prefix is optional.
- The body attributes approval to the user and points to their explicit choice
  in the supplied conversation. It does not invent a person's name or quote.
- The explanation gives duplication drift as the reason, repeated full guides
  as the rejected option, and two-page reading as the cost.
- The branch and PR identify implementation evidence, not approval by themselves.

For `capture-agent-insight`, check that the claim explains the layout's useful
effect without inventing user approval. The request to reduce repetition gives
the goal. The agent chose the layout. The capture request does not change who
made that choice.

For `capture-shipped-fact`, check that the body preserves the redirect location,
its subpath scope, and `static/docs-routing.json`. It must not invent a design
decision or rationale from the fact that the PR merged.

Record the run stamp, model, repeat, and each failed condition when reviewing.
An automatic pass is not a prose-quality verdict. A row that never saves gives
no evidence about the body guidance.
