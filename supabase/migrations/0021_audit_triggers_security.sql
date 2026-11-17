-- =============================================================================
-- 0021_audit_triggers_security.sql
-- Lets the guards journal without granting anyone access to the journals.
--
-- The problem: audit.order_events is written by a trigger that fires when a
-- client cancels their own order. The trigger ran with the caller's
-- privileges, and a client has no access to the audit schema at all — by
-- design. So the cancellation failed with "permission denied for schema
-- audit", and journaling was effectively coupled to the caller's rights.
--
-- Journaling must never depend on who acts. These trigger functions therefore
-- become SECURITY DEFINER: they can append to the journals, while no caller
-- gains the ability to write a journal row directly.
--
-- The audit tables also drop FORCE ROW LEVEL SECURITY. They keep RLS enabled,
-- so readers still go through the policies (admins and staff only), but the
-- owner — reached exclusively through these functions — can append. Forcing
-- RLS on the owner as well would leave the journals unwritable.
-- =============================================================================

alter table audit.order_events      no force row level security;
alter table audit.admin_actions     no force row level security;
alter table audit.settings_history  no force row level security;
alter table audit.retention_runs    no force row level security;
alter table audit.hr_access_log     no force row level security;

-- Order transitions (spec 12): records the actor and the reason on every move.
create or replace function app.guard_order_transition()
returns trigger
language plpgsql
security definer
set search_path = public, app, audit
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

-- Mission bookkeeping (migration 0018): a client's own transition closes the
-- courier's mission, and a client has no write access to missions.
create or replace function app.sync_mission_status()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
declare
  m record;
  still_in_flight integer;
begin
  if new.status = old.status then
    return new;
  end if;

  for m in
    select mi.id, mi.status
      from missions mi
      join mission_orders mo on mo.mission_id = mi.id
     where mo.order_id = new.id
  loop
    select count(*) into still_in_flight
      from mission_orders mo2
      join orders o2 on o2.id = mo2.order_id
     where mo2.mission_id = m.id
       and o2.status not in ('DELIVERED', 'DELIVERY_FAILED', 'HELD_AT_HUB',
                             'CANCELLED_BY_CLIENT', 'CANCELLED_BY_OPS',
                             'REFUNDED_FULL', 'REFUNDED_PARTIAL', 'NO_COURIER_FOUND');

    if still_in_flight = 0 then
      update missions
         set status = 'done', completed_at = coalesce(completed_at, now())
       where id = m.id and status <> 'done';
    else
      update missions
         set status = case new.status
                        when 'AT_STORE'  then 'at_store'
                        when 'PURCHASED' then 'purchased'
                        when 'EN_ROUTE'  then 'en_route'
                        when 'ARRIVED'   then 'en_route'
                        else missions.status
                      end
       where id = m.id and status <> 'done';
    end if;
  end loop;

  return new;
end;
$$;

-- Parameter history and night-work derogations, same reasoning.
create or replace function app.log_setting_change()
returns trigger
language plpgsql
security definer
set search_path = public, app, audit
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

create or replace function app.guard_shift_publication()
returns trigger
language plpgsql
security definer
set search_path = public, app, audit
as $$
declare
  night_threshold time := app.setting_text('work.night_work_threshold_time')::time;
  service_end     time := app.setting_text('work.service_end_time')::time;
  missing         text;
begin
  select string_agg(key, ', ') into missing
    from app_settings
   where key in ('pay.hourly_wage_cents',
                 'pay.joint_committee_ref',
                 'labour.work_accident_insurance_ref',
                 'labour.prevention_service_ref',
                 'labour.work_rules_document_id')
     and value = 'null'::jsonb;

  if missing is not null then
    raise exception 'cannot publish a shift while these are unset: %', missing
      using errcode = 'check_violation',
            hint = 'Spec 4.3: wage scale, work-accident insurance, prevention service and work rules.';
  end if;

  if new.ends_at::time > service_end and new.ends_at::time > night_threshold then
    raise exception 'shift ends after the service end time (%)', service_end
      using errcode = 'check_violation';
  end if;

  if (new.ends_at::time > night_threshold or new.starts_at::time < time '06:00')
     and not new.night_derogation then
    raise exception 'a shift running past % requires a validated night derogation', night_threshold
      using errcode = 'check_violation',
            hint = 'Spec 14: night work is in principle forbidden in Belgian law.';
  end if;

  if new.night_derogation then
    insert into audit.settings_history (key, old_value, new_value, changed_by)
    values ('shift.night_derogation', null,
            jsonb_build_object('shift_window', tstzrange(new.starts_at, new.ends_at),
                               'note', new.derogation_note),
            new.derogation_validated_by);
  end if;

  return new;
end;
$$;

comment on function app.guard_order_transition is
  'SECURITY DEFINER so that journaling never depends on the privileges of '
  'whoever triggered the transition. No caller gains write access to the '
  'journal: only this function appends to it.';
