#!/usr/bin/env bash
# Rebuilds a local database from scratch and applies every migration in order.
# Usage: scripts/db-reset.sh [--seed]
#
# Environment:
#   PGHOST, PGPORT, PGUSER   connection to a Postgres superuser (default: local test cluster)
#   PGDATABASE               database to rebuild (default: uberpalette)
set -euo pipefail

PGHOST="${PGHOST:-/var/run/postgresql}"
PGPORT="${PGPORT:-5433}"
PGUSER="${PGUSER:-postgres}"
PGDATABASE="${PGDATABASE:-uberpalette}"
export PGHOST PGPORT PGUSER

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PSQL="psql -v ON_ERROR_STOP=1 -q"

echo "→ rebuilding ${PGDATABASE}"
$PSQL -d postgres -c "drop database if exists ${PGDATABASE} with (force);" >/dev/null
$PSQL -d postgres -c "create database ${PGDATABASE};" >/dev/null

for f in "$ROOT"/supabase/migrations/*.sql; do
  printf '  %-44s' "$(basename "$f")"
  $PSQL -d "$PGDATABASE" -f "$f" >/dev/null
  echo "ok"
done

if [[ "${1:-}" == "--seed" ]]; then
  for f in "$ROOT"/supabase/seed/*.sql; do
    printf '  %-44s' "seed: $(basename "$f")"
    $PSQL -d "$PGDATABASE" -f "$f" >/dev/null
    echo "ok"
  done
fi

echo "→ done"
