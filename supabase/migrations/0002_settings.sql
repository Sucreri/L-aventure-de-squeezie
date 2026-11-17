-- =============================================================================
-- 0002_settings.sql
-- Parameter store. Spec rule 0.3: amounts, thresholds, schedules, legal texts
-- and product lists are back-office parameters. Nothing is hard-coded.
--
-- Two deliberate behaviours:
--   * a missing parameter raises an explicit error instead of silently
--     defaulting, so a forgotten setting fails loudly in tests;
--   * some parameters have NO default on purpose (hourly wage, insurance
--     references). Their absence BLOCKS shift opening (HYPOTHESES.md H-11).
-- =============================================================================

create table app_settings (
  key           text primary key,
  value         jsonb       not null,
  value_type    text        not null
                check (value_type in ('int','cents','decimal','bool','text','json','time','duration_s')),
  category      text        not null,
  description   text        not null,
  -- A parameter flagged required_for_launch must be non-null before the first
  -- neighbourhood can open. Checked by app.assert_launch_ready().
  required_for_launch boolean not null default false,
  updated_at    timestamptz not null default now(),
  updated_by    uuid
);

comment on table app_settings is
  'Back-office parameters. Every business value in the product comes from here.';

-- Journal of parameter changes: a price or a legal text changing is an event
-- a juriste or an accountant may need to reconstruct months later.
create table audit.settings_history (
  id          bigserial primary key,
  key         text        not null,
  old_value   jsonb,
  new_value   jsonb       not null,
  changed_at  timestamptz not null default now(),
  changed_by  uuid
);

create index on audit.settings_history (key, changed_at desc);

create or replace function app.log_setting_change()
returns trigger
language plpgsql
as $$
begin
  insert into audit.settings_history (key, old_value, new_value, changed_by)
  values (new.key,
          case when tg_op = 'UPDATE' then old.value else null end,
          new.value,
          new.updated_by);
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_settings_history
  before insert or update of value on app_settings
  for each row execute function app.log_setting_change();

-- -----------------------------------------------------------------------------
-- Typed accessors. All of them raise when the key is unknown.
-- -----------------------------------------------------------------------------

create or replace function app.setting(p_key text)
returns jsonb
language plpgsql
stable
as $$
declare
  v jsonb;
  found_row boolean;
begin
  select value, true into v, found_row from app_settings where key = p_key;
  if not found_row then
    raise exception 'unknown setting: %', p_key
      using errcode = 'undefined_parameter',
            hint = 'Add the key to app_settings; settings are never defaulted silently.';
  end if;
  return v;
end;
$$;

-- Returns the integer value, raising if the parameter is deliberately unset
-- (hourly wage, insurance references). The error message names the key so the
-- admin knows exactly what to fill in.
create or replace function app.setting_int(p_key text)
returns integer
language plpgsql
stable
as $$
declare
  v jsonb := app.setting(p_key);
