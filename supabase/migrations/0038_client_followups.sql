-- 0038: client follow-up tasks — a real due date, owner and completion status for "follow up on …" set when logging a client activity.
-- Run once in the Supabase SQL editor. The activity itself (call, meeting, note) stays untouched in activity_log; completing or
-- rescheduling a follow-up only changes this table and adds an audit event. Until this is run, follow-ups are shown read-only.

create table if not exists client_followups (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references organizations(id) on delete cascade,
  activity_id bigint,                                   -- the activity_log entry this follow-up came from (no FK: the audit trail must outlive the task)
  title text not null,
  due_date date not null,
  original_due date,                                    -- first due date, kept when rescheduled
  rescheduled_count int not null default 0,
  owner_id uuid references profiles(id) on delete set null,
  status text not null default 'open' check (status in ('open', 'done')),
  completed_at timestamptz,
  completed_by uuid references profiles(id) on delete set null,
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists client_followups_activity_uq on client_followups(activity_id) where activity_id is not null;
create index if not exists client_followups_org_idx on client_followups(org_id, status, due_date);
create index if not exists client_followups_due_idx on client_followups(status, due_date);

alter table client_followups enable row level security;
drop policy if exists staff_all_client_followups on client_followups;
create policy staff_all_client_followups on client_followups for all using (is_staff()) with check (is_staff());

-- bring in the follow-up dates already logged on client activities (owner = whoever logged the activity)
insert into client_followups (org_id, activity_id, title, due_date, original_due, owner_id, created_by, created_at)
select a.entity_id, a.id,
       coalesce(nullif(trim(a.detail->>'next_action'), ''), left(coalesce(a.detail->>'note', ''), 200), 'Follow up'),
       (a.detail->>'follow_up')::date, (a.detail->>'follow_up')::date, a.actor_id, a.actor_id, a.created_at
from activity_log a join organizations o on o.id = a.entity_id
where a.entity_type = 'organization' and a.action like 'crm\_%' and (a.detail->>'follow_up') ~ '^\d{4}-\d{2}-\d{2}$'
on conflict do nothing;
