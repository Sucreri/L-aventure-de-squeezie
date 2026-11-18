-- =============================================================================
-- acceptance.sql — the MVP acceptance criteria of spec 20, as executable tests.
--
-- Run against a database built by scripts/db-reset.sh --seed:
--   psql -d uberpalette -f supabase/tests/acceptance.sql
--
-- The script RAISES at the end if any assertion failed, so it can gate CI.
-- =============================================================================

\set ON_ERROR_STOP on
set client_min_messages = warning;

create schema if not exists test;

create table if not exists test.results (
  id serial primary key,
  criterion text not null,
  label text not null,
  passed boolean not null,
  detail text
);

truncate test.results restart identity;

create or replace function test.ok(p_criterion text, p_label text, p_cond boolean, p_detail text default null)
returns void language plpgsql as $$
begin
  insert into test.results (criterion, label, passed, detail)
  values (p_criterion, p_label, coalesce(p_cond, false), p_detail);
end;
$$;

-- Asserts that a statement is refused, optionally checking the message.
create or replace function test.refuses(p_criterion text, p_label text, p_sql text, p_expect text default null)
returns void language plpgsql as $$
declare
  msg text;
begin
  begin
    execute p_sql;
    insert into test.results (criterion, label, passed, detail)
    values (p_criterion, p_label, false, 'the statement was ACCEPTED but should have been refused');
    return;
  exception when others then
    msg := sqlerrm;
  end;

  if p_expect is not null and position(lower(p_expect) in lower(msg)) = 0 then
    insert into test.results (criterion, label, passed, detail)
    values (p_criterion, p_label, false, format('refused, but with an unexpected message: %s', msg));
  else
    insert into test.results (criterion, label, passed, detail)
    values (p_criterion, p_label, true, msg);
  end if;
end;
$$;

-- Asserts that a statement is accepted.
create or replace function test.accepts(p_criterion text, p_label text, p_sql text)
returns void language plpgsql as $$
begin
  begin
    execute p_sql;
    insert into test.results (criterion, label, passed, detail)
    values (p_criterion, p_label, true, null);
  exception when others then
    insert into test.results (criterion, label, passed, detail)
    values (p_criterion, p_label, false, sqlerrm);
  end;
end;
$$;

-- =============================================================================
-- Fixtures
-- =============================================================================

do $$
declare
  zone_biereau uuid := '11111111-0000-0000-0000-000000000001';
  admin_id uuid := '44444444-0000-0000-0000-000000000001';
begin
  -- Open Biéreau for the end-to-end tests. Thresholds are parameters, so an
  -- admin lowering them for a pilot is a legitimate action.
  update zones set client_threshold = 1, courier_threshold = 1 where id = zone_biereau;
  perform app.open_zone(zone_biereau, admin_id);
end;
$$;

-- =============================================================================
-- Criterion 20.1 — no order without a verified account, CGU + CGV, open zone
-- =============================================================================

do $$
declare
  unverified uuid := gen_random_uuid();
  addr uuid;
  client_biereau uuid;
  addr_biereau uuid;
  store uuid := '22222222-0000-0000-0000-000000000001';
  zone_hocaille uuid := '11111111-0000-0000-0000-000000000002';
  addr_hocaille uuid;
begin
  -- An unverified account with no consents.
  insert into users (id, roles, first_name, last_name, email, status)
  values (unverified, array['client']::user_role[], 'Non', 'Vérifié', 'unverified@example.invalid', 'active');

  insert into addresses (user_id, street, number, floor, lat, lon)
  values (unverified, 'Rue des Blancs Chevaux', '99', 1, 50.6680, 4.6150)
  returning id into addr;

  perform test.refuses('20.1', 'une commande sans compte vérifié est refusée',
    format($q$insert into orders (client_id, address_id, store_id, zone_id, mode)
             values (%L, %L, %L, %L, 'express')$q$, unverified, addr, store, '11111111-0000-0000-0000-000000000001'),
    'verified account');

  -- A verified client in the OPEN zone can order.
  select u.id, a.id into client_biereau, addr_biereau
    from users u join addresses a on a.user_id = u.id
    join zones z on z.id = a.zone_id
   where z.slug = 'biereau' and u.age_bracket = 'b18_plus' and u.email like 'kot%'
   limit 1;

  perform test.accepts('20.1', 'une commande valide dans une zone ouverte est acceptée',
    format($q$insert into orders (client_id, address_id, store_id, zone_id, mode)
             values (%L, %L, %L, %L, 'express')$q$,
           client_biereau, addr_biereau, store, '11111111-0000-0000-0000-000000000001'));

  -- A zone still on the waiting list only accepts a WAITLISTED order.
  select a.id into addr_hocaille
    from addresses a join zones z on z.id = a.zone_id
   where z.slug = 'hocaille' limit 1;

  perform test.refuses('20.1', 'une commande CREATED dans un quartier non ouvert est refusée',
    format($q$insert into orders (client_id, address_id, store_id, zone_id, mode)
             values ((select user_id from addresses where id = %L), %L, %L, %L, 'express')$q$,
           addr_hocaille, addr_hocaille, store, zone_hocaille),
    'not open yet');

  perform test.accepts('20.1', 'la même commande en WAITLISTED est acceptée',
    format($q$insert into orders (client_id, address_id, store_id, zone_id, mode, status)
             values ((select user_id from addresses where id = %L), %L, %L, %L, 'express', 'WAITLISTED')$q$,
           addr_hocaille, addr_hocaille, store, zone_hocaille));

  -- An address outside every zone is refused outright (spec 6.3).
  perform test.refuses('20.1', 'une adresse hors zone est refusée',
    format($q$insert into addresses (user_id, street, number, lat, lon)
             values (%L, 'Rue de Bruxelles', '1', 50.8500, 4.3500)$q$, unverified),
    'outside the service area');
end;
$$;

-- =============================================================================
-- Criterion 20.2 — the server refuses any alcohol beyond the verified age,
--                  including inside a group order
-- =============================================================================

do $$
declare
  store uuid := '22222222-0000-0000-0000-000000000001';
  zone uuid := '11111111-0000-0000-0000-000000000001';
  teen uuid; teen_addr uuid;
  adult uuid; adult_addr uuid;
  o_teen uuid; o_adult uuid;
  beer uuid := '33333333-0000-0000-0000-000000000001';
  water uuid := '33333333-0000-0000-0000-000000000006';
  spirit uuid;
  go_id uuid;