begin
  if v = 'null'::jsonb then
    raise exception 'setting % is required but has never been set', p_key
      using errcode = 'null_value_not_allowed';
  end if;
  return (v #>> '{}')::integer;
end;
$$;

create or replace function app.setting_num(p_key text)
returns double precision
language plpgsql
stable
as $$
declare
  v jsonb := app.setting(p_key);
begin
  if v = 'null'::jsonb then
    raise exception 'setting % is required but has never been set', p_key
      using errcode = 'null_value_not_allowed';
  end if;
  return (v #>> '{}')::double precision;
end;
$$;

create or replace function app.setting_bool(p_key text)
returns boolean
language sql
stable
as $$ select (app.setting(p_key) #>> '{}')::boolean; $$;

create or replace function app.setting_text(p_key text)
returns text
language sql
stable
as $$ select app.setting(p_key) #>> '{}'; $$;

create or replace function app.setting_is_set(p_key text)
returns boolean
language sql
stable
as $$ select app.setting(p_key) <> 'null'::jsonb; $$;

-- -----------------------------------------------------------------------------
-- Default parameter set
-- -----------------------------------------------------------------------------

insert into app_settings (key, value, value_type, category, description, required_for_launch) values

-- Identity (spec 2: operator identity is a parameter shown in legal notices,
-- receipts and e-mails). Empty until the SRL exists -> required for launch.
('operator.legal_name',        '""',   'text',  'identity', 'Dénomination sociale de l''Opérateur (SRL)', true),
('operator.bce_number',        '""',   'text',  'identity', 'Numéro d''entreprise BCE', true),
('operator.vat_number',        '""',   'text',  'identity', 'Numéro de TVA', true),
('operator.address',           '""',   'text',  'identity', 'Siège social', true),
('operator.contact_email',     '""',   'text',  'identity', 'E-mail de contact consommateur', true),
('operator.contact_phone',     '""',   'text',  'identity', 'Téléphone de contact', true),
('operator.hub_address',       'null', 'text',  'identity', 'Adresse du local de garde 24 h (statut HELD_AT_HUB)', false),
('app.display_name',           '"Palette"', 'text', 'identity', 'Nom affiché de l''app (provisoire, voir HYPOTHESES.md H-01)', false),

-- Pricing (spec 9). Reference test: 2 palettes, 3rd floor no lift, c=1.0,
-- express -> delivery 6.50 EUR, service 0.49 EUR.
('pricing.base_fee_cents',             '350',  'cents',   'pricing', 'Frais de base (1re palette ou commande sans palette)', false),
('pricing.extra_pallet_fee_cents',     '150',  'cents',   'pricing', 'Par palette supplémentaire', false),
('pricing.floor_fee_no_lift_cents',    '50',   'cents',   'pricing', 'Livraison à l''étage sans ascenseur, par étage', false),
('pricing.floor_fee_with_lift_cents',  '100',  'cents',   'pricing', 'Livraison à l''étage avec ascenseur, forfait', false),
('pricing.service_fee_cents',          '49',   'cents',   'pricing', 'Frais de service par commande', false),
('pricing.grouped_round_discount',     '0.40', 'decimal', 'pricing', 'Réduction sur les frais de livraison en Tournée groupée', false),
('pricing.surge_min',                  '1.0',  'decimal', 'pricing', 'Borne basse du coefficient d''affluence', false),
('pricing.surge_max',                  '1.5',  'decimal', 'pricing', 'Borne haute du coefficient d''affluence (H-18)', false),
('pricing.card_preauth_margin',        '0.10', 'decimal', 'pricing', 'Marge de pré-autorisation carte sur le total estimé (§10)', false),
('pricing.operator_absorbs_gap_cents', '100',  'cents',   'pricing', 'Écart ticket > estimation absorbé par l''Opérateur (§10)', false),
('pricing.price_gap_alert_cents',      '50',   'cents',   'pricing', 'Écart répété déclenchant une alerte admin sur le prix indicatif', false),

-- Cancellation (spec 12)
('cancellation.fee_share_after_purchase', '0.50', 'decimal', 'orders', 'Part des frais de livraison due après PURCHASED', false),
('cancellation.no_courier_timeout_s',     '600',  'duration_s', 'orders', 'Délai sans palettier ouvrant l''annulation sans frais (10 min)', false),
('cancellation.client_absent_wait_s',     '300',  'duration_s', 'orders', 'Attente du palettier après ARRIVED avant DELIVERY_FAILED (5 min)', false),
('orders.hub_hold_hours',                 '24',   'int',   'orders', 'Durée de garde des articles après un échec de remise', false),
('orders.substitution_response_s',        '180',  'duration_s', 'orders', 'Délai laissé au client pour répondre à un remplacement (3 min)', false),
('orders.express_max_units',              '6',    'int',   'orders', 'Jauge de capacité maximale d''un panier Express', false),
('orders.group_order_expiry_s',           '1800', 'duration_s', 'orders', 'Expiration d''une commande groupée (30 min)', false),

-- Age and alcohol (spec 4.1, 13)
('alcohol.min_age_beer_wine',   '16',   'int',  'compliance', 'Âge légal bière et vin en Belgique', false),
('alcohol.min_age_spirits',     '18',   'int',  'compliance', 'Âge légal spiritueux (hors périmètre MVP)', false),
('alcohol.health_warning_fr',
  '"La consommation d''alcool est interdite aux moins de 16 ans. À consommer avec modération."',
  'text', 'compliance', 'Avertissement sanitaire paramétrable (§4.2)', true),
('alcohol.pin_length',          '4',    'int',  'compliance', 'Longueur du code PIN de remise', false),

-- Working time (spec 14, 4.3)
('work.service_end_time',            '"22:00"', 'time', 'labour', 'heure_fin_service, fin de service par défaut', false),
('work.night_work_threshold_time',   '"20:00"', 'time', 'labour', 'Seuil au-delà duquel une dérogation est requise', false),
('work.annual_quota_hours',          '650',  'int', 'labour', 'Quota annuel à cotisations réduites (Student@work)', false),
('work.quota_alert_threshold_hours', '600',  'int', 'labour', 'Seuil d''alerte à l''approche du quota', false),
('work.max_hours_per_day',           '8',    'int', 'labour', 'Durée maximale de travail par jour', false),
('work.max_hours_per_week',          '40',   'int', 'labour', 'Durée maximale de travail par semaine', false),
('work.min_rest_between_shifts_h',   '11',   'int', 'labour', 'Repos minimal entre deux créneaux', false),

-- Courier pay (spec 11). hourly_wage_cents has NO default: inventing a wage
-- would be a mistake, see HYPOTHESES.md H-11 and Q-04.
('pay.hourly_wage_cents',          'null', 'cents', 'labour', 'Salaire horaire brut, barème de la commission paritaire (AUCUNE valeur par défaut)', true),
('pay.bonus_per_delivery_cents',   '100',  'cents', 'labour', 'Prime par livraison', false),
('pay.bonus_per_floor_cents',      '30',   'cents', 'labour', 'Prime par étage sans ascenseur', false),
('pay.tips_share_to_courier',      '1.0',  'decimal', 'labour', 'Part des pourboires reversée au palettier (100 %)', false),
('pay.joint_committee_ref',        'null', 'text',  'labour', 'Référence de la commission paritaire applicable', true),

-- Mandatory employer documents (spec 4.3): their absence blocks shift opening.
('labour.work_accident_insurance_ref', 'null', 'text', 'labour', 'Référence de la police d''assurance accidents du travail', true),
('labour.prevention_service_ref',      'null', 'text', 'labour', 'Référence de l''affiliation au service externe de prévention', true),
('labour.work_rules_document_id',      'null', 'text', 'labour', 'Identifiant du règlement de travail remis au palettier', true),

-- Courier capacity (spec 14)
('courier.capacity_foot_trolley', '3',   'int',   'courier', 'Capacité en unités, à pied avec diable', false),
('courier.capacity_bike_trailer', '4',   'int',   'courier', 'Capacité en unités, vélo avec remorque', false),
('courier.capacity_cargo_bike',   '6',   'int',   'courier', 'Capacité en unités, vélo-cargo', false),
('courier.max_hand_carried_pallets', '2', 'int',  'courier', 'Palettes maximum portées à la main par trajet', false),
('courier.spend_card_ceiling_cents', '8000', 'cents', 'courier', 'Plafond par mission de la carte de dépense (H-09)', false),
('courier.min_age',               '18',  'int',   'courier', 'Âge minimum d''un palettier', false),

-- Dispatch (spec 15)
('dispatch.max_distance_to_store_m', '2000', 'int',   'dispatch', 'Distance maximale palettier-magasin pour être candidat', false),
('dispatch.offer_timeout_s',         '30',   'duration_s', 'dispatch', 'Durée d''une offre avant passage au candidat suivant', false),
('dispatch.broadcast_after_declines', '3',   'int',   'dispatch', 'Nombre de refus avant diffusion à tous les candidats', false),
('dispatch.weight_speed',            '0.6',  'decimal', 'dispatch', 'Poids de la rapidité d''arrivée au magasin', false),
('dispatch.weight_capacity',         '0.2',  'decimal', 'dispatch', 'Poids de l''adéquation de la capacité', false),
('dispatch.weight_grouping',         '0.2',  'decimal', 'dispatch', 'Poids de la possibilité de regroupement', false),
('dispatch.express_max_grouped',     '2',    'int',   'dispatch', 'Commandes maximum regroupées par trajet en Express', false),
('dispatch.grouping_max_distance_m', '400',  'int',   'dispatch', 'Distance maximale entre deux destinations regroupées', false),

-- Growth (spec 8)
('growth.referral_reward_deliveries', '1', 'int', 'growth', 'Livraisons offertes au parrain et au filleul', false),
('growth.referral_monthly_cap',       '5', 'int', 'growth', 'Plafond mensuel de parrainages récompensés', false),
('growth.ambassador_reward_mode', '"credit"', 'text', 'growth', 'credit | remuneration — statut à valider juridiquement (Q-06)', false),
('growth.marketing_push_max_per_week', '2', 'int', 'growth', 'Fréquence maximale des notifications marketing', false),

-- Retention (spec 4.7), applied by a scheduled job
('retention.courier_positions_days',   '30',  'int', 'privacy', 'Conservation des positions des palettiers', false),
('retention.chat_messages_months',     '6',   'int', 'privacy', 'Conservation des messages du chat', false),
('retention.inactive_accounts_months', '24',  'int', 'privacy', 'Suppression des comptes inactifs (H-20)', false),
('retention.inactive_notice_days',     '30',  'int', 'privacy', 'Préavis par e-mail avant suppression', false),
('retention.waitlist_never_opened_months', '12', 'int', 'privacy', 'Conservation des inscriptions en liste d''attente jamais activées', false),
('privacy.dpo_contact_email',          'null','text','privacy', 'Adresse de contact dédiée aux droits des personnes', true),
('privacy.breach_notification_hours',  '72',  'int', 'privacy', 'Délai de notification d''une violation de données', false),

-- Consumer law (spec 4.6)
('checkout.pay_button_label', '"Commander et payer"', 'text', 'consumer', 'Libellé sans ambiguïté sur l''obligation de payer (H-19)', false),
('consumer.withdrawal_policy_text', 'null', 'text', 'consumer', 'Texte du droit de rétractation et de ses exceptions (Q-08)', true),
('consumer.mediation_service_contact', 'null', 'text', 'consumer', 'Coordonnées du Service de médiation pour le consommateur', true),

-- Food safety (spec 4.11): must be filled OR explicitly declared not required.
('food.afsca_registration_ref', 'null', 'text', 'compliance', 'Référence d''enregistrement AFSCA, ou "NON_REQUIS" après vérification (Q-07)', true),

-- Independent mode lock (spec 4.4, H-03)
('courier.independent_mode_enabled',    'false', 'bool', 'compliance', 'Mode INDEPENDENT. Activable uniquement par un super-admin après avis juridique.', false),
('courier.independent_legal_opinion_id','null',  'text', 'compliance', 'Identifiant du document d''avis juridique téléversé', false),

-- Zone opening thresholds (spec 8), default per zone, overridable per zone row
('zones.default_client_threshold',  '150', 'int', 'growth', 'Seuil d''inscrits clients par défaut', false),
('zones.default_courier_threshold', '10',  'int', 'growth', 'Seuil d''inscrits palettiers par défaut', false);

-- -----------------------------------------------------------------------------
-- Launch readiness
-- -----------------------------------------------------------------------------

-- Returns the list of parameters that still block the opening of the first
-- neighbourhood. Used by the back-office and by the zone-opening guard.
create or replace function app.launch_blockers()
returns table (key text, description text)
language sql
stable
as $$
  select s.key, s.description
    from app_settings s
   where s.required_for_launch
     and (s.value = 'null'::jsonb or s.value = '""'::jsonb)
   order by s.category, s.key;
$$;

comment on function app.launch_blockers is
  'Parameters that must be filled before the first zone can be opened. '
  'Drives the back-office checklist and blocks zone activation.';
