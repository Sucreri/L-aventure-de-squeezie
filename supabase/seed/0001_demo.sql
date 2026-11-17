-- =============================================================================
-- 0001_demo.sql — demonstration data (acceptance criterion 20, last line)
-- "3 magasins fictifs, 3 zones, 20 kots, 6 palettiers, le catalogue du §5."
--
-- NEVER load this in production. Every record is fictional.
--
-- Product names are generic and descriptive on purpose: no third-party brand
-- dressing (spec 4.10, HYPOTHESES.md H-02). The exact commercial labelling is
-- a legal decision, not a seeding one.
-- =============================================================================

begin;

-- -----------------------------------------------------------------------------
-- Demo values for the parameters that have no default on purpose (H-11).
-- An operator fills these in from their social secretariat; here they only
-- exist so the demo can publish shifts.
-- -----------------------------------------------------------------------------
update app_settings set value = to_jsonb('Palette Démo SRL'::text)          where key = 'operator.legal_name';
update app_settings set value = to_jsonb('BE 0123.456.789'::text)           where key = 'operator.bce_number';
update app_settings set value = to_jsonb('BE0123456789'::text)              where key = 'operator.vat_number';
update app_settings set value = to_jsonb('Rue de la Démonstration 1, 1348 Louvain-la-Neuve'::text) where key = 'operator.address';
update app_settings set value = to_jsonb('contact@example.invalid'::text)   where key = 'operator.contact_email';
update app_settings set value = to_jsonb('+32 000 00 00 00'::text)          where key = 'operator.contact_phone';
update app_settings set value = to_jsonb(1450)                              where key = 'pay.hourly_wage_cents';
update app_settings set value = to_jsonb('DÉMO — commission paritaire à confirmer (Q-04)'::text) where key = 'pay.joint_committee_ref';
update app_settings set value = to_jsonb('DÉMO — police accidents du travail à souscrire (Q-12)'::text) where key = 'labour.work_accident_insurance_ref';
update app_settings set value = to_jsonb('DÉMO — service externe de prévention à désigner (Q-12)'::text) where key = 'labour.prevention_service_ref';
update app_settings set value = to_jsonb('DÉMO — règlement de travail v0'::text) where key = 'labour.work_rules_document_id';
update app_settings set value = to_jsonb('DÉMO — à vérifier auprès de l''AFSCA (Q-07)'::text) where key = 'food.afsca_registration_ref';
update app_settings set value = to_jsonb('privacy@example.invalid'::text)   where key = 'privacy.dpo_contact_email';
update app_settings set value = to_jsonb('DÉMO — droit de rétractation à faire valider (Q-08)'::text) where key = 'consumer.withdrawal_policy_text';
update app_settings set value = to_jsonb('DÉMO — Service de médiation pour le consommateur'::text) where key = 'consumer.mediation_service_contact';

-- -----------------------------------------------------------------------------
-- Legal documents. Marked validated ONLY so the demo can run: the validator
-- name says exactly what they are.
-- -----------------------------------------------------------------------------
insert into legal_documents (doc_key, version, title, body_md, validated_by_lawyer, validated_by, validated_at, published_at)
values
  ('tos',         'DEMO-0.1', 'Conditions générales d''utilisation', '# CGU — GABARIT DE DÉMONSTRATION', true, 'GABARIT DE DÉMONSTRATION — NON VALIDÉ JURIDIQUEMENT', now(), now()),
  ('sales_terms', 'DEMO-0.1', 'Conditions générales de vente',       '# CGV — GABARIT DE DÉMONSTRATION', true, 'GABARIT DE DÉMONSTRATION — NON VALIDÉ JURIDIQUEMENT', now(), now()),
  ('privacy',     'DEMO-0.1', 'Politique de confidentialité',        '# Politique — GABARIT DE DÉMONSTRATION', true, 'GABARIT DE DÉMONSTRATION — NON VALIDÉ JURIDIQUEMENT', now(), now());

