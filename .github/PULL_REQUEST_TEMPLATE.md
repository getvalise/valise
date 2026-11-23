## User job and change

Name the user job and the owning ADR/design contract. For a UI change, describe
the default populated view, primary action and what is deliberately disclosed
only on demand. For a non-UI change, state the mechanism.

## Acceptance evidence

Record representative volume, metadata variants, failure cases and loading
budgets. Link the default-view/primary-action walkthrough for UI changes,
including narrow-screen and no-script behavior. Separate runtime, browser,
provider and production evidence; name what remains unverified.

## Release gate

Record the exact head, full local `npm run verify` result, and build result when
applicable. No stale-head evidence or waived failures. CI is disabled; it is
not a substitute for this gate. A merge is not production confirmation.