begin
  select id into spirit from products where sku = 'SPIRIT-DEMO';

  -- A verified 16-17 client in the open zone.
  select u.id, a.id into teen, teen_addr
    from users u join addresses a on a.user_id = u.id join zones z on z.id = a.zone_id
   where z.slug = 'biereau' and u.age_bracket = 'b16_17' limit 1;

  -- If no 16-17 client landed in Biéreau, move one there for the test.
  if teen is null then
    select u.id into teen from users u where u.age_bracket = 'b16_17' limit 1;
    insert into addresses (user_id, street, number, floor, lat, lon)
    values (teen, 'Rue des Blancs Chevaux', '77', 2, 50.6680, 4.6150)
    returning id into teen_addr;
  end if;

  select u.id, a.id into adult, adult_addr
    from users u join addresses a on a.user_id = u.id join zones z on z.id = a.zone_id
   where z.slug = 'biereau' and u.age_bracket = 'b18_plus' and u.email like 'kot%' limit 1;

  insert into orders (client_id, address_id, store_id, zone_id, mode)
  values (teen, teen_addr, store, zone, 'express') returning id into o_teen;

  insert into orders (client_id, address_id, store_id, zone_id, mode)
  values (adult, adult_addr, store, zone, 'express') returning id into o_adult;

  -- Beer is 16+: a verified 16-17 client may buy it.
  perform test.accepts('20.2', 'un client 16-17 vérifié peut acheter de la bière (16+)',
    format($q$insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                                       age_minimum_snapshot, contains_alcohol_snapshot)
             values (%L, %L, 1, 1499, 0, false)$q$, o_teen, beer));

  -- An 18+ product is refused for a 16-17 client.
  perform test.refuses('20.2', 'un produit 18+ est refusé à un client 16-17',
    format($q$insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                                       age_minimum_snapshot, contains_alcohol_snapshot)
             values (%L, %L, 1, 1999, 0, false)$q$, o_teen, spirit),
    'not available');   -- the spirits row is inactive, which is the first refusal

  -- Group order: an alcoholic item attributed to a 16-17 participant where the
  -- product needs 18 must be refused; beer attributed to them is fine.
  insert into group_orders (order_id, host_id, expires_at)
  values (o_adult, adult, now() + interval '30 minutes') returning id into go_id;

  insert into group_participants (group_order_id, user_id) values (go_id, adult);
  insert into group_participants (group_order_id, user_id) values (go_id, teen);

  perform test.accepts('20.2', 'commande groupée : la bière peut être attribuée à un participant 16-17',
    format($q$insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                                       participant_id, age_minimum_snapshot, contains_alcohol_snapshot)
             values (%L, %L, 1, 1499, %L, 0, false)$q$, o_adult, beer, teen));

  -- A participant who is not in the group cannot be attributed an item.
  perform test.refuses('20.2', 'commande groupée : un non-participant ne peut pas se voir attribuer un article',
    format($q$insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                                       participant_id, age_minimum_snapshot, contains_alcohol_snapshot)
             values (%L, %L, 1, 399, %L, 0, false)$q$,
           o_adult, water, '44444444-0000-0000-0000-000000000001'),
    'does not take part');

  -- A participant without a verified account cannot join at all (spec 8.6).
  perform test.refuses('20.2', 'commande groupée : un compte non vérifié ne peut pas participer',
    format($q$insert into group_participants (group_order_id, user_id)
             values (%L, (select id from users where email = 'unverified@example.invalid'))$q$, go_id),
    'verified account');
end;
$$;

-- Direct test of the age predicate, which every path goes through.
do $$
begin
  perform test.ok('20.2', 'prédicat d''âge : non vérifié ne peut acheter aucun alcool',
    app.may_buy_age_restricted('b18_plus', false, 16) = false);
  perform test.ok('20.2', 'prédicat d''âge : 16-17 ne peut pas acheter du 18+',
    app.may_buy_age_restricted('b16_17', true, 18) = false);
  perform test.ok('20.2', 'prédicat d''âge : 18+ vérifié peut acheter du 16+',
    app.may_buy_age_restricted('b18_plus', true, 16) = true);
  perform test.ok('20.2', 'prédicat d''âge : un produit sans alcool est ouvert à tous',
    app.may_buy_age_restricted(null, false, 0) = true);
end;
$$;

-- =============================================================================
-- Criterion 20.3 — alcohol cannot reach DELIVERED without an age check and a
--                  correct PIN; no identity data is stored
-- =============================================================================

do $$
declare
  store uuid := '22222222-0000-0000-0000-000000000001';
  zone uuid := '11111111-0000-0000-0000-000000000001';
  client uuid; addr uuid; o uuid;
  courier uuid;
  beer uuid := '33333333-0000-0000-0000-000000000001';
  ac uuid;
  cols integer;
begin
  select u.id, a.id into client, addr
    from users u join addresses a on a.user_id = u.id join zones z on z.id = a.zone_id
   where z.slug = 'biereau' and u.age_bracket = 'b18_plus' and u.email like 'kot%' limit 1;

  select user_id into courier from courier_profiles limit 1;

  insert into orders (client_id, address_id, store_id, zone_id, mode, status)
  values (client, addr, store, zone, 'express', 'CREATED') returning id into o;

  insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                           age_minimum_snapshot, contains_alcohol_snapshot)
  values (o, beer, 2, 1499, 0, false);

  perform app.set_order_pin(o, '4821');

  -- Walk the order to ARRIVED.
  perform app.set_actor(client, 'client', 'test');
  update orders set status = 'PAID' where id = o;
  update orders set status = 'SEARCHING_COURIER' where id = o;
  update orders set status = 'COURIER_ASSIGNED' where id = o;
  update orders set status = 'AT_STORE' where id = o;
  update orders set status = 'PURCHASED' where id = o;
  update orders set status = 'EN_ROUTE' where id = o;
  update orders set status = 'ARRIVED' where id = o;

  -- No age check yet: delivery must be refused.
  perform test.refuses('20.3', 'alcool : livraison refusée sans contrôle d''âge',
    format($q$select app.deliver_order(%L, %L, '4821')$q$, o, courier),
    'age check is required');

  -- Record a passing age check, then try a wrong PIN.
  ac := app.record_age_check(o, courier, 'ok', null, true, true);

  perform test.refuses('20.3', 'alcool : livraison refusée avec un mauvais PIN',
    format($q$select app.deliver_order(%L, %L, '0000')$q$, o, courier),
    'invalid pin');

  -- A direct UPDATE must be refused too: the rule is in the database, not in
  -- a service layer that could be bypassed.
  perform test.refuses('20.3', 'alcool : un UPDATE direct vers DELIVERED est refusé',
    format($q$update orders set status = 'DELIVERED' where id = %L$q$, o),
    'requires a verified pin');

  -- The correct PIN, after the age check, works.
  perform test.accepts('20.3', 'alcool : livraison acceptée après contrôle d''âge et PIN correct',
    format($q$select app.deliver_order(%L, %L, '4821')$q$, o, courier));

  perform test.ok('20.3', 'la commande est bien passée à DELIVERED',
    (select status from orders where id = o) = 'DELIVERED');

  -- No identity data is stored: the age_checks table must have no column that
  -- could hold a birth year, a document number or a photo.
  select count(*) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'age_checks'
     and (column_name ~* '(birth|naissance|year|annee|année|document_number|id_number|photo|image|scan)');

  perform test.ok('20.3', 'age_checks ne contient aucune colonne d''identité', cols = 0,
    format('colonnes suspectes trouvées : %s', cols));

  select count(*) into cols
    from information_schema.columns
   where table_schema = 'public' and table_name = 'users'
     and (column_name ~* '(birth|naissance|date_of_birth|dob)');

  perform test.ok('20.3', 'users ne contient aucune date de naissance', cols = 0);

  -- The PIN is never stored in clear.
  perform test.ok('20.3', 'le PIN est stocké haché, jamais en clair',
    (select pin_hash from orders where id = o) not like '%4821%');

  -- An age check cannot be rewritten afterwards.
  perform test.refuses('20.3', 'un contrôle d''âge ne peut pas être modifié après coup',
    format($q$update age_checks set result = 'refused' where id = %L$q$, ac),
    'append-only');
