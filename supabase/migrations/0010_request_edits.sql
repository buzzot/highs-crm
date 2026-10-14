-- 0010: clients can edit a request (an admin approves the change), and choose a preferred delivery method

-- preferred delivery: sea / air / land (rail or truck) / any
alter table requests add column if not exists delivery_mode text
  check (delivery_mode in ('sea', 'air', 'land', 'any'));
grant select (delivery_mode) on requests to authenticated;

-- quotes replaced by an updated offer after the client changed the request
alter type quote_status add value if not exists 'superseded';

-- a client's proposed change, waiting for an admin
create table if not exists request_revisions (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  created_by uuid references profiles(id),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'cancelled')),
  data jsonb not null,               -- the request as the client wants it (header fields + products)
  admin_note text,
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists request_revisions_request_idx on request_revisions(request_id, created_at desc);
create unique index if not exists request_revisions_one_pending on request_revisions(request_id) where status = 'pending';

alter table request_revisions enable row level security;
drop policy if exists staff_all_request_revisions on request_revisions;
create policy staff_all_request_revisions on request_revisions for all using (is_staff()) with check (is_staff());
drop policy if exists client_request_revisions_select on request_revisions;
create policy client_request_revisions_select on request_revisions for select
  using (request_id in (select id from requests where org_id = current_org()));
grant select on request_revisions to authenticated;
grant all on request_revisions to service_role;

-- files added in a proposed change stay attached to it until approved
alter table documents add column if not exists revision_id uuid references request_revisions(id) on delete cascade;
