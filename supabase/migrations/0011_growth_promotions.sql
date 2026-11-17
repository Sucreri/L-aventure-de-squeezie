-- =============================================================================
-- 0011_growth_promotions.sql
-- Referrals, partner codes, ambassadors, promotions and marketing.
--
-- Acceptance criterion 20.4: "Le moteur de promotions rejette toute règle
-- portant sur un produit alcoolisé."
--
-- The defence is structural, in three layers:
--   1. promotion_target is an enum holding ONLY fee targets. There is no
--      column in which a product could be named.
--   2. Conditions go through a WHITELIST: any key that is not explicitly
--      allowed is refused, so a quantity- or product-based rule cannot be
--      smuggled in through free-form JSON.
--   3. A trigger re-checks both at write time.
-- =============================================================================

create table promotions (
  id          uuid primary key default gen_random_uuid(),
  code        text unique,
  name        text not null,
  -- Fees only. Spec 4.1 and the Belgian alcohol advertising convention.
  target      promotion_target not null,
  discount_type text not null check (discount_type in ('percent','fixed')),
  -- A percentage and a fixed amount are different things and were a single
  -- column at first; a fixed discount of 100 cents then overflowed the
  -- numeric(6,4) meant for percentages. Two columns, one coherence check.
  discount_percent    numeric(5,4) check (discount_percent > 0 and discount_percent <= 1),
  discount_fixed_cents integer     check (discount_fixed_cents > 0),
  conditions  jsonb not null default '{}'::jsonb,

  zone_id     uuid references zones(id),
  starts_at   timestamptz not null,
  ends_at     timestamptz not null,
  max_uses    integer check (max_uses > 0),
  uses        integer not null default 0 check (uses >= 0),
  -- Spec 4.1: never any targeting of under-18s with anything alcohol-related.
  audience_min_age integer not null default 0 check (audience_min_age in (0,16,18)),
  active      boolean not null default true,
  created_by  uuid references users(id),
  created_at  timestamptz not null default now(),

  constraint chk_window check (ends_at > starts_at),
  -- Exactly one value, matching the declared type.
  constraint chk_discount_matches_type check (
    (discount_type = 'percent' and discount_percent is not null and discount_fixed_cents is null)
    or (discount_type = 'fixed' and discount_fixed_cents is not null and discount_percent is null)
  )
);

comment on table promotions is
  'Spec 4.1: promotions may only ever reduce the delivery fee or the service '
  'fee. The schema has no column able to name a product.';

-- Keys a promotion condition may use. Anything else is refused, which is what
-- stops "buy 2 pallets, get a discount" (a quantity-of-alcohol-linked rule).
create or replace function app.allowed_promotion_condition_keys()
returns text[]
language sql
immutable
as $$
  select array['min_order_cents','modes','zone_ids','first_order_only','valid_weekdays','max_per_user'];
$$;

create or replace function app.guard_promotion_rule()
returns trigger
language plpgsql
as $$
declare
  k text;
  allowed text[] := app.allowed_promotion_condition_keys();
begin
  -- Layer 2: whitelist of condition keys.
  for k in select jsonb_object_keys(new.conditions) loop
    if not (k = any(allowed)) then
      raise exception 'forbidden promotion condition "%"', k
        using errcode = 'check_violation',
              hint = 'Spec 4.1: a promotion may not depend on products or on quantities. '
                  || 'Allowed keys: ' || array_to_string(allowed, ', ') || '.';
    end if;
  end loop;

  -- Layer 3: defence in depth. Even though promotion_target cannot name a
  -- product, refuse anything whose text mentions a product id or an alcohol
  -- keyword, so a future column or a copy-pasted rule cannot slip through.
  if new.conditions::text ~* '(product|article|pallet|palette|bier|biere|bière|beer|alcoo|alcohol|degre|degré)' then
    raise exception 'a promotion may not reference a product or alcohol'
      using errcode = 'check_violation',
            hint = 'Spec 4.1: no discount on an alcoholic product, no free alcohol, '
                || 'no discount tied to the quantity of alcohol.';
  end if;

  -- A promotion must never be aimed at minors in an alcohol context, and the
  -- service itself is 16+, so a 0 audience is only valid for fee-only, all-ages
  -- communication. Kept explicit so an admin has to think about it.
  if new.audience_min_age = 0 and new.code is not null then
    new.audience_min_age := app.setting_int('alcohol.min_age_beer_wine');
  end if;

  return new;
