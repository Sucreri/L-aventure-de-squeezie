-- =============================================================================
-- 0010_payments_receipts.sql
-- Payments, refunds, till receipts, expense cards, invoices and reconciliation.
--
-- Spec 4.5: an approved PSP with SCA, NO card data stored here (tokenised at
-- the provider), idempotent webhooks, automatic reconciliation
-- till receipt <-> card spend <-> captured amount, alert on gap, compliant
-- invoices with continuous numbering, traceable refunds, never cash.
--
-- Spec 10: the gap rules between the indicative price and the till receipt.
-- =============================================================================

create table payments (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id),
  provider    text not null check (provider in ('mollie','stripe')),
  provider_ref text not null,
  method      text not null check (method in ('bancontact','card','apple_pay','google_pay')),
  status      payment_status not null default 'pending',

  amount_authorized_cents integer check (amount_authorized_cents >= 0),
  amount_captured_cents   integer check (amount_captured_cents >= 0),

  -- Spec 4.5: strong customer authentication is mandatory.
  sca_completed boolean not null default false,

  -- Spec 4.5: webhooks must be idempotent. This key is the guarantee.
  idempotency_key text not null unique,

  created_at   timestamptz not null default now(),
  authorized_at timestamptz,
  captured_at  timestamptz,
  failed_reason text,

  unique (provider, provider_ref),
  -- A captured payment must have gone through SCA.
  constraint chk_capture_requires_sca check (
    status <> 'captured' or sca_completed
  )
);

comment on table payments is
  'No PAN, no expiry date, no CVC: card data is tokenised at the provider '
  '(spec 4.5). This table deliberately has no column able to hold them.';

create index on payments (order_id);

create table refunds (
  id          uuid primary key default gen_random_uuid(),
  payment_id  uuid not null references payments(id),
  amount_cents integer not null check (amount_cents > 0),
  -- Spec 4.5: traceable refunds — reason, author, amount. Never cash.
  reason      text not null,
  issued_by   uuid references users(id),
  provider_ref text,
  status      text not null default 'pending'
              check (status in ('pending','done','failed')),
  created_at  timestamptz not null default now(),
  constraint chk_reason_not_empty check (length(btrim(reason)) > 0)
);

comment on table refunds is
  'Spec 4.5: every refund carries a reason and an author. There is no cash '
  'path: a refund always goes back through the payment provider.';

-- -----------------------------------------------------------------------------
-- Till receipts and expense cards
-- -----------------------------------------------------------------------------

create table receipts (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null references orders(id) on delete cascade,
  mission_id  uuid references missions(id),
  -- Path in Supabase Storage, never the image bytes in the database.
  photo_path  text not null,
  -- Spec 7.6: automatic amount reading, with manual correction possible.
  amount_read_cents      integer check (amount_read_cents >= 0),
  amount_validated_cents integer not null check (amount_validated_cents >= 0),
  validated_by uuid references users(id),
  created_at  timestamptz not null default now()
);

create index on receipts (order_id);

create table spend_cards (
  id          uuid primary key default gen_random_uuid(),
  courier_id  uuid not null references courier_profiles(user_id),
  provider_ref text not null unique,
  ceiling_cents integer not null check (ceiling_cents > 0),
  active      boolean not null default true,
  issued_at   timestamptz not null default now()
);

comment on table spend_cards is
  'Spec 2: purchases are made with the operator''s corporate cards, capped per '
  'mission. A courier never advances their own money.';

create table spend_card_transactions (
  id          uuid primary key default gen_random_uuid(),
  spend_card_id uuid not null references spend_cards(id),
  mission_id  uuid references missions(id),
  order_id    uuid references orders(id),
  amount_cents integer not null check (amount_cents > 0),
  provider_ref text not null unique,
  occurred_at timestamptz not null default now()
);

-- Spec 2 and H-09: a card spend above the per-mission ceiling is refused.
create or replace function app.guard_spend_ceiling()
returns trigger
language plpgsql
as $$
declare
  ceiling_cents integer;
  spent integer;
begin
  select c.ceiling_cents into ceiling_cents from spend_cards c where c.id = new.spend_card_id;

  select coalesce(sum(t.amount_cents), 0) into spent
    from spend_card_transactions t
   where t.mission_id is not distinct from new.mission_id
     and t.spend_card_id = new.spend_card_id;

  if spent + new.amount_cents > ceiling_cents then
    raise exception 'spend card ceiling exceeded for this mission (% + % > %)',
      spent, new.amount_cents, ceiling_cents
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_spend_ceiling
  before insert on spend_card_transactions
  for each row execute function app.guard_spend_ceiling();

-- -----------------------------------------------------------------------------
-- Spec 10: gap between the indicative price and the till receipt
-- -----------------------------------------------------------------------------

create or replace function app.ticket_gap_decision(
  p_order uuid,
  p_items_actual_cents integer
) returns table (
  gap_cents                integer,
  operator_absorbs_cents   integer,
  extra_capture_cents      integer,
  refund_cents             integer,
  requires_client_approval boolean,
  explanation              text
)
language plpgsql
stable
as $$
declare
  o record;
  absorb_limit integer := app.setting_int('pricing.operator_absorbs_gap_cents');
  gap integer;
  absorbed integer;
  remainder integer;
