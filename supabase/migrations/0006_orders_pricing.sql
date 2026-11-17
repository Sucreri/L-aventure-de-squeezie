-- =============================================================================
-- 0006_orders_pricing.sql
-- Orders, order lines, the pricing engine and the order state machine.
--
-- Spec 9  : delivery fee = (base + extra pallets + floors) × c × (1 − discount)
-- Spec 12 : allowed transitions are DATA, not code. The server refuses any
--           transition absent from order_transitions.
-- Spec 20 : the displayed total must equal the debited amount, hence integer
--           cents everywhere and a single rounding step (HYPOTHESES.md H-14).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Pricing engine (authoritative; the TypeScript copy is for display only)
-- -----------------------------------------------------------------------------

create or replace function app.compute_delivery_fee(
  p_pallet_count integer,
  p_floor        integer,
  p_has_lift     boolean,
  p_surge        double precision,
  p_mode         delivery_mode
) returns integer
language plpgsql
stable
as $$
declare
  base_fee     integer := app.setting_int('pricing.base_fee_cents');
  extra_fee    integer := app.setting_int('pricing.extra_pallet_fee_cents');
  floor_no_lift integer := app.setting_int('pricing.floor_fee_no_lift_cents');
  floor_lift   integer := app.setting_int('pricing.floor_fee_with_lift_cents');
  discount     double precision := app.setting_num('pricing.grouped_round_discount');
  surge_min    double precision := app.setting_num('pricing.surge_min');
  surge_max    double precision := app.setting_num('pricing.surge_max');
  floors_cents integer;
  subtotal     integer;
  applied_discount double precision := 0;
begin
  if p_surge < surge_min or p_surge > surge_max then
    raise exception 'surge coefficient % outside the allowed range [%, %]',
      p_surge, surge_min, surge_max
      using errcode = 'check_violation';
  end if;

  -- Spec 9: flat fee with a lift, per-floor fee without one. Ground floor is free.
  if coalesce(p_floor, 0) <= 0 then
    floors_cents := 0;
  elsif p_has_lift then
    floors_cents := floor_lift;
  else
    floors_cents := p_floor * floor_no_lift;
  end if;

  -- The base fee covers the first pallet, or an order with no pallet at all.
  subtotal := base_fee
            + greatest(coalesce(p_pallet_count, 0) - 1, 0) * extra_fee
            + floors_cents;

  if p_mode = 'grouped_round' then
    applied_discount := discount;
  end if;

  -- Single rounding step, at the very end (H-14).
  return app.round_cents(subtotal::double precision * p_surge * (1.0 - applied_discount));
end;
$$;

comment on function app.compute_delivery_fee is
  'Authoritative delivery fee (spec 9). Reference vector: 2 pallets, floor 3, '
  'no lift, c = 1.0, express -> 650 cents.';

-- -----------------------------------------------------------------------------
-- Orders
-- -----------------------------------------------------------------------------