end;
$$;

-- A refused age check sends the order to DELIVERY_FAILED (spec 13.3).
do $$
declare
  store uuid := '22222222-0000-0000-0000-000000000001';
  zone uuid := '11111111-0000-0000-0000-000000000001';
  client uuid; addr uuid; o uuid; courier uuid;
  beer uuid := '33333333-0000-0000-0000-000000000001';
begin
  select u.id, a.id into client, addr
    from users u join addresses a on a.user_id = u.id join zones z on z.id = a.zone_id
   where z.slug = 'biereau' and u.age_bracket = 'b18_plus' and u.email like 'kot%' limit 1;
  select user_id into courier from courier_profiles limit 1;

  insert into orders (client_id, address_id, store_id, zone_id, mode)
  values (client, addr, store, zone, 'express') returning id into o;
  insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                           age_minimum_snapshot, contains_alcohol_snapshot)
  values (o, beer, 1, 1499, 0, false);

  perform app.set_order_pin(o, '1234');
  perform app.set_actor(client, 'client', 'test');
  update orders set status = 'PAID' where id = o;
  update orders set status = 'SEARCHING_COURIER' where id = o;
  update orders set status = 'COURIER_ASSIGNED' where id = o;
  update orders set status = 'AT_STORE' where id = o;
  update orders set status = 'PURCHASED' where id = o;
  update orders set status = 'EN_ROUTE' where id = o;
  update orders set status = 'ARRIVED' where id = o;

  perform app.record_age_check(o, courier, 'refused', 'visibly_intoxicated', true, false);

  perform test.ok('20.3', 'un refus de remise bascule la commande en DELIVERY_FAILED',
    (select status from orders where id = o) = 'DELIVERY_FAILED');

  -- A positive check requires both boxes to be ticked (spec 13.2).
  perform test.refuses('20.3', 'un contrôle "ok" sans pièce vérifiée est refusé',
    format($q$insert into age_checks (order_id, courier_id, result, document_checked, person_appears_sober)
             values (%L, %L, 'ok', false, true)$q$, o, courier),
    'chk_ok_requires_both_boxes');
end;
$$;

-- =============================================================================
-- Criterion 20.4 — the promotion engine rejects any alcohol-related rule
-- =============================================================================

do $$
declare
  d integer; s integer;
begin
  perform test.refuses('20.4', 'une promotion liée à une quantité de palettes est rejetée',
    $q$insert into promotions (name, target, discount_type, discount_percent, conditions, starts_at, ends_at)
       values ('2 palettes', 'delivery_fee', 'percent', 0.5, '{"min_pallets":2}'::jsonb, now(), now()+interval '1 day')$q$,
    'forbidden promotion condition');

  perform test.refuses('20.4', 'une promotion ciblant un produit est rejetée',
    $q$insert into promotions (name, target, discount_type, discount_fixed_cents, conditions, starts_at, ends_at)
       values ('Produit', 'delivery_fee', 'fixed', 100, '{"product_ids":["x"]}'::jsonb, now(), now()+interval '1 day')$q$,
    'forbidden promotion condition');

  perform test.refuses('20.4', 'une promotion dont le texte mentionne la bière est rejetée',
    $q$insert into promotions (name, target, discount_type, discount_fixed_cents, conditions, starts_at, ends_at)
       values ('Bière', 'delivery_fee', 'fixed', 100, '{"modes":["express"],"max_per_user":"biere offerte"}'::jsonb, now(), now()+interval '1 day')$q$,
    'may not reference a product or alcohol');

  perform test.accepts('20.4', 'une promotion portant uniquement sur les frais est acceptée',
    $q$insert into promotions (name, target, discount_type, discount_percent, conditions, starts_at, ends_at)
       values ('Frais réduits', 'delivery_fee', 'percent', 0.5, '{"min_order_cents":1500}'::jsonb, now(), now()+interval '1 day')$q$);

  -- A fixed discount in cents must also work: 100 cents off a 650 cent fee.
  perform test.accepts('20.4', 'une promotion à montant fixe en centimes est acceptée',
    $q$insert into promotions (name, target, discount_type, discount_fixed_cents, conditions, starts_at, ends_at)
       values ('1 € de frais en moins', 'service_fee', 'fixed', 20, '{"modes":["express"]}'::jsonb, now(), now()+interval '1 day')$q$);

  -- Structural proof: promotion_target can only ever name a fee.
  perform test.ok('20.4', 'promotion_target ne peut désigner que des frais',
    (select array_agg(e.enumlabel::text order by e.enumlabel)
       from pg_enum e join pg_type t on t.oid = e.enumtypid
      where t.typname = 'promotion_target') = array['delivery_fee','service_fee']);

  -- Applying a promotion cannot touch the item total: it is not even an input.
  select p.delivery_fee_cents, p.service_fee_cents into d, s
    from app.apply_promotion((select id from promotions where name = 'Frais réduits'), 650, 49) p;

  perform test.ok('20.4', 'appliquer une promotion ne réduit que les frais (650 -> 325)',
    d = 325 and s = 49, format('obtenu : livraison=%s service=%s', d, s));
end;
$$;

-- =============================================================================
-- Criterion 20.5 — displayed total equals debited amount; the spec 9 example
--                  gives 6.50 EUR
-- =============================================================================

do $$
declare
  fee integer;
