-- 0006: profile details filled in when accepting an invitation, and invitation email confirmation.
alter table profiles add column if not exists job_title text;
alter table profiles add column if not exists phone text;
alter table profiles add column if not exists wechat text;
alter table invitations add column if not exists verified_at timestamptz;   -- code from the invitation email confirmed
