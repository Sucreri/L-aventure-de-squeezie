-- =============================================================================
-- 0019_settings_accessors_security.sql
-- Makes the parameter accessors SECURITY DEFINER.
--
-- The problem this fixes: app_settings is readable only by staff (policy
-- settings_staff), because it holds thresholds and legal texts that a client
-- has no business enumerating. But app.compute_delivery_fee, and everything
-- else that prices or validates, reads parameters — so under a client's own
-- role those functions failed with "unknown setting".
--
-- The right boundary is the ACCESSOR, not the table: the table stays
-- invisible, and the functions expose exactly the values a computation needs.
-- Each one pins its search_path, as a SECURITY DEFINER function must.
--
-- Note that this grants no new ability to enumerate: a caller still has to
-- know a key by name, and keys are not secrets — their values drive prices
-- that are displayed to the client anyway.
-- =============================================================================

create or replace function app.setting(p_key text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, app
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

create or replace function app.setting_int(p_key text)
returns integer
language plpgsql
stable
security definer
set search_path = public, app
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
security definer
set search_path = public, app
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
security definer
set search_path = public, app
as $$ select (app.setting(p_key) #>> '{}')::boolean; $$;

create or replace function app.setting_text(p_key text)
returns text
language sql
stable
security definer
set search_path = public, app
as $$ select app.setting(p_key) #>> '{}'; $$;

create or replace function app.setting_is_set(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public, app
as $$ select app.setting(p_key) <> 'null'::jsonb; $$;

-- The pricing function is called by clients through the ordering path, so it
-- needs the same treatment: it reads six parameters.
create or replace function app.compute_delivery_fee(
  p_pallet_count integer,
  p_floor        integer,
  p_has_lift     boolean,
  p_surge        double precision,
  p_mode         delivery_mode
) returns integer
language plpgsql
stable
security definer
set search_path = public, app
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

  if coalesce(p_floor, 0) <= 0 then
    floors_cents := 0;
  elsif p_has_lift then
    floors_cents := floor_lift;
  else
    floors_cents := p_floor * floor_no_lift;
  end if;

  subtotal := base_fee
            + greatest(coalesce(p_pallet_count, 0) - 1, 0) * extra_fee
            + floors_cents;

  if p_mode = 'grouped_round' then
    applied_discount := discount;
  end if;

  return app.round_cents(subtotal::double precision * p_surge * (1.0 - applied_discount));
end;
$$;

-- Same for the two helpers a client legitimately triggers.
create or replace function app.cancellation_terms(p_order uuid)
returns table (free boolean, items_due_cents integer, fees_due_cents integer, explanation text)
language plpgsql
stable
security definer
set search_path = public, app
as $$
declare
  o record;
  share double precision := app.setting_num('cancellation.fee_share_after_purchase');
begin
  -- Visibility is still enforced: the caller must be able to see the order.
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

comment on function app.setting is
  'SECURITY DEFINER on purpose: app_settings stays invisible to clients, but '
  'the pricing and validation functions they trigger need its values.';
