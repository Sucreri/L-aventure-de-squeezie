-- =============================================================================
-- 0024_courier_journey.sql
-- What the courier journey needs beyond the tables already in place:
-- the mandatory training (§7.2), the substitution flow with its deadline
-- (§6.5, §7.6), hours and the annual quota (§7.4), the earnings estimate
-- (§7.8), and deduplication of actions replayed from offline (§18).
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Mandatory training (§7.2)
-- -----------------------------------------------------------------------------

-- The quiz content is a parameter, not code: its questions are about Belgian
-- law and about safety, and both change without the app changing.
create table training_questions (
  id          uuid primary key default gen_random_uuid(),
  topic       text not null check (topic in
              ('legal_age','refusal','id_check','load','bike_safety','conduct')),
  prompt      text not null,
  choices     jsonb not null,
  -- Index of the correct choice. Kept server-side: sending it to the app
  -- would let anyone read the answers before taking the quiz.
  correct_index integer not null check (correct_index >= 0),
  explanation text not null,
  display_rank integer not null default 100,
  active      boolean not null default true,
  constraint chk_choices_shape check (
    jsonb_typeof(choices) = 'array' and jsonb_array_length(choices) between 2 and 6
  ),
  constraint chk_correct_in_range check (correct_index < jsonb_array_length(choices))
);

comment on table training_questions is
  'Spec 7.2: legal ages, refusal when visibly intoxicated, checking an ID '
  'without copying it, carrying loads, bike safety, conduct.';

create table training_attempts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  answers     jsonb not null,
  score       integer not null check (score >= 0),
  total       integer not null check (total > 0),
  passed      boolean not null,
  attempted_at timestamptz not null default now()
);

create index on training_attempts (user_id, attempted_at desc);

-- An attempt is evidence that the person was trained: it is never rewritten.
create or replace function app.training_attempts_are_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'les tentatives de quiz sont en ajout seul (%)', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger trg_training_attempts_append_only
  before update or delete on training_attempts
  for each row execute function app.training_attempts_are_append_only();

-- Grades an attempt server-side and records it. The app never sees the
-- answer key, so it cannot mark its own homework.
create or replace function app.grade_training(p_user uuid, p_answers jsonb)
returns table (score integer, total integer, passed boolean, wrong jsonb)
language plpgsql
security definer
set search_path = public, app
as $$
declare
  pass_ratio double precision := app.setting_num('training.pass_ratio');
  correct integer := 0;
  asked   integer := 0;
  missed  jsonb := '[]'::jsonb;
  q record;
  given integer;
begin
  for q in select * from training_questions where active order by display_rank, id loop
    asked := asked + 1;
    given := nullif(p_answers ->> q.id::text, '')::integer;

    if given is not distinct from q.correct_index then
      correct := correct + 1;
    else
      missed := missed || jsonb_build_object(
        'question_id', q.id, 'prompt', q.prompt, 'explanation', q.explanation);
    end if;
  end loop;

  if asked = 0 then
    raise exception 'aucune question de formation active' using errcode = 'no_data_found';
  end if;

  passed := (correct::double precision / asked) >= pass_ratio;

  insert into training_attempts (user_id, answers, score, total, passed)
  values (p_user, p_answers, correct, asked, passed);

  -- Spec 7.2: the training is a prerequisite, recorded on the profile.
  if passed then
    update courier_profiles
       set training_passed_at = coalesce(training_passed_at, now())
     where user_id = p_user;
  end if;

  return query select correct, asked, passed, missed;
end;
$$;

comment on function app.grade_training is
  'Spec 7.2: grading happens on the server. The answer key is never sent to '
  'the app, so a courier cannot mark their own quiz.';

-- -----------------------------------------------------------------------------
-- Substitution flow (§6.5 and §7.6)
-- -----------------------------------------------------------------------------

create type substitution_outcome as enum (
  'awaiting_client', 'other_format', 'equivalent', 'refunded', 'expired_default'
);

