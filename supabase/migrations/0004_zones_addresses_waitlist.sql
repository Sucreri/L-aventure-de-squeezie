-- =============================================================================
-- 0004_zones_addresses_waitlist.sql
-- Neighbourhoods, delivery addresses and the per-neighbourhood waiting list.
--
-- Spec 6.3: an address outside every zone is REFUSED. An address inside a zone
-- that is not yet open puts the client on the waiting list (spec 8.1).
-- Both rules are enforced by a trigger, not by the client.
-- =============================================================================

create table zones (
  id          uuid primary key default gen_random_uuid(),
  slug        text        not null unique,
  name        text        not null,
  -- GeoJSON Polygon, outer ring only (HYPOTHESES.md H-10).
  boundary    jsonb       not null,
  status      zone_status not null default 'waitlist',
  client_threshold  integer not null default 150 check (client_threshold  > 0),
  courier_threshold integer not null default 10  check (courier_threshold > 0),
  opened_at   timestamptz,
  opened_by   uuid references users(id),
  created_at  timestamptz not null default now(),

  constraint chk_boundary_is_polygon check (boundary->>'type' = 'Polygon'),
  constraint chk_opened_consistency check (
    (status = 'open') = (opened_at is not null)
  )
);

comment on table zones is
  'Neighbourhoods opened one by one (spec 8.1). A zone opens only when both '
  'thresholds are reached AND no launch blocker remains.';

create table waitlist_entries (
  id         bigserial primary key,
  user_id    uuid      not null references users(id) on delete cascade,
  zone_id    uuid      not null references zones(id) on delete cascade,
  role       user_role not null check (role in ('client','courier')),
  created_at timestamptz not null default now(),
  notified_at  timestamptz,
  activated_at timestamptz,
  unique (user_id, zone_id, role)
);

comment on table waitlist_entries is
  'Per-zone waiting list. Retention: entries never activated are purged after '
  'retention.waitlist_never_opened_months (spec 4.7).';

create index on waitlist_entries (zone_id, role) where activated_at is null;

-- Live counters for the public gauge ("Biéreau : 78/150") and for the opening
-- guard. A view rather than denormalised counters: the volumes are tiny and a
-- stale counter must never be the reason a zone opens.
create or replace view zone_progress as
  select z.id as zone_id,
         z.slug,
         z.name,
         z.status,
         z.client_threshold,
         z.courier_threshold,
         count(*) filter (where w.role = 'client'  and w.activated_at is null) as clients_waiting,
         count(*) filter (where w.role = 'courier' and w.activated_at is null) as couriers_waiting
    from zones z
    left join waitlist_entries w on w.zone_id = z.id
   group by z.id;

-- -----------------------------------------------------------------------------
-- Addresses
-- -----------------------------------------------------------------------------

create table addresses (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  label       text,
  street      text not null,
  number      text not null,
  building    text,                      -- kot, kot-à-projet, résidence
  floor       integer not null default 0 check (floor between 0 and 30),
  room        text,
  has_lift    boolean not null default false,
  -- Spec 6.3: the map pin is mandatory because GPS is imprecise on the slab.
  lat         double precision not null check (lat between -90 and 90),
  lon         double precision not null check (lon between -180 and 180),
  instructions text,
  zone_id     uuid references zones(id),
  is_default  boolean not null default false,
  created_at  timestamptz not null default now(),
  deleted_at  timestamptz
);

create index on addresses (user_id) where deleted_at is null;
create unique index on addresses (user_id) where is_default and deleted_at is null;

-- Resolve the zone from the pin, and refuse an address outside every zone.
create or replace function app.resolve_address_zone()
returns trigger
language plpgsql
as $$
declare
  z_id uuid;
begin
  select z.id into z_id
    from zones z
   where z.status <> 'closed'
     and app.point_in_polygon(new.lat, new.lon, z.boundary)
   order by z.status = 'open' desc   -- prefer an open zone on overlap
   limit 1;

  if z_id is null then
    raise exception 'address is outside the service area'
      using errcode = 'check_violation',
            hint = 'Spec 6.3: an address outside every zone is refused.';
  end if;

  new.zone_id := z_id;
  return new;
end;
$$;

create trigger trg_address_zone
  before insert or update of lat, lon on addresses
  for each row execute function app.resolve_address_zone();

-- -----------------------------------------------------------------------------
-- Zone opening
-- -----------------------------------------------------------------------------

-- A zone opens only when: both thresholds are reached, and every parameter
-- flagged required_for_launch is filled. The second condition is what stops a
-- neighbourhood from opening while the hourly wage, the work-accident
-- insurance reference or the AFSCA answer are still missing (spec 4.3, 4.11).
create or replace function app.open_zone(p_zone uuid, p_admin uuid)
returns void
language plpgsql
security definer
set search_path = public, app
as $$
declare
  p record;
  blockers text;
begin
  select * into p from zone_progress where zone_id = p_zone;
  if not found then
    raise exception 'unknown zone %', p_zone;
  end if;

  select string_agg(key, ', ') into blockers from app.launch_blockers();
  if blockers is not null then
    raise exception 'cannot open a zone while launch parameters are missing: %', blockers
      using errcode = 'check_violation';
  end if;

  if p.clients_waiting < p.client_threshold
     or p.couriers_waiting < p.courier_threshold then
    raise exception 'thresholds not reached: % / % clients, % / % couriers',
      p.clients_waiting, p.client_threshold, p.couriers_waiting, p.courier_threshold
      using errcode = 'check_violation';
  end if;

  update zones
     set status = 'open', opened_at = now(), opened_by = p_admin
   where id = p_zone;

  -- Spec 8.1: everyone on the list is notified, but only those who consented
  -- to notifications. The consent check lives here so no caller can skip it.
  update waitlist_entries w
     set activated_at = now(),
         notified_at  = case when app.has_consent(w.user_id, 'marketing')
                             then now() else null end
   where w.zone_id = p_zone and w.activated_at is null;
end;
$$;

comment on function app.open_zone is
  'Opens a neighbourhood. Refuses while any required_for_launch parameter is '
  'unset (spec 4.3, 4.11) or either threshold is unmet (spec 8.1).';
