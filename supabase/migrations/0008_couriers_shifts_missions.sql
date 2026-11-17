-- =============================================================================
-- 0008_couriers_shifts_missions.sql
-- Courier profiles, payroll-sensitive data, shifts, missions and positions.
--
-- Blocking requirements enforced here (spec 4.3, acceptance criteria 20):
--   * no mission without contract_signed AND dimona_confirmed;
--   * no shift after work.night_work_threshold_time without a validated
--     derogation, and publishing one is a logged action;
--   * no shift at all while the mandatory employer documents or the hourly
--     wage are missing (HYPOTHESES.md H-11);
--   * no position collected outside an active booked shift (spec 4.3, 7.9).
-- =============================================================================

create table courier_profiles (
  user_id        uuid primary key references users(id) on delete cascade,
  -- H-03: STUDENT_EMPLOYEE is the only model that can be used in the MVP.
  courier_model  courier_model not null default 'STUDENT_EMPLOYEE',
  transport      transport_mode not null,
  capacity_units integer not null check (capacity_units > 0),

  -- Spec 7.1: proof of enrolment in an educational institution.
  enrolment_proof_ref text,
  training_passed_at  timestamptz,       -- spec 7.2, mandatory quiz

  -- Spec 7.3: both must be true before any mission.
  contract_signed     boolean not null default false,
  contract_signed_at  timestamptz,
  dimona_confirmed    boolean not null default false,
  dimona_confirmed_at timestamptz,

  status         courier_status not null default 'applied',
  created_at     timestamptz not null default now(),
  ended_at       timestamptz,

  constraint chk_contract_timestamp check (contract_signed = (contract_signed_at is not null)),
  constraint chk_dimona_timestamp   check (dimona_confirmed = (dimona_confirmed_at is not null)),

  -- Spec 7.3: the account only becomes active with BOTH elements.
  constraint chk_active_requires_contract_and_dimona check (
    status <> 'active' or (contract_signed and dimona_confirmed)
  )
);

comment on constraint chk_active_requires_contract_and_dimona on courier_profiles is
  'Spec 7.3 and 4.3: a student employment contract signed before any work, '
  'and a confirmed Dimona declaration. Both, or the account is not active.';

-- Spec 4.4 / H-03: INDEPENDENT is double-locked. The setting must be on AND a
-- written legal opinion must be referenced.
create or replace function app.guard_independent_mode()
returns trigger
language plpgsql
as $$
begin
  if new.courier_model = 'INDEPENDENT' then
    if not app.setting_bool('courier.independent_mode_enabled')
       or not app.setting_is_set('courier.independent_legal_opinion_id') then
      raise exception 'INDEPENDENT mode is locked'
        using errcode = 'check_violation',
              hint = 'Spec 4.4: a super-admin must enable it AND upload a written legal opinion.';
    end if;
  end if;
  return new;
end;
$$;

create trigger trg_independent_mode
  before insert or update of courier_model on courier_profiles
  for each row execute function app.guard_independent_mode();

-- -----------------------------------------------------------------------------
-- Payroll-sensitive data, isolated in the hr schema (spec 4.7, 4.8)
-- -----------------------------------------------------------------------------

create table hr.courier_payroll (
  user_id uuid primary key references users(id) on delete cascade,
  -- Encrypted at rest with pgcrypto; the key lives outside the database.
  iban_encrypted              bytea,
  national_register_encrypted bytea,
  joint_committee_ref         text,
  hourly_wage_cents           integer check (hourly_wage_cents > 0),
  updated_at timestamptz not null default now()
);

comment on table hr.courier_payroll is
  'Spec 4.7: national register number and IBAN are collected only because '
  'payroll requires them, encrypted at rest, and readable only by the hr role.';

create table audit.hr_access_log (
  id          bigserial primary key,
  subject_id  uuid        not null,
  accessed_by uuid,
  field       text        not null,
  purpose     text        not null,
  occurred_at timestamptz not null default now()
);