create table orders (
  id          uuid primary key default gen_random_uuid(),
  reference   text not null unique default upper(substr(encode(gen_random_bytes(5),'hex'), 1, 8)),
  client_id   uuid not null references users(id),
  address_id  uuid not null references addresses(id),
  store_id    uuid not null references stores(id),
  zone_id     uuid not null references zones(id),

  mode        delivery_mode not null,
  status      order_status  not null default 'CREATED',

  -- Scheduled and grouped-round orders carry their slot.
  slot_start  timestamptz,
  slot_end    timestamptz,

  -- Price inputs are SNAPSHOT on the order so a price can always be recomputed
  -- exactly as it was shown, even if the address or the settings change later.
  surge_coefficient numeric(3,2) not null default 1.00,
  pallet_count      integer not null default 0 check (pallet_count >= 0),
  floor_snapshot    integer not null default 0 check (floor_snapshot >= 0),
  has_lift_snapshot boolean not null default false,
  to_the_door       boolean not null default false,   -- "Livraison à l'étage"

  -- Amounts, integer cents (H-14).
  items_estimated_cents integer not null default 0 check (items_estimated_cents >= 0),
  items_actual_cents    integer check (items_actual_cents >= 0),
  delivery_fee_cents    integer not null default 0 check (delivery_fee_cents >= 0),
  service_fee_cents     integer not null default 0 check (service_fee_cents >= 0),
  tip_cents             integer not null default 0 check (tip_cents >= 0),
  total_estimated_cents integer not null default 0 check (total_estimated_cents >= 0),
  total_charged_cents   integer check (total_charged_cents >= 0),
  refunded_cents        integer not null default 0 check (refunded_cents >= 0),

  -- Spec 4.6: the exact CGV version the client agreed to, frozen on the order.
  sales_terms_document_id uuid references legal_documents(id),

  -- Spec 13.4: four-digit PIN, stored hashed only (H-13).
  pin_hash    text,
  default_substitution substitution_rule not null default 'equivalent_ask_me',
  note_for_courier text,

  created_at   timestamptz not null default now(),
  paid_at      timestamptz,
  delivered_at timestamptz,
  cancelled_at timestamptz,
  cancellation_reason text,

  constraint chk_slot_coherent check (
    (mode = 'express' and slot_start is null)
    or (mode <> 'express' and slot_start is not null and slot_end > slot_start)
  ),
  -- Spec 20.5: what is displayed is what is debited.
  constraint chk_total_is_sum check (
    total_estimated_cents
      = items_estimated_cents + delivery_fee_cents + service_fee_cents + tip_cents
  )
);

create index on orders (client_id, created_at desc);
create index on orders (status) where status not in ('DELIVERED','REFUNDED_FULL','REFUNDED_PARTIAL');
create index on orders (zone_id, created_at desc);

create table order_items (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  product_id  uuid not null references products(id),
  quantity    integer not null check (quantity > 0),

  unit_indicative_price_cents integer not null check (unit_indicative_price_cents > 0),
  unit_actual_price_cents     integer check (unit_actual_price_cents >= 0),

  substitution_rule substitution_rule not null default 'equivalent_ask_me',

  -- Snapshots: the age rule applied is the one in force when the order was
  -- placed, and it must stay auditable even if the product changes later.
  age_minimum_snapshot     integer not null,
  contains_alcohol_snapshot boolean not null,

  -- Spec 6.12: in a group order, an alcoholic item belongs to the participant
  -- who takes and pays for it. The age check applies to THAT person.
  participant_id uuid references users(id),

  fulfilled   boolean not null default false,
  refunded    boolean not null default false
);

create index on order_items (order_id);

-- -----------------------------------------------------------------------------
-- Age gate on every order line (spec 4.1, acceptance criterion 20.2)
-- -----------------------------------------------------------------------------

create or replace function app.guard_order_item_age()
returns trigger
language plpgsql
as $$
declare
  prod       record;
  buyer      uuid;
  buyer_row  record;
begin
  select age_minimum, contains_alcohol, active
    into prod
    from products where id = new.product_id;

  if not found or not prod.active then
    raise exception 'product % is not available', new.product_id
      using errcode = 'check_violation';
  end if;

  new.age_minimum_snapshot      := prod.age_minimum;
  new.contains_alcohol_snapshot := prod.contains_alcohol;

  -- The person who must satisfy the age rule: the participant in a group
  -- order, otherwise the client who pays.
  buyer := coalesce(new.participant_id, (select client_id from orders where id = new.order_id));

  select age_bracket, age_verified into buyer_row from users where id = buyer;

  if not app.may_buy_age_restricted(buyer_row.age_bracket,
                                    buyer_row.age_verified,
                                    prod.age_minimum) then
    raise exception 'age requirement not met for product % (requires %+)',
      new.product_id, prod.age_minimum
      using errcode = 'check_violation',
            hint = 'Spec 4.1: enforced server-side, including in group orders.';
  end if;

  return new;
