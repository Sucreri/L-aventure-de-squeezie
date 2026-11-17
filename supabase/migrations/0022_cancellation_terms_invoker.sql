-- =============================================================================
-- 0022_cancellation_terms_invoker.sql
-- Puts app.cancellation_terms back under the caller's own privileges.
--
-- Migration 0019 made it SECURITY DEFINER along with the parameter accessors,
-- because it reads cancellation.fee_share_after_purchase. That was the wrong
-- call: the function also READS AN ORDER, and visibility of an order is
-- exactly what Row Level Security is there to decide.
--
-- Worse, it did not even work: `orders` has FORCE ROW LEVEL SECURITY, so the
-- owner is subject to the policies too, and the policies are granted to the
-- `authenticated` role. Running as the owner matched no policy at all, so the
-- function saw no order and raised "unknown order" for everyone.
--
-- It only ever needed the parameter, and the parameter accessors are already
-- SECURITY DEFINER. So the function goes back to the caller's rights, and the
-- caller's RLS decides which orders exist for them.
-- =============================================================================

create or replace function app.cancellation_terms(p_order uuid)
returns table (free boolean, items_due_cents integer, fees_due_cents integer, explanation text)
language plpgsql
stable
security invoker
set search_path = public, app
as $$
declare
  o record;
  share double precision := app.setting_num('cancellation.fee_share_after_purchase');
begin
  select * into o from orders where id = p_order;
  if not found then
    raise exception 'unknown order %', p_order
      using errcode = 'no_data_found';
  end if;

  if o.status in ('WAITLISTED','CREATED','PAID','SEARCHING_COURIER',
                  'NO_COURIER_FOUND','COURIER_ASSIGNED','AT_STORE') then
    return query select true, 0, 0,
      'Annulation gratuite : les articles ne sont pas encore achetés.'::text;
  else
    return query select false,
      coalesce(o.items_actual_cents, o.items_estimated_cents),
      app.round_cents(o.delivery_fee_cents * share),
      format('Les articles ont été achetés : ils restent dus, ainsi que %s %% des frais de livraison.',
             round((share * 100)::numeric, 0))::text;
  end if;
end;
$$;

comment on function app.cancellation_terms is
  'SECURITY INVOKER on purpose: whether an order is visible is a Row Level '
  'Security decision, not this function''s. It only needs the fee-share '
  'parameter, and the parameter accessors are already SECURITY DEFINER.';