-- -----------------------------------------------------------------------------
-- Zones: three real Louvain-la-Neuve neighbourhoods, simplified boundaries.
-- -----------------------------------------------------------------------------
insert into zones (id, slug, name, boundary, status, client_threshold, courier_threshold) values
  ('11111111-0000-0000-0000-000000000001', 'biereau', 'Biéreau',
   '{"type":"Polygon","coordinates":[[[4.6100,50.6650],[4.6220,50.6650],[4.6220,50.6720],[4.6100,50.6720],[4.6100,50.6650]]]}',
   'waitlist', 150, 10),
  ('11111111-0000-0000-0000-000000000002', 'hocaille', 'Hocaille',
   '{"type":"Polygon","coordinates":[[[4.5980,50.6630],[4.6100,50.6630],[4.6100,50.6700],[4.5980,50.6700],[4.5980,50.6630]]]}',
   'waitlist', 150, 10),
  ('11111111-0000-0000-0000-000000000003', 'bruyeres', 'Bruyères',
   '{"type":"Polygon","coordinates":[[[4.6220,50.6680],[4.6350,50.6680],[4.6350,50.6760],[4.6220,50.6760],[4.6220,50.6680]]]}',
   'waitlist', 150, 10);

-- -----------------------------------------------------------------------------
-- Stores: three fictional supply points in the pedestrian centre.
-- -----------------------------------------------------------------------------
insert into stores (id, name, street, number, postal_code, lat, lon, opening_hours) values
  ('22222222-0000-0000-0000-000000000001', 'Supermarché Centre (fictif)', 'Grand-Place', '1', '1348', 50.6695, 4.6145,
   '{"mon":[["08:00","20:00"]],"tue":[["08:00","20:00"]],"wed":[["08:00","20:00"]],"thu":[["08:00","21:00"]],"fri":[["08:00","21:00"]],"sat":[["09:00","20:00"]],"sun":[["09:00","13:00"]]}'),
  ('22222222-0000-0000-0000-000000000002', 'Supérette Hocaille (fictif)', 'Rue de la Hocaille', '12', '1348', 50.6665, 4.6040,
   '{"mon":[["09:00","19:00"]],"tue":[["09:00","19:00"]],"wed":[["09:00","19:00"]],"thu":[["09:00","20:00"]],"fri":[["09:00","20:00"]],"sat":[["09:00","19:00"]]}'),
  ('22222222-0000-0000-0000-000000000003', 'Épicerie Bruyères (fictif)', 'Voie des Hennuyers', '5', '1348', 50.6715, 4.6280,
   '{"mon":[["10:00","20:00"]],"tue":[["10:00","20:00"]],"wed":[["10:00","20:00"]],"thu":[["10:00","22:00"]],"fri":[["10:00","22:00"]],"sat":[["10:00","20:00"]]}');

-- -----------------------------------------------------------------------------
-- Catalogue (spec 5)
-- -----------------------------------------------------------------------------
insert into products (id, sku, name, format, contains_alcohol, alcohol_degree, age_minimum,
                      weight_kg, capacity_units, pallet_count, display_rank) values
  ('33333333-0000-0000-0000-000000000001','PAL-BLONDE-33','Palette bière blonde','24 × 33 cl', true, 4.2, 16, 8.50, 1.0, 1, 30),
  ('33333333-0000-0000-0000-000000000002','PAL-BLONDE-50','Palette bière blonde','24 × 50 cl', true, 4.2, 16, 12.50, 1.5, 1, 31),
  ('33333333-0000-0000-0000-000000000003','PAL-SANSALC-33','Palette bière sans alcool','24 × 33 cl', false, null, 0, 8.50, 1.0, 1, 10),
  ('33333333-0000-0000-0000-000000000004','SOFT-COLA','Cola','Pack de bouteilles ou canettes', false, null, 0, 6.00, 0.5, 0, 11),
  ('33333333-0000-0000-0000-000000000005','SIROP-GREN','Sirop de grenadine','Bouteille', false, null, 0, 1.00, 0.2, 0, 12),
  ('33333333-0000-0000-0000-000000000006','EAU-6X15','Eau','Pack de 6 × 1,5 L', false, null, 0, 9.00, 0.5, 0, 13),
  ('33333333-0000-0000-0000-000000000007','GLACONS','Glaçons','Sac', false, null, 0, 2.00, 0.1, 0, 14),
  ('33333333-0000-0000-0000-000000000008','CHIPS','Chips','Sachet', false, null, 0, 0.20, 0.1, 0, 15),
  ('33333333-0000-0000-0000-000000000009','GOBELETS','Gobelets','Paquet', false, null, 0, 0.30, 0.1, 0, 16);

