-- =============================================================================
-- 0015_rls.sql
-- Row Level Security, roles and least privilege (spec 4.8).
--
-- Principle: deny by default. Every table has RLS enabled; a table with no
-- policy for a role is invisible to it. Nothing relies on the client sending
-- the right filter.
--
-- The hr schema is NOT exposed to PostgREST at all: payroll-sensitive fields
-- are reached only through SECURITY DEFINER functions that log the access.
-- =============================================================================

-- Supabase provides these roles. Create them when running on a plain Postgres
-- so the policies, and the test suite, behave identically in both places.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin bypassrls;
  end if;
end;
$$;

-- Current user id. Uses Supabase's auth.uid() when present, and falls back to
-- a session setting so the policies can be exercised in tests.
create or replace function app.current_user_id()
returns uuid
language plpgsql
stable
as $$
declare
  uid uuid;
begin
  begin
    execute 'select auth.uid()' into uid;
  exception when others then
    uid := null;
  end;

  if uid is null then
    uid := nullif(current_setting('app.current_user_id', true), '')::uuid;
  end if;

  return uid;
end;
$$;

create or replace function app.current_user_has_role(p_role user_role)
returns boolean
language sql
stable
as $$ select app.has_role(app.current_user_id(), p_role); $$;

create or replace function app.is_staff()
returns boolean
language sql
stable
as $$
  select app.current_user_has_role('admin')
      or app.current_user_has_role('super_admin')
      or app.current_user_has_role('ops')
      or app.current_user_has_role('support');
$$;

create or replace function app.is_admin()
returns boolean
language sql
stable
as $$
  select app.current_user_has_role('admin') or app.current_user_has_role('super_admin');
$$;

-- Is the current user the courier assigned to this order?
create or replace function app.is_assigned_courier(p_order uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1
      from mission_orders mo
      join missions m on m.id = mo.mission_id
     where mo.order_id = p_order
       and m.courier_id = app.current_user_id()
       and m.status in ('assigned','at_store','purchased','en_route')
  );
$$;

-- -----------------------------------------------------------------------------
-- Enable RLS everywhere (deny by default)
-- -----------------------------------------------------------------------------

do $$
declare t text;
begin
  for t in
    select format('%I.%I', schemaname, tablename)
      from pg_tables
     where schemaname in ('public','audit','hr')
  loop
    execute format('alter table %s enable row level security', t);
    execute format('alter table %s force row level security', t);
  end loop;
end;
$$;

-- -----------------------------------------------------------------------------
-- Schema-level privileges
-- -----------------------------------------------------------------------------

revoke all on schema hr   from public, anon, authenticated;
revoke all on schema audit from public, anon, authenticated;
revoke all on schema app  from public, anon, authenticated;

grant usage on schema public to anon, authenticated;
-- app functions are callable, but the schema's tables are not readable.
grant usage on schema app to authenticated;

-- -----------------------------------------------------------------------------
-- users
-- -----------------------------------------------------------------------------

create policy users_select_self on users for select to authenticated
  using (id = app.current_user_id() or app.is_staff());

create policy users_update_self on users for update to authenticated
  using (id = app.current_user_id())
  with check (id = app.current_user_id());

create policy users_staff_update on users for update to authenticated
  using (app.is_admin());

-- -----------------------------------------------------------------------------
-- consents, addresses
-- -----------------------------------------------------------------------------

create policy consents_own on consents for select to authenticated
  using (user_id = app.current_user_id() or app.is_staff());

create policy consents_insert_own on consents for insert to authenticated
  with check (user_id = app.current_user_id());

create policy addresses_own on addresses for all to authenticated
  using (user_id = app.current_user_id() or app.is_staff())
  with check (user_id = app.current_user_id());

-- -----------------------------------------------------------------------------
-- Catalogue: readable by everyone signed in, written by admins only
-- -----------------------------------------------------------------------------

create policy zones_read on zones for select to anon, authenticated using (true);
create policy zones_write on zones for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy stores_read on stores for select to authenticated using (active or app.is_staff());
create policy stores_write on stores for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- Note: the age filter is applied by app.catalogue_for_user(), not here. RLS
-- cannot see the viewer's bracket cheaply, and the spec requires the SERVER to
-- refuse the purchase, which the order-item guard does unconditionally.
create policy products_read on products for select to authenticated
  using (active or app.is_staff());
create policy products_write on products for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy store_products_read on store_products for select to authenticated using (true);
create policy store_products_write on store_products for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy waitlist_own on waitlist_entries for all to authenticated
  using (user_id = app.current_user_id() or app.is_staff())
  with check (user_id = app.current_user_id());

-- -----------------------------------------------------------------------------
-- Orders: the client, the assigned courier, and staff
-- -----------------------------------------------------------------------------

create policy orders_client on orders for select to authenticated
  using (client_id = app.current_user_id()
         or app.is_assigned_courier(id)
         or app.is_staff());

