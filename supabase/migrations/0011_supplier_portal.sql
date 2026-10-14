-- 0011: suppliers can be invited by email. They confirm a code, fill in their company and personal
-- details, create a password, and get a small supplier portal (company details, their products).

alter type user_role add value if not exists 'supplier';

alter table profiles add column if not exists supplier_id uuid references suppliers(id) on delete set null;
create index if not exists profiles_supplier_idx on profiles(supplier_id);
alter table invitations add column if not exists supplier_id uuid references suppliers(id) on delete cascade;

-- company details the supplier fills in
alter table suppliers add column if not exists company_type text check (company_type in ('factory', 'trading', 'both'));
alter table suppliers add column if not exists main_products text;
alter table suppliers add column if not exists year_established int;
alter table suppliers add column if not exists employees text;
alter table suppliers add column if not exists certifications text;
alter table suppliers add column if not exists registration_no text;
alter table suppliers add column if not exists postal_code text;
alter table suppliers add column if not exists details_completed_at timestamptz;
alter table suppliers add column if not exists details_completed_by uuid references profiles(id);

-- which supplier the signed-in person belongs to (for row policies)
create or replace function current_supplier() returns uuid language sql stable security definer set search_path = public as $$
  select supplier_id from profiles where id = auth.uid()
$$;
revoke execute on function current_supplier() from anon;

-- suppliers may read their own company row and products; everything else stays staff-only.
-- (The app reads supplier data server-side; these policies only matter for direct API calls.)
drop policy if exists supplier_own_row on suppliers;
create policy supplier_own_row on suppliers for select using (id = current_supplier());
drop policy if exists supplier_own_products on products;
create policy supplier_own_products on products for select using (supplier_id = current_supplier());

-- new logins pick up the supplier from their invitation
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from invitations
   where lower(email) = lower(new.email) and accepted_at is null and revoked_at is null
   order by created_at desc limit 1;
  insert into profiles(id, email, full_name, role, org_id, supplier_id, active, invited_at)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''),
          coalesce(inv.role, 'client'), inv.org_id, inv.supplier_id, inv.id is not null, inv.created_at);
  return new;
end $$;

grant all on invitations, profiles, suppliers to service_role;
