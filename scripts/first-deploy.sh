#!/usr/bin/env bash
set -euo pipefail

# Historical entrypoint; setup prepares an independent installation, never a
# laptop deployment. Application code still ships from main via Workers Builds.
cd "$(dirname "$0")/.."
exec node scripts/self-host.mjs "$@"
