#!/usr/bin/env bash
# Rebuilds the database, loads the demo data and runs the acceptance suite.
# The suite is NOT idempotent on purpose: it creates fixtures and opens zones,
# so it always runs against a freshly built database.
#
# Usage: scripts/test-db.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PGDATABASE="${PGDATABASE:-uberpalette}"

"$ROOT/scripts/db-reset.sh" --seed >/dev/null
exec psql -v ON_ERROR_STOP=1 \
  -h "${PGHOST:-/var/run/postgresql}" -p "${PGPORT:-5433}" -U "${PGUSER:-postgres}" \
  -d "$PGDATABASE" -f "$ROOT/supabase/tests/acceptance.sql"
