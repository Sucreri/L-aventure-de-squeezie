-- =============================================================================
-- 0026_courier_fixes.sql
--
-- Two corrections to 0024 and 0025, both found by running the courier journey.
--
-- 1. courier_actions referenced courier_profiles, but the FIRST action a
--    courier ever takes is applying — which happens before a profile exists.
--    The offline log could therefore never record it. The log is per user, so
--    it references users.
--
-- 2. The guards added in 0025 raised in French, while every other guard in
--    this schema raises in English and errors.ts turns that into French for
--    the person. Mixing the two meant the new refusals fell through to the
--    generic "refused by a rule" message, so a courier was told something had
--    been refused without being told what to do about it.
-- =============================================================================

alter table courier_actions
  drop constraint courier_actions_courier_id_fkey,
  add constraint courier_actions_courier_id_fkey
    foreign key (courier_id) references users(id) on delete cascade;

comment on column courier_actions.courier_id is
  'References users, not courier_profiles: the first action replayed from '
  'offline may be the application itself, before any profile exists.';

create or replace function app.guard_shift_booking()
returns trigger
language plpgsql
as $$
declare
  c record;
  taken integer;
  s record;
  day_hours numeric;
  week_hours numeric;
  max_day integer := app.setting_int('work.max_hours_per_day');
  max_week integer := app.setting_int('work.max_hours_per_week');
  shift_hours numeric;
begin
  select * into c from courier_profiles where user_id = new.courier_id;

  if not found then
    raise exception 'no courier profile for %', new.courier_id
      using errcode = 'check_violation';
  end if;

  -- Spec 7.2: the mandatory training is a prerequisite in its own right.
  if c.training_passed_at is null then
    raise exception 'mandatory training has not been passed'
      using errcode = 'check_violation', hint = 'Spec 7.2.';
  end if;

  -- Spec 4.3 and 7.3: contract signed and Dimona confirmed.
  if c.status <> 'active' or not c.contract_signed or not c.dimona_confirmed then
    raise exception 'courier % cannot book a shift: contract or Dimona missing', new.courier_id
      using errcode = 'check_violation',
            hint = 'Spec 4.3: no work without a signed contract and a confirmed Dimona.';
  end if;

  select * into s from shifts where id = new.shift_id;
  if s.cancelled_at is not null then
    raise exception 'this shift has been cancelled' using errcode = 'check_violation';
  end if;

  select count(*) into taken
    from shift_bookings b where b.shift_id = new.shift_id and b.cancelled_at is null;

  if taken >= s.places then
    raise exception 'shift is full (% places)', s.places using errcode = 'check_violation';
  end if;

  -- Spec 14: the app prevents booking beyond the configured limits. Enforcing
  -- it here means no caller can route around it.
  shift_hours := extract(epoch from (s.ends_at - s.starts_at)) / 3600.0;

  day_hours := app.courier_hours(new.courier_id,
                                 date_trunc('day', s.starts_at),
                                 date_trunc('day', s.starts_at) + interval '1 day');
  week_hours := app.courier_hours(new.courier_id,
                                  date_trunc('week', s.starts_at),
                                  date_trunc('week', s.starts_at) + interval '1 week');

  if day_hours + shift_hours > max_day then
    raise exception 'booking would exceed the maximum of % hours per day', max_day
      using errcode = 'check_violation', hint = 'Spec 14: working time limits.';
  end if;

  if week_hours + shift_hours > max_week then
    raise exception 'booking would exceed the maximum of % hours per week', max_week
      using errcode = 'check_violation', hint = 'Spec 14: working time limits.';
  end if;

  return new;
end;
$$;

comment on function app.guard_shift_booking is
  'Spec 7.2, 7.3 and 14: training passed, contract signed, Dimona confirmed, '
  'shift not full, and daily and weekly working-time limits respected. Raises '
  'in English like every other guard; errors.ts turns it into French.';
