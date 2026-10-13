-- 0007: the app now sends all emails itself (Resend) and checks its own codes / reset links.
-- Only a keyed hash of each code is stored. No policies → only the server (service role) can use it.
create table if not exists auth_codes (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  purpose text not null check (purpose in ('login', 'invite', 'reset')),
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0,
  used_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists auth_codes_lookup on auth_codes (email, purpose, created_at desc);
alter table auth_codes enable row level security;
grant all on auth_codes to service_role;

-- housekeeping: old codes are useless after a day
create or replace function purge_auth_codes() returns void language sql as $$
  delete from auth_codes where created_at < now() - interval '1 day' and (used_at is not null or expires_at < now());
$$;