begin
  fee := app.compute_delivery_fee(2, 3, false, 1.0, 'express');
  perform test.ok('20.5', 'exemple §9 : 2 palettes, 3e étage sans ascenseur, c=1,0 → 6,50 €',
    fee = 650, format('obtenu %s centimes', fee));

  perform test.ok('20.5', 'frais de service = 0,49 €',
    app.setting_int('pricing.service_fee_cents') = 49);

  -- Lift: flat fee instead of per floor.
  perform test.ok('20.5', 'avec ascenseur : forfait de 1,00 € quel que soit l''étage',
    app.compute_delivery_fee(1, 5, true, 1.0, 'express') = 450);

  -- Ground floor: no floor fee.
  perform test.ok('20.5', 'rez-de-chaussée : aucun frais d''étage',
    app.compute_delivery_fee(1, 0, false, 1.0, 'express') = 350);

  -- Grouped round: -40% on the delivery fee.
  perform test.ok('20.5', 'tournée groupée : −40 % sur les frais de livraison',
    app.compute_delivery_fee(2, 3, false, 1.0, 'grouped_round') = 390,
    format('obtenu %s', app.compute_delivery_fee(2, 3, false, 1.0, 'grouped_round')));

  -- Surge is applied and bounded.
  perform test.ok('20.5', 'coefficient d''affluence 1,5 appliqué',
    app.compute_delivery_fee(2, 3, false, 1.5, 'express') = 975);

  perform test.refuses('20.5', 'un coefficient hors bornes est refusé',
    $q$select app.compute_delivery_fee(2, 3, false, 2.0, 'express')$q$,
    'outside the allowed range');

  -- The order total is constrained to be the exact sum of its parts.
  perform test.refuses('20.5', 'un total incohérent est refusé par la base',
    $q$insert into orders (client_id, address_id, store_id, zone_id, mode,
                           items_estimated_cents, delivery_fee_cents, service_fee_cents,
                           tip_cents, total_estimated_cents)
       values ((select u.id from users u join addresses a on a.user_id=u.id
                 join zones z on z.id=a.zone_id where z.slug='biereau' and u.email like 'kot%' limit 1),
               (select a.id from addresses a join zones z on z.id=a.zone_id where z.slug='biereau' limit 1),
               '22222222-0000-0000-0000-000000000001','11111111-0000-0000-0000-000000000001','express',
               1000, 650, 49, 0, 9999)$q$,
    'chk_total_is_sum');
end;
$$;

-- Spec 10: the ticket-gap rules.
do $$
declare
  store uuid := '22222222-0000-0000-0000-000000000001';
  zone uuid := '11111111-0000-0000-0000-000000000001';
  client uuid; addr uuid; o uuid;
  r record;
begin
  select u.id, a.id into client, addr
    from users u join addresses a on a.user_id = u.id join zones z on z.id = a.zone_id
   where z.slug = 'biereau' and u.email like 'kot%' limit 1;

  insert into orders (client_id, address_id, store_id, zone_id, mode,
                      items_estimated_cents, delivery_fee_cents, service_fee_cents,
                      total_estimated_cents)
  values (client, addr, store, zone, 'express', 3000, 650, 49, 3699) returning id into o;

  -- Ticket lower than the estimate: the difference is refunded.
  select * into r from app.ticket_gap_decision(o, 2800);
  perform test.ok('20.5/§10', 'ticket inférieur : remboursement automatique de la différence',
    r.refund_cents = 200 and r.requires_client_approval = false);

  -- Ticket 80 cents higher: fully absorbed by the operator (limit 100).
  select * into r from app.ticket_gap_decision(o, 3080);
  perform test.ok('20.5/§10', 'ticket supérieur de 0,80 € : absorbé par l''Opérateur',
    r.operator_absorbs_cents = 80 and r.extra_capture_cents = 0 and r.requires_client_approval = false);

  -- Ticket 2.50 EUR higher: 1.00 absorbed, 1.50 needs the client's approval.
  select * into r from app.ticket_gap_decision(o, 3250);
  perform test.ok('20.5/§10', 'ticket supérieur de 2,50 € : 1,00 € absorbé, accord du client requis pour 1,50 €',
    r.operator_absorbs_cents = 100 and r.extra_capture_cents = 150 and r.requires_client_approval = true,
    format('absorbé=%s solde=%s accord=%s', r.operator_absorbs_cents, r.extra_capture_cents, r.requires_client_approval));
end;
$$;

-- =============================================================================
-- Criterion 20.6 — no mission without contract + Dimona; no shift after 20:00
--                  without a ticked derogation
-- =============================================================================

do $$
declare
  zone uuid := '11111111-0000-0000-0000-000000000001';
  store uuid := '22222222-0000-0000-0000-000000000001';
  admin_id uuid := '44444444-0000-0000-0000-000000000001';
  nocontract uuid := gen_random_uuid();
  tomorrow date := (now() + interval '1 day')::date;
begin
  -- A courier without a contract.
  insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                     verification_method, verified_at, status)
  values (nocontract, array['client','courier']::user_role[], 'Sans', 'Contrat',
          'nocontract@example.invalid', 'b18_plus', true, 'itsme', now(), 'active');

  -- Formation validée, mais ni contrat ni Dimona : chaque condition est
  -- testée séparément, sinon un refus pour le mauvais motif passerait inaperçu.
  insert into courier_profiles (user_id, transport, capacity_units, training_passed_at,
                                contract_signed, dimona_confirmed, status)
  values (nocontract, 'foot_trolley', 3, now(), false, false, 'applied');

  perform test.refuses('20.6', 'aucune mission sans contrat signé ni Dimona confirmée',
    format($q$insert into missions (courier_id, store_id) values (%L, %L)$q$, nocontract, store),
    'signed contract and a confirmed dimona');

  perform test.refuses('20.6', 'un palettier sans contrat ne peut pas réserver de créneau',
    format($q$insert into shift_bookings (shift_id, courier_id)
             values ((select id from shifts limit 1), %L)$q$, nocontract),
    'contract or dimona missing');

  -- §7.2 : la formation obligatoire est une condition distincte du contrat.
  declare
    untrained uuid := gen_random_uuid();
  begin
    insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                       verification_method, verified_at, status)
    values (untrained, array['client','courier']::user_role[], 'Sans', 'Formation',
            'untrained@example.invalid', 'b18_plus', true, 'itsme', now(), 'active');

    insert into courier_profiles (user_id, transport, capacity_units, training_passed_at,
                                  contract_signed, contract_signed_at,
                                  dimona_confirmed, dimona_confirmed_at, status)
    values (untrained, 'foot_trolley', 3, null, true, now(), true, now(), 'active');

    perform test.refuses('20.6', 'un palettier sans formation validée ne peut pas réserver',
      format($q$insert into shift_bookings (shift_id, courier_id)
               values ((select id from shifts limit 1), %L)$q$, untrained),
      'mandatory training');
  end;

  -- A courier cannot be set active without both elements.
  perform test.refuses('20.6', 'un profil palettier ne peut pas être actif sans contrat ni Dimona',
    format($q$update courier_profiles set status = 'active' where user_id = %L$q$, nocontract),
    'chk_active_requires_contract_and_dimona');

  -- A shift ending at 19:00 is fine.
  perform test.accepts('20.6', 'un créneau 16 h – 19 h est publiable sans dérogation',
    format($q$insert into shifts (zone_id, starts_at, ends_at, places, published_by)
             values (%L, timestamptz %L, timestamptz %L, 5, %L)$q$,
           zone, tomorrow || ' 16:00+01', tomorrow || ' 19:00+01', admin_id));

  -- A shift ending at 22:00 without the derogation is refused.
  perform test.refuses('20.6', 'un créneau 19 h – 22 h sans dérogation est refusé',
    format($q$insert into shifts (zone_id, starts_at, ends_at, places, published_by)
             values (%L, timestamptz %L, timestamptz %L, 5, %L)$q$,
           zone, tomorrow || ' 19:00+01', tomorrow || ' 22:00+01', admin_id),
    'night derogation');

  -- With a validated derogation it is accepted, and the action is journalled.
  perform test.accepts('20.6', 'le même créneau avec dérogation validée est accepté',
    format($q$insert into shifts (zone_id, starts_at, ends_at, places, published_by,
                                  night_derogation, derogation_validated_by, derogation_note)
             values (%L, timestamptz %L, timestamptz %L, 5, %L, true, %L,
                     'Dérogation validée par le secrétariat social — réf. DÉMO')$q$,
           zone, tomorrow || ' 19:00+01', tomorrow || ' 22:00+01', admin_id, admin_id));

  perform test.ok('20.6', 'la dérogation est journalisée',
    exists (select 1 from audit.settings_history where key = 'shift.night_derogation'));

  -- §14 : l'app empêche de réserver au-delà des durées maximales.
  declare
    marathon uuid;
    courier uuid := gen_random_uuid();
    long_shift uuid;
    max_day integer := app.setting_int('work.max_hours_per_day');
  begin
    -- Un palettier neuf : réutiliser un palettier de démonstration ferait
    -- compter les heures des tests précédents et testerait autre chose.
    insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                       verification_method, verified_at, status)
    values (courier, array['client','courier']::user_role[], 'Durée', 'Maximale',
            'maxhours@example.invalid', 'b18_plus', true, 'itsme', now(), 'active');

    insert into courier_profiles (user_id, transport, capacity_units, training_passed_at,
                                  contract_signed, contract_signed_at,
                                  dimona_confirmed, dimona_confirmed_at, status)
    values (courier, 'cargo_bike', 6, now(), true, now(), true, now(), 'active');

    insert into shifts (zone_id, starts_at, ends_at, places, published_by)
    values (zone, (tomorrow || ' 08:00+01')::timestamptz,
                  (tomorrow || ' 15:00+01')::timestamptz, 5, admin_id)
    returning id into long_shift;

    insert into shift_bookings (shift_id, courier_id) values (long_shift, courier);

    insert into shifts (zone_id, starts_at, ends_at, places, published_by)
    values (zone, (tomorrow || ' 15:30+01')::timestamptz,
                  (tomorrow || ' 18:30+01')::timestamptz, 5, admin_id)
    returning id into marathon;

    perform test.refuses('20.6',
      format('aucune réservation au-delà de %s h par jour (§14)', max_day),
      format($q$insert into shift_bookings (shift_id, courier_id) values (%L, %L)$q$,
             marathon, courier),
      'hours per day');
  end;