end;
$$;

create trigger trg_order_item_age
  before insert or update of product_id, participant_id on order_items
  for each row execute function app.guard_order_item_age();

-- -----------------------------------------------------------------------------
-- Order state machine (spec 12): allowed transitions live in a table
-- -----------------------------------------------------------------------------

create table order_transitions (
  from_status order_status not null,
  to_status   order_status not null,
  description text not null,
  primary key (from_status, to_status)
);

comment on table order_transitions is
  'The complete transition matrix (spec 12). A juriste can audit it without '
  'reading code, and criterion 20 "100% of transitions tested" is a table scan.';

insert into order_transitions (from_status, to_status, description) values
  ('WAITLISTED','CREATED',              'Le quartier ouvre, la commande devient réelle'),
  ('WAITLISTED','CANCELLED_BY_CLIENT',  'Le client renonce avant ouverture'),
  ('CREATED','PAID',                    'Paiement autorisé par le prestataire'),
  ('CREATED','CANCELLED_BY_CLIENT',     'Annulation avant paiement, sans frais'),
  ('CREATED','CANCELLED_BY_OPS',        'Annulation par l''équipe avant paiement'),
  ('PAID','SEARCHING_COURIER',          'Recherche d''un palettier'),
  ('PAID','CANCELLED_BY_CLIENT',        'Annulation après paiement, sans frais'),
  ('PAID','CANCELLED_BY_OPS',           'Annulation par l''équipe'),
  ('PAID','REFUNDED_FULL',              'Remboursement intégral immédiat'),
  ('SEARCHING_COURIER','COURIER_ASSIGNED','Offre acceptée'),
  ('SEARCHING_COURIER','NO_COURIER_FOUND','Aucun palettier après le délai'),
  ('SEARCHING_COURIER','CANCELLED_BY_CLIENT','Annulation pendant la recherche'),
  ('SEARCHING_COURIER','CANCELLED_BY_OPS','Annulation par l''équipe'),
  ('NO_COURIER_FOUND','SEARCHING_COURIER','Nouvelle tentative'),
  ('NO_COURIER_FOUND','CANCELLED_BY_CLIENT','Annulation sans frais (§12)'),
  ('NO_COURIER_FOUND','REFUNDED_FULL',  'Remboursement intégral automatique'),
  ('NO_COURIER_FOUND','CANCELLED_BY_OPS','Annulation par l''équipe'),
  ('COURIER_ASSIGNED','AT_STORE',       'Le palettier est au magasin'),
  ('COURIER_ASSIGNED','SEARCHING_COURIER','Abandon ou fin de créneau, réattribution'),
  ('COURIER_ASSIGNED','CANCELLED_BY_CLIENT','Annulation gratuite avant AT_STORE'),
  ('COURIER_ASSIGNED','CANCELLED_BY_OPS','Annulation par l''équipe'),
  ('AT_STORE','PURCHASED',              'Articles achetés, ticket envoyé'),
  ('AT_STORE','SEARCHING_COURIER',      'Abandon au magasin, réattribution'),
  ('AT_STORE','CANCELLED_BY_CLIENT',    'Annulation gratuite, dernier moment (§12)'),
  ('AT_STORE','CANCELLED_BY_OPS',       'Rupture de stock généralisée'),
  ('PURCHASED','EN_ROUTE',              'Départ vers le kot'),
  ('PURCHASED','CANCELLED_BY_CLIENT',   'Annulation payante : articles + 50 % des frais'),
  ('PURCHASED','CANCELLED_BY_OPS',      'Annulation par l''équipe après achat'),
  ('PURCHASED','DELIVERY_FAILED',       'Incident avant le départ'),
  ('EN_ROUTE','ARRIVED',                'Palettier sur place'),
  ('EN_ROUTE','DELIVERY_FAILED',        'Adresse introuvable, incident'),
  ('EN_ROUTE','CANCELLED_BY_OPS',       'Annulation par l''équipe en route'),
  ('ARRIVED','DELIVERED',               'Âge contrôlé et PIN valide (§13)'),
  ('ARRIVED','DELIVERY_FAILED',         'Refus de remise ou client absent (§13.3)'),
  ('DELIVERY_FAILED','HELD_AT_HUB',     'Articles gardés 24 h au local (§12)'),
  ('DELIVERY_FAILED','REFUNDED_PARTIAL','Remboursement partiel'),
  ('HELD_AT_HUB','DELIVERED',           'Retrait au local sur pièce d''identité'),
  ('HELD_AT_HUB','REFUNDED_PARTIAL',    'Non réclamé, sort fixé par les CGV'),
  ('DELIVERED','REFUNDED_PARTIAL',      'Réclamation acceptée'),
  ('DELIVERED','REFUNDED_FULL',         'Réclamation acceptée intégralement'),
  ('CANCELLED_BY_CLIENT','REFUNDED_FULL','Remboursement de l''annulation'),
  ('CANCELLED_BY_CLIENT','REFUNDED_PARTIAL','Remboursement partiel de l''annulation'),
  ('CANCELLED_BY_OPS','REFUNDED_FULL',  'Remboursement intégral'),
  ('CANCELLED_BY_OPS','REFUNDED_PARTIAL','Remboursement partiel'),
  ('REFUNDED_PARTIAL','REFUNDED_FULL',  'Complément de remboursement');

