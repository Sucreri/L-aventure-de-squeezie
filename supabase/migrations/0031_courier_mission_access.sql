-- =============================================================================
-- 0031_courier_mission_access.sql
-- What an ASSIGNED courier may read and change.
--
-- Two gaps, both found by running a mission end to end.
--
-- 1. The delivery address was unreadable. `addresses_own` only opens a row to
--    its owner and to staff, so a courier could accept a mission and then not
--    be told where to take it. The address is exactly what they need, and
--    only once the mission is theirs — spec 7.5 keeps it out of the offer.
--
-- 2. The mission status could not be advanced. `missions` had a SELECT policy
--    and nothing else, so "I'm at the shop" updated zero rows and silently
--    did nothing. Rather than opening UPDATE on the table — which would also
--    let a courier reassign a mission to themselves — the transitions go
--    through a function that checks ownership and the order of the steps.
-- =============================================================================

create policy addresses_assigned_courier on addresses for select to authenticated
  using (
    exists (
      select 1
        from orders o
        join mission_orders mo on mo.order_id = o.id
        join missions m on m.id = mo.mission_id
       where o.address_id = addresses.id
         and m.courier_id = app.current_user_id()
         and m.status in ('assigned', 'at_store', 'purchased', 'en_route')
    )
  );

comment on policy addresses_assigned_courier on addresses is
  'Spec 7.5 and 7.6: the address appears once the mission is accepted, not in '
  'the offer. It closes again when the mission ends.';

/**
 * Advances a mission through its steps.
 *
 * The order of the steps is not decoration: a receipt photographed before the
 * shop was reached, or a departure before anything was bought, would leave
 * the reconciliation (spec 4.5) with nothing to match.
 */
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

  allowed := case mission.status
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
  'Spec 7.6: the guided sequence, enforced server-side. The courier holds no '
  'direct write access to missions, so they cannot reassign one to themselves.';

grant execute on function app.advance_mission(uuid, text) to authenticated;
