#!/usr/bin/env bash
# Starts everything needed to try the app by hand, then waits.
#
#   npm run demo
#
# Rebuilds the database with the demonstration data, opens one neighbourhood,
# builds the web bundle, and serves the API and the app. Ctrl-C stops both.
#
# Nothing here reaches a real payment provider or a real identity check: both
# are simulated, and the database refuses simulated providers unless the
# environment allows them (migration 0017).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-8787}"
APP_PORT="${APP_PORT:-8080}"
SKIP_BUILD=0

[[ "${1:-}" == "--skip-build" ]] && SKIP_BUILD=1

cleanup() {
  echo ""
  echo "→ arrêt"
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null || true
  [[ -n "${APP_PID:-}" ]] && kill "$APP_PID" 2>/dev/null || true
}
trap cleanup EXIT INT TERM

# --- Postgres -----------------------------------------------------------------

export PGHOST="${PGHOST:-localhost}"
export PGPORT="${PGPORT:-5433}"
export PGUSER="${PGUSER:-postgres}"
export PGDATABASE="${PGDATABASE:-uberpalette}"

if ! pg_isready -q 2>/dev/null; then
  # A local cluster may be reachable over its Unix socket instead.
  if PGHOST=/var/run/postgresql pg_isready -q 2>/dev/null; then
    export PGHOST=/var/run/postgresql
  else
    cat >&2 <<'MSG'
Postgres n'est pas joignable sur le port 5433.

  Avec Docker   : docker compose up -d
  Sans Docker   : démarrez votre PostgreSQL 16 et exportez
                  PGHOST, PGPORT, PGUSER, PGDATABASE

MSG
    exit 1
  fi
fi

echo "→ base de données (${PGHOST}:${PGPORT})"
"$ROOT/scripts/db-reset.sh" --seed >/dev/null

# One neighbourhood open, so there is something to order. Thresholds are
# parameters, so lowering them for a pilot is a legitimate admin action.
psql -q -c "
  update zones set client_threshold = 1, courier_threshold = 1 where slug = 'biereau';
  select app.open_zone((select id from zones where slug = 'biereau'),
                       '44444444-0000-0000-0000-000000000001');" >/dev/null

# --- web bundle ---------------------------------------------------------------

if [[ "$SKIP_BUILD" -eq 0 ]]; then
  echo "→ construction de l'app (une minute environ)"
  (cd "$ROOT/apps/mobile" && EXPO_NO_TELEMETRY=1 CI=1 npx expo export \
     --platform web --output-dir dist >/dev/null 2>&1)
fi

# --- servers ------------------------------------------------------------------

echo "→ serveurs"
ALLOWED_ORIGINS="http://localhost:${APP_PORT}" PORT="$API_PORT" \
  node --experimental-strip-types "$ROOT/apps/api/src/main.ts" >/dev/null 2>&1 &
API_PID=$!

node "$ROOT/scripts/serve-static.mjs" "$ROOT/apps/mobile/dist" "$APP_PORT" >/dev/null 2>&1 &
APP_PID=$!

for _ in $(seq 1 30); do
  curl -sf "http://localhost:${API_PORT}/health" >/dev/null 2>&1 \
    && curl -sf "http://localhost:${APP_PORT}/" >/dev/null 2>&1 && break
  sleep 0.5
done

cat <<MSG

════════════════════════════════════════════════════════════════
  L'app tourne.      →  http://localhost:${APP_PORT}
  L'API tourne.      →  http://localhost:${API_PORT}/health
════════════════════════════════════════════════════════════════

  CÔTÉ CLIENT
    Créer un compte (n'importe quel e-mail, rien n'est envoyé)
    → « Vérifier mon âge » : le prestataire est simulé, c'est instantané
    → cocher les trois consentements obligatoires
    → l'adresse est pré-remplie sur Biéreau, le seul quartier ouvert
    → commander, puis « Simuler l'authentification et le paiement »

  CÔTÉ PALETTIER
    Depuis l'accueil → « Devenir palettier »
    → candidature, puis la formation obligatoire (10 questions)
    → signer le contrat
    → PUIS, dans un autre terminal :   npm run demo:admin
      (l'équipe confirme la Dimona et publie un créneau : ce sont des
       actions d'admin, il n'existe volontairement pas de route palettier)
    → réserver le créneau, puis repasser côté client pour commander :
      l'offre arrive au palettier

  Ctrl-C pour arrêter.

MSG

wait
