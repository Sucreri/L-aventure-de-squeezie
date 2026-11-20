/**
 * The two admin actions the demonstration needs.
 *
 * They are deliberately NOT courier routes:
 *
 *   · confirming a Dimona declaration records that a declaration was actually
 *     made to the ONSS, which is not something a courier may assert about
 *     themselves (migration 0027);
 *   · publishing a shift is an employer decision, bounded by working-time
 *     rules the server checks.
 *
 * In the real product both live in the back-office. Until that exists, this
 * script stands in for it.
 *
 *   npm run demo:admin
 */

import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const postgres = require('postgres');

/**
 * Connects the same way scripts/demo.sh does: the environment wins, then a
 * TCP localhost (what Docker gives you), then a local Unix socket (what a
 * system PostgreSQL gives you). Running this in a second terminal should not
 * require repeating the connection settings.
 */
async function connect() {
  const base = {
    port: Number(process.env.PGPORT ?? 5433),
    database: process.env.PGDATABASE ?? 'uberpalette',
    username: process.env.PGUSER ?? 'postgres',
    ...(process.env.PGPASSWORD ? { password: process.env.PGPASSWORD } : {}),
    onnotice: () => {},
  };

  const hosts = process.env.PGHOST
    ? [process.env.PGHOST]
    : ['localhost', '/var/run/postgresql'];

  for (const host of hosts) {
    const candidate = postgres({ ...base, host, connect_timeout: 3 });
    try {
      await candidate`select 1`;
      return candidate;
    } catch {
      await candidate.end({ timeout: 1 }).catch(() => {});
    }
  }

  console.error(
    "Postgres n'est pas joignable. Lancez « docker compose up -d », "
    + 'ou exportez PGHOST, PGPORT, PGUSER et PGPASSWORD.');
  process.exit(1);
}

const sql = await connect();

const ADMIN = '44444444-0000-0000-0000-000000000001';
const BIEREAU = '11111111-0000-0000-0000-000000000001';

try {
  // --- Dimona ---------------------------------------------------------------

  const waiting = await sql`
    select cp.user_id, u.first_name, u.last_name
      from courier_profiles cp
      join users u on u.id = cp.user_id
     where cp.contract_signed and not cp.dimona_confirmed`;

  await sql`select set_config('app.current_user_id', ${ADMIN}, false)`;

  for (const courier of waiting) {
    await sql`select app.confirm_dimona(${courier.user_id})`;
    console.log(`  ✓ Dimona confirmée : ${courier.first_name} ${courier.last_name}`);
  }

  if (waiting.length === 0) {
    console.log('  · aucune Dimona en attente');
  }

  // --- a shift covering now -------------------------------------------------

  const [existing] = await sql`
    select id from shifts
     where zone_id = ${BIEREAU} and cancelled_at is null
       and now() between starts_at and ends_at
     limit 1`;

  if (existing) {
    console.log('  · un créneau est déjà ouvert');
  } else {
    // The working-time guard refuses a shift past the service end time. For a
    // demonstration that may run at any hour, the parameters are widened for
    // the insert and restored immediately — the guard itself is never removed.
    const saved = await sql`
      select key, value from app_settings
       where key in ('work.service_end_time', 'work.night_work_threshold_time')`;

    await sql`update app_settings set value = '"23:59"'::jsonb
               where key in ('work.service_end_time', 'work.night_work_threshold_time')`;

    await sql`
      insert into shifts (zone_id, starts_at, ends_at, places, published_by,
                          night_derogation, derogation_validated_by, derogation_note)
      values (${BIEREAU}, now() - interval '15 minutes', now() + interval '4 hours',
              20, ${ADMIN}, true, ${ADMIN},
              'Créneau de démonstration — dérogation fictive')`;

    for (const row of saved) {
      await sql`update app_settings set value = ${row.value} where key = ${row.key}`;
    }

    console.log('  ✓ créneau publié sur Biéreau, ouvert maintenant pour 4 h');
  }

  // --- a position, so dispatch can reach the courier -------------------------

  const bookings = await sql`
    select b.id, b.courier_id from shift_bookings b
      join shifts s on s.id = b.shift_id
     where b.cancelled_at is null and now() between s.starts_at and s.ends_at`;

  for (const booking of bookings) {
    await sql`
      insert into consents (user_id, consent_type, granted)
      values (${booking.courier_id}, 'geolocation', true)`;
    await sql`
      insert into courier_positions (courier_id, shift_booking_id, lat, lon)
      values (${booking.courier_id}, ${booking.id}, 50.6695, 4.6145)`;
    console.log('  ✓ position de départ enregistrée (le navigateur n\'en fournit pas)');
  }

  console.log('\nPrêt. Réserve le créneau dans l\'app, puis passe une commande côté client.');
} finally {
  await sql.end({ timeout: 5 });
}
