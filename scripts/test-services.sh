#!/usr/bin/env bash
# Integration tests for the orchestration layer.
#
# These run against a REAL Postgres carrying the real constraints and triggers.
# A fake database would have to re-implement the rules, and the tests would
# then prove only that the fake agrees with itself.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
"$ROOT/scripts/db-reset.sh" --seed >/dev/null
exec node --test --test-concurrency=1 --experimental-strip-types "$ROOT"/packages/services/tests/*.test.ts