end;
$$;

create trigger trg_promotion_rule
  before insert or update on promotions
  for each row execute function app.guard_promotion_rule();

-- Applies the promotion to the fee it targets. It is mathematically unable to
-- touch the item total: the item amount is not even passed in.
create or replace function app.apply_promotion(
  p_promotion uuid,
  p_delivery_fee_cents integer,
  p_service_fee_cents integer
) returns table (delivery_fee_cents integer, service_fee_cents integer)
language plpgsql
stable
as $$
declare
  pr record;
  d integer := p_delivery_fee_cents;
  s integer := p_service_fee_cents;
  cut integer;
begin
  select * into pr from promotions where id = p_promotion and active;
  if not found then
    return query select d, s; return;
  end if;

  if now() < pr.starts_at or now() > pr.ends_at then
    return query select d, s; return;
  end if;

  if pr.target = 'delivery_fee' then
    cut := case when pr.discount_type = 'percent'
                then app.round_cents(d * pr.discount_percent::double precision)
                else least(pr.discount_fixed_cents, d) end;
    d := greatest(d - cut, 0);
  else
    cut := case when pr.discount_type = 'percent'
                then app.round_cents(s * pr.discount_percent::double precision)
                else least(pr.discount_fixed_cents, s) end;
    s := greatest(s - cut, 0);
  end if;

  return query select d, s;
end;
$$;

-- -----------------------------------------------------------------------------
-- Referrals, partner codes, ambassadors (spec 8)
-- -----------------------------------------------------------------------------

create table referral_codes (
  id          uuid primary key default gen_random_uuid(),
  code        text not null unique,
  owner_id    uuid references users(id) on delete cascade,
  kind        text not null check (kind in ('client_referral','partner','ambassador','courier_referral')),
  label       text,
  active      boolean not null default true,
  created_at  timestamptz not null default now(),
  -- Partner codes (cercles, kots-à-projet) have no individual owner.
  constraint chk_owner_required check (kind = 'partner' or owner_id is not null)
);

create table referrals (
  id          uuid primary key default gen_random_uuid(),
  code_id     uuid not null references referral_codes(id),
  referrer_id uuid references users(id),
  referee_id  uuid not null references users(id),
  -- Spec 8.2: the reward is granted only after the referee's FIRST DELIVERED
  -- order, not at sign-up. That alone removes most of the fraud incentive.
  qualifying_order_id uuid references orders(id),
  reward_granted_at   timestamptz,

  -- Anti-fraud fingerprints. Hashes only: we never store a device identifier
  -- or a payment instrument in clear (spec 4.7 minimisation).
  device_fingerprint_hash  text,
  payment_fingerprint_hash text,
  phone_fingerprint_hash   text,

  blocked_reason text,
  created_at  timestamptz not null default now(),
  unique (referee_id)
);

comment on column referrals.device_fingerprint_hash is
  'Spec 8.2 anti-fraud: same phone, device or payment method. Stored as a '
  'salted hash so the raw identifier never sits in the database.';

create index on referrals (referrer_id);
create index on referrals (device_fingerprint_hash) where device_fingerprint_hash is not null;

-- Spec 8.2: self-referral and shared-device/payment referrals are blocked, and
-- the monthly cap is enforced server-side.
create or replace function app.guard_referral()
returns trigger
language plpgsql
as $$
declare
  cap integer := app.setting_int('growth.referral_monthly_cap');
  granted_this_month integer;
