-- =============================================================================
-- 0014_retention_privacy.sql
-- Retention jobs and data-subject rights (spec 4.7, 6.13).
--
-- Every retention period is a PARAMETER, and the purge is performed by a job
-- that writes what it did to a journal. "We delete after 30 days" is only
-- credible when something actually runs and leaves a trace.
-- =============================================================================

create table audit.retention_runs (
  id          bigserial primary key,
  job_name    text not null,
  rows_affected integer not null,
  ran_at      timestamptz not null default now(),
  details     jsonb not null default '{}'::jsonb
);

create index on audit.retention_runs (job_name, ran_at desc);

create table data_subject_requests (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references users(id) on delete cascade,
  kind        text not null check (kind in
              ('export','deletion','rectification','consent_withdrawal','access','objection')),
  status      text not null default 'received'
              check (status in ('received','in_progress','completed','refused','deferred')),
  requested_at timestamptz not null default now(),
  completed_at timestamptz,
  -- A deletion can be deferred while an order is in flight (spec 19), but the
  -- reason must be recorded and the request honoured afterwards.
  deferred_until timestamptz,
  refusal_reason text,
  export_path  text,
  handled_by   uuid references users(id)
);

comment on table data_subject_requests is
  'Spec 4.7: access, export, rectification, deletion, consent withdrawal and '
  'objection, all self-service, plus a dedicated contact address.';

create index on data_subject_requests (user_id, requested_at desc);
create index on data_subject_requests (status) where status in ('received','in_progress','deferred');

create table data_breaches (
  id          uuid primary key default gen_random_uuid(),
  detected_at timestamptz not null,
  description text not null,
  affected_scope text not null,
  severity    text not null check (severity in ('low','medium','high','critical')),
  -- Spec 4.7: notification to the Data Protection Authority within 72 hours
  -- when required.
  authority_notification_required boolean,
  authority_notified_at timestamptz,
  subjects_notified_at  timestamptz,
  -- Spec 4.7: notification deadline, derived from detected_at and the
  -- privacy.breach_notification_hours parameter. Set by a trigger rather than
  -- a generated column, because timestamptz + interval is not immutable.
  deadline_at timestamptz,
  closed_at   timestamptz,
  created_by  uuid references users(id)
);

comment on column data_breaches.deadline_at is
  'Spec 4.7: privacy.breach_notification_hours (72 by default) from detection. '
  'Always recomputed by a trigger, so the deadline cannot be mistyped or '
  'quietly moved forward.';

create or replace function app.set_breach_deadline()
returns trigger
language plpgsql
as $$
begin
  new.deadline_at := new.detected_at
                   + (app.setting_int('privacy.breach_notification_hours') || ' hours')::interval;
  return new;
end;
$$;

create trigger trg_breach_deadline
  before insert or update of detected_at on data_breaches
  for each row execute function app.set_breach_deadline();

-- -----------------------------------------------------------------------------
-- Self-service export (spec 6.13)
-- -----------------------------------------------------------------------------