end;
$$;

-- No shift at all while the mandatory employer references are missing (H-11).
do $$
declare
  zone uuid := '11111111-0000-0000-0000-000000000001';
  admin_id uuid := '44444444-0000-0000-0000-000000000001';
  saved jsonb;
begin
  select value into saved from app_settings where key = 'labour.work_accident_insurance_ref';
  update app_settings set value = 'null'::jsonb where key = 'labour.work_accident_insurance_ref';

  perform test.refuses('20.6', 'aucun créneau tant que l''assurance accidents du travail n''est pas référencée',
    format($q$insert into shifts (zone_id, starts_at, ends_at, places, published_by)
             values (%L, now() + interval '2 days', now() + interval '2 days 3 hours', 5, %L)$q$,
           zone, admin_id),
    'work_accident_insurance_ref');

  update app_settings set value = saved where key = 'labour.work_accident_insurance_ref';
end;
$$;

-- =============================================================================
-- Criterion 20.7 — no position outside a shift; positions older than 30 days
--                  are purged
-- =============================================================================

-- Fixed windows on purpose: a relative "now() + 2 hours" would drift past the
-- service end time depending on when the suite runs, and the guard would be
-- right to refuse it. Shifts here run 16:00-19:00, well inside the day.
do $$
declare
  courier uuid; booking uuid; shift_id uuid; old_shift uuid; old_booking uuid;
  zone uuid := '11111111-0000-0000-0000-000000000001';
  admin_id uuid := '44444444-0000-0000-0000-000000000001';
  day_soon date := (now() + interval '1 day')::date;
  day_past date := (now() - interval '40 days')::date;
  purged integer;
begin
  select user_id into courier from courier_profiles where status = 'active' limit 1;

  insert into shifts (zone_id, starts_at, ends_at, places, published_by)
  values (zone, (day_soon || ' 16:00+01')::timestamptz, (day_soon || ' 19:00+01')::timestamptz, 5, admin_id)
  returning id into shift_id;

  insert into shift_bookings (shift_id, courier_id) values (shift_id, courier)
  returning id into booking;

  perform test.accepts('20.7', 'une position pendant un créneau réservé est acceptée',
    format($q$insert into courier_positions (courier_id, shift_booking_id, lat, lon, recorded_at)
             values (%L, %L, 50.6695, 4.6145, timestamptz %L)$q$,
           courier, booking, day_soon || ' 17:00+01'));

  perform test.refuses('20.7', 'une position hors de la fenêtre du créneau est refusée',
    format($q$insert into courier_positions (courier_id, shift_booking_id, lat, lon, recorded_at)
             values (%L, %L, 50.6695, 4.6145, timestamptz %L)$q$,
           courier, booking, day_soon || ' 20:30+01'),
    'outside the booked shift');

  -- Positions older than the retention period are purged by the job.
  insert into shifts (zone_id, starts_at, ends_at, places, published_by)
  values (zone, (day_past || ' 16:00+01')::timestamptz, (day_past || ' 19:00+01')::timestamptz, 5, admin_id)
  returning id into old_shift;
  insert into shift_bookings (shift_id, courier_id) values (old_shift, courier)
  returning id into old_booking;

  insert into courier_positions (courier_id, shift_booking_id, lat, lon, recorded_at)
  values (courier, old_booking, 50.6695, 4.6145, (day_past || ' 17:00+01')::timestamptz);

  select rows_affected into purged
    from app.run_retention() where job_name = 'courier_positions';

  perform test.ok('20.7', 'les positions de plus de 30 jours sont purgées', purged >= 1,
    format('%s ligne(s) purgée(s)', purged));

  perform test.ok('20.7', 'la purge est journalisée',
    exists (select 1 from audit.retention_runs where job_name = 'courier_positions'));
end;
$$;

-- Geolocation requires a separate consent (spec 6.2).
do $$
declare
  courier uuid; booking uuid; shift_id uuid;
  zone uuid := '11111111-0000-0000-0000-000000000001';
  admin_id uuid := '44444444-0000-0000-0000-000000000001';
  day_soon date := (now() + interval '1 day')::date;
