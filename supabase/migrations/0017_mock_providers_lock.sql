-- =============================================================================
-- 0017_mock_providers_lock.sql
-- Allows simulated providers, but only where they are explicitly permitted.
--
-- The MVP has to be runnable end to end before the SRL exists and before a
-- Mollie or Stripe contract is signed. That means a simulated payment
-- provider. The risk this introduces is obvious: a production deployment that
-- silently accepts fake payments.
--
-- So 'mock' becomes an accepted provider value, and a guard refuses it unless
-- environment.allow_mock_providers is explicitly true. The default is FALSE:
-- a fresh production database refuses simulated payments without anyone
-- having to remember to turn anything off.
-- =============================================================================

insert into app_settings (key, value, value_type, category, description, required_for_launch)
values ('environment.allow_mock_providers', 'false', 'bool', 'compliance',
        'Autorise les prestataires simulés (développement et démonstration uniquement). '
        'Doit rester false en production : un paiement simulé n''encaisse rien.', false);

alter table payments drop constraint payments_provider_check;
alter table payments add constraint payments_provider_check
  check (provider in ('mollie', 'stripe', 'mock'));

create or replace function app.guard_mock_provider()
returns trigger
language plpgsql
as $$
begin
  if new.provider = 'mock' and not app.setting_bool('environment.allow_mock_providers') then
    raise exception 'les prestataires simulés sont désactivés sur cet environnement'
      using errcode = 'check_violation',
            hint = 'Un paiement simulé n''encaisse rien. Configurez Mollie ou Stripe, '
                || 'ou activez environment.allow_mock_providers sur un environnement de test.';
  end if;
  return new;
end;
$$;

create trigger trg_mock_provider
  before insert or update of provider on payments
  for each row execute function app.guard_mock_provider();

comment on function app.guard_mock_provider is
  'Refuse un paiement simulé tant que environment.allow_mock_providers est faux. '
  'Protège contre une production qui accepterait des paiements fictifs.';
