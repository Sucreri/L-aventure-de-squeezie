-- =============================================================================
-- 0003_identity_consents.sql
-- Users, age verification, legal documents and consent journal.
--
-- CRITICAL DESIGN NOTE (HYPOTHESES.md H-04, spec 4.7 and 6.1):
-- This schema has NO column able to hold a date of birth, a year of birth, an
-- identity document number or an image of one. That is not an omission; it is
-- the enforcement mechanism. Age verification produces a bracket and nothing
-- else. Do not add such a column without a new DPIA.
-- =============================================================================

create table legal_documents (
  id             uuid primary key default gen_random_uuid(),
  doc_key        text        not null,   -- 'tos', 'sales_terms', 'privacy', ...
  version        text        not null,   -- e.g. '2026-11-17.1'
  locale         text        not null default 'fr',
  title          text        not null,
  body_md        text        not null,
  -- Spec 4.12: every generated legal text carries the lawyer-validation header
  -- until a juriste signs it off. Nothing may be published without this flag.
  validated_by_lawyer boolean not null default false,
  validated_by        text,
  validated_at        timestamptz,
  published_at   timestamptz,
  created_at     timestamptz not null default now(),
  unique (doc_key, version, locale),
  constraint chk_validation_coherent check (
    (validated_by_lawyer = false and validated_at is null)
    or (validated_by_lawyer = true and validated_at is not null and validated_by is not null)
  ),
  -- A document cannot be published before a lawyer has validated it.
  constraint chk_no_publish_before_validation check (
    published_at is null or validated_by_lawyer = true
  )
);

comment on table legal_documents is
  'Versioned legal texts (spec 4.12). Publication is blocked until a lawyer '
  'has validated the version, enforced by chk_no_publish_before_validation.';

create index on legal_documents (doc_key, locale, published_at desc);

-- -----------------------------------------------------------------------------
-- Users
-- -----------------------------------------------------------------------------

create table users (
  id          uuid primary key default gen_random_uuid(),
  roles       user_role[] not null default array['client']::user_role[],
  first_name  text        not null,
  last_name   text        not null,
  phone       text,
  email       citext,

  -- Age: bracket only. See the critical note at the top of this file.
  age_bracket         age_bracket,
  age_verified        boolean     not null default false,
  verification_method verification_method,
  verified_at         timestamptz,

  status      text        not null default 'pending'
              check (status in ('pending','active','suspended','deleted')),
  locale      text        not null default 'fr',

  created_at     timestamptz not null default now(),
  last_active_at timestamptz not null default now(),
  -- Soft delete so an in-flight order can finish; the retention job hard-deletes.
  deleted_at     timestamptz,

  -- A live account must be reachable. A deleted one is anonymised and has no
  -- contact details left on purpose (spec 4.7), so it is exempt.
  constraint chk_contact_present check (
    status = 'deleted' or phone is not null or email is not null
  ),

  -- Verification is all-or-nothing: a verified user has a bracket, a method
  -- and a timestamp. Prevents a half-written verification from passing as valid.
  constraint chk_verification_complete check (
    (age_verified = false)
    or (age_bracket is not null
        and verification_method is not null
        and verified_at is not null)
  ),

  -- Spec 6.1: under 16, registration is refused. Such a user can never be active.
  constraint chk_under_16_never_active check (
    age_bracket is distinct from 'under_16' or status <> 'active'
  ),

  -- Spec 4.3 / courier.min_age: a courier must be 18+.
  constraint chk_courier_is_adult check (
    not ('courier' = any(roles)) or age_bracket = 'b18_plus'
  )
);

comment on column users.age_bracket is
  'Age bracket only. Storing a date of birth here would breach spec 4.7 '
  'minimisation and HYPOTHESES.md H-04.';

create index on users (status) where deleted_at is null;
create index on users (email) where email is not null;
create index on users (last_active_at);
create index on users using gin (roles);

create or replace function app.has_role(p_user uuid, p_role user_role)
returns boolean
language sql
stable
as $$ select exists (select 1 from users u where u.id = p_user and p_role = any(u.roles)); $$;

-- Numeric minimum age a bracket satisfies. Used by the ordering guard.
create or replace function app.bracket_min_age(b age_bracket)
returns integer
language sql
immutable
as $$
  select case b
           when 'b18_plus' then 18
           when 'b16_17'   then 16
           when 'under_16' then 0
         end;
$$;

-- Central authorisation predicate for an age-restricted product.
-- Returns true when a user whose bracket is `b` may buy a product whose
-- age_minimum is `p_age_minimum`. An unverified user may buy nothing restricted.
create or replace function app.may_buy_age_restricted(
  b age_bracket,
  p_verified boolean,
  p_age_minimum integer
) returns boolean
language sql
immutable
as $$
  select case
           when coalesce(p_age_minimum, 0) = 0 then true
           when b is null or p_verified is not true then false
           else app.bracket_min_age(b) >= p_age_minimum
         end;
$$;

comment on function app.may_buy_age_restricted is
  'Single source of truth for age gating (spec 4.1). Called by the order-item '
  'guard and by the catalogue view. Never duplicate this rule in a client.';

-- -----------------------------------------------------------------------------
-- Consents: append-only journal, current state = latest row per (user, type)
-- -----------------------------------------------------------------------------

create table consents (
  id            bigserial primary key,
  user_id       uuid        not null references users(id) on delete cascade,
  consent_type  consent_type not null,
  granted       boolean     not null,
  -- Mandatory consents reference the exact document version accepted (spec 4.6).
  legal_document_id uuid    references legal_documents(id),
  occurred_at   timestamptz not null default now(),
  source        text        not null default 'app'
                check (source in ('app','web','backoffice','import')),

  -- CGU and CGV acceptance must name the version that was accepted, otherwise
  -- the operator cannot prove what the client agreed to.
  constraint chk_document_required_for_terms check (
    consent_type not in ('tos','sales_terms','privacy')
    or legal_document_id is not null
  )
);

comment on table consents is
  'Append-only consent journal (spec 6.2). Withdrawal is a new row with '
  'granted = false, never an update, so history stays provable.';

create index on consents (user_id, consent_type, occurred_at desc);

-- Updating or deleting a consent row would destroy the proof. Refuse both.
create or replace function app.consents_are_append_only()
returns trigger
language plpgsql
as $$
begin
  raise exception 'consents are append-only: record a new row instead of % ', tg_op
    using errcode = 'restrict_violation';
end;
$$;

create trigger trg_consents_no_update
  before update or delete on consents
  for each row execute function app.consents_are_append_only();

-- Current consent state for a user.
create or replace function app.has_consent(p_user uuid, p_type consent_type)
returns boolean
language sql
stable
as $$
  select coalesce(
    (select c.granted
       from consents c
      where c.user_id = p_user and c.consent_type = p_type
      order by c.occurred_at desc, c.id desc
      limit 1),
    false);
$$;

-- Spec 20: ordering is impossible without a verified account and accepted
-- CGU + CGV. Used by the order guard.
create or replace function app.may_place_order(p_user uuid)
returns boolean
language sql
stable
as $$
  select exists (
    select 1 from users u
     where u.id = p_user
       and u.status = 'active'
       and u.deleted_at is null
       and u.age_verified
       and u.age_bracket in ('b16_17','b18_plus')
  )
  and app.has_consent(p_user, 'tos')
  and app.has_consent(p_user, 'sales_terms');
$$;
