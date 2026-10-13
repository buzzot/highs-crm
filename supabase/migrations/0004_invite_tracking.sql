-- 0004: invitation tracking — each invite has its own link token, valid 14 days,
-- and "accepted" now means the person actually set their password (not just that the email went out).

alter table invitations add column if not exists token text unique;
alter table invitations add column if not exists expires_at timestamptz;
alter table invitations add column if not exists revoked_at timestamptz;
alter table profiles add column if not exists invited_at timestamptz;
alter table profiles add column if not exists accepted_at timestamptz;

-- Older invitations: give them the 14-day window from when they were sent.
update invitations set expires_at = created_at + interval '14 days' where expires_at is null;

-- The trigger links the new login to its invitation but no longer marks it accepted.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from invitations
   where lower(email) = lower(new.email) and accepted_at is null and revoked_at is null
   order by created_at desc limit 1;
  insert into profiles(id, email, full_name, role, org_id, active, invited_at)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''),
          coalesce(inv.role, 'client'), inv.org_id, inv.id is not null, inv.created_at);
  return new;
end $$;

-- Existing users who have already signed in count as accepted.
update profiles p set accepted_at = coalesce(u.last_sign_in_at, now())
  from auth.users u where u.id = p.id and u.last_sign_in_at is not null and p.accepted_at is null;

grant all on invitations, profiles to service_role;
