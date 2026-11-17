-- =============================================================================
-- 0001_foundations.sql
-- Extensions, schemas, enumerated types and pure helper functions.
--
-- Design note (HYPOTHESES.md H-10): no PostGIS. Zone boundaries are GeoJSON
-- polygons in jsonb, positions are lat/lon pairs. Two PL/pgSQL functions cover
-- everything the MVP needs for a 2 km town. Their signatures are stable so a
-- later move to PostGIS only rewrites their bodies.
--
-- Design note (HYPOTHESES.md H-14): every monetary amount is an integer number
-- of cents. No numeric, no float, anywhere.
-- =============================================================================

create extension if not exists "pgcrypto";      -- gen_random_uuid, crypt, digest
create extension if not exists "citext";        -- case-insensitive email

create schema if not exists app;      -- domain functions and guards (not exposed)
create schema if not exists hr;       -- payroll-sensitive data, hr role only
create schema if not exists audit;    -- immutable journals

comment on schema app is
  'Domain logic, guards and helpers. Never exposed through the REST API.';
comment on schema hr is
  'Payroll-sensitive data (encrypted IBAN, national register). Readable only '
  'through SECURITY DEFINER functions that check the hr role and log access.';
comment on schema audit is
  'Append-only journals: admin actions, age checks, order transitions.';

-- -----------------------------------------------------------------------------
-- Enumerated types
-- -----------------------------------------------------------------------------

-- Roles. A user row may carry several (a client can also be a courier).
create type user_role as enum (
  'client', 'courier', 'ambassador', 'support', 'ops', 'hr', 'admin', 'super_admin'
);

-- Age bracket. Deliberately NOT a date of birth (H-04, spec 4.7 and 13.2).
-- 'under_16' exists only to express a refusal; such a user is never activated.
create type age_bracket as enum ('under_16', 'b16_17', 'b18_plus');

create type verification_method as enum ('itsme', 'psp_identity', 'admin_manual');

create type consent_type as enum (
  'tos',          -- CGU
  'sales_terms',  -- CGV
  'privacy',      -- politique de confidentialité (prise de connaissance)
  'geolocation',  -- facultatif
  'marketing'     -- facultatif, décoché par défaut (H-08)
);

create type zone_status as enum ('waitlist', 'open', 'closed');

create type delivery_mode as enum ('express', 'scheduled', 'grouped_round');

-- Full order lifecycle, spec 12. Normal flow then annex statuses.
create type order_status as enum (
  'WAITLISTED', 'CREATED', 'PAID', 'SEARCHING_COURIER', 'COURIER_ASSIGNED',
  'AT_STORE', 'PURCHASED', 'EN_ROUTE', 'ARRIVED', 'DELIVERED',
  'CANCELLED_BY_CLIENT', 'CANCELLED_BY_OPS', 'NO_COURIER_FOUND',
  'DELIVERY_FAILED', 'HELD_AT_HUB', 'REFUNDED_PARTIAL', 'REFUNDED_FULL'
);

create type courier_model as enum ('STUDENT_EMPLOYEE', 'INDEPENDENT');

-- Carrying capacity in "units" (spec 14): foot+trolley 3, bike+trailer 4, cargo 6.
create type transport_mode as enum ('foot_trolley', 'bike_trailer', 'cargo_bike');

create type courier_status as enum (
  'applied', 'training_done', 'contract_pending', 'active', 'suspended', 'ended'
);

-- Per-item substitution rule chosen by the client (spec 6.5).
create type substitution_rule as enum ('other_format', 'equivalent_ask_me', 'refund');

create type age_check_result as enum ('ok', 'refused');

create type age_refusal_reason as enum (
  'age_not_proven', 'underage', 'visibly_intoxicated', 'recipient_absent', 'other'
);

create type payment_status as enum (
  'pending', 'authorized', 'captured', 'failed', 'cancelled', 'refunded'
);

create type mission_offer_status as enum ('offered', 'accepted', 'declined', 'expired');

-- Promotions may only ever target fees, never products (H-06, spec 4.1).
create type promotion_target as enum ('delivery_fee', 'service_fee');

-- -----------------------------------------------------------------------------
-- Helper: money
-- -----------------------------------------------------------------------------

-- Half-up rounding of a cent amount expressed as a real-valued computation.
-- Used once, at the very end of the delivery fee calculation (H-14).
create or replace function app.round_cents(amount double precision)
returns integer
language sql
immutable
as $$
  select floor(amount + 0.5)::integer;
$$;

comment on function app.round_cents is
  'Half-up rounding to the nearest cent. Called exactly once per price '
  'computation, at the end, so the displayed total equals the debited amount.';

-- -----------------------------------------------------------------------------
-- Helper: geography (H-10)
-- -----------------------------------------------------------------------------

-- Great-circle distance in metres between two WGS84 points.
create or replace function app.haversine_m(
  lat1 double precision, lon1 double precision,
  lat2 double precision, lon2 double precision
) returns double precision
language sql
immutable
as $$
  select 6371000.0 * 2.0 * asin(sqrt(
      power(sin(radians(lat2 - lat1) / 2.0), 2)
    + cos(radians(lat1)) * cos(radians(lat2))
    * power(sin(radians(lon2 - lon1) / 2.0), 2)
  ));
$$;

-- Ray casting point-in-polygon over a GeoJSON Polygon.
-- `boundary` is a GeoJSON Polygon object: {"type":"Polygon","coordinates":[[[lon,lat],...]]}
-- Only the outer ring is considered: zones in LLN have no holes.
create or replace function app.point_in_polygon(
  lat double precision,
  lon double precision,
  boundary jsonb
) returns boolean
language plpgsql
immutable
as $$
declare
  ring      jsonb;
  n         integer;
  i         integer;
  j         integer;
  xi        double precision;
  yi        double precision;
  xj        double precision;
  yj        double precision;
  inside    boolean := false;
begin
  if boundary is null or boundary->'coordinates' is null then
    return false;
  end if;

  ring := boundary->'coordinates'->0;
  n := jsonb_array_length(ring);
  if n < 4 then
    -- A valid GeoJSON ring is closed and has at least 4 positions.
    return false;
  end if;

  j := n - 1;
  for i in 0 .. n - 1 loop
    xi := (ring->i->>0)::double precision;   -- longitude
    yi := (ring->i->>1)::double precision;   -- latitude
    xj := (ring->j->>0)::double precision;
    yj := (ring->j->>1)::double precision;

    if ((yi > lat) <> (yj > lat))
       and (lon < (xj - xi) * (lat - yi) / nullif(yj - yi, 0) + xi)
    then
      inside := not inside;
    end if;

    j := i;
  end loop;

  return inside;
end;
$$;

comment on function app.point_in_polygon is
  'Ray-casting containment test against the outer ring of a GeoJSON Polygon. '
  'Replaces ST_Contains for the MVP perimeter (see HYPOTHESES.md H-10).';