-- Append-only journal of every transition, with actor and reason (spec 12).
create table audit.order_events (
  id          bigserial primary key,
  order_id    uuid        not null,
  from_status order_status,
  to_status   order_status not null,
  actor_id    uuid,
  actor_role  text,
  reason      text,
  occurred_at timestamptz not null default now(),
  metadata    jsonb not null default '{}'::jsonb
);

create index on audit.order_events (order_id, occurred_at);

-- Set by the application before an update, so the journal records who acted.
create or replace function app.set_actor(p_actor uuid, p_role text, p_reason text default null)
returns void
language sql
as $$
  select set_config('app.actor_id',   coalesce(p_actor::text, ''), true),
         set_config('app.actor_role', coalesce(p_role, ''), true),
         set_config('app.reason',     coalesce(p_reason, ''), true);
$$;

create or replace function app.guard_order_transition()
returns trigger
language plpgsql
as $$
declare
  allowed boolean;
begin
  if new.status = old.status then
    return new;
  end if;

  select exists (
    select 1 from order_transitions t
     where t.from_status = old.status and t.to_status = new.status
  ) into allowed;

  if not allowed then
    raise exception 'forbidden order transition % -> %', old.status, new.status
      using errcode = 'check_violation',
            hint = 'Spec 12: the server refuses any transition absent from order_transitions.';
  end if;

  -- Timestamps follow the status, so they cannot drift from it.
  if new.status = 'PAID'      and new.paid_at      is null then new.paid_at      := now(); end if;
  if new.status = 'DELIVERED' and new.delivered_at is null then new.delivered_at := now(); end if;
  if new.status in ('CANCELLED_BY_CLIENT','CANCELLED_BY_OPS')
     and new.cancelled_at is null then new.cancelled_at := now(); end if;

  insert into audit.order_events (order_id, from_status, to_status, actor_id, actor_role, reason)
  values (new.id, old.status, new.status,
          nullif(current_setting('app.actor_id',   true), '')::uuid,
          nullif(current_setting('app.actor_role', true), ''),
          nullif(current_setting('app.reason',     true), ''));

  return new;
end;
$$;

create trigger trg_order_transition
  before update of status on orders
  for each row execute function app.guard_order_transition();

