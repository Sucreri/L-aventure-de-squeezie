-- =============================================================================
-- 0028_courier_offers.sql
-- What a courier sees about a mission they have only been OFFERED.
--
-- The problem: an offer points at a mission that has no courier yet, and the
-- policies on `missions` and `orders` only open up once a courier is assigned.
-- So an offer was invisible to the person it was addressed to.
--
-- Widening those policies would be the wrong fix. It would expose, to every
-- courier who happens to be a candidate, the client's exact address and the
-- rest of the order — for a mission they may well decline.
--
-- Spec 7.5 says precisely what an offer must carry: "le détail (articles,
-- poids, magasin, étage, distance, prime estimée)". So this function returns
-- that, and only that. No client identity, no street, no number, no
-- instructions: those appear once the mission is accepted, through the
-- ordinary policies.
-- =============================================================================

create or replace function app.courier_offers(p_courier uuid)
returns table (
  offer_id        uuid,
  mission_id      uuid,
  score           numeric,
  offered_at      timestamptz,
  store_name      text,
  store_street    text,
  store_number    text,
  order_reference text,
  item_count      integer,
  total_weight_kg numeric,
  contains_alcohol boolean,
  floor           integer,
  has_lift        boolean,
  distance_m      double precision,
  estimated_bonus_cents integer
)
language sql
stable
security definer
set search_path = public, app
as $$
  select mo.id, mo.mission_id, mo.score, mo.offered_at,
         st.name, st.street, st.number,
         o.reference,
         (select count(*)::integer from order_items i where i.order_id = o.id),
         (select coalesce(sum(i.quantity * p.weight_kg), 0)::numeric(8,2)
            from order_items i join products p on p.id = i.product_id
           where i.order_id = o.id),
         app.order_contains_alcohol(o.id),
         a.floor,
         a.has_lift,
         (select app.haversine_m(pos.lat, pos.lon, st.lat, st.lon)
            from courier_positions pos
           where pos.courier_id = p_courier
           order by pos.recorded_at desc limit 1),
         m.estimated_bonus_cents
    from mission_offers mo
    join missions m on m.id = mo.mission_id
    join stores st on st.id = m.store_id
    join mission_orders mord on mord.mission_id = m.id
    join orders o on o.id = mord.order_id
    join addresses a on a.id = o.address_id
   where mo.courier_id = p_courier
     and mo.status = 'offered'
     and m.courier_id is null
   order by mo.offered_at desc;
$$;

comment on function app.courier_offers is
  'Spec 7.5: items, weight, store, floor, distance, estimated bonus. The '
  'client''s address and identity appear only once the mission is accepted.';

grant execute on function app.courier_offers(uuid) to authenticated;

-- A courier must also be able to read the mission row once it is theirs, and
-- while it is merely offered to them — otherwise accepting cannot even look
-- the mission up.
drop policy if exists missions_own on missions;
create policy missions_own on missions for select to authenticated
  using (
    courier_id = app.current_user_id()
    or app.is_staff()
    or exists (select 1 from mission_offers mo
                where mo.mission_id = missions.id
                  and mo.courier_id = app.current_user_id())
  );

comment on policy missions_own on missions is
  'Visible to the assigned courier, to staff, and to a courier the mission '
  'has been offered to. The ORDER behind it stays closed until acceptance; '
  'what an offer reveals is decided by app.courier_offers.';
