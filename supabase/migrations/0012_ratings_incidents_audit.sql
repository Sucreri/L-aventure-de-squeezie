-- =============================================================================
-- 0012_ratings_incidents_audit.sql
-- Ratings, incidents, in-order chat, client blocks and the admin audit journal.
--
-- Spec 16 and 4.6: only a client whose order was DELIVERED may rate. Ratings
-- are NEVER edited or filtered to flatter the service — enforced by an
-- append-only trigger, not by a policy document.
--
-- Spec 15 and 16: no decision affecting a courier is automatic. A block is a
-- reasoned human decision that can be contested.
-- =============================================================================

create table ratings (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid not null unique references orders(id) on delete cascade,
  client_id   uuid not null references users(id),
  courier_id  uuid references courier_profiles(user_id),
  score       integer not null check (score between 1 and 5),
  labels      text[] not null default '{}',
  comment     text,
  created_at  timestamptz not null default now()
);

create index on ratings (courier_id, created_at desc);

-- Spec 16: "Seul un client dont la commande a été livrée peut noter."
create or replace function app.guard_rating()
returns trigger
language plpgsql
as $$
declare
  o record;
begin
  select * into o from orders where id = new.order_id;

  if not found then
    raise exception 'unknown order %', new.order_id;
  end if;

  if o.status <> 'DELIVERED' then
    raise exception 'only a delivered order can be rated (status is %)', o.status
      using errcode = 'check_violation', hint = 'Spec 16 and 4.6: authentic reviews only.';
  end if;

  if o.client_id <> new.client_id then
    raise exception 'only the client of this order may rate it'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$$;

create trigger trg_rating before insert on ratings
  for each row execute function app.guard_rating();

-- Spec 16: ratings are never modified or filtered.
create or replace function app.ratings_are_immutable()
returns trigger language plpgsql as $$
begin
  raise exception 'ratings are never modified or deleted (%)', tg_op
    using errcode = 'restrict_violation',
          hint = 'Spec 16: reviews are not curated to flatter the service.';
end;
$$;

create trigger trg_ratings_immutable
  before update or delete on ratings
  for each row execute function app.ratings_are_immutable();

-- -----------------------------------------------------------------------------
-- Incidents (spec 6.11, 7.7)
-- -----------------------------------------------------------------------------

create table incidents (
  id          uuid primary key default gen_random_uuid(),
  order_id    uuid references orders(id) on delete set null,
  reported_by uuid references users(id),
  reporter_role text not null check (reporter_role in ('client','courier','ops')),
  kind        text not null check (kind in
              ('missing_item','damaged_item','wrong_item','late','behaviour','safety','payment','other')),
  description text not null,
  photo_path  text,
  status      text not null default 'open'
              check (status in ('open','investigating','resolved','rejected')),
  resolution  text,
  resolved_by uuid references users(id),
  resolved_at timestamptz,
  created_at  timestamptz not null default now(),
  constraint chk_resolution_has_human check (
    status not in ('resolved','rejected')
    or (resolved_by is not null and resolved_at is not null and resolution is not null)
  )
);

comment on constraint chk_resolution_has_human on incidents is
  'Spec 15: no decision that affects a person is taken automatically. Closing '
  'an incident requires a named human and a reason.';

-- -----------------------------------------------------------------------------
-- Client blocks: a reasoned, contestable human decision (spec 16)
-- -----------------------------------------------------------------------------

create table client_blocks (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  reason      text not null,
  -- NOT NULL: there is no automatic blocking path.
  decided_by  uuid not null references users(id),
  decided_at  timestamptz not null default now(),
  appeal_status text not null default 'none'
                check (appeal_status in ('none','requested','upheld','overturned')),
  appeal_note text,
  lifted_at   timestamptz,
  constraint chk_reason_not_empty check (length(btrim(reason)) > 0)
);

comment on table client_blocks is
  'Spec 16: blocking a client is a human decision, reasoned and contestable '
  'through support. decided_by is NOT NULL on purpose.';

-- -----------------------------------------------------------------------------
-- In-order chat (spec 6.9), retained 6 months (spec 4.7)
-- -----------------------------------------------------------------------------

create table chat_messages (
  id          bigserial primary key,
  order_id    uuid not null references orders(id) on delete cascade,
  sender_id   uuid not null references users(id),
  body        text not null,
  created_at  timestamptz not null default now()
);

create index on chat_messages (order_id, created_at);
create index on chat_messages (created_at);

-- -----------------------------------------------------------------------------
-- Admin audit journal (spec 4.8)
-- -----------------------------------------------------------------------------

create table audit.admin_actions (
  id          bigserial primary key,
  actor_id    uuid,
  actor_role  text,
  action      text not null,
  entity      text not null,
  entity_id   text,
  before_state jsonb,
  after_state  jsonb,
  reason      text,
  occurred_at timestamptz not null default now()
);

create index on audit.admin_actions (entity, entity_id, occurred_at desc);
create index on audit.admin_actions (actor_id, occurred_at desc);

comment on table audit.admin_actions is
  'Spec 4.8: every admin action and every age check is journalled. '
  'Append-only; backups are encrypted.';

create or replace function app.audit_journal_is_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'the audit journal is append-only (%)', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger trg_admin_actions_append_only
  before update or delete on audit.admin_actions
  for each row execute function app.audit_journal_is_append_only();

create trigger trg_order_events_append_only
  before update or delete on audit.order_events
  for each row execute function app.audit_journal_is_append_only();