-- -----------------------------------------------------------------------------
-- Cancellation terms (spec 12), computed server-side and shown before payment
-- -----------------------------------------------------------------------------

create or replace function app.cancellation_terms(p_order uuid)
returns table (free boolean, items_due_cents integer, fees_due_cents integer, explanation text)
language plpgsql
stable
as $$
declare
  o record;
  share double precision := app.setting_num('cancellation.fee_share_after_purchase');
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown order %', p_order; end if;

  if o.status in ('WAITLISTED','CREATED','PAID','SEARCHING_COURIER',
                  'NO_COURIER_FOUND','COURIER_ASSIGNED','AT_STORE') then
    return query select true, 0, 0,
      'Annulation gratuite : les articles ne sont pas encore achetés.'::text;
  else
    return query select false,
      coalesce(o.items_actual_cents, o.items_estimated_cents),
      app.round_cents(o.delivery_fee_cents * share),
      format('Les articles ont été achetés : ils restent dus, ainsi que %s %% des frais de livraison.',
             round((share * 100)::numeric, 0))::text;
  end if;
end;
$$;

comment on function app.cancellation_terms is
  'Spec 12 and 4.6: cancellation conditions must be computed server-side and '
  'displayed BEFORE payment, not discovered afterwards.';

-- -----------------------------------------------------------------------------
-- Order creation guard (acceptance criteria 20.1 and 20.10)
-- -----------------------------------------------------------------------------

-- 20.1: "Impossible de commander sans compte vérifié, CGU et CGV acceptées,
--        et adresse dans une zone ouverte."
-- 20.10: "Un quartier en liste d'attente n'accepte aucun paiement."
create or replace function app.guard_order_creation()
returns trigger
language plpgsql
as $$
declare
  z record;
  a record;
begin
  if not app.may_place_order(new.client_id) then
    raise exception 'ordering requires a verified account with CGU and CGV accepted'
      using errcode = 'check_violation',
            hint = 'Acceptance criterion 20.1.';
  end if;

  select * into a from addresses where id = new.address_id and deleted_at is null;
  if not found or a.user_id <> new.client_id then
    raise exception 'this address does not belong to the client'
      using errcode = 'check_violation';
  end if;

  -- The order is always attached to the address's resolved zone, never to a
  -- zone the client chose.
  new.zone_id := a.zone_id;
  new.floor_snapshot    := a.floor;
  new.has_lift_snapshot := a.has_lift;

  select * into z from zones where id = new.zone_id;

  if z.status <> 'open' and new.status <> 'WAITLISTED' then
    raise exception 'neighbourhood "%" is not open yet', z.name
      using errcode = 'check_violation',
            hint = 'Acceptance criterion 20.1: an order outside an open zone can only be WAITLISTED.';
  end if;

  return new;
end;
$$;

create trigger trg_order_creation
  before insert on orders
  for each row execute function app.guard_order_creation();

-- 20.10: a waiting-list neighbourhood accepts no payment. More precisely, a
-- WAITLISTED order may only become real (CREATED) or be paid once the zone is
-- actually open. Guarding PAID alone was not enough: CREATED is the step that
-- turns a waiting-list entry into an order, and spec 12 describes that
-- transition as "le quartier ouvre, la commande devient réelle".
create or replace function app.guard_no_payment_in_waitlist_zone()
returns trigger
language plpgsql
as $$
declare
  z record;
begin
  if new.status not in ('CREATED', 'PAID') then
    return new;
  end if;

  select * into z from zones where id = new.zone_id;

  if z.status <> 'open' then
    raise exception 'neighbourhood "%" is still on the waiting list: no order and no payment', z.name
      using errcode = 'check_violation',
            hint = 'Acceptance criteria 20.1 and 20.10.';
  end if;

  return new;
end;
$$;

create trigger trg_no_payment_in_waitlist_zone
  before update of status on orders
  for each row execute function app.guard_no_payment_in_waitlist_zone();
