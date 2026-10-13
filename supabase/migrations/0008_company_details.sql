-- 0008: company details that the client completes on first sign-in (used on quotes, invoices and shipping documents)
alter table organizations add column if not exists city text;
alter table organizations add column if not exists postal_code text;
alter table organizations add column if not exists phone text;
alter table organizations add column if not exists email text;
alter table organizations add column if not exists website text;
alter table organizations add column if not exists registration_no text;
alter table organizations add column if not exists delivery_address text;
alter table organizations add column if not exists details_completed_at timestamptz;
alter table organizations add column if not exists details_completed_by uuid references profiles(id);
