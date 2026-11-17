-- =============================================================================
-- 0009_age_checks_delivery.sql
-- Age check at handover, delivery PIN, and the guard that makes DELIVERED
-- unreachable without both.
--
-- Spec 13 and acceptance criterion 20.3:
--   "Une commande avec alcool ne peut pas passer à DELIVERED sans contrôle
--    d'âge validé et PIN correct ; aucune donnée d'identité n'est stockée."
--
-- CRITICAL: age_checks has NO birth-year column and NO photo column. The
-- courier's app computes locally whether the age is sufficient and sends only
-- the outcome (HYPOTHESES.md H-04, spec 13.2).
-- =============================================================================

create table age_checks (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  courier_id  uuid not null references courier_profiles(user_id),
  result      age_check_result not null,
  refusal_reason age_refusal_reason,
  -- Spec 13.2: "Pièce vérifiée, personne en état normal".
  document_checked boolean not null default false,
  person_appears_sober boolean not null default false,
  occurred_at timestamptz not null default now(),

  constraint chk_refusal_has_reason check (
    (result = 'ok' and refusal_reason is null)
    or (result = 'refused' and refusal_reason is not null)
  ),
  -- A positive check means the courier actually looked at the document AND
  -- judged the person able to receive alcohol (spec 13.2, 13.3).
  constraint chk_ok_requires_both_boxes check (
    result <> 'ok' or (document_checked and person_appears_sober)
  )
);

comment on table age_checks is
  'Spec 13.2: only the outcome, the reason, the timestamp and the courier are '
  'recorded. Never the year entered, never a photo of the document. The table '
  'has no column able to hold either.';

create index on age_checks (order_id, occurred_at desc);
create index on age_checks (courier_id, occurred_at desc);

-- Age checks are evidence: they are never rewritten.
create or replace function app.age_checks_are_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'age checks are append-only (%)', tg_op using errcode = 'restrict_violation';
end;
$$;

create trigger trg_age_checks_append_only
  before update or delete on age_checks
  for each row execute function app.age_checks_are_append_only();

-- PIN verification timestamp lives on the order.
alter table orders add column pin_verified_at timestamptz;
alter table orders add column age_check_id uuid references age_checks(id);

-- -----------------------------------------------------------------------------
-- Helpers
-- -----------------------------------------------------------------------------

create or replace function app.order_contains_alcohol(p_order uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from order_items i
     where i.order_id = p_order and i.contains_alcohol_snapshot and not i.refunded
  );
$$;

-- Sets the delivery PIN, stored hashed only (H-13).
create or replace function app.set_order_pin(p_order uuid, p_pin text)
returns void
language plpgsql
security definer
set search_path = public, app, extensions
as $$
declare
  expected_len integer := app.setting_int('alcohol.pin_length');
begin
  if p_pin !~ ('^[0-9]{' || expected_len || '}$') then
    raise exception 'the PIN must be exactly % digits', expected_len
      using errcode = 'check_violation';
  end if;
  update orders set pin_hash = crypt(p_pin, gen_salt('bf', 8)) where id = p_order;
end;
$$;

comment on function app.set_order_pin is
  'Stores the delivery PIN as a bcrypt hash. The clear PIN never touches a '
  'column or a log (HYPOTHESES.md H-13).';

-- -----------------------------------------------------------------------------
-- Handover: age check then PIN, in that order (spec 13.4)
-- -----------------------------------------------------------------------------

create or replace function app.record_age_check(
  p_order uuid,
  p_courier uuid,
  p_result age_check_result,
  p_reason age_refusal_reason default null,
  p_document_checked boolean default false,
  p_sober boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  new_id uuid;
begin
  insert into age_checks (order_id, courier_id, result, refusal_reason,
                          document_checked, person_appears_sober)
  values (p_order, p_courier, p_result, p_reason, p_document_checked, p_sober)
  returning id into new_id;

  if p_result = 'ok' then
    update orders set age_check_id = new_id where id = p_order;
  else
    -- Spec 13.3: a refusal sends the order to DELIVERY_FAILED. Spec 13.5: the
    -- courier incurs no penalty for refusing.
    perform app.set_actor(p_courier, 'courier', 'age check refused: ' || p_reason::text);
    update orders set status = 'DELIVERY_FAILED' where id = p_order;
  end if;

  return new_id;
end;
$$;

-- The single entry point for marking an order delivered.
create or replace function app.deliver_order(
  p_order   uuid,
  p_courier uuid,
  p_pin     text
) returns void
language plpgsql
security definer
set search_path = public, app, extensions
as $$
declare
  o record;
  ac record;
begin
  select * into o from orders where id = p_order for update;
  if not found then
    raise exception 'unknown order %', p_order;
  end if;

  -- Spec 13.2: the age check is mandatory for any order containing alcohol.
  if app.order_contains_alcohol(p_order) then
    if o.age_check_id is null then
      raise exception 'an age check is required before handing over alcohol'
        using errcode = 'check_violation', hint = 'Spec 13.2.';
    end if;

    select * into ac from age_checks where id = o.age_check_id;
    if ac.result <> 'ok' then
      raise exception 'the age check did not pass' using errcode = 'check_violation';
    end if;
  end if;

  if o.pin_hash is null then
    raise exception 'this order has no delivery PIN' using errcode = 'check_violation';
  end if;

  if crypt(p_pin, o.pin_hash) <> o.pin_hash then
    raise exception 'invalid PIN' using errcode = 'check_violation';
  end if;

  update orders set pin_verified_at = now() where id = p_order;

  perform app.set_actor(p_courier, 'courier', 'handover completed');
  update orders set status = 'DELIVERED' where id = p_order;
end;
$$;

comment on function app.deliver_order is
  'Spec 13.4: the PIN is only asked after the age check. Without a valid PIN '
  'and a passed age check, the order cannot reach DELIVERED.';

-- Belt and braces: even a direct UPDATE cannot reach DELIVERED without both.
-- The function above is the intended path; this trigger makes bypassing it
-- impossible, which is what "enforced server-side" means (spec 4).
create or replace function app.guard_delivered_requires_checks()
returns trigger
language plpgsql
as $$
declare
  ac record;
begin
  if new.status <> 'DELIVERED' then
    return new;
  end if;

  if new.pin_verified_at is null then
    raise exception 'DELIVERED requires a verified PIN'
      using errcode = 'check_violation', hint = 'Spec 13.4.';
  end if;

  if app.order_contains_alcohol(new.id) then
    if new.age_check_id is null then
      raise exception 'DELIVERED requires a passed age check for an order containing alcohol'
        using errcode = 'check_violation', hint = 'Spec 13.2 and acceptance criterion 20.3.';
    end if;

    select * into ac from age_checks where id = new.age_check_id;

    if ac.result <> 'ok' then
      raise exception 'the referenced age check did not pass'
        using errcode = 'check_violation';
    end if;

    -- Spec 13.4: the PIN comes AFTER the age check, never before.
    if new.pin_verified_at < ac.occurred_at then
      raise exception 'the PIN was verified before the age check'
        using errcode = 'check_violation', hint = 'Spec 13.4: age first, then PIN.';
    end if;
  end if;

  return new;
end;
$$;

create trigger trg_delivered_requires_checks
  before update of status on orders
  for each row execute function app.guard_delivered_requires_checks();