create policy orders_client_insert on orders for insert to authenticated
  with check (client_id = app.current_user_id());

create policy orders_client_update on orders for update to authenticated
  using (client_id = app.current_user_id() or app.is_assigned_courier(id) or app.is_staff());

create policy order_items_scoped on order_items for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id
                  and (o.client_id = app.current_user_id()
                       or app.is_assigned_courier(o.id)
                       or app.is_staff())));

create policy order_items_write on order_items for all to authenticated
  using (exists (select 1 from orders o where o.id = order_id
                  and (o.client_id = app.current_user_id() or app.is_staff())))
  with check (exists (select 1 from orders o where o.id = order_id
                  and (o.client_id = app.current_user_id() or app.is_staff())));

create policy group_orders_scoped on group_orders for select to authenticated
  using (host_id = app.current_user_id()
         or exists (select 1 from group_participants p
                     where p.group_order_id = id and p.user_id = app.current_user_id())
         or app.is_staff());

create policy group_participants_scoped on group_participants for select to authenticated
  using (user_id = app.current_user_id()
         or exists (select 1 from group_orders g
                     where g.id = group_order_id and g.host_id = app.current_user_id())
         or app.is_staff());

create policy group_participants_join on group_participants for insert to authenticated
  with check (user_id = app.current_user_id());

-- -----------------------------------------------------------------------------
-- Courier side
-- -----------------------------------------------------------------------------

create policy courier_profile_own on courier_profiles for select to authenticated
  using (user_id = app.current_user_id() or app.is_staff());

create policy courier_profile_update_own on courier_profiles for update to authenticated
  using (user_id = app.current_user_id() or app.is_admin());

-- Shifts are public to couriers so they can book, but only admins publish.
create policy shifts_read on shifts for select to authenticated
  using (app.current_user_has_role('courier') or app.is_staff());
create policy shifts_write on shifts for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy bookings_own on shift_bookings for all to authenticated
  using (courier_id = app.current_user_id() or app.is_staff())
  with check (courier_id = app.current_user_id());

create policy missions_own on missions for select to authenticated
  using (courier_id = app.current_user_id() or app.is_staff());

create policy mission_orders_scoped on mission_orders for select to authenticated
  using (exists (select 1 from missions m where m.id = mission_id
                  and (m.courier_id = app.current_user_id() or app.is_staff())));

create policy mission_offers_own on mission_offers for all to authenticated
  using (courier_id = app.current_user_id() or app.is_staff())
  with check (courier_id = app.current_user_id() or app.is_staff());

-- Spec 4.3: a courier sees their own positions; nobody else does except staff
-- investigating an incident.
create policy positions_own on courier_positions for all to authenticated
  using (courier_id = app.current_user_id() or app.is_staff())
  with check (courier_id = app.current_user_id());

create policy age_checks_scoped on age_checks for select to authenticated
  using (courier_id = app.current_user_id() or app.is_staff());

create policy age_checks_insert on age_checks for insert to authenticated
  with check (courier_id = app.current_user_id());

-- -----------------------------------------------------------------------------
-- Money
-- -----------------------------------------------------------------------------

create policy payments_scoped on payments for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id
                  and (o.client_id = app.current_user_id() or app.is_staff())));

create policy refunds_scoped on refunds for select to authenticated
  using (app.is_staff()
         or exists (select 1 from payments p join orders o on o.id = p.order_id
                     where p.id = payment_id and o.client_id = app.current_user_id()));

create policy invoices_scoped on invoices for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id
                  and (o.client_id = app.current_user_id() or app.is_staff())));

create policy receipts_scoped on receipts for select to authenticated
  using (exists (select 1 from orders o where o.id = order_id
                  and (o.client_id = app.current_user_id()
                       or app.is_assigned_courier(o.id)
                       or app.is_staff())));

-- Spend cards and their transactions are operator-internal.
create policy spend_cards_staff on spend_cards for select to authenticated
  using (courier_id = app.current_user_id() or app.is_staff());
create policy spend_card_tx_staff on spend_card_transactions for select to authenticated
  using (app.is_staff());
create policy payroll_exports_staff on payroll_exports for all to authenticated
  using (app.current_user_has_role('hr') or app.is_admin())
  with check (app.current_user_has_role('hr') or app.is_admin());

create policy invoice_counters_staff on invoice_counters for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- -----------------------------------------------------------------------------
-- Growth
-- -----------------------------------------------------------------------------

create policy promotions_read on promotions for select to authenticated
  using (active and now() between starts_at and ends_at or app.is_staff());
create policy promotions_write on promotions for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy referral_codes_own on referral_codes for select to authenticated
  using (owner_id = app.current_user_id() or app.is_staff());
create policy referral_codes_admin on referral_codes for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy referrals_own on referrals for select to authenticated
  using (referrer_id = app.current_user_id() or referee_id = app.current_user_id() or app.is_staff());

