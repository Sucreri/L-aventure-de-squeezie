-- =============================================================================
-- 0029_accept_offer.sql
-- Accepting a mission offer, atomically.
--
-- Two problems with doing this as a sequence of statements from the service
-- layer.
--
-- 1. Visibility. Before acceptance the mission has no courier, so the courier
--    cannot read mission_orders under the policies — the very rows the
--    acceptance needs. Widening those policies would expose every candidate's
--    order contents to couriers who may decline.
--
-- 2. A race. After three refusals a mission is broadcast to every remaining
--    candidate (spec 15). Two of them tapping "accept" at the same time would
--    both have passed their check before either wrote, and the second would
--    quietly overwrite the first — leaving one courier walking to a shop for
--    a mission that is no longer theirs.
--
-- Locking the mission row inside one function settles both: the first
-- acceptance wins, the second is told the mission is gone.
-- =============================================================================

create or replace function app.accept_mission_offer(p_offer uuid)
-- The OUT parameters are named apart from the column names they would
-- otherwise shadow: `mission_id` as an output collides with
-- mission_offers.mission_id inside the body.
returns table (assigned_mission_id uuid, assigned_order_ids uuid[])
language plpgsql
security definer
set search_path = public, app
as $$
declare
  caller uuid := app.current_user_id();
  offer  mission_offers;
  mission missions;
  booking uuid;
  orders uuid[];
  order_id uuid;
begin
  if caller is null then
    raise exception 'authentification requise' using errcode = 'insufficient_privilege';
  end if;

  select * into offer from mission_offers where id = p_offer;

  if not found or offer.courier_id <> caller then
    -- Indistinguishable from "does not exist": whose offer it is, is not
    -- something to disclose.
    raise exception 'offer not found' using errcode = 'no_data_found';
  end if;

  if offer.status <> 'offered' then
    raise exception 'this offer is no longer open'
      using errcode = 'check_violation';
  end if;

  -- The lock is what makes two simultaneous acceptances safe.
  select * into mission from missions where id = offer.mission_id for update;

  if mission.courier_id is not null then
    update mission_offers set status = 'expired', responded_at = now() where id = p_offer;
    raise exception 'this mission has already been taken'
      using errcode = 'check_violation',
            hint = 'Spec 15: after a broadcast, the first acceptance wins.';
  end if;

  select b.id into booking
    from shift_bookings b join shifts s on s.id = b.shift_id
   where b.courier_id = caller and b.cancelled_at is null
     and now() between s.starts_at and s.ends_at
   limit 1;

  if booking is null then
    raise exception 'no active shift booking'
      using errcode = 'check_violation',
            hint = 'Spec 7.5: missions are offered during a booked shift.';
  end if;

  update mission_offers set status = 'accepted', responded_at = now() where id = p_offer;

  -- The assignment trigger re-checks contract and Dimona (spec 4.3).
  update missions
     set courier_id = caller, shift_booking_id = booking, status = 'assigned'
   where id = mission.id;

  select array_agg(mo.order_id) into orders
    from mission_orders mo where mo.mission_id = mission.id;

  perform app.set_actor(caller, 'courier', 'offre acceptée');

  foreach order_id in array coalesce(orders, '{}'::uuid[]) loop
    update orders set status = 'COURIER_ASSIGNED' where id = order_id;
  end loop;

  -- Every other courier still holding an offer for this mission learns it is
  -- gone, rather than tapping accept and getting an error.
  update mission_offers
     set status = 'expired', responded_at = now()
   where mission_id = mission.id and status = 'offered';

  return query select mission.id, coalesce(orders, '{}'::uuid[]);
end;
$$;

comment on function app.accept_mission_offer is
  'Spec 15. Locks the mission so the first acceptance wins, expires the other '
  'offers, and moves every order the mission carries to COURIER_ASSIGNED.';

grant execute on function app.accept_mission_offer(uuid) to authenticated;
