-- =============================================================================
-- 0007_group_orders.sql
-- Group orders from a kot (spec 6.12), also used as the main viral channel.
--
-- Two rules carry legal weight and are enforced here:
--   * every participant must hold a VERIFIED account (no guest checkout), so
--     the viral channel cannot become an age-verification bypass;
--   * an alcoholic line can only be attributed to, and paid by, a participant
--     who meets the age requirement — already enforced by the order-item guard
--     in 0006 through order_items.participant_id.
-- =============================================================================

create table group_orders (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references orders(id) on delete cascade,
  host_id     uuid not null references users(id),
  -- Random, unguessable, and short-lived: the link is the access control.
  share_token text not null unique default encode(gen_random_bytes(16), 'hex'),
  split_mode  text not null default 'per_item' check (split_mode in ('equal','per_item')),
  expires_at  timestamptz not null,
  closed_at   timestamptz,
  created_at  timestamptz not null default now(),
  constraint chk_expiry_in_future check (expires_at > created_at)
);

comment on column group_orders.share_token is
  'Shared as a link or QR code (spec 6.12). Expires with the group order, so a '
  'leaked link stops working after group_order_expiry_s.';

create table group_participants (
  id             uuid primary key default gen_random_uuid(),
  group_order_id uuid not null references group_orders(id) on delete cascade,
  user_id        uuid not null references users(id),
  share_cents    integer not null default 0 check (share_cents >= 0),
  paid           boolean not null default false,
  paid_at        timestamptz,
  joined_at      timestamptz not null default now(),
  unique (group_order_id, user_id),
  constraint chk_paid_has_timestamp check (paid = (paid_at is not null))
);

-- Spec 6.12 and 8.6: a participant without an account goes through full
-- registration, age verification included. No guest path.
create or replace function app.guard_group_participant()
returns trigger
language plpgsql
as $$
declare
  u record;
  g record;
begin
  select status, age_verified, age_bracket, deleted_at
    into u from users where id = new.user_id;

  if not found or u.deleted_at is not null or u.status <> 'active' then
    raise exception 'participant % has no active account', new.user_id
      using errcode = 'check_violation';
  end if;

  if not u.age_verified or u.age_bracket = 'under_16' then
    raise exception 'participant % must hold a verified account', new.user_id
      using errcode = 'check_violation',
            hint = 'Spec 8.6: a group order is never an age-verification bypass.';
  end if;

  select * into g from group_orders where id = new.group_order_id;
  if g.closed_at is not null or g.expires_at <= now() then
    raise exception 'this group order is closed or expired'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_group_participant
  before insert on group_participants
  for each row execute function app.guard_group_participant();

-- A participant of a group order must actually be a participant of THAT order.
create or replace function app.guard_item_participant_membership()
returns trigger
language plpgsql
as $$
declare
  gid uuid;
begin
  if new.participant_id is null then
    return new;
  end if;

  select g.id into gid
    from group_orders g where g.order_id = new.order_id;

  if gid is null then
    raise exception 'order % is not a group order, participant_id is not allowed', new.order_id
      using errcode = 'check_violation';
  end if;

  if not exists (select 1 from group_participants p
                  where p.group_order_id = gid and p.user_id = new.participant_id) then
    raise exception 'user % does not take part in this group order', new.participant_id
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_item_participant_membership
  before insert or update of participant_id on order_items
  for each row execute function app.guard_item_participant_membership();
