-- =============================================================================
-- 0030_age_check_precondition.sql
-- An age check only happens at the door.
--
-- app.record_age_check accepted a check at any point in an order's life. A
-- refusal then tried to move the order to DELIVERY_FAILED, which the
-- transition matrix rejects from most states — so the courier got an opaque
-- "forbidden order transition" instead of being told the real problem.
--
-- The check belongs to the handover: the courier is standing in front of the
-- person. The states where that is true are ARRIVED and HELD_AT_HUB (a pickup
-- at the operator's premises, which spec 12 also puts behind an ID check).
-- =============================================================================

create or replace function app.record_age_check(
  p_order uuid,
  p_courier uuid,
  p_result age_check_result,
  p_reason age_refusal_reason default null,
  p_document_checked boolean default false,
  p_sober boolean default false
) returns uuid
language plpgsql
security definer
set search_path = public, app
as $$
declare
  new_id uuid;
  order_status_now order_status;
begin
  select status into order_status_now from orders where id = p_order;

  if not found then
    raise exception 'unknown order %', p_order using errcode = 'no_data_found';
  end if;

  if order_status_now not in ('ARRIVED', 'HELD_AT_HUB') then
    raise exception 'an age check happens at the handover, not in state %', order_status_now
      using errcode = 'check_violation',
            hint = 'Spec 13.2: the courier checks the document of the person receiving.';
  end if;

  insert into age_checks (order_id, courier_id, result, refusal_reason,
                          document_checked, person_appears_sober)
  values (p_order, p_courier, p_result, p_reason, p_document_checked, p_sober)
  returning id into new_id;

  if p_result = 'ok' then
    update orders set age_check_id = new_id where id = p_order;
  else
    -- Spec 13.3: a refusal sends the order to DELIVERY_FAILED. Spec 13.5: the
    -- courier incurs no penalty for refusing.
    perform app.set_actor(p_courier, 'courier', 'age check refused: ' || p_reason::text);
    update orders set status = 'DELIVERY_FAILED' where id = p_order;
  end if;

  return new_id;
end;
$$;

comment on function app.record_age_check is
  'Spec 13.2. Only valid at the handover (ARRIVED, or HELD_AT_HUB for a '
  'pickup). Records the outcome, the reason, the time and the courier — never '
  'the year read, never a photograph.';
