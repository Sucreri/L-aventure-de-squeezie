-- =============================================================================
-- 0033_act_on_behalf.sql
-- Letting a trusted server-side context act for a named courier.
--
-- app.apply_as_courier and app.sign_courier_contract act on
-- app.current_user_id(). That is right for the API, where the courier is the
-- caller. But a system context — a migration, a support tool, the service
-- layer's own tests — has no session identity, and could not perform these
-- steps at all.
--
-- So both now take an optional subject. The rule is explicit: naming someone
-- else is allowed only from a context that has no user identity (the service
-- role) or from staff. A signed-in courier naming another user is refused,
-- which is the case that matters.
-- =============================================================================

create or replace function app.apply_as_courier(
  p_transport transport_mode,
  p_enrolment_proof_ref text,
  p_user uuid default null
) returns courier_profiles
language plpgsql
security definer
set search_path = public, app
as $$
declare
  caller  uuid := app.current_user_id();
  subject uuid := coalesce(p_user, caller);
  capacity integer;
  profile courier_profiles;
begin
  if subject is null then
    raise exception 'authentification requise' using errcode = 'insufficient_privilege';
  end if;

  -- Acting for someone else requires a system context or staff.
  if caller is not null and subject <> caller and not app.is_staff() then
    raise exception 'cannot apply on behalf of another user'
      using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from users u
                  where u.id = subject and u.age_bracket = 'b18_plus' and u.age_verified) then
    raise exception 'a courier must be a verified adult'
      using errcode = 'check_violation', hint = 'Spec 4.3 and courier.min_age.';
  end if;

  capacity := case p_transport
                when 'foot_trolley' then app.setting_int('courier.capacity_foot_trolley')
                when 'bike_trailer' then app.setting_int('courier.capacity_bike_trailer')
                when 'cargo_bike'   then app.setting_int('courier.capacity_cargo_bike')
              end;

  insert into courier_profiles (user_id, transport, capacity_units,
                                enrolment_proof_ref, status,
                                contract_signed, dimona_confirmed)
  values (subject, p_transport, capacity, p_enrolment_proof_ref, 'applied', false, false)
  on conflict (user_id) do update
     set transport = excluded.transport,
         capacity_units = excluded.capacity_units,
         enrolment_proof_ref = excluded.enrolment_proof_ref
  returning * into profile;

  update users
     set roles = array(select distinct unnest(roles || 'courier'::user_role))
   where id = subject;

  return profile;
end;
$$;

create or replace function app.sign_courier_contract(p_user uuid default null)
returns courier_profiles
language plpgsql
security definer
set search_path = public, app
as $$
declare
  caller  uuid := app.current_user_id();
  subject uuid := coalesce(p_user, caller);
  profile courier_profiles;
begin
  if subject is null then
    raise exception 'authentification requise' using errcode = 'insufficient_privilege';
  end if;

  if caller is not null and subject <> caller and not app.is_staff() then
    raise exception 'cannot sign on behalf of another user'
      using errcode = 'insufficient_privilege';
  end if;

  select * into profile from courier_profiles where user_id = subject;

  if not found then
    raise exception 'no courier application for this account'
      using errcode = 'no_data_found';
  end if;

  if profile.training_passed_at is null then
    raise exception 'mandatory training has not been passed'
      using errcode = 'check_violation', hint = 'Spec 7.2.';
  end if;

  if profile.contract_signed then
    return profile;
  end if;

  update courier_profiles
     set contract_signed = true,
         contract_signed_at = now(),
         status = (case when dimona_confirmed then 'active' else 'contract_pending' end)::courier_status
   where user_id = subject
  returning * into profile;

  return profile;
end;
$$;

-- Dimona confirmation already names its subject and is admin-only; it also
-- needs to work from a system context, which has no identity to check a role
-- against.
create or replace function app.confirm_dimona(p_courier uuid)
returns courier_profiles
language plpgsql
security definer
set search_path = public, app, audit
as $$
declare
  caller uuid := app.current_user_id();
  profile courier_profiles;
begin
  -- A signed-in user must be an admin. A system context (no identity) is
  -- trusted, because it is the server acting, not a person.
  if caller is not null and not app.is_admin() then
    raise exception 'only an admin may confirm a Dimona declaration'
      using errcode = 'insufficient_privilege';
  end if;

  update courier_profiles
     set dimona_confirmed = true,
         dimona_confirmed_at = now(),
         status = (case when contract_signed then 'active' else 'contract_pending' end)::courier_status
   where user_id = p_courier
  returning * into profile;

  if not found then
    raise exception 'unknown courier %', p_courier using errcode = 'no_data_found';
  end if;

  insert into audit.admin_actions (actor_id, actor_role, action, entity, entity_id, reason)
  values (caller, case when caller is null then 'system' else 'admin' end,
          'confirm_dimona', 'courier_profiles', p_courier::text,
          'Déclaration Dimona confirmée');

  return profile;
end;
$$;

grant execute on function app.apply_as_courier(transport_mode, text, uuid) to authenticated;
grant execute on function app.sign_courier_contract(uuid) to authenticated;
