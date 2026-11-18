-- =============================================================================
-- 0025_courier_rls.sql
-- Row Level Security for the tables introduced in 0024.
--
-- Tables created after 0015 do not inherit its blanket "enable RLS on
-- everything" pass, so they must be covered explicitly. Forgetting one would
-- leave it readable by anyone signed in.
--
-- The quiz deserves particular care: `training_questions` holds the answer
-- key. No courier may read that table at all; they get the questions through
-- app.training_quiz(), which does not return correct_index.
-- =============================================================================

do $$
declare t text;
begin
  for t in select unnest(array[
    'public.training_questions', 'public.training_attempts',
    'public.substitution_requests', 'public.courier_actions'])
  loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Training
-- -----------------------------------------------------------------------------

-- Admins only. The answer key is in this table.
create policy training_questions_admin on training_questions for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy training_attempts_own on training_attempts for select to authenticated
  using (user_id = app.current_user_id() or app.is_staff());

/**
 * The quiz as the app receives it: questions and choices, no answer key.
 *
 * Choices are shuffled per attempt so that answering by position, or sharing
 * "it's always the third one", does not work.
 */
create or replace function app.training_quiz(p_seed integer default null)
returns table (question_id uuid, topic text, prompt text, choices jsonb)
language sql
stable
security definer
set search_path = public, app
as $$
  select q.id, q.topic, q.prompt,
         (select jsonb_agg(c order by md5(c::text || coalesce(p_seed, 0)::text))
            from jsonb_array_elements(q.choices) c)
    from training_questions q
   where q.active
   order by q.display_rank, q.id;
$$;

comment on function app.training_quiz is
  'Spec 7.2: the questions without the answer key. Grading happens in '
  'app.grade_training, on the server.';

grant execute on function app.training_quiz(integer) to authenticated;
grant execute on function app.grade_training(uuid, jsonb) to authenticated;

-- -----------------------------------------------------------------------------
-- Substitutions
-- -----------------------------------------------------------------------------

-- Visible to the client whose order it is, and to the courier on the mission.
create policy substitution_scoped on substitution_requests for select to authenticated
  using (
    courier_id = app.current_user_id()
    or app.is_staff()
    or exists (
      select 1 from order_items i
        join orders o on o.id = i.order_id
       where i.id = order_item_id and o.client_id = app.current_user_id())
  );

create policy substitution_courier_insert on substitution_requests for insert to authenticated
  with check (courier_id = app.current_user_id());

grant execute on function app.resolve_substitution(uuid, substitution_outcome) to authenticated;

-- -----------------------------------------------------------------------------
-- Offline action log
-- -----------------------------------------------------------------------------

create policy courier_actions_own on courier_actions for all to authenticated
  using (courier_id = app.current_user_id() or app.is_staff())
  with check (courier_id = app.current_user_id());

-- -----------------------------------------------------------------------------
-- Grants on the new tables
-- -----------------------------------------------------------------------------

grant select, insert, update on training_attempts, substitution_requests, courier_actions
  to authenticated;
grant select on training_questions to authenticated;   -- filtered to nothing by RLS
grant execute on function app.courier_hours(uuid, timestamptz, timestamptz) to authenticated;
grant execute on function app.courier_quota_status(uuid) to authenticated;
grant execute on function app.courier_earnings_estimate(uuid, timestamptz, timestamptz) to authenticated;

-- -----------------------------------------------------------------------------
-- Guard: a courier cannot book or work without having passed the training
-- -----------------------------------------------------------------------------

-- Spec 7.2 makes the quiz mandatory, and spec 7.3 lists contract and Dimona.
-- The booking guard already checks the latter two; this adds the training, so
-- the three prerequisites are enforced in the same place.
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

  if c.training_passed_at is null then
    raise exception 'la formation obligatoire n''a pas été validée'
      using errcode = 'check_violation', hint = 'Spec 7.2.';
  end if;

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

  -- Spec 14: the app prevents booking beyond the configured daily and weekly
  -- limits. Checking it here means no caller can route around it.
  declare
    day_hours numeric;
    week_hours numeric;
    max_day integer := app.setting_int('work.max_hours_per_day');
    max_week integer := app.setting_int('work.max_hours_per_week');
    shift_hours numeric := extract(epoch from (s.ends_at - s.starts_at)) / 3600.0;
  begin
    day_hours := app.courier_hours(new.courier_id,
                                   date_trunc('day', s.starts_at),
                                   date_trunc('day', s.starts_at) + interval '1 day');
    week_hours := app.courier_hours(new.courier_id,
                                    date_trunc('week', s.starts_at),
                                    date_trunc('week', s.starts_at) + interval '1 week');

    if day_hours + shift_hours > max_day then
      raise exception 'ce créneau dépasserait la durée maximale de % h par jour', max_day
        using errcode = 'check_violation', hint = 'Spec 14.';
    end if;

    if week_hours + shift_hours > max_week then
      raise exception 'ce créneau dépasserait la durée maximale de % h par semaine', max_week
        using errcode = 'check_violation', hint = 'Spec 14.';
    end if;
  end;

  return new;
end;
$$;

comment on function app.guard_shift_booking is
  'Spec 7.2, 7.3 and 14: training passed, contract signed, Dimona confirmed, '
  'shift not full, and daily and weekly working-time limits respected.';
