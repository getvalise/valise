#!/usr/bin/env bash
#
# What Cloudflare Workers Builds runs as its deploy command, after the build
# command has run `npm run verify:ci && npm run build`.
#
#   schema, then code, then a check that the deployed thing serves.
#
# The schema goes first because the only migrations this applies are additive,
# and a column the running Worker does not read costs it nothing. The code
# follows and finds its columns there. V1-20 shipped the other order by
# accident — code on main, migration still on a laptop — and every create_todo
# in production failed for three hours. ADR-0008.
#
# Needs D1 (edit) on the Workers Builds API token, which the token does not
# carry by default: My Profile > API Tokens.
set -euo pipefail

# Workers Builds runs the preview command, not this one, for branches that are
# not production. If that ever gets wired the other way, stop here rather than
# migrate production from a feature branch. The staging Worker's own build
# watches `staging` and may deploy only the staging config from it.
branch="${WORKERS_CI_BRANCH:-main}"
expected=main
if [ "${VALISE_CONFIG:-}" = "wrangler.staging.jsonc" ]; then
  expected=staging
fi
if [ "$branch" != "$expected" ]; then
  echo "deploy: refusing to run ${VALISE_CONFIG:-wrangler.jsonc} from $branch; it deploys from $expected" >&2
  exit 1
fi

if [ -n "${VALISE_CONFIG:-}" ] && [ -z "${VALISE_ORIGIN:-}" ]; then
  echo "deploy: set VALISE_ORIGIN for the self-host smoke check" >&2
  exit 1
fi
if [ -n "${VALISE_CONFIG:-}" ]; then
  node scripts/deploy-target.mjs
fi

# Builds run concurrently and the last to finish deploys. A build whose commit
# is no longer the branch head stops here, before migrations, and succeeds:
# the newer commit's build deploys. A build that cannot read the branch head
# fails here, under set -e, with nothing migrated or deployed.
# scripts/deploy-head.mjs.
verdict="$(node scripts/deploy-head.mjs check "$expected")"
if [ "$verdict" != deploy ]; then
  echo "deploy: superseded, nothing deployed" >&2
  exit 0
fi

config=()
if [ -n "${VALISE_CONFIG:-}" ]; then
  config=(--config build/server/wrangler.json)
fi

# The version message names the commit, so `wrangler versions view` answers
# which commit production serves.
message=()
commit_message="$(node scripts/deploy-head.mjs message "$expected")"
if [ -n "$commit_message" ]; then
  message=(--message "$commit_message")
fi

node scripts/migrations.mjs apply
# The Vite build already flattened the selected config into build/server.
npx wrangler deploy ${config[@]+"${config[@]}"} ${message[@]+"${message[@]}"}
./scripts/smoke.sh
