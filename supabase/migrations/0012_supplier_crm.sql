-- 0012: last sign-in per person, and light CRM fields for suppliers (status + next follow-up)
alter table profiles add column if not exists last_login_at timestamptz;

-- fill from Supabase's own record for people who signed in before this existed
update profiles p set last_login_at = u.last_sign_in_at
  from auth.users u where u.id = p.id and p.last_login_at is null and u.last_sign_in_at is not null;

alter table suppliers add column if not exists crm_status text not null default 'active'
  check (crm_status in ('prospect', 'contacted', 'sampling', 'approved', 'active', 'on_hold', 'blocked'));
alter table suppliers add column if not exists next_follow_up date;
-- suppliers added by invitation start as "contacted" until they register
update suppliers set crm_status = 'contacted' where details_completed_at is null and name like '(%)';