comment on table audit.hr_access_log is
  'Every read of a payroll-sensitive field is logged with its purpose.';

-- -----------------------------------------------------------------------------
-- Shifts
-- -----------------------------------------------------------------------------

create table shifts (
  id         uuid primary key default gen_random_uuid(),
  zone_id    uuid not null references zones(id),
  starts_at  timestamptz not null,
  ends_at    timestamptz not null,
  places     integer not null check (places > 0),

  -- Spec 14: night work (20:00-06:00) is in principle forbidden in Belgium.
  night_derogation boolean not null default false,
  derogation_validated_by uuid references users(id),
  derogation_note  text,

  peak_bonus_cents integer not null default 0 check (peak_bonus_cents >= 0),
  published_by uuid references users(id),
  published_at timestamptz not null default now(),
  cancelled_at timestamptz,

  constraint chk_shift_window check (ends_at > starts_at),
  constraint chk_derogation_has_validator check (
    night_derogation = false or derogation_validated_by is not null
  )
);

create index on shifts (zone_id, starts_at);

-- Refuses a shift that runs past the night threshold without a validated
-- derogation, and refuses any shift while mandatory employer documents or the
-- hourly wage are missing.
create or replace function app.guard_shift_publication()
returns trigger
language plpgsql
as $$
declare
  night_threshold time := app.setting_text('work.night_work_threshold_time')::time;
  service_end     time := app.setting_text('work.service_end_time')::time;
  missing         text;
begin
  -- H-11: no shift while the employer's legal obligations are unreferenced.
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

  -- Spec 14: anything running past the night threshold needs the derogation.
  if (new.ends_at::time > night_threshold or new.starts_at::time < time '06:00')
     and not new.night_derogation then
    raise exception 'a shift running past % requires a validated night derogation', night_threshold
      using errcode = 'check_violation',
            hint = 'Spec 14: night work is in principle forbidden in Belgian law.';
  end if;

  -- Publishing a derogation is a logged action (spec 14).
  if new.night_derogation then
    insert into audit.settings_history (key, old_value, new_value, changed_by)
    values ('shift.night_derogation',
            null,
            jsonb_build_object('shift_window', tstzrange(new.starts_at, new.ends_at),
                               'note', new.derogation_note),
            new.derogation_validated_by);
  end if;

  return new;
end;
$$;

create trigger trg_shift_publication
  before insert or update on shifts
  for each row execute function app.guard_shift_publication();

create table shift_bookings (
  id          uuid primary key default gen_random_uuid(),
  shift_id    uuid not null references shifts(id) on delete cascade,
  courier_id  uuid not null references courier_profiles(user_id),
  booked_at   timestamptz not null default now(),
  cancelled_at timestamptz,
  -- Spec 11: hours run from the start of the booked shift to its end, or to
  -- the end of the last mission when it overruns.
  worked_from timestamptz,
  worked_to   timestamptz,
  unique (shift_id, courier_id)
);

create index on shift_bookings (courier_id, booked_at desc);

-- A courier may only book while active (contract + Dimona), and the shift must
-- not be oversubscribed.
create or replace function app.guard_shift_booking()
returns trigger
language plpgsql
as $$
declare
  c record;
  taken integer;
  s record;
begin
  select * into c from courier_profiles where user_id = new.courier_id;

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

  return new;
end;
$$;

create trigger trg_shift_booking
  before insert on shift_bookings
  for each row execute function app.guard_shift_booking();

-- -----------------------------------------------------------------------------
-- Missions and offers (spec 15)
-- -----------------------------------------------------------------------------

create table missions (
  id          uuid primary key default gen_random_uuid(),
  courier_id  uuid references courier_profiles(user_id),
  shift_booking_id uuid references shift_bookings(id),
  store_id    uuid not null references stores(id),
  status      text not null default 'pending'
              check (status in ('pending','assigned','at_store','purchased','en_route','done','abandoned')),
  created_at  timestamptz not null default now(),
  assigned_at timestamptz,
  completed_at timestamptz,
  estimated_bonus_cents integer not null default 0
);

