-- =============================================================================
-- 0018_mission_status_follows_order.sql
-- Keeps a mission's status in step with the orders it carries.
--
-- Why this is a database trigger and not application code: a courier's
-- remaining capacity is computed from missions still in flight
-- (app.courier_committed_units). If a mission never leaves that set, the
-- courier's capacity is consumed for good and they quietly stop being offered
-- work. Relying on every caller to remember to close the mission would make
-- that failure a matter of discipline; here it cannot be forgotten.
--
-- A mission may carry up to two grouped orders (spec 15), so it only closes
-- when NONE of its orders is still in flight.
-- =============================================================================

create or replace function app.sync_mission_status()
returns trigger
language plpgsql
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
    -- How many orders on this mission are still under way?
    select count(*) into still_in_flight
      from mission_orders mo2
      join orders o2 on o2.id = mo2.order_id
     where mo2.mission_id = m.id
       and o2.status not in ('DELIVERED', 'DELIVERY_FAILED', 'HELD_AT_HUB',
                             'CANCELLED_BY_CLIENT', 'CANCELLED_BY_OPS',
                             'REFUNDED_FULL', 'REFUNDED_PARTIAL', 'NO_COURIER_FOUND');

    if still_in_flight = 0 then
      update missions
         set status = 'done',
             completed_at = coalesce(completed_at, now())
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

create trigger trg_sync_mission_status
  after update of status on orders
  for each row execute function app.sync_mission_status();

comment on function app.sync_mission_status is
  'Closes a mission once none of its orders is in flight, so the courier''s '
  'capacity is released. Without it, capacity leaks and a courier silently '
  'stops receiving offers.';