create policy ambassadors_own on ambassadors for select to authenticated
  using (user_id = app.current_user_id() or app.is_staff());

create policy campaigns_staff on marketing_campaigns for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- -----------------------------------------------------------------------------
-- Feedback and support
-- -----------------------------------------------------------------------------

-- Spec 16: ratings are not curated. Any signed-in user may read them.
create policy ratings_read on ratings for select to authenticated using (true);
create policy ratings_insert on ratings for insert to authenticated
  with check (client_id = app.current_user_id());

create policy incidents_scoped on incidents for select to authenticated
  using (reported_by = app.current_user_id() or app.is_staff());
create policy incidents_insert on incidents for insert to authenticated
  with check (reported_by = app.current_user_id());
create policy incidents_staff_update on incidents for update to authenticated
  using (app.is_staff());

create policy blocks_staff on client_blocks for select to authenticated
  using (user_id = app.current_user_id() or app.is_staff());
create policy blocks_write on client_blocks for all to authenticated
  using (app.is_staff()) with check (app.is_staff());

create policy chat_scoped on chat_messages for all to authenticated
  using (exists (select 1 from orders o where o.id = order_id
                  and (o.client_id = app.current_user_id()
                       or app.is_assigned_courier(o.id)
                       or app.is_staff())))
  with check (sender_id = app.current_user_id());

-- -----------------------------------------------------------------------------
-- Privacy and settings
-- -----------------------------------------------------------------------------

create policy dsr_own on data_subject_requests for select to authenticated
  using (user_id = app.current_user_id() or app.is_staff());
create policy dsr_insert_own on data_subject_requests for insert to authenticated
  with check (user_id = app.current_user_id());

create policy breaches_admin on data_breaches for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy legal_docs_read on legal_documents for select to anon, authenticated
  using (published_at is not null or app.is_staff());
create policy legal_docs_write on legal_documents for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- Settings are readable by staff only: some hold legal texts and thresholds
-- that should not be enumerable by a client.
create policy settings_staff on app_settings for select to authenticated
  using (app.is_staff());
create policy settings_write on app_settings for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

create policy transitions_read on order_transitions for select to authenticated using (true);

-- -----------------------------------------------------------------------------
-- Audit journals: readable by admins, never writable from the API
-- -----------------------------------------------------------------------------

create policy audit_admin_read on audit.admin_actions for select to authenticated
  using (app.is_admin());
create policy audit_orders_read on audit.order_events for select to authenticated
  using (app.is_staff());
create policy audit_settings_read on audit.settings_history for select to authenticated
  using (app.is_admin());
create policy audit_retention_read on audit.retention_runs for select to authenticated
  using (app.is_admin());
create policy audit_hr_read on audit.hr_access_log for select to authenticated
  using (app.is_admin());

-- hr.courier_payroll gets NO policy: it is unreachable through the API by
-- design. Access goes through hr.read_payroll_field(), which checks the role
-- and logs the purpose.
create or replace function hr.read_payroll_field(
  p_subject uuid,
  p_field text,
  p_purpose text
) returns text
language plpgsql
security definer
set search_path = hr, public, app, extensions
as $$
declare
  v text;
begin
  if not (app.current_user_has_role('hr') or app.current_user_has_role('super_admin')) then
    raise exception 'payroll data is restricted to the hr role'
      using errcode = 'insufficient_privilege';
  end if;

  if p_purpose is null or length(btrim(p_purpose)) = 0 then
    raise exception 'a purpose must be given for every payroll data access'
      using errcode = 'check_violation';
  end if;

  select case p_field
           when 'iban' then convert_from(iban_encrypted, 'UTF8')
           when 'national_register' then convert_from(national_register_encrypted, 'UTF8')
           when 'hourly_wage_cents' then hourly_wage_cents::text
           else null
         end
    into v
    from hr.courier_payroll where user_id = p_subject;

  insert into audit.hr_access_log (subject_id, accessed_by, field, purpose)
  values (p_subject, app.current_user_id(), p_field, p_purpose);

  return v;
end;
$$;

comment on function hr.read_payroll_field is
  'Spec 4.7 and 4.8: the only way to read a payroll-sensitive field. Checks '
  'the hr role, demands a stated purpose, and logs the access.';

-- -----------------------------------------------------------------------------
-- Table grants (RLS filters rows; grants decide who may touch the table at all)
-- -----------------------------------------------------------------------------

grant select on zones, legal_documents to anon;
grant select, insert, update on all tables in schema public to authenticated;
grant select on all tables in schema audit to authenticated;
grant usage, select on all sequences in schema public to authenticated;
grant execute on all functions in schema app to authenticated;
grant execute on function hr.read_payroll_field(uuid, text, text) to authenticated;

-- Nobody deletes through the API: cancellations and erasures go through the
-- dedicated functions, so they are journalled.
revoke delete on all tables in schema public from authenticated, anon;