create table mission_orders (
  mission_id uuid not null references missions(id) on delete cascade,
  order_id   uuid not null references orders(id) on delete cascade,
  primary key (mission_id, order_id)
);

create table mission_offers (
  id          uuid primary key default gen_random_uuid(),
  mission_id  uuid not null references missions(id) on delete cascade,
  courier_id  uuid not null references courier_profiles(user_id),
  score       numeric(5,4) not null check (score >= 0 and score <= 1),
  status      mission_offer_status not null default 'offered',
  offered_at  timestamptz not null default now(),
  responded_at timestamptz,
  -- Spec 7.5: a courier may decline with a reason, and declining carries NO
  -- automatic penalty. The reason is for quality follow-up only.
  decline_reason text,
  unique (mission_id, courier_id)
);

comment on column mission_offers.decline_reason is
  'Spec 7.5 and 15: declining never triggers an automatic sanction. Any '
  'decision affecting a courier requires a reasoned human review.';

-- Spec 4.3, acceptance criterion: no mission may be assigned to a courier
-- without a signed contract and a confirmed Dimona.
create or replace function app.guard_mission_assignment()
returns trigger
language plpgsql
as $$
declare
  c record;
begin
  if new.courier_id is null then
    return new;
  end if;

  select * into c from courier_profiles where user_id = new.courier_id;

  if not found or not c.contract_signed or not c.dimona_confirmed then
    raise exception 'no mission without a signed contract and a confirmed Dimona (courier %)', new.courier_id
      using errcode = 'check_violation',
            hint = 'Spec 4.3, blocking requirement.';
  end if;

  if c.status <> 'active' then
    raise exception 'courier % is not active (status %)', new.courier_id, c.status
      using errcode = 'check_violation';
  end if;

  if new.assigned_at is null then
    new.assigned_at := now();
  end if;

  return new;
end;
$$;

create trigger trg_mission_assignment
  before insert or update of courier_id on missions
  for each row execute function app.guard_mission_assignment();

-- -----------------------------------------------------------------------------
-- Positions: only during an active booked shift (spec 4.3, 7.9)
-- -----------------------------------------------------------------------------

create table courier_positions (
  id          bigserial primary key,
  courier_id  uuid not null references courier_profiles(user_id) on delete cascade,
  shift_booking_id uuid not null references shift_bookings(id) on delete cascade,
  lat         double precision not null,
  lon         double precision not null,
  recorded_at timestamptz not null default now()
);

create index on courier_positions (courier_id, recorded_at desc);
create index on courier_positions (recorded_at);

comment on table courier_positions is
  'Spec 4.3: geolocation only during a booked shift, with clear information to '
  'the courier. Purged after retention.courier_positions_days (spec 4.7).';

create or replace function app.guard_position_within_shift()
returns trigger
language plpgsql
as $$
declare
  b record;
  s record;
begin
  select * into b from shift_bookings where id = new.shift_booking_id;

  if not found or b.courier_id <> new.courier_id then
    raise exception 'position does not belong to this courier''s booking'
      using errcode = 'check_violation';
  end if;

  if b.cancelled_at is not null then
    raise exception 'no position may be collected on a cancelled booking'
      using errcode = 'check_violation';
  end if;

  select * into s from shifts where id = b.shift_id;

  if new.recorded_at < s.starts_at or new.recorded_at > s.ends_at then
    raise exception 'no position may be collected outside the booked shift window'
      using errcode = 'check_violation',
            hint = 'Spec 4.3: geolocation only during a booked shift.';
  end if;

  -- Consent to geolocation is separate and must be present (spec 6.2).
  if not app.has_consent(new.courier_id, 'geolocation') then
    raise exception 'courier % has not consented to geolocation', new.courier_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_position_within_shift
  before insert on courier_positions
  for each row execute function app.guard_position_within_shift();