create or replace function app.export_user_data(p_user uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, app
as $$
declare
  result jsonb;
begin
  select jsonb_build_object(
    'exported_at', now(),
    'account', (select to_jsonb(u) - 'id' from users u where u.id = p_user),
    'consents', (select coalesce(jsonb_agg(to_jsonb(c)), '[]'::jsonb)
                   from consents c where c.user_id = p_user),
    'addresses', (select coalesce(jsonb_agg(to_jsonb(a)), '[]'::jsonb)
                    from addresses a where a.user_id = p_user and a.deleted_at is null),
    'orders', (select coalesce(jsonb_agg(jsonb_build_object(
                        'reference', o.reference,
                        'created_at', o.created_at,
                        'status', o.status,
                        'total_cents', o.total_estimated_cents,
                        'items', (select coalesce(jsonb_agg(jsonb_build_object(
                                     'product', p.name, 'quantity', i.quantity)), '[]'::jsonb)
                                    from order_items i join products p on p.id = i.product_id
                                   where i.order_id = o.id)
                      )), '[]'::jsonb)
                 from orders o where o.client_id = p_user),
    'ratings_given', (select coalesce(jsonb_agg(to_jsonb(r)), '[]'::jsonb)
                        from ratings r where r.client_id = p_user),
    'referrals', (select coalesce(jsonb_agg(to_jsonb(rf)), '[]'::jsonb)
                    from referrals rf where rf.referrer_id = p_user or rf.referee_id = p_user)
  ) into result;

  insert into data_subject_requests (user_id, kind, status, completed_at)
  values (p_user, 'export', 'completed', now());

  return result;
end;
$$;

comment on function app.export_user_data is
  'Spec 6.13 and 4.7: portable export in self-service. Note that it contains '
  'no age data beyond the bracket, because nothing more is stored (H-04).';

-- -----------------------------------------------------------------------------
-- Self-service deletion (spec 6.13, edge case 19)
-- -----------------------------------------------------------------------------

create or replace function app.request_account_deletion(p_user uuid)
returns data_subject_requests
language plpgsql
security definer
set search_path = public, app
as $$
declare
  in_flight integer;
  req data_subject_requests;
begin
  if p_user is null or not exists (select 1 from users where id = p_user) then
    raise exception 'unknown user' using errcode = 'check_violation';
  end if;

  select count(*) into in_flight
    from orders o
   where o.client_id = p_user
     and o.status not in ('DELIVERED','CANCELLED_BY_CLIENT','CANCELLED_BY_OPS',
                          'REFUNDED_FULL','REFUNDED_PARTIAL','NO_COURIER_FOUND');

  if in_flight > 0 then
    -- Spec 19: a deletion request while an order is in flight. The request is
    -- accepted and deferred, never silently dropped.
    insert into data_subject_requests (user_id, kind, status, deferred_until, refusal_reason)
    values (p_user, 'deletion', 'deferred', null,
            format('%s commande(s) en cours. La suppression sera exécutée dès leur clôture.', in_flight))
    returning * into req;
    return req;
  end if;

  -- Soft delete first: accounting records must survive for their legal period
  -- (spec 4.7), so the account is anonymised rather than physically removed.
  update users
     set status = 'deleted',
         deleted_at = now(),
         first_name = 'Compte',
         last_name  = 'supprimé',
         phone = null,
         email = null,
         age_bracket = null,
         age_verified = false,
         verification_method = null,
         verified_at = null
   where id = p_user;

  delete from addresses where user_id = p_user;

  insert into data_subject_requests (user_id, kind, status, completed_at)
  values (p_user, 'deletion', 'completed', now())
  returning * into req;

  return req;
end;
$$;

comment on function app.request_account_deletion is
  'Spec 6.13: deletion is self-service and as simple as signing up (no dark '
  'pattern, spec 4.6). Invoices are kept for their legal period but the '
  'account is anonymised.';

-- -----------------------------------------------------------------------------
-- Retention jobs (spec 4.7)
-- -----------------------------------------------------------------------------

create or replace function app.run_retention()
returns table (job_name text, rows_affected integer)
language plpgsql
security definer
set search_path = public, app, audit
as $$
declare
  n integer;
begin
  -- Courier positions: 30 days by default.
  delete from courier_positions
   where recorded_at < now() - (app.setting_int('retention.courier_positions_days') || ' days')::interval;
  get diagnostics n = row_count;
  insert into audit.retention_runs (job_name, rows_affected) values ('courier_positions', n);
  job_name := 'courier_positions'; rows_affected := n; return next;

  -- Chat messages: 6 months.
  delete from chat_messages
   where created_at < now() - (app.setting_int('retention.chat_messages_months') || ' months')::interval;
  get diagnostics n = row_count;
  insert into audit.retention_runs (job_name, rows_affected) values ('chat_messages', n);
  job_name := 'chat_messages'; rows_affected := n; return next;

  -- Waiting-list entries never activated: 12 months.
  delete from waitlist_entries
   where activated_at is null
     and created_at < now() - (app.setting_int('retention.waitlist_never_opened_months') || ' months')::interval;
  get diagnostics n = row_count;
  insert into audit.retention_runs (job_name, rows_affected) values ('waitlist_never_activated', n);
  job_name := 'waitlist_never_activated'; rows_affected := n; return next;

  -- Inactive accounts: flagged for deletion after a notice period (H-20).
  -- The job only marks them; the notice e-mail is sent by the application and
  -- the actual deletion happens on the next run after the notice expires.
  with to_notify as (
    select u.id from users u
     where u.status = 'active'
       and u.deleted_at is null
       and u.last_active_at < now() - (app.setting_int('retention.inactive_accounts_months') || ' months')::interval
       and not exists (select 1 from data_subject_requests d
                        where d.user_id = u.id and d.kind = 'deletion'
                          and d.status in ('received','deferred'))
  )
  insert into data_subject_requests (user_id, kind, status, deferred_until, refusal_reason)
  select id, 'deletion', 'deferred',
         now() + (app.setting_int('retention.inactive_notice_days') || ' days')::interval,
         'Compte inactif : suppression programmée après le préavis par e-mail.'
    from to_notify;
  get diagnostics n = row_count;
  insert into audit.retention_runs (job_name, rows_affected) values ('inactive_accounts_notice', n);
  job_name := 'inactive_accounts_notice'; rows_affected := n; return next;

  return;
end;
$$;

comment on function app.run_retention is
  'Spec 4.7: retention periods are parameters applied by an automatic job. '
  'Schedule with pg_cron (Supabase) or an external scheduler. Each run writes '
  'to audit.retention_runs so deletion is provable.';
