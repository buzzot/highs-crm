-- 0036: access levels for staff — Admin (full), Director (sees everything, deletes only what they created), Manager (sees only their own records).
-- Run once in the Supabase SQL editor. Existing staff become Directors. Until this is run the app behaves exactly as before.

-- who is a Director / Manager (role stays 'staff'; admins are role 'admin')
alter table profiles add column if not exists staff_level text not null default 'director' check (staff_level in ('director', 'manager'));

-- ownership: created_by = who made it (delete rule), owner_id = whose record it is (what a Manager can see; an Admin/Director can reassign it)
do $$ declare t text; begin
  foreach t in array array['organizations', 'requests', 'quotes', 'orders', 'shipments', 'rfqs'] loop
    execute format('alter table %I add column if not exists created_by uuid references profiles(id) on delete set null', t);
    execute format('alter table %I add column if not exists owner_id uuid references profiles(id) on delete set null', t);
    execute format('create index if not exists %I on %I(owner_id)', t || '_owner_idx', t);
  end loop;
end $$;

-- records made by someone else's action (a client's request or order, a quote accepted in the portal) inherit the owner of what they belong to
create or replace function inherit_owner() returns trigger language plpgsql as $$
begin
  if new.owner_id is not null then return new; end if;
  if tg_table_name = 'requests' then
    select owner_id into new.owner_id from organizations where id = new.org_id;
  elsif tg_table_name = 'quotes' then
    select owner_id into new.owner_id from requests where id = new.request_id;
  elsif tg_table_name = 'orders' then
    select owner_id into new.owner_id from requests where id = new.request_id;
    if new.owner_id is null then select owner_id into new.owner_id from organizations where id = new.org_id; end if;
  elsif tg_table_name = 'shipments' then
    select owner_id into new.owner_id from orders where id = new.order_id;
  elsif tg_table_name = 'rfqs' then
    select owner_id into new.owner_id from requests where id = new.request_id;
  end if;
  return new;
end $$;
do $$ declare t text; begin
  foreach t in array array['requests', 'quotes', 'orders', 'shipments', 'rfqs'] loop
    execute format('drop trigger if exists %I on %I', t || '_inherit_owner', t);
    execute format('create trigger %I before insert on %I for each row execute function inherit_owner()', t || '_inherit_owner', t);
  end loop;
end $$;

-- the orders list reads this view: rebuild it so it carries owner_id / created_by (same columns as before, plus those two via o.*)
drop view if exists order_overview;
create view order_overview as
select o.*, org.name as client_name, s.name as supplier_name,
  (select count(*) from shipments sh where sh.order_id = o.id) as shipment_count,
  (select max(sh.eta) from shipments sh where sh.order_id = o.id) as latest_eta,
  case when o.cost_total > 0 then round((o.subtotal - o.cost_total) / o.cost_total * 100, 2) end as margin_pct,
  case when o.subtotal > 0 then round((o.subtotal - o.cost_total - o.freight_total), 2) end as gross_profit
from orders o
join organizations org on org.id = o.org_id
left join suppliers s on s.id = o.supplier_id;
alter view order_overview set (security_invoker = true);
revoke all on order_overview from anon, authenticated;
grant select on order_overview to service_role;