create table substitution_requests (
  id            uuid primary key default gen_random_uuid(),
  order_item_id uuid not null references order_items(id) on delete cascade,
  courier_id    uuid not null references courier_profiles(user_id),
  reason        text not null check (reason in ('out_of_stock','price_gap','other')),
  -- What the courier found instead, if anything.
  proposed_label text,
  proposed_price_cents integer check (proposed_price_cents >= 0),
  -- Spec 6.5: the client has orders.substitution_response_s to answer;
  -- after that, their per-item default rule applies.
  asked_at   timestamptz not null default now(),
  expires_at timestamptz not null,
  answered_at timestamptz,
  outcome    substitution_outcome not null default 'awaiting_client',
  constraint chk_expiry_after_ask check (expires_at > asked_at),
  constraint chk_answer_has_outcome check (
    (answered_at is null) = (outcome = 'awaiting_client')
  )
);

create index on substitution_requests (order_item_id);
create index on substitution_requests (expires_at) where outcome = 'awaiting_client';

-- Sets the deadline from the parameter, so it is never typed by a caller.
create or replace function app.set_substitution_deadline()
returns trigger
language plpgsql
security definer
set search_path = public, app
as $$
begin
  new.expires_at := new.asked_at
                  + (app.setting_int('orders.substitution_response_s') || ' seconds')::interval;
  return new;
end;
$$;

create trigger trg_substitution_deadline
  before insert on substitution_requests
  for each row execute function app.set_substitution_deadline();

/**
 * Resolves a substitution.
 *
 * Called either by the client answering, or by the courier's app once the
 * deadline has passed. In the second case the client's own default rule for
 * that line applies — which is why the rule is captured per item at checkout
 * rather than asked for in the moment.
 */
create or replace function app.resolve_substitution(
  p_request uuid,
  p_answer  substitution_outcome default null
) returns substitution_requests
language plpgsql
security definer
set search_path = public, app
as $$
declare
  r substitution_requests;
  item order_items;
  resolved substitution_outcome;
begin
  select * into r from substitution_requests where id = p_request for update;
  if not found then
    raise exception 'demande de remplacement inconnue' using errcode = 'no_data_found';
  end if;

  if r.outcome <> 'awaiting_client' then
    return r;   -- already settled; replaying must not change the answer
  end if;

  select * into item from order_items where id = r.order_item_id;

  if p_answer is not null then
    if clock_timestamp() > r.expires_at then
      raise exception 'le délai de réponse est dépassé'
        using errcode = 'check_violation',
              hint = 'La règle de remplacement choisie par le client s''applique.';
    end if;
    resolved := p_answer;
  else
    -- Deadline reached: fall back to the rule the client chose up front.
    if clock_timestamp() <= r.expires_at then
      raise exception 'le délai de réponse n''est pas encore écoulé'
        using errcode = 'check_violation';
    end if;
    resolved := 'expired_default';
  end if;

  update substitution_requests
     set outcome = resolved, answered_at = now()
   where id = p_request
  returning * into r;

  -- A refusal removes the line from what the client pays for.
  if resolved = 'refunded'
     or (resolved = 'expired_default' and item.substitution_rule = 'refund') then
    update order_items set refunded = true, fulfilled = false where id = item.id;
  end if;

  return r;
end;
$$;

comment on function app.resolve_substitution is
  'Spec 6.5 and 7.6: the client answers within orders.substitution_response_s, '
  'otherwise the per-line rule they chose at checkout applies. The deadline is '
  'enforced here, not in the courier app.';

-- -----------------------------------------------------------------------------
-- Hours, quota and earnings (§7.4 and §7.8)
-- -----------------------------------------------------------------------------

/**
 * Hours worked over a period.
 *
 * Spec 11: hours run from the start of the booked shift to its end, or to the
 * end of the last mission when it overruns. A courier is paid for waiting, so
 * the shift window is what counts, not time spent on missions.
 */
create or replace function app.courier_hours(
  p_courier uuid,
  p_from timestamptz,
  p_to   timestamptz
) returns numeric
language sql
stable
as $$
  select coalesce(sum(
           extract(epoch from (
             least(coalesce(b.worked_to, s.ends_at), p_to)
             - greatest(coalesce(b.worked_from, s.starts_at), p_from)
           )) / 3600.0
         ), 0)::numeric(8,2)
    from shift_bookings b
    join shifts s on s.id = b.shift_id
   where b.courier_id = p_courier
     and b.cancelled_at is null
     and coalesce(b.worked_from, s.starts_at) < p_to
     and coalesce(b.worked_to, s.ends_at) > p_from;
$$;

/**
 * Where the courier stands against the annual Student@work quota (§7.4).
 *
 * The figure is informative: the authoritative counter is Student@work itself,
 * and hours worked for other employers count too. The app says so rather than
 * implying it knows the whole picture.
 */