-- A spirits row exists to prove the constraint: it can never be activated.
insert into products (sku, name, format, contains_alcohol, alcohol_degree, age_minimum,
                      weight_kg, capacity_units, pallet_count, active)
values ('SPIRIT-DEMO','Spiritueux (hors périmètre MVP)','70 cl', true, 37.5, 18, 1.20, 0.5, 0, false);

-- Indicative prices per store (spec 5, maintained by the admin — H-15).
insert into store_products (store_id, product_id, indicative_price_cents)
select s.id, p.id,
       case p.sku
         when 'PAL-BLONDE-33'  then 1499
         when 'PAL-BLONDE-50'  then 2199
         when 'PAL-SANSALC-33' then 1699
         when 'SOFT-COLA'      then 799
         when 'SIROP-GREN'     then 249
         when 'EAU-6X15'       then 399
         when 'GLACONS'        then 299
         when 'CHIPS'          then 189
         when 'GOBELETS'       then 299
       end
       -- A small per-store variation, because indicative prices differ.
       + (case s.name when 'Supérette Hocaille (fictif)' then 30
                      when 'Épicerie Bruyères (fictif)'  then 50
                      else 0 end)
  from stores s cross join products p
 where p.active;

-- -----------------------------------------------------------------------------
-- Users: 1 admin, 6 couriers, 20 kot residents (clients)
-- -----------------------------------------------------------------------------
insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                   verification_method, verified_at, status)
values ('44444444-0000-0000-0000-000000000001',
        array['admin','super_admin']::user_role[], 'Admin', 'Démo',
        'admin@example.invalid', 'b18_plus', true, 'admin_manual', now(), 'active');

do $$
declare
  i integer;
  uid uuid;
  zone_ids uuid[] := array[
    '11111111-0000-0000-0000-000000000001'::uuid,
    '11111111-0000-0000-0000-000000000002'::uuid,
    '11111111-0000-0000-0000-000000000003'::uuid];
  z uuid;
  base_lat double precision;
  base_lon double precision;
  tos uuid;  cgv uuid;  priv uuid;
  transports transport_mode[] := array['foot_trolley','bike_trailer','cargo_bike',
                                       'foot_trolley','bike_trailer','cargo_bike']::transport_mode[];
  caps integer[] := array[3,4,6,3,4,6];