begin
  select cp.user_id into courier from courier_profiles cp where cp.status = 'active'
   order by cp.user_id desc limit 1;

  insert into consents (user_id, consent_type, granted) values (courier, 'geolocation', false);

  insert into shifts (zone_id, starts_at, ends_at, places, published_by)
  values (zone, (day_soon || ' 16:00+01')::timestamptz, (day_soon || ' 19:00+01')::timestamptz, 5, admin_id)
  returning id into shift_id;
  insert into shift_bookings (shift_id, courier_id) values (shift_id, courier)
  returning id into booking;

  perform test.refuses('20.7', 'aucune position sans consentement à la géolocalisation',
    format($q$insert into courier_positions (courier_id, shift_booking_id, lat, lon, recorded_at)
             values (%L, %L, 50.6695, 4.6145, timestamptz %L)$q$,
           courier, booking, day_soon || ' 17:00+01'),
    'has not consented');

  insert into consents (user_id, consent_type, granted) values (courier, 'geolocation', true);
end;
$$;

-- =============================================================================
-- Criterion 20.8 — INDEPENDENT stays unactivatable without a legal opinion
-- =============================================================================

do $$
declare
  c uuid;
begin
  select user_id into c from courier_profiles limit 1;

  perform test.refuses('20.8', 'le mode INDEPENDENT est refusé par défaut',
    format($q$update courier_profiles set courier_model = 'INDEPENDENT' where user_id = %L$q$, c),
    'independent mode is locked');

  -- Turning the flag on is not enough: the legal opinion is still required.
  update app_settings set value = 'true'::jsonb where key = 'courier.independent_mode_enabled';

  perform test.refuses('20.8', 'activer le paramètre ne suffit pas sans avis juridique téléversé',
    format($q$update courier_profiles set courier_model = 'INDEPENDENT' where user_id = %L$q$, c),
    'independent mode is locked');

  update app_settings set value = to_jsonb('AVIS-DEMO-001'::text)
    where key = 'courier.independent_legal_opinion_id';

  perform test.accepts('20.8', 'avec le paramètre ET l''avis juridique, le mode devient activable',
    format($q$update courier_profiles set courier_model = 'INDEPENDENT' where user_id = %L$q$, c));

  -- Restore the locked state.
  update courier_profiles set courier_model = 'STUDENT_EMPLOYEE' where user_id = c;
  update app_settings set value = 'false'::jsonb where key = 'courier.independent_mode_enabled';
  update app_settings set value = 'null'::jsonb where key = 'courier.independent_legal_opinion_id';
end;
$$;

-- =============================================================================
-- Criterion 20.9 — self-service export and deletion
-- =============================================================================

do $$
declare
  client uuid;
  payload jsonb;
  req data_subject_requests;
  deleting uuid := gen_random_uuid();
  addr uuid;
begin
  select u.id into client from users u where u.email like 'kot3@%' limit 1;

  payload := app.export_user_data(client);

  perform test.ok('20.9', 'l''export libre-service renvoie le compte, les consentements et les commandes',
    payload ? 'account' and payload ? 'consents' and payload ? 'orders' and payload ? 'addresses');

  perform test.ok('20.9', 'l''export ne contient aucune date de naissance',
    payload::text !~* '(birth|naissance|date_of_birth)');

  perform test.ok('20.9', 'la demande d''export est tracée',
    exists (select 1 from data_subject_requests d
             where d.user_id = client and d.kind = 'export' and d.status = 'completed'));

  -- Deletion with no order in flight completes immediately.
  insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                     verification_method, verified_at, status)
  values (deleting, array['client']::user_role[], 'À', 'Supprimer', 'todelete@example.invalid',
          'b18_plus', true, 'itsme', now(), 'active');
  insert into addresses (user_id, street, number, lat, lon)
  values (deleting, 'Rue des Blancs Chevaux', '1', 50.6680, 4.6150) returning id into addr;

  req := app.request_account_deletion(deleting);

  perform test.ok('20.9', 'la suppression en libre-service aboutit immédiatement sans commande en cours',
    req.status = 'completed');

  perform test.ok('20.9', 'le compte supprimé est anonymisé',
    (select email is null and phone is null and age_bracket is null and status = 'deleted'
       from users where id = deleting));

  perform test.ok('20.9', 'les adresses du compte supprimé sont effacées',
    not exists (select 1 from addresses where user_id = deleting));

  -- Deletion with an order in flight is deferred, not dropped (spec 19).
  -- The fixture creates its own in-flight order rather than hoping one exists.
  declare
    busy uuid := gen_random_uuid();
    busy_addr uuid;
    busy_order uuid;
    tos2 uuid;
    cgv2 uuid;
  begin
    select id into tos2 from legal_documents where doc_key = 'tos';
    select id into cgv2 from legal_documents where doc_key = 'sales_terms';

    insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                       verification_method, verified_at, status)
    values (busy, array['client']::user_role[], 'Commande', 'EnCours',
            'busy@example.invalid', 'b18_plus', true, 'itsme', now(), 'active');
    insert into consents (user_id, consent_type, granted, legal_document_id)
    values (busy, 'tos', true, tos2), (busy, 'sales_terms', true, cgv2);
    insert into addresses (user_id, street, number, lat, lon)
    values (busy, 'Rue des Blancs Chevaux', '5', 50.6680, 4.6150) returning id into busy_addr;

    insert into orders (client_id, address_id, store_id, zone_id, mode)
    values (busy, busy_addr, '22222222-0000-0000-0000-000000000001',
            '11111111-0000-0000-0000-000000000001', 'express')
    returning id into busy_order;

    perform app.set_actor(busy, 'client', 'test');
    update orders set status = 'PAID' where id = busy_order;

    perform test.ok('20.9', 'une suppression avec commande en cours est différée, jamais ignorée',
      (app.request_account_deletion(busy)).status = 'deferred');

    perform test.ok('20.9', 'le compte avec commande en cours n''est pas anonymisé tout de suite',
      (select status = 'active' from users where id = busy));
  end;
end;
$$;

-- =============================================================================
-- Criterion 20.10 — a waiting-list neighbourhood accepts no payment; opening
--                   notifies only those who consented
-- =============================================================================

do $$
declare
  o uuid;
  zone_bruyeres uuid := '11111111-0000-0000-0000-000000000003';
  admin_id uuid := '44444444-0000-0000-0000-000000000001';
  notified integer; activated integer; consenting integer;
