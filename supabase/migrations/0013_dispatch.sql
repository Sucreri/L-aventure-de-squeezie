-- =============================================================================
-- 0013_dispatch.sql
-- Mission allocation (spec 15).
--
--   Score = 0.6 × speed to store + 0.2 × capacity fit + 0.2 × grouping
--   Each criterion is normalised to [0, 1]. On a tie, the courier who has done
--   the fewest missions in the shift wins.
--
-- Spec 15 also requires the allocation logic to be DOCUMENTED AND READABLE BY
-- COURIERS. app.dispatch_explanation() returns exactly that, from the same
-- parameters the scoring uses, so the explanation can never drift from the code.
-- =============================================================================

-- Capacity already committed by a courier's in-flight missions.
create or replace function app.courier_committed_units(p_courier uuid)
returns numeric
language sql
stable
as $$
  select coalesce(sum(i.quantity * p.capacity_units), 0)
    from missions m
    join mission_orders mo on mo.mission_id = m.id
    join order_items i on i.order_id = mo.order_id
    join products p on p.id = i.product_id
   where m.courier_id = p_courier
     and m.status in ('assigned','at_store','purchased','en_route');
$$;

create or replace function app.order_units(p_order uuid)
returns numeric
language sql
stable
as $$
  select coalesce(sum(i.quantity * p.capacity_units), 0)
    from order_items i join products p on p.id = i.product_id
   where i.order_id = p_order;
$$;

-- Candidates and their score for a given order.
create or replace function app.dispatch_candidates(p_order uuid)
returns table (
  courier_id      uuid,
  distance_m      double precision,
  remaining_units numeric,
  score           numeric,
  missions_in_shift integer
)
language plpgsql
stable
as $$
declare
  o            record;
  st           record;
  max_dist     integer := app.setting_int('dispatch.max_distance_to_store_m');
  w_speed      double precision := app.setting_num('dispatch.weight_speed');
  w_capacity   double precision := app.setting_num('dispatch.weight_capacity');
  w_grouping   double precision := app.setting_num('dispatch.weight_grouping');
  group_dist   integer := app.setting_int('dispatch.grouping_max_distance_m');
  needed       numeric;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown order %', p_order; end if;

  select * into st from stores where id = o.store_id;
  needed := app.order_units(p_order);

  return query
  with active_couriers as (
    select cp.user_id,
           cp.capacity_units,
           b.id as booking_id,
           -- Latest known position, which only exists during a booked shift.
           (select pos.lat from courier_positions pos
             where pos.courier_id = cp.user_id
             order by pos.recorded_at desc limit 1) as lat,
           (select pos.lon from courier_positions pos
             where pos.courier_id = cp.user_id
             order by pos.recorded_at desc limit 1) as lon
      from courier_profiles cp
      join shift_bookings b on b.courier_id = cp.user_id and b.cancelled_at is null
      join shifts s on s.id = b.shift_id
     where cp.status = 'active'
       and cp.contract_signed
       and cp.dimona_confirmed
       and s.zone_id = o.zone_id
       and now() between s.starts_at and s.ends_at
  ),
  scored as (
    select ac.user_id,
           app.haversine_m(ac.lat, ac.lon, st.lat, st.lon) as dist,
           ac.capacity_units - app.courier_committed_units(ac.user_id) as remaining,
           ac.booking_id,
           -- Grouping: is there already an in-flight mission from the same
           -- store whose destination is close to this one? (spec 15)
           exists (
             select 1
               from missions m
               join mission_orders mo on mo.mission_id = m.id
               join orders o2 on o2.id = mo.order_id
               join addresses a2 on a2.id = o2.address_id
               join addresses a1 on a1.id = o.address_id
              where m.courier_id = ac.user_id
                and m.status in ('assigned','at_store')
                and m.store_id = o.store_id
                and app.haversine_m(a1.lat, a1.lon, a2.lat, a2.lon) <= group_dist
           ) as can_group
      from active_couriers ac
     where ac.lat is not null
  )
  select s2.user_id,
         s2.dist,
         s2.remaining,
         round((
             w_speed    * greatest(0.0, 1.0 - (s2.dist / max_dist::double precision))
           + w_capacity * least(1.0, case when needed = 0 then 1.0
                                          else (s2.remaining / needed)::double precision end)
           + w_grouping * (case when s2.can_group then 1.0 else 0.0 end)
         )::numeric, 4) as score,
         (select count(*)::integer from missions m
           where m.courier_id = s2.user_id
             and m.shift_booking_id = s2.booking_id) as missions_in_shift
    from scored s2
   where s2.dist <= max_dist
     and s2.remaining >= needed          -- enough capacity left (spec 15)
   order by score desc, missions_in_shift asc;   -- tie-break (spec 15)
end;
$$;

comment on function app.dispatch_candidates is
  'Spec 15: candidates are couriers on an active shift, with enough remaining '
  'capacity, within dispatch.max_distance_to_store_m of the store. Ordering is '
  'score desc then fewest missions in the shift.';

-- Spec 15: the courier-facing explanation, generated from the same parameters.
create or replace function app.dispatch_explanation()
returns text
language sql
stable
as $$
  select format(
$fmt$Comment les missions sont attribuées

Pour être candidat à une mission, il faut : être en créneau réservé dans le
quartier concerné, avoir un contrat signé et une Dimona confirmée, disposer
d'assez de capacité restante, et se trouver à moins de %s mètres du magasin.

Parmi les candidats, un score est calculé entre 0 et 1 :
  · %s de la note vient de votre rapidité d'arrivée au magasin ;
  · %s vient de l'adéquation entre votre capacité restante et la commande ;
  · %s vient de la possibilité de regrouper avec une mission que vous avez déjà.

L'offre part au meilleur score pendant %s secondes, puis au suivant. Après
%s refus, elle est proposée à tous les candidats. À score égal, la priorité va
au palettier qui a fait le moins de missions sur le créneau.

Refuser une mission n'entraîne aucune sanction automatique. Aucune décision qui
vous concerne (fin de contrat, retrait de créneaux) n'est prise par le système :
elle est toujours prise par une personne, motivée, et vous pouvez demander une
explication et la contester.$fmt$,
    app.setting_int('dispatch.max_distance_to_store_m'),
    to_char(app.setting_num('dispatch.weight_speed')    * 100, 'FM999') || ' %',
    to_char(app.setting_num('dispatch.weight_capacity') * 100, 'FM999') || ' %',
    to_char(app.setting_num('dispatch.weight_grouping') * 100, 'FM999') || ' %',
    app.setting_int('dispatch.offer_timeout_s'),
    app.setting_int('dispatch.broadcast_after_declines'));
$$;

comment on function app.dispatch_explanation is
  'Spec 15 and 4.3 (EU directive 2024/2831): couriers have a right to a written '
  'explanation of the automated allocation system. Generated from the live '
  'parameters so it cannot drift from the actual behaviour.';
