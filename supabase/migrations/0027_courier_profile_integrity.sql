-- =============================================================================
-- 0027_courier_profile_integrity.sql
--
-- Closes a hole in the policies written in 0015.
--
-- `courier_profile_update_own` granted UPDATE on a courier's own row with no
-- WITH CHECK clause. A courier could therefore set contract_signed = true,
-- dimona_confirmed = true and status = 'active' on themselves — and the
-- constraints would be satisfied, because they only check that those three
-- agree with each other, not that they are TRUE.
--
-- That defeats the central requirement of spec 4.3: no work without a signed
-- student employment contract and a confirmed Dimona declaration. The guards
-- on missions and bookings read exactly those columns, so whoever can write
-- them can work without a contract.
--
-- The fix follows the pattern already used for payments (0020): the courier
-- holds no direct write access at all, and each transition goes through a
-- SECURITY DEFINER function that enforces its own precondition.
--
--   app.apply_as_courier()        self-service, forces the safe defaults
--   app.sign_courier_contract()   self-service, requires the training
--   app.confirm_dimona()          admin only, and journalled
-- =============================================================================

drop policy if exists courier_profile_update_own on courier_profiles;

-- Admins keep direct access, for support and corrections. Couriers do not.
create policy courier_profile_admin_write on courier_profiles for all to authenticated
  using (app.is_admin()) with check (app.is_admin());

-- -----------------------------------------------------------------------------

/**
 * Applying as a courier (spec 7.1).
 *
 * Self-service, but the function decides what is written: the capacity comes
 * from the parameter for the declared transport (spec 14), and the three
 * employment flags are forced to their initial values whatever the caller
 * wants. Re-applying updates the transport and leaves everything else alone.
 */
create or replace function app.apply_as_courier(
  p_transport transport_mode,
  p_enrolment_proof_ref text
) returns courier_profiles
language plpgsql
security definer
set search_path = public, app
as $$
declare
  caller uuid := app.current_user_id();
  capacity integer;
  profile courier_profiles;
begin
  if caller is null then
    raise exception 'authentification requise' using errcode = 'insufficient_privilege';
  end if;

  if not exists (select 1 from users u
                  where u.id = caller and u.age_bracket = 'b18_plus' and u.age_verified) then
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
  values (caller, p_transport, capacity, p_enrolment_proof_ref, 'applied', false, false)
  on conflict (user_id) do update
     set transport = excluded.transport,
         capacity_units = excluded.capacity_units,
         enrolment_proof_ref = excluded.enrolment_proof_ref
  returning * into profile;

  update users
     set roles = array(select distinct unnest(roles || 'courier'::user_role))
   where id = caller;

  return profile;
end;
$$;

comment on function app.apply_as_courier is
  'Spec 7.1 and 14. The capacity comes from the transport parameter and the '
  'employment flags are forced to false: a courier never writes them.';

/**
 * Signing the student employment contract (spec 7.3).
 *
 * Requires the mandatory training (spec 7.2) and never touches the Dimona
 * flag: that confirmation belongs to the admin, because it reflects a
 * declaration made to the ONSS, not something the courier can assert.
 */
create or replace function app.sign_courier_contract()
returns courier_profiles
language plpgsql
security definer
set search_path = public, app
as $$
declare
  caller uuid := app.current_user_id();
  profile courier_profiles;
begin
  select * into profile from courier_profiles where user_id = caller;

  if not found then
    raise exception 'no courier application for this account'
      using errcode = 'no_data_found';
  end if;

  if profile.training_passed_at is null then
    raise exception 'mandatory training has not been passed'
      using errcode = 'check_violation', hint = 'Spec 7.2.';
  end if;

  if profile.contract_signed then
    return profile;   -- replaying a signature changes nothing
  end if;

  update courier_profiles
     set contract_signed = true,
         contract_signed_at = now(),
         status = (case when dimona_confirmed then 'active' else 'contract_pending' end)::courier_status
   where user_id = caller
  returning * into profile;

  return profile;
end;
$$;

/**
 * Confirming the Dimona declaration (spec 7.3).
 *
 * Admin only, and journalled: it records that a declaration was actually made
 * to the ONSS. A courier asserting it about themselves would be the whole
 * problem this migration exists to solve.
 */
create or replace function app.confirm_dimona(p_courier uuid)
returns courier_profiles
language plpgsql
security definer
set search_path = public, app, audit
as $$
declare
  profile courier_profiles;
begin
  if not app.is_admin() then
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
  values (app.current_user_id(), 'admin', 'confirm_dimona', 'courier_profiles',
          p_courier::text, 'Déclaration Dimona confirmée');

  return profile;
end;
$$;

grant execute on function app.apply_as_courier(transport_mode, text) to authenticated;
grant execute on function app.sign_courier_contract() to authenticated;
grant execute on function app.confirm_dimona(uuid) to authenticated;
