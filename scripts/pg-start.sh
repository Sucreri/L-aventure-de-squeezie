#!/usr/bin/env bash
# Starts the local test Postgres cluster, creating it on first run.
# The cluster lives outside the repository: it is scratch state, not a deliverable.
set -euo pipefail

PGDIR="${PGDIR:-/var/lib/postgresql/uberpalette_test}"
PGBIN=/usr/lib/postgresql/16/bin

if pg_isready -h /var/run/postgresql -p 5433 >/dev/null 2>&1; then
  echo "postgres déjà démarré"
  exit 0
fi

mkdir -p "$PGDIR" /var/run/postgresql
chown -R postgres:postgres "$PGDIR" /var/run/postgresql

if [ ! -f "$PGDIR/PG_VERSION" ]; then
  echo "→ initialisation du cluster"
  su postgres -c "$PGBIN/initdb -D $PGDIR -U postgres --auth=trust -E UTF8" >/dev/null
fi

su postgres -c "$PGBIN/pg_ctl -D $PGDIR -o '-p 5433 -k /var/run/postgresql -c listen_addresses=' -l $PGDIR/server.log start" >/dev/null
sleep 2

psql -h /var/run/postgresql -p 5433 -U postgres -tAc \
  "select 1 from pg_database where datname='uberpalette'" | grep -q 1 \
  || createdb -h /var/run/postgresql -p 5433 -U postgres uberpalette

pg_isready -h /var/run/postgresql -p 5433
