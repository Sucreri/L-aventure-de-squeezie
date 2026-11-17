-- =============================================================================
-- 0020_register_payment.sql
-- Controlled creation of a payment record.
--
-- A client must never be able to write a row in `payments`: that table is the
-- system's account of what a provider said, not a claim a client gets to make.
-- RLS therefore grants no INSERT on it at all.
--
-- But the payment record IS created during checkout, in the same transaction
-- as the order, under the client's own role. The way out is not to widen the
-- policy: it is a controlled accessor that checks what matters —
--   * the order exists and belongs to the caller;
--   * it is still awaiting payment;
--   * the amount is not below the total the client was shown;
--   * the same idempotency key is never used twice.
-- =============================================================================

create or replace function app.register_payment(
  p_order           uuid,
  p_provider        text,
  p_provider_ref    text,
  p_method          text,
  p_amount_cents    integer,
  p_idempotency_key text
) returns payments
language plpgsql
security definer
set search_path = public, app
as $$
declare
  o record;
  caller uuid := app.current_user_id();
  existing payments;
  inserted payments;
begin
  -- Idempotence: replaying checkout returns the payment already created
  -- rather than opening a second one against the same order.
  select * into existing from payments where idempotency_key = p_idempotency_key;
  if found then
    if existing.order_id <> p_order then
      raise exception 'cette clé d''idempotence appartient à une autre commande'
        using errcode = 'check_violation';
    end if;
    return existing;
  end if;

  select * into o from orders where id = p_order;
  if not found then
    raise exception 'commande inconnue' using errcode = 'no_data_found';
  end if;

  -- The caller must own the order. A null caller means a trusted server-side
  -- context (the API's service role), which is allowed.
  if caller is not null and o.client_id <> caller and not app.is_staff() then
    raise exception 'cette commande ne vous appartient pas'
      using errcode = 'insufficient_privilege';
  end if;

  if o.status <> 'CREATED' then
    raise exception 'cette commande n''est plus en attente de paiement (statut %)', o.status
      using errcode = 'check_violation';
  end if;

  -- Guards against a client trying to authorise less than they were quoted.
  if p_amount_cents < o.total_estimated_cents then
    raise exception 'le montant autorisé (%) est inférieur au total annoncé (%)',
      p_amount_cents, o.total_estimated_cents
      using errcode = 'check_violation';
  end if;

  insert into payments (order_id, provider, provider_ref, method, status,
                        amount_authorized_cents, idempotency_key)
  values (p_order, p_provider, p_provider_ref, p_method, 'pending',
          p_amount_cents, p_idempotency_key)
  returning * into inserted;

  return inserted;
end;
$$;

comment on function app.register_payment is
  'The only way to create a payment row. RLS grants no INSERT on payments, '
  'because what a provider said is not something a client may assert.';

grant execute on function app.register_payment(uuid, text, text, text, integer, text)
  to authenticated;
