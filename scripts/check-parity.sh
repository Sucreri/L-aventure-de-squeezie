#!/usr/bin/env bash
# Verifies that the SQL and TypeScript implementations agree.
#
# Pricing exists twice by design (docs/ARCHITECTURE.md §6): SQL is
# authoritative, TypeScript lets the app price instantly and offline. This
# script replays the shared vectors against both and fails on any divergence.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
GENERATED="$(mktemp -t parity-XXXXXX.sql)"
trap 'rm -f "$GENERATED"' EXIT

node --experimental-strip-types "$ROOT/scripts/check-parity.mjs" > "$GENERATED"

exec psql -v ON_ERROR_STOP=1 \
  -h "${PGHOST:-/var/run/postgresql}" -p "${PGPORT:-5433}" -U "${PGUSER:-postgres}" \
  -d "${PGDATABASE:-uberpalette}" -f "$GENERATED"
