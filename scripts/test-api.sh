#!/usr/bin/env bash
# End-to-end tests of the HTTP surface.
#
# The real server, against the real database, with Row Level Security enforced:
# every request runs under the `authenticated` role with app.current_user_id
# set, exactly as in production. Nothing is stubbed between the request and
# Postgres, because the properties worth testing here only exist in that
# combination.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/scripts/db-reset.sh" --seed >/dev/null
exec node --test --test-concurrency=1 --experimental-strip-types "$ROOT"/apps/api/tests/*.test.ts
