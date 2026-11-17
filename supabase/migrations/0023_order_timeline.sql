-- =============================================================================
-- 0023_order_timeline.sql
-- A client-facing status timeline, instead of the audit journal.
--
-- The tracking screen needs to show "payée 19:04, palettier trouvé 19:06,
-- au magasin 19:12". The obvious implementation — selecting from
-- audit.order_events — is wrong twice over:
--
--   1. a client has no access to the audit schema, and should not: the
--      journal carries actor identities and internal reasons;
--   2. granting that access to make a tracking screen work would trade a
--      real confidentiality boundary for a convenience.
--
-- So this function returns only what the client legitimately sees: the status
-- and when it happened. No actor, no internal reason, no metadata.
--
-- Note the explicit ownership test. The function is SECURITY DEFINER, and
-- `orders` has FORCE ROW LEVEL SECURITY, so the owner is subject to the
-- policies too and matches none of them (they are granted to `authenticated`).
-- Relying on RLS inside a definer function would therefore return nothing at
-- all. The check below mirrors the orders_client policy deliberately, and must
-- be kept in step with it.
-- =============================================================================

create or replace function app.order_timeline(p_order uuid)
returns table (status order_status, occurred_at timestamptz)
language plpgsql
stable
security definer
set search_path = public, app, audit
as $$
declare
  caller uuid := app.current_user_id();
  o record;
begin
  select client_id into o from orders where id = p_order;
  if not found then
    raise exception 'unknown order %', p_order using errcode = 'no_data_found';
  end if;

  if caller is not null
     and o.client_id <> caller
     and not app.is_assigned_courier(p_order)
     and not app.is_staff() then
    -- Indistinguishable from "does not exist", on purpose.
    raise exception 'unknown order %', p_order using errcode = 'no_data_found';
  end if;

  return query
    select e.to_status, e.occurred_at
      from audit.order_events e
     where e.order_id = p_order
     order by e.occurred_at;
end;
$$;

comment on function app.order_timeline is
  'Client-facing status history: status and timestamp only. The audit journal '
  'itself stays closed — it carries actor identities and internal reasons.';

grant execute on function app.order_timeline(uuid) to authenticated;