begin
  select * into o from orders where id = p_order;
  if not found then raise exception 'unknown order %', p_order; end if;

  gap := p_items_actual_cents - o.items_estimated_cents;

  if gap <= 0 then
    -- Spec 10: the client is never charged more than the till receipt.
    -- On card the capture is simply lower; on Bancontact the difference is
    -- refunded automatically.
    return query select
      gap, 0, 0, abs(gap), false,
      case when gap = 0
           then 'Le ticket correspond à l''estimation.'
           else 'Le ticket est inférieur à l''estimation : la différence est remboursée automatiquement.'
      end::text;
    return;
  end if;

  absorbed  := least(gap, absorb_limit);
  remainder := gap - absorbed;

  return query select
    gap,
    absorbed,
    remainder,
    0,
    remainder > 0,
    case when remainder > 0
         then format('Le ticket dépasse l''estimation de %s centimes. L''Opérateur en absorbe %s ; '
                   || 'le palettier doit obtenir l''accord du client dans l''app avant de payer le solde de %s.',
                     gap, absorbed, remainder)
         else format('Le ticket dépasse l''estimation de %s centimes, intégralement absorbés par l''Opérateur.', gap)
    end::text;
end;
$$;

comment on function app.ticket_gap_decision is
  'Spec 10. The operator absorbs up to pricing.operator_absorbs_gap_cents. '
  'Beyond that, the courier must get the client''s in-app approval (with SCA '
  'for the extra debit) before paying.';

-- -----------------------------------------------------------------------------
-- Invoices: gapless, continuous numbering (spec 4.5)
-- -----------------------------------------------------------------------------

-- A sequence would leave gaps on rollback, which Belgian invoicing rules do
-- not accept. A counter row locked inside the transaction gives gapless numbers.
create table invoice_counters (
  year        integer primary key,
  last_number integer not null default 0
);

create table invoices (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references orders(id),
  number      text not null unique,
  issued_at   timestamptz not null default now(),

  -- Operator identity is frozen on the invoice: it must stay readable years
  -- later even if the parameter changes (spec 4.5).
  operator_legal_name text not null,
  operator_vat_number text not null,
  operator_address    text not null,

  items_cents    integer not null check (items_cents >= 0),
  delivery_cents integer not null check (delivery_cents >= 0),
  service_cents  integer not null check (service_cents >= 0),
  tip_cents      integer not null default 0 check (tip_cents >= 0),
  total_cents    integer not null check (total_cents >= 0),
  -- VAT treatment of the re-invoiced goods is pending the accountant (Q-03).
  vat_detail     jsonb not null default '{}'::jsonb,

  pdf_path    text,
  constraint chk_invoice_total check (
    total_cents = items_cents + delivery_cents + service_cents + tip_cents
  )
);

create or replace function app.next_invoice_number()
returns text
language plpgsql
as $$
declare
  y integer := extract(year from now())::integer;
  n integer;
begin
  insert into invoice_counters (year, last_number) values (y, 0)
    on conflict (year) do nothing;

  update invoice_counters
     set last_number = last_number + 1
   where year = y
  returning last_number into n;

  return format('%s-%s', y, lpad(n::text, 6, '0'));
end;
$$;

comment on function app.next_invoice_number is
  'Gapless continuous numbering (spec 4.5). The counter row is locked by the '
  'UPDATE, so concurrent invoices serialise instead of leaving holes.';

-- -----------------------------------------------------------------------------
-- Reconciliation (spec 4.5)
-- -----------------------------------------------------------------------------

create or replace view payment_reconciliation as
  select o.id as order_id,
         o.reference,
         o.status,
         o.total_estimated_cents,
         o.total_charged_cents,
         r.amount_validated_cents       as till_receipt_cents,
         sct.card_spent_cents,
         p.amount_captured_cents        as captured_cents,
         coalesce(o.refunded_cents, 0)  as refunded_cents,
         -- A non-zero value here is what raises the alert.
         coalesce(r.amount_validated_cents, 0) - coalesce(sct.card_spent_cents, 0)
           as receipt_vs_card_gap_cents,
         coalesce(p.amount_captured_cents, 0)
           - coalesce(o.refunded_cents, 0)
           - coalesce(o.total_charged_cents, 0)
           as captured_vs_charged_gap_cents
    from orders o
    left join lateral (
      select amount_validated_cents from receipts
       where order_id = o.id order by created_at desc limit 1
    ) r on true
    left join lateral (
      select sum(amount_cents) as card_spent_cents
        from spend_card_transactions where order_id = o.id
    ) sct on true
    left join lateral (
      select amount_captured_cents from payments
       where order_id = o.id and status = 'captured'
       order by captured_at desc limit 1
    ) p on true;

comment on view payment_reconciliation is
  'Spec 4.5: automatic reconciliation till receipt <-> card spend <-> captured '
  'amount. Any non-zero gap column feeds the admin alert.';

-- -----------------------------------------------------------------------------
-- Payroll exports (spec 11)
-- -----------------------------------------------------------------------------

create table payroll_exports (
  id            uuid primary key default gen_random_uuid(),
  period_start  date not null,
  period_end    date not null,
  file_path     text,
  status        text not null default 'pending'
                check (status in ('pending','generated','sent','acknowledged','failed')),
  generated_at  timestamptz,
  generated_by  uuid references users(id),
  courier_count integer,
  total_hours   numeric(8,2),
  total_bonus_cents integer,
  total_tips_cents  integer,
  constraint chk_period check (period_end >= period_start)
);

comment on table payroll_exports is
  'Spec 11: the admin periodically exports hours, bonuses and tips to the '
  'social secretariat, which produces the official payslip.';