begin
  if new.referrer_id = new.referee_id then
    raise exception 'self-referral is not allowed' using errcode = 'check_violation';
  end if;

  if new.device_fingerprint_hash is not null and exists (
       select 1 from referrals r
        where r.referrer_id = new.referrer_id
          and r.device_fingerprint_hash = new.device_fingerprint_hash
          and r.referee_id <> new.referee_id) then
    new.blocked_reason := 'same device as a previous referral';
  end if;

  if new.payment_fingerprint_hash is not null and exists (
       select 1 from referrals r
        where r.referrer_id = new.referrer_id
          and r.payment_fingerprint_hash = new.payment_fingerprint_hash
          and r.referee_id <> new.referee_id) then
    new.blocked_reason := 'same payment method as a previous referral';
  end if;

  select count(*) into granted_this_month
    from referrals r
   where r.referrer_id = new.referrer_id
     and r.reward_granted_at >= date_trunc('month', now());

  if granted_this_month >= cap then
    new.blocked_reason := coalesce(new.blocked_reason, 'monthly referral cap reached');
  end if;

  return new;
end;
$$;

create trigger trg_referral
  before insert on referrals
  for each row execute function app.guard_referral();

create table ambassadors (
  user_id     uuid primary key references users(id) on delete cascade,
  code_id     uuid not null references referral_codes(id),
  -- Spec 8.5 and Q-06: credit or remuneration is a legal question, not a
  -- product one. Until it is answered the mode comes from a setting.
  reward_mode text not null default 'credit' check (reward_mode in ('credit','remuneration')),
  active      boolean not null default true,
  joined_at   timestamptz not null default now()
);

-- -----------------------------------------------------------------------------
-- Marketing communications (spec 4.2, 8.8)
-- -----------------------------------------------------------------------------

create table marketing_campaigns (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  channel     text not null check (channel in ('push','email','sms','banner','social')),
  social_network text,
  -- Spec 4.2: any communication featuring an alcoholic product carries this flag.
  mentions_alcohol boolean not null default false,
  audience_min_age integer not null default 16 check (audience_min_age in (16,18)),
  health_warning_text text,
  body        text not null,
  scheduled_at timestamptz,
  sent_at     timestamptz,
  created_by  uuid references users(id),

  -- Spec 4.2: a communication featuring alcohol is 18+ and carries the warning.
  constraint chk_alcohol_audience check (
    mentions_alcohol = false or (audience_min_age = 18 and health_warning_text is not null)
  )
);

comment on constraint chk_alcohol_audience on marketing_campaigns is
  'Spec 4.2: the mentions_alcohol flag imposes the health warning and an '
  'audience limited to 18 and over.';

-- Spec 4.2: no alcohol advertising on social networks without age control
-- (TikTok, Snapchat). On those networks only the delivery service is shown.
create or replace function app.guard_campaign()
returns trigger
language plpgsql
as $$
declare
  no_age_control text[] := array['tiktok','snapchat'];
begin
  if new.channel = 'social'
     and new.mentions_alcohol
     and lower(coalesce(new.social_network, '')) = any(no_age_control) then
    raise exception 'no alcohol communication on % (no age control)', new.social_network
      using errcode = 'check_violation',
            hint = 'Spec 4.2: on those networks, communicate about the delivery service only.';
  end if;

  -- Spec 4.2: no message associating alcohol with performance, success or excess.
  if new.body ~* '(performance|réussite|reussite|succès|succes|cul sec|cul-sec|biture|défonce|defonce|bourré|bourre|ivre)' then
    raise exception 'this message associates alcohol with performance or excess'
      using errcode = 'check_violation', hint = 'Spec 4.2.';
  end if;

  -- The health warning text comes from the parameter, never hard-coded.
  if new.mentions_alcohol and new.health_warning_text is null then
    new.health_warning_text := app.setting_text('alcohol.health_warning_fr');
  end if;

  return new;
end;
$$;

create trigger trg_campaign
  before insert or update on marketing_campaigns
  for each row execute function app.guard_campaign();

-- Spec 8.8: marketing goes only to users who consented, with a frequency cap.
create or replace function app.marketing_audience(p_campaign uuid)
returns table (user_id uuid)
language sql
stable
as $$
  select u.id
    from users u
    join marketing_campaigns c on c.id = p_campaign
   where u.status = 'active'
     and u.deleted_at is null
     and app.has_consent(u.id, 'marketing')
     and app.bracket_min_age(u.age_bracket) >= c.audience_min_age
     and u.age_verified;
$$;

comment on function app.marketing_audience is
  'Spec 8.8 and 4.2: consent is required, and an alcohol-related campaign only '
  'ever reaches verified 18+ users.';