create or replace function app.courier_quota_status(p_courier uuid)
returns table (
  year integer,
  hours_with_operator numeric,
  quota_hours integer,
  alert_threshold_hours integer,
  alerting boolean
)
language sql
stable
as $$
  select extract(year from now())::integer,
         app.courier_hours(p_courier,
                           date_trunc('year', now()),
                           date_trunc('year', now()) + interval '1 year'),
         app.setting_int('work.annual_quota_hours'),
         app.setting_int('work.quota_alert_threshold_hours'),
         app.courier_hours(p_courier,
                           date_trunc('year', now()),
                           date_trunc('year', now()) + interval '1 year')
           >= app.setting_int('work.quota_alert_threshold_hours');
$$;

/**
 * Estimated earnings over a period (§7.8).
 *
 * An ESTIMATE, and the app must label it as one: the official payslip comes
 * from the social secretariat, which applies contributions, withholding and
 * the treatment of tips this function does not model.
 */
create or replace function app.courier_earnings_estimate(
  p_courier uuid,
  p_from timestamptz,
  p_to   timestamptz
) returns table (
  hours numeric,
  hourly_wage_cents integer,
  wage_cents integer,
  deliveries integer,
  delivery_bonus_cents integer,
  floor_bonus_cents integer,
  tips_cents integer,
  total_cents integer
)
language plpgsql
stable
as $$
declare
  worked numeric := app.courier_hours(p_courier, p_from, p_to);
  wage integer := app.setting_int('pay.hourly_wage_cents');
  per_delivery integer := app.setting_int('pay.bonus_per_delivery_cents');
  per_floor integer := app.setting_int('pay.bonus_per_floor_cents');
  tip_share double precision := app.setting_num('pay.tips_share_to_courier');
  delivered integer;
  floors integer;
  tips integer;
begin
  select count(*)::integer,
         coalesce(sum(case when o.has_lift_snapshot then 0 else o.floor_snapshot end), 0)::integer,
         coalesce(sum(o.tip_cents), 0)::integer
    into delivered, floors, tips
    from missions m
    join mission_orders mo on mo.mission_id = m.id
    join orders o on o.id = mo.order_id
   where m.courier_id = p_courier
     and o.status = 'DELIVERED'
     and o.delivered_at between p_from and p_to;

  return query select
    worked,
    wage,
    app.round_cents(worked::double precision * wage),
    delivered,
    delivered * per_delivery,
    floors * per_floor,
    app.round_cents(tips * tip_share),
    app.round_cents(worked::double precision * wage)
      + delivered * per_delivery
      + floors * per_floor
      + app.round_cents(tips * tip_share);
end;
$$;

comment on function app.courier_earnings_estimate is
  'Spec 7.8: an ESTIMATE. The official pay and payslip come from the social '
  'secretariat, which applies contributions and withholding this does not model.';

-- -----------------------------------------------------------------------------
-- Offline action log (§18 robustesse)
-- -----------------------------------------------------------------------------

-- The courier app queues actions while offline and replays them on
-- reconnection. Without deduplication a replay would record a second age
-- check, or accept a mission twice. The app generates the id; the server
-- refuses to act on one it has already seen.
create table courier_actions (
  action_id   uuid primary key,
  courier_id  uuid not null references courier_profiles(user_id) on delete cascade,
  kind        text not null,
  result      jsonb not null default '{}'::jsonb,
  performed_at timestamptz not null default now()
);

create index on courier_actions (courier_id, performed_at desc);

comment on table courier_actions is
  'Spec 18: the courier app works offline and replays its queue. The action id '
  'comes from the app, so a replay is recognised and not performed twice.';

-- -----------------------------------------------------------------------------
-- Parameters this migration introduces
-- -----------------------------------------------------------------------------

insert into app_settings (key, value, value_type, category, description, required_for_launch) values
('training.pass_ratio', '0.8', 'decimal', 'labour',
 'Part de bonnes réponses exigée au quiz obligatoire (§7.2)', false),
('courier.shift_cancel_notice_h', '12', 'int', 'labour',
 'Préavis en heures pour annuler un créneau réservé sans justification', false),
('courier.help_contact', 'null', 'text', 'labour',
 'Contact direct de l''équipe pour le bouton d''aide du palettier (§7.9)', true);
