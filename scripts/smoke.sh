#!/usr/bin/env bash
#
# Answer the question a test suite cannot: is the thing that is actually
# serving the right thing? Production once ran for four hours with a console
# that had no stylesheet while every test passed, because the tests ran
# against a build nobody had shipped.
#
# Runs against a deployed origin, so it belongs after a deploy, not in verify.
#
#   ./scripts/smoke.sh                        # the default origin below
#   ./scripts/smoke.sh https://preview.example.com # anywhere else
set -euo pipefail

origin="${1:-${VALISE_ORIGIN:-https://app.valise.run}}"
origin="${origin%/}"

fail() {
  echo "smoke: $1" >&2
  exit 1
}

# The Worker answers at all.
curl -fsS --max-time 20 "$origin/health" | grep -q '"ok": *true' \
  || fail "health did not report ok at $origin"

# The console's stylesheet is a static asset, so a build that drops it still
# renders and still passes every test. This is the check that would have
# caught the last drift.
curl -fsS --max-time 20 -o /dev/null "$origin/valise.css" \
  || fail "/valise.css is not being served"

# Browsers ask for /favicon.ico by name whatever the page links, and the
# iPhone installs from the manifest.
for path in /favicon.ico /apple-touch-icon.png /manifest.webmanifest; do
  curl -fsS --max-time 20 -o /dev/null "$origin$path" \
    || fail "$path is not being served"
done

curl -fsS --max-time 20 "$origin/login" | grep -q 'rel="stylesheet"' \
  || fail "the login page does not link a stylesheet"

# MCP is mounted and refuses an unauthenticated call rather than 404ing,
# which is what a Worker deployed without its OAuth provider would do.
status=$(curl -sS --max-time 20 -o /dev/null -w '%{http_code}' \
  -X POST "$origin/mcp" -H 'content-type: application/json' -d '{}')
[ "$status" = "401" ] || fail "/mcp answered $status, expected 401"

metadata=$(curl -fsS --max-time 20 "$origin/.well-known/oauth-protected-resource/mcp") \
  || fail "OAuth resource metadata is missing"
node -e '
  const metadata = JSON.parse(process.argv[1]);
  const origin = process.argv[2];
  if (metadata.resource_name !== "Valise" ||
      metadata.resource !== `${origin}/mcp` ||
      !metadata.authorization_servers?.includes(origin)) process.exit(1);
' "$metadata" "$origin" || fail "OAuth resource metadata names the wrong origin"

echo "smoke: $origin is serving health, the stylesheet, and MCP"
