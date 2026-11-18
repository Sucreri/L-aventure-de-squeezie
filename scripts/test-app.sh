#!/usr/bin/env bash
# End-to-end check of the client app, in a real browser.
#
# Rebuilds the database, exports the web bundle, starts the API and a static
# server, runs the journey with assertions, then tears everything down.
#
# Usage: scripts/test-app.sh [--shots <dir>] [--skip-build]
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-8787}"
APP_PORT="${APP_PORT:-8080}"
SHOTS=""
SKIP_BUILD=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shots) SHOTS="$2"; shift 2 ;;
    --skip-build) SKIP_BUILD=1; shift ;;
    *) echo "option inconnue : $1" >&2; exit 2 ;;
  esac
done

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT

"$ROOT/scripts/pg-start.sh" >/dev/null

echo "→ base de données"
"$ROOT/scripts/db-reset.sh" --seed >/dev/null

# The demo needs one open neighbourhood; thresholds are parameters, so an
# admin lowering them for a pilot is a legitimate action.
psql -h /var/run/postgresql -p 5433 -U postgres -d uberpalette -q -c "
  update zones set client_threshold = 1, courier_threshold = 1 where slug = 'biereau';
  select app.open_zone((select id from zones where slug = 'biereau'),
                       '44444444-0000-0000-0000-000000000001');" >/dev/null

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "→ bundle web"
  (cd "$ROOT/apps/mobile" && EXPO_NO_TELEMETRY=1 CI=1 npx expo export \
     --platform web --output-dir dist >/dev/null 2>&1)
fi

echo "→ serveurs"
ALLOWED_ORIGINS="http://localhost:${APP_PORT}" PORT="$API_PORT" \
  node --experimental-strip-types "$ROOT/apps/api/src/main.ts" >/dev/null 2>&1 &
API_PID=$!

node "$ROOT/scripts/serve-static.mjs" "$ROOT/apps/mobile/dist" "$APP_PORT" >/dev/null 2>&1 &
APP_PID=$!

for _ in $(seq 1 20); do
  if curl -sf "http://localhost:${API_PORT}/health" >/dev/null 2>&1 \
     && curl -sf "http://localhost:${APP_PORT}/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.5
done

echo "→ parcours"
APP_URL="http://localhost:${APP_PORT}" \
  node "$ROOT/apps/mobile/tests/journey.mjs" ${SHOTS:+--shots "$SHOTS"}