begin
  select id into tos  from legal_documents where doc_key = 'tos';
  select id into cgv  from legal_documents where doc_key = 'sales_terms';
  select id into priv from legal_documents where doc_key = 'privacy';

  -- 20 kot residents, spread over the three zones.
  for i in 1 .. 20 loop
    z := zone_ids[1 + (i - 1) % 3];

    -- A point safely inside each rectangle.
    if z = zone_ids[1] then base_lat := 50.6680; base_lon := 4.6150;
    elsif z = zone_ids[2] then base_lat := 50.6660; base_lon := 4.6040;
    else base_lat := 50.6710; base_lon := 4.6280;
    end if;

    uid := gen_random_uuid();

    insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                       verification_method, verified_at, status)
    values (uid, array['client']::user_role[],
            'Kot' || i, 'Étudiant' || i,
            format('kot%s@example.invalid', i),
            -- Two residents are 16-17: the demo must contain the case where
            -- beer is allowed (16+) but an 18+ product would not be.
            case when i in (7, 14) then 'b16_17' else 'b18_plus' end::age_bracket,
            true, 'itsme', now(), 'active');

    insert into consents (user_id, consent_type, granted, legal_document_id) values
      (uid, 'tos', true, tos),
      (uid, 'sales_terms', true, cgv),
      (uid, 'privacy', true, priv),
      -- Spec 6.2 / H-08: marketing is OFF by default. Only a few opt in.
      (uid, 'marketing', (i % 4 = 0), null),
      (uid, 'geolocation', true, null);

    insert into addresses (user_id, label, street, number, building, floor, room, has_lift,
                           lat, lon, instructions, is_default)
    values (uid,
            'Kot ' || i,
            case when z = zone_ids[1] then 'Rue des Blancs Chevaux'
                 when z = zone_ids[2] then 'Rue de la Hocaille'
                 else 'Voie des Hennuyers' end,
            (10 + i)::text,
            'Bâtiment ' || chr(65 + (i % 5)),
            (i % 4),                                  -- floors 0..3
            'Chambre ' || (100 + i),
            (i % 7 = 0),                              -- a few have a lift
            base_lat + (i % 5) * 0.0004,
            base_lon + (i % 5) * 0.0004,
            case when i % 3 = 0 then 'Sonner au nom du kot, la porte du bas coince.' end,
            true);

    insert into waitlist_entries (user_id, zone_id, role) values (uid, z, 'client');
  end loop;

  -- 6 couriers: student employees, contract signed and Dimona confirmed.
  for i in 1 .. 6 loop
    uid := gen_random_uuid();
    z := zone_ids[1 + (i - 1) % 3];

    insert into users (id, roles, first_name, last_name, email, age_bracket, age_verified,
                       verification_method, verified_at, status)
    values (uid, array['client','courier']::user_role[],
            'Palettier' || i, 'Démo' || i,
            format('palettier%s@example.invalid', i),
            'b18_plus', true, 'itsme', now(), 'active');

    insert into consents (user_id, consent_type, granted, legal_document_id) values
      (uid, 'tos', true, tos),
      (uid, 'sales_terms', true, cgv),
      (uid, 'privacy', true, priv),
      (uid, 'geolocation', true, null),
      (uid, 'marketing', false, null);

    insert into courier_profiles (user_id, courier_model, transport, capacity_units,
                                  enrolment_proof_ref, training_passed_at,
                                  contract_signed, contract_signed_at,
                                  dimona_confirmed, dimona_confirmed_at, status)
    values (uid, 'STUDENT_EMPLOYEE', transports[i], caps[i],
            'DÉMO — attestation d''inscription ' || i, now() - interval '10 days',
            true, now() - interval '9 days',
            true, now() - interval '8 days',
            'active');

    insert into hr.courier_payroll (user_id, iban_encrypted, hourly_wage_cents, joint_committee_ref)
    values (uid, convert_to('BE00 0000 0000 0000 (démo)', 'UTF8'), 1450, 'DÉMO — CP à confirmer');

    insert into spend_cards (courier_id, provider_ref, ceiling_cents)
    values (uid, 'DEMO-CARD-' || i, 8000);

    insert into waitlist_entries (user_id, zone_id, role) values (uid, z, 'courier');
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- A referral code and a fee-only promotion, to show the growth side.
-- -----------------------------------------------------------------------------
insert into referral_codes (code, owner_id, kind, label)
select 'DEMO-' || upper(substr(md5(u.id::text), 1, 5)), u.id, 'client_referral', 'Code de démonstration'
  from users u where u.email like 'kot1@%';

insert into promotions (name, target, discount_type, discount_percent, conditions,
                        starts_at, ends_at, audience_min_age, created_by)
values ('Frais de livraison offerts — première commande', 'delivery_fee', 'percent', 1.0,
        '{"first_order_only": true}'::jsonb,
        now() - interval '1 day', now() + interval '60 days', 16,
        '44444444-0000-0000-0000-000000000001');

commit;

-- -----------------------------------------------------------------------------
-- Summary
-- -----------------------------------------------------------------------------
select 'zones' as entity, count(*) from zones
union all select 'stores', count(*) from stores
union all select 'products (actifs)', count(*) from products where active
union all select 'addresses (kots)', count(*) from addresses
union all select 'clients', count(*) from users where 'client' = any(roles) and not ('courier' = any(roles))
union all select 'palettiers', count(*) from courier_profiles
union all select 'waitlist', count(*) from waitlist_entries
order by 1;

-- Demonstration environment: simulated providers are allowed here, and only
-- here. A production database keeps environment.allow_mock_providers = false
-- and refuses them (migration 0017).
update app_settings set value = 'true'::jsonb where key = 'environment.allow_mock_providers';
