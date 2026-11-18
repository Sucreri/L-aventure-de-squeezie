-- =============================================================================
-- 0032_advance_mission_idempotent.sql
-- app.advance_mission tolerates being asked for the status it already has.
--
-- Mission status is already kept in step with order status by the trigger
-- added in 0018: moving an order to AT_STORE moves its mission to 'at_store'.
-- A caller that also asked for the move explicitly was then refused for
-- "cannot go from at_store to at_store" — a transition that is not wrong, it
-- has simply already happened.
--
-- The trigger stays the single source of truth for the forward steps; this
-- function remains for 'abandoned', and now returns quietly when there is
-- nothing to do. That also makes it safe to replay from the offline queue.
-- =============================================================================

create or replace function app.advance_mission(p_mission uuid, p_status text)
returns missions
language plpgsql
security definer
set search_path = public, app
as $$
declare
  caller uuid := app.current_user_id();
  mission missions;
  allowed text[];
begin
  select * into mission from missions where id = p_mission for update;

  if not found or (caller is not null and mission.courier_id <> caller and not app.is_staff()) then
    raise exception 'mission not found' using errcode = 'no_data_found';
  end if;

  -- Already there: nothing to do, and nothing wrong.
  if mission.status = p_status then
    return mission;
  end if;

  allowed := case mission.status
               when 'pending'   then array['assigned', 'abandoned']
               when 'assigned'  then array['at_store', 'abandoned']
               when 'at_store'  then array['purchased', 'abandoned']
               when 'purchased' then array['en_route', 'abandoned']
               when 'en_route'  then array['done', 'abandoned']
               else array[]::text[]
             end;

  if not (p_status = any(allowed)) then
    raise exception 'mission cannot go from % to %', mission.status, p_status
      using errcode = 'check_violation';
  end if;

  update missions
     set status = p_status,
         completed_at = case when p_status in ('done', 'abandoned')
                             then coalesce(completed_at, now()) else completed_at end
   where id = p_mission
  returning * into mission;

  return mission;
end;
$$;

comment on function app.advance_mission is
  'Spec 7.6. Idempotent: the trigger from 0018 may already have moved the '
  'mission when its order moved. Kept for abandonment and for replays.';