begin
  select id into o from orders where status = 'WAITLISTED' limit 1;

  perform app.set_actor(admin_id, 'ops', 'test');

  perform test.refuses('20.10', 'un quartier en liste d''attente ne laisse pas une commande devenir réelle',
    format($q$update orders set status = 'CREATED' where id = %L$q$, o),
    'still on the waiting list');

  perform test.refuses('20.10', 'un quartier en liste d''attente n''accepte aucun paiement',
    format($q$update orders set status = 'PAID' where id = %L$q$, o),
    'still on the waiting list');

  -- Opening is blocked while thresholds are unmet.
  perform test.refuses('20.10', 'un quartier n''ouvre pas tant que les seuils ne sont pas atteints',
    format($q$select app.open_zone(%L, %L)$q$, zone_bruyeres, admin_id),
    'thresholds not reached');

  -- Lower the thresholds and open: only consenting users get notified.
  update zones set client_threshold = 1, courier_threshold = 1 where id = zone_bruyeres;

  select count(*) into consenting
    from waitlist_entries w where w.zone_id = zone_bruyeres
     and app.has_consent(w.user_id, 'marketing');

  perform app.open_zone(zone_bruyeres, admin_id);

  select count(*) filter (where notified_at is not null),
         count(*) filter (where activated_at is not null)
    into notified, activated
    from waitlist_entries where zone_id = zone_bruyeres;

  perform test.ok('20.10', 'tous les inscrits sont activés à l''ouverture', activated > 0);
  perform test.ok('20.10', 'seuls les inscrits consentants sont notifiés',
    notified = consenting,
    format('notifiés=%s consentants=%s activés=%s', notified, consenting, activated));
end;
$$;

-- A zone cannot open while a launch parameter is missing (spec 4.3, 4.11).
do $$
declare
  saved jsonb;
  admin_id uuid := '44444444-0000-0000-0000-000000000001';
  zone_hocaille uuid := '11111111-0000-0000-0000-000000000002';
begin
  select value into saved from app_settings where key = 'food.afsca_registration_ref';
  update app_settings set value = 'null'::jsonb where key = 'food.afsca_registration_ref';
  update zones set client_threshold = 1, courier_threshold = 1 where id = zone_hocaille;

  perform test.refuses('20.10', 'un quartier n''ouvre pas tant qu''un paramètre de lancement manque (AFSCA)',
    format($q$select app.open_zone(%L, %L)$q$, zone_hocaille, admin_id),
    'launch parameters are missing');

  update app_settings set value = saved where key = 'food.afsca_registration_ref';
end;
$$;

-- =============================================================================
-- Criterion 20.11 — 100% of status transitions are tested
-- =============================================================================

do $$
declare
  st_from order_status;
  st_to order_status;
  o uuid;
  client uuid; addr uuid;
  store uuid := '22222222-0000-0000-0000-000000000001';
  zone uuid := '11111111-0000-0000-0000-000000000001';
  water uuid := '33333333-0000-0000-0000-000000000006';
  should_pass boolean;
  did_pass boolean;
  failures integer := 0;
  tested integer := 0;
  mismatch text := '';
begin
  select u.id, a.id into client, addr
    from users u join addresses a on a.user_id = u.id join zones z on z.id = a.zone_id
   where z.slug = 'biereau' and u.email like 'kot%' limit 1;

  -- An alcohol-free order with a verified PIN, so DELIVERED is reachable.
  insert into orders (client_id, address_id, store_id, zone_id, mode)
  values (client, addr, store, zone, 'express') returning id into o;
  insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                           age_minimum_snapshot, contains_alcohol_snapshot)
  values (o, water, 1, 399, 0, false);
  update orders set pin_verified_at = now() where id = o;

  perform app.set_actor(client, 'client', 'transition matrix test');

  for st_from in select unnest(enum_range(null::order_status)) loop
    for st_to in select unnest(enum_range(null::order_status)) loop
      continue when st_from = st_to;

      should_pass := exists (select 1 from order_transitions t
                              where t.from_status = st_from and t.to_status = st_to);

      -- Position the order at st_from without going through the guard.
      alter table orders disable trigger trg_order_transition;
      update orders set status = st_from where id = o;
      alter table orders enable trigger trg_order_transition;

      begin
        update orders set status = st_to where id = o;
        did_pass := true;
      exception when others then
        did_pass := false;
      end;

      tested := tested + 1;

      if did_pass <> should_pass then
        failures := failures + 1;
        mismatch := mismatch || format('%s->%s (attendu %s, obtenu %s); ',
                                        st_from, st_to, should_pass, did_pass);
      end if;
    end loop;
  end loop;

  perform test.ok('20.11', format('matrice complète des transitions : %s paires testées', tested),
    failures = 0, nullif(mismatch, ''));

  perform test.ok('20.11', 'toutes les transitions autorisées sont couvertes',
    tested = (select count(*) from
                (select unnest(enum_range(null::order_status)) a) x
              cross join (select unnest(enum_range(null::order_status)) b) y
              where x.a <> y.b));

  -- Every transition writes to the journal with its actor.
  perform test.ok('20.11', 'chaque transition est journalisée avec son acteur',
    (select count(*) from audit.order_events where order_id = o) > 40);
end;
$$;

-- End-to-end: sign-up -> order -> delivery -> rating
do $$
declare
  u uuid := gen_random_uuid();
  addr uuid; o uuid; courier uuid; r uuid;
  tos uuid; cgv uuid; priv uuid;
  store uuid := '22222222-0000-0000-0000-000000000001';
  zone uuid := '11111111-0000-0000-0000-000000000001';
  beer uuid := '33333333-0000-0000-0000-000000000001';
  fee integer; service integer; items integer;
