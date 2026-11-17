-- =============================================================================
-- 0005_catalogue.sql
-- Stores, products and per-store indicative prices.
--
-- Spec 5 enforcement highlights:
--   * an alcoholic product MUST carry its degree and an age_minimum >= 16;
--   * a product with age_minimum = 18 CANNOT be active in the MVP (spirits are
--     out of scope, spec 22) — enforced by chk_no_18_plus_in_mvp;
--   * product photos must be the operator's own (spec 4.10, H-02);
--   * alcohol-free products always come first in the catalogue (spec 5).
-- =============================================================================

create table stores (
  id            uuid primary key default gen_random_uuid(),
  name          text not null,
  street        text not null,
  number        text not null,
  postal_code   text not null,
  city          text not null default 'Louvain-la-Neuve',
  lat           double precision not null check (lat between -90 and 90),
  lon           double precision not null check (lon between -180 and 180),
  -- {"mon":[["08:00","20:00"]], ...}; no store integration in the MVP (H-15).
  opening_hours jsonb not null default '{}'::jsonb,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

comment on table stores is
  'Supply points. The MVP has no store integration: hours, products and '
  'indicative prices are maintained by the admin (HYPOTHESES.md H-15).';

create table products (
  id              uuid primary key default gen_random_uuid(),
  sku             text not null unique,
  name            text not null,
  format          text not null,                 -- "24 × 33 cl"
  photo_url       text,
  -- Spec 4.10: no third-party logo or brand dressing. A photo may only be used
  -- when it was taken by the operator.
  photo_owned_by_operator boolean not null default false,

  contains_alcohol boolean not null default false,
  alcohol_degree   numeric(4,2) check (alcohol_degree >= 0 and alcohol_degree <= 80),
  age_minimum      integer not null default 0 check (age_minimum in (0, 16, 18)),

  weight_kg        numeric(6,2) not null check (weight_kg > 0),
  -- Capacity units consumed in a courier's load (spec 5): a 33 cl pallet = 1.
  capacity_units   numeric(4,2) not null check (capacity_units > 0),
  -- Number of pallets this line represents, for the pricing formula (spec 9).
  pallet_count     integer not null default 0 check (pallet_count >= 0),

  active           boolean not null default true,
  display_rank     integer not null default 100,
  created_at       timestamptz not null default now(),

  -- An alcoholic product must declare its degree and be age-restricted.
  constraint chk_alcohol_is_declared check (
    (contains_alcohol = false and alcohol_degree is null and age_minimum = 0)
    or (contains_alcohol = true and alcohol_degree is not null and age_minimum >= 16)
  ),

  -- Spec 5 and 22: spirits are out of the MVP. A product that needs 18+ may
  -- exist as a row but can never be switched on.
  constraint chk_no_18_plus_in_mvp check (
    not (age_minimum = 18 and active = true)
  ),

  -- Spec 4.10 / H-02: a published photo must be the operator's own.
  constraint chk_photo_is_own check (
    photo_url is null or photo_owned_by_operator = true
  )
);

comment on constraint chk_no_18_plus_in_mvp on products is
  'Spec 5 and 22: no 18+ product may be activated in the MVP. Lifting this '
  'constraint is an explicit decision, not a configuration change.';

comment on column products.photo_owned_by_operator is
  'Spec 4.10: no third-party brand imagery. A photo may only be published '
  'when the operator took it.';

create index on products (active, display_rank) where active;

create table store_products (
  store_id    uuid not null references stores(id) on delete cascade,
  product_id  uuid not null references products(id) on delete cascade,
  indicative_price_cents integer not null check (indicative_price_cents > 0),
  available   boolean not null default true,
  -- Spec 10: a stale indicative price is the main cause of ticket gaps.
  price_updated_at timestamptz not null default now(),
  price_updated_by uuid references users(id),
  primary key (store_id, product_id)
);

comment on column store_products.indicative_price_cents is
  'Indicative shelf price. The client is always refunded or charged the exact '
  'till price (spec 10); this value only drives the estimate.';

-- -----------------------------------------------------------------------------
-- Age-filtered catalogue
-- -----------------------------------------------------------------------------

-- Spec 5: a product above the client's verified age is HIDDEN, and alcohol-free
-- products always appear first. One function, used by the app and the API, so
-- no client can accidentally widen what it shows.
create or replace function app.catalogue_for_user(p_user uuid, p_store uuid)
returns table (
  product_id   uuid,
  sku          text,
  name         text,
  format       text,
  photo_url    text,
  contains_alcohol boolean,
  alcohol_degree numeric,
  age_minimum  integer,
  weight_kg    numeric,
  capacity_units numeric,
  pallet_count integer,
  indicative_price_cents integer,
  available    boolean,
  alcohol_notice text
)
language sql
stable
as $$
  select p.id, p.sku, p.name, p.format, p.photo_url,
         p.contains_alcohol, p.alcohol_degree, p.age_minimum,
         p.weight_kg, p.capacity_units, p.pallet_count,
         sp.indicative_price_cents, sp.available,
         -- Spec 5: an alcoholic product always shows the notice and its degree.
         case when p.contains_alcohol
              then 'Contient de l''alcool — ' || trim(trailing '.' from trim(trailing '0' from p.alcohol_degree::text)) || '% vol.'
         end
    from products p
    join store_products sp on sp.product_id = p.id and sp.store_id = p_store
    left join users u on u.id = p_user
   where p.active
     and app.may_buy_age_restricted(u.age_bracket, u.age_verified, p.age_minimum)
   order by p.contains_alcohol asc,   -- alcohol-free first (spec 5)
            p.display_rank asc,
            p.name asc;
$$;

comment on function app.catalogue_for_user is
  'Age-filtered catalogue (spec 5). Hides every product above the verified '
  'bracket and lists alcohol-free products first.';