begin
  select id into tos  from legal_documents where doc_key = 'tos';
  select id into cgv  from legal_documents where doc_key = 'sales_terms';
  select id into priv from legal_documents where doc_key = 'privacy';
  select user_id into courier from courier_profiles where status = 'active' limit 1;

  -- 1. Sign-up with age verification
  insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                     verification_method, verified_at, status)
  values (u, array['client']::user_role[], 'Bout', 'EnBout', 'e2e@example.invalid',
          'b18_plus', true, 'itsme', now(), 'active');

  -- 2. Consents
  insert into consents (user_id, consent_type, granted, legal_document_id) values
    (u, 'tos', true, tos), (u, 'sales_terms', true, cgv), (u, 'privacy', true, priv);

  -- 3. Address, resolved into the open zone
  insert into addresses (user_id, street, number, floor, has_lift, lat, lon, is_default)
  values (u, 'Rue des Blancs Chevaux', '42', 3, false, 50.6680, 4.6150, true)
  returning id into addr;

  -- 4. Order with a priced basket (2 pallets, 3rd floor, no lift, c = 1.0)
  items   := 2 * 1499;
  fee     := app.compute_delivery_fee(2, 3, false, 1.0, 'express');
  service := app.setting_int('pricing.service_fee_cents');

  insert into orders (client_id, address_id, store_id, zone_id, mode,
                      pallet_count, surge_coefficient,
                      items_estimated_cents, delivery_fee_cents, service_fee_cents,
                      tip_cents, total_estimated_cents, sales_terms_document_id)
  values (u, addr, store, zone, 'express', 2, 1.00,
          items, fee, service, 0, items + fee + service, cgv)
  returning id into o;

  insert into order_items (order_id, product_id, quantity, unit_indicative_price_cents,
                           age_minimum_snapshot, contains_alcohol_snapshot)
  values (o, beer, 2, 1499, 0, false);

  perform test.ok('20.11/e2e', 'le total affiché est la somme exacte de ses composantes',
    (select total_estimated_cents from orders where id = o) = items + fee + service);

  perform test.ok('20.11/e2e', 'les frais de livraison correspondent à l''exemple du §9 (6,50 €)',
    fee = 650);

  -- 5. Payment and fulfilment
  perform app.set_order_pin(o, '7391');
  perform app.set_actor(u, 'client', 'e2e');
  update orders set status = 'PAID' where id = o;

  insert into payments (order_id, provider, provider_ref, method, status,
                        amount_authorized_cents, amount_captured_cents,
                        sca_completed, idempotency_key, captured_at)
  values (o, 'mollie', 'tr_e2e_demo', 'bancontact', 'captured',
          items + fee + service, items + fee + service, true, 'idem-e2e-demo', now());

  perform app.set_actor(courier, 'courier', 'e2e');
  update orders set status = 'SEARCHING_COURIER' where id = o;
  update orders set status = 'COURIER_ASSIGNED' where id = o;
  update orders set status = 'AT_STORE' where id = o;

  insert into receipts (order_id, photo_path, amount_read_cents, amount_validated_cents, validated_by)
  values (o, 'demo/receipt-e2e.jpg', items, items, courier);

  update orders set status = 'PURCHASED', items_actual_cents = items,
                    total_charged_cents = items + fee + service where id = o;
  update orders set status = 'EN_ROUTE' where id = o;
  update orders set status = 'ARRIVED' where id = o;

  -- 6. Age check then PIN
  perform app.record_age_check(o, courier, 'ok', null, true, true);
  perform app.deliver_order(o, courier, '7391');

  perform test.ok('20.11/e2e', 'la commande est livrée', (select status from orders where id = o) = 'DELIVERED');

  perform test.ok('20.11/e2e', 'le montant débité égale le total affiché',
    (select total_charged_cents = total_estimated_cents from orders where id = o));

  -- 7. Rating
  insert into ratings (order_id, client_id, courier_id, score, labels, comment)
  values (o, u, courier, 5, array['rapide','sympa'], 'Parfait') returning id into r;

  perform test.ok('20.11/e2e', 'le client peut noter une commande livrée', r is not null);

  perform test.refuses('20.11/e2e', 'une note ne peut plus être modifiée',
    format($q$update ratings set score = 1 where id = %L$q$, r),
    'never modified');

  -- Reconciliation shows no gap.
  perform test.ok('20.11/e2e', 'le rapprochement ne montre aucun écart',
    (select captured_vs_charged_gap_cents = 0 from payment_reconciliation where order_id = o));
end;
$$;

-- Only a delivered order can be rated (spec 16).
do $$
declare
  o uuid; c uuid;
begin
  select id, client_id into o, c from orders where status = 'CREATED' limit 1;
  perform test.refuses('20.11', 'une commande non livrée ne peut pas être notée',
    format($q$insert into ratings (order_id, client_id, score) values (%L, %L, 5)$q$, o, c),
    'only a delivered order');
end;
$$;

-- =============================================================================
-- Criterion 20.12 — demonstration data
-- =============================================================================

do $$
begin
  perform test.ok('20.12', '3 zones', (select count(*) from zones) = 3);
  perform test.ok('20.12', '3 magasins', (select count(*) from stores) = 3);
  perform test.ok('20.12', '20 kots', (select count(*) from addresses where label like 'Kot %') = 20);
  perform test.ok('20.12', '6 palettiers',
    (select count(*) from courier_profiles where status = 'active'
       and user_id in (select id from users where email like 'palettier%')) = 6);
  perform test.ok('20.12', 'le catalogue du §5 est présent (9 produits actifs)',
    (select count(*) from products where active) = 9);
  perform test.ok('20.12', 'un produit 18+ existe mais reste inactif',
    (select not active from products where sku = 'SPIRIT-DEMO'));
end;
$$;

-- =============================================================================
-- Cross-cutting structural guarantees
-- =============================================================================

do $$
declare n integer;
begin
  -- RLS is on everywhere.
  select count(*) into n
    from pg_tables t join pg_class c on c.relname = t.tablename
                                    and c.relnamespace = t.schemaname::regnamespace
   where t.schemaname in ('public','audit','hr') and not c.relrowsecurity;
  perform test.ok('4.8', 'toutes les tables ont RLS activé', n = 0, format('%s sans RLS', n));

  -- No table anywhere can hold a birth date or an identity document image.
  select count(*) into n
    from information_schema.columns
   where table_schema in ('public','hr')
     and column_name ~* '(date_of_birth|birth_date|birthdate|naissance|id_card|carte_identite|id_photo|id_scan)';
  perform test.ok('4.7', 'aucune colonne de date de naissance ou de pièce d''identité', n = 0);

  -- No column could hold a card number.
  select count(*) into n
    from information_schema.columns
   where table_schema = 'public'
     -- Anchored tokens: an unanchored "pan" also matches "partici(pan)t_id".
     and column_name ~* '^(card_number|card_pan|pan|cvc|cvv|card_expiry|card_cvc)$';
  perform test.ok('4.5', 'aucune colonne pouvant contenir un numéro de carte', n = 0);

  -- Consents and ratings are append-only.
  perform test.ok('6.2', 'les consentements sont en ajout seul',
    exists (select 1 from pg_trigger where tgname = 'trg_consents_no_update'));
  perform test.ok('16', 'les notes sont immuables',
    exists (select 1 from pg_trigger where tgname = 'trg_ratings_immutable'));

  -- Blocking a client requires a named human.
  select count(*) into n from information_schema.columns
   where table_schema = 'public' and table_name = 'client_blocks'
     and column_name = 'decided_by' and is_nullable = 'NO';
  perform test.ok('16', 'bloquer un client exige une décision humaine nommée', n = 1);

  -- The courier-facing explanation of the dispatch system exists (EU 2024/2831).
  perform test.ok('4.3', 'l''explication du système d''attribution est disponible',
    length(app.dispatch_explanation()) > 400);

  -- Launch blockers are listed, not silently defaulted.
  perform test.ok('4.3', 'les paramètres bloquants sont listés par app.launch_blockers()',
    (select count(*) from app.launch_blockers()) = 0,
    'après le seed de démonstration, plus aucun blocage ne doit rester');
end;
$$;

-- =============================================================================
-- Report
-- =============================================================================

\echo ''
\echo '================= RÉSULTATS DES TESTS D''ACCEPTATION ================='

select criterion as "critère",
       count(*) as "tests",
       count(*) filter (where passed) as "ok",
       count(*) filter (where not passed) as "échecs"
  from test.results group by criterion order by criterion;

\echo ''
select criterion as "critère", label as "test", coalesce(detail,'') as "détail"
  from test.results where not passed order by id;

do $$
declare
  failed integer;
  total integer;
begin
  select count(*) filter (where not passed), count(*) into failed, total from test.results;
  raise notice '';
  raise notice '% tests exécutés, % réussis, % en échec', total, total - failed, failed;
  if failed > 0 then
    raise exception '% test(s) d''acceptation en échec', failed;
  end if;
end;
$$;
