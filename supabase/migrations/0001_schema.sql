-- Highs Business — Order Tracking & CRM
-- Run in Supabase SQL editor (or `supabase db push`).

create extension if not exists "pgcrypto";

-- ---------- enums ----------
create type user_role as enum ('admin', 'staff', 'client');
create type request_status as enum ('new', 'reviewing', 'quoted', 'accepted', 'declined', 'cancelled');
create type quote_status as enum ('draft', 'sent', 'accepted', 'rejected', 'expired');
create type order_status as enum (
  'confirmed', 'deposit_paid', 'in_production', 'qc', 'packed',
  'shipped', 'in_transit', 'customs', 'delivered', 'closed', 'cancelled'
);
create type shipment_mode as enum ('sea_fcl', 'sea_lcl', 'air', 'rail', 'express');
create type shipment_status as enum ('planned', 'booked', 'picked_up', 'departed', 'arrived', 'customs', 'delivered');
create type freight_cost_type as enum (
  'origin_handling', 'export_declaration', 'main_freight', 'insurance',
  'destination_handling', 'import_duty', 'import_vat', 'customs_brokerage', 'last_mile', 'other'
);
create type document_kind as enum (
  'product_photo', 'packing_photo', 'proforma_invoice', 'commercial_invoice', 'packing_list',
  'bill_of_lading', 'airway_bill', 'export_declaration', 'certificate', 'qc_report', 'other'
);

-- ---------- core ----------
create table organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text,
  address text,
  tax_id text,
  default_currency text not null default 'USD',
  notes text,
  active boolean not null default true,
  created_at timestamptz not null default now()
);

-- one row per auth user; org_id null for staff/admin
create table profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  role user_role not null default 'client',
  org_id uuid references organizations(id) on delete set null,
  active boolean not null default true,
  created_at timestamptz not null default now()
);
create index on profiles(org_id);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  email text not null,
  role user_role not null default 'client',
  org_id uuid references organizations(id) on delete cascade,
  invited_by uuid references profiles(id),
  accepted_at timestamptz,
  created_at timestamptz not null default now()
);

create table settings (
  key text primary key,
  value jsonb not null,
  updated_at timestamptz not null default now()
);
insert into settings(key, value) values
  ('fx_rates', '{"CNY_USD": 0.138, "USD_CNY": 7.25}'),
  ('pricing', '{"min_margin_pct": 20, "default_margin_pct": 25}');

-- ---------- suppliers & products ----------
create table suppliers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  country text default 'China',
  city text,
  contact_name text,
  phone text,
  email text,
  wechat text,
  website text,
  payment_terms text,
  lead_time_days int,
  rating smallint check (rating between 1 and 5),
  can_export_official boolean default false, -- holds export licence / can issue export declaration
  notes text,
  created_at timestamptz not null default now()
);

create table products (
  id uuid primary key default gen_random_uuid(),
  sku text unique,
  name text not null,
  category text,
  description text,
  spec jsonb default '{}',
  supplier_id uuid references suppliers(id) on delete set null,
  unit_cost numeric(12,4),           -- supplier cost
  cost_currency text not null default 'CNY',
  moq int,
  hs_code text,
  unit_weight_kg numeric(10,3),
  carton_qty int,
  carton_cbm numeric(10,4),
  carton_weight_kg numeric(10,3),
  created_at timestamptz not null default now()
);
create index on products(supplier_id);

create table forwarders (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  contact_name text,
  email text,
  phone text,
  wechat text,
  modes shipment_mode[] default '{}',
  notes text,
  created_at timestamptz not null default now()
);

-- ---------- client requests → quotes → orders ----------
create table requests (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null default ('REQ-' || to_char(now(), 'YYMM') || '-' || lpad(floor(random()*9999)::text, 4, '0')),
  org_id uuid not null references organizations(id) on delete cascade,
  created_by uuid references profiles(id),
  title text not null,
  description text,
  quantity int,
  target_unit_price numeric(12,4),
  target_currency text default 'USD',
  destination_country text,
  destination_city text,
  needed_by date,
  status request_status not null default 'new',
  assigned_to uuid references profiles(id),
  internal_notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on requests(org_id);
create index on requests(status);

create table quotes (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  product_id uuid references products(id),
  supplier_id uuid references suppliers(id),
  quantity int not null,
  unit_cost numeric(12,4) not null,            -- product cost (supplier price)
  cost_currency text not null default 'CNY',
  fx_rate numeric(12,6) not null,              -- cost_currency -> sell_currency
  margin_pct numeric(6,2) not null,            -- on product cost, min 20
  sell_currency text not null default 'USD',
  unit_price numeric(12,4) not null,           -- sell price ex-logistics
  freight_estimate numeric(12,2) default 0,    -- total, sell currency
  duties_estimate numeric(12,2) default 0,
  other_costs numeric(12,2) default 0,
  landed_unit_price numeric(12,4),             -- computed: unit_price + (freight+duties+other)/qty
  incoterm text default 'FOB',
  lead_time_days int,
  valid_until date,
  status quote_status not null default 'draft',
  ai_check jsonb,                              -- {ok, score, issues:[...], checked_at}
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index on quotes(request_id);

create table orders (
  id uuid primary key default gen_random_uuid(),
  order_no text unique not null default ('HB-' || to_char(now(), 'YYMM') || '-' || lpad(floor(random()*9999)::text, 4, '0')),
  org_id uuid not null references organizations(id),
  request_id uuid references requests(id),
  quote_id uuid references quotes(id),
  supplier_id uuid references suppliers(id),
  status order_status not null default 'confirmed',
  currency text not null default 'USD',
  subtotal numeric(14,2) default 0,            -- client-facing goods total
  cost_total numeric(14,2) default 0,          -- supplier cost total (sell currency)
  freight_total numeric(14,2) default 0,       -- actual freight from freight_costs
  client_notes text,
  internal_notes text,
  expected_ship_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on orders(org_id);
create index on orders(status);

create table order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  product_id uuid references products(id),
  description text not null,
  quantity int not null,
  unit_cost numeric(12,4),
  unit_price numeric(12,4) not null,
  hs_code text
);

-- ---------- logistics ----------
create table shipments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  forwarder_id uuid references forwarders(id),
  mode shipment_mode not null default 'sea_lcl',
  incoterm text default 'FOB',
  origin_port text,
  destination_port text,
  container_no text,
  tracking_no text,
  bl_no text,
  export_declaration_no text,                  -- government-issued customs declaration
  export_official boolean not null default true,
  etd date,
  eta date,
  atd date,
  ata date,
  status shipment_status not null default 'planned',
  gross_weight_kg numeric(12,3),
  volume_cbm numeric(12,4),
  cartons int,
  notes text,
  created_at timestamptz not null default now()
);
create index on shipments(order_id);

create table freight_costs (
  id uuid primary key default gen_random_uuid(),
  shipment_id uuid not null references shipments(id) on delete cascade,
  type freight_cost_type not null,
  description text,
  amount numeric(12,2) not null,
  currency text not null default 'USD',
  fx_to_order numeric(12,6) default 1,         -- to order currency
  invoice_ref text,
  paid boolean default false,
  paid_at date,
  created_at timestamptz not null default now()
);
create index on freight_costs(shipment_id);

create table packing_lists (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  carton_no text not null,
  product_id uuid references products(id),
  description text,
  quantity int,
  length_cm numeric(8,2),
  width_cm numeric(8,2),
  height_cm numeric(8,2),
  gross_weight_kg numeric(10,3),
  net_weight_kg numeric(10,3),
  cbm numeric(10,4) generated always as (coalesce(length_cm,0)*coalesce(width_cm,0)*coalesce(height_cm,0)/1000000) stored
);

create table documents (
  id uuid primary key default gen_random_uuid(),
  entity_type text not null check (entity_type in ('request','quote','order','shipment','product','supplier')),
  entity_id uuid not null,
  kind document_kind not null default 'other',
  title text,
  storage_path text not null,                  -- in bucket "documents"
  mime_type text,
  size_bytes bigint,
  client_visible boolean not null default true,
  uploaded_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index on documents(entity_type, entity_id);

create table activity_log (
  id bigserial primary key,
  entity_type text not null,
  entity_id uuid not null,
  action text not null,
  detail jsonb,
  actor_id uuid references profiles(id),
  client_visible boolean not null default false,
  created_at timestamptz not null default now()
);
create index on activity_log(entity_type, entity_id, created_at desc);

-- ---------- triggers ----------
create or replace function touch_updated_at() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
create trigger requests_touch before update on requests for each row execute function touch_updated_at();
create trigger orders_touch before update on orders for each row execute function touch_updated_at();

-- create profile automatically when a user is created via invite
create or replace function handle_new_user() returns trigger language plpgsql security definer as $$
declare inv record;
begin
  select * into inv from invitations where lower(email) = lower(new.email) and accepted_at is null order by created_at desc limit 1;
  insert into profiles(id, email, full_name, role, org_id)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''),
          coalesce(inv.role, (new.raw_user_meta_data->>'role')::user_role, 'client'),
          coalesce(inv.org_id, (new.raw_user_meta_data->>'org_id')::uuid));
  if inv.id is not null then update invitations set accepted_at = now() where id = inv.id; end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users for each row execute function handle_new_user();

-- order freight_total roll-up
create or replace function recalc_order_freight() returns trigger language plpgsql as $$
declare oid uuid;
begin
  select order_id into oid from shipments where id = coalesce(new.shipment_id, old.shipment_id);
  update orders o set freight_total = coalesce((
    select sum(fc.amount * coalesce(fc.fx_to_order,1)) from freight_costs fc
    join shipments s on s.id = fc.shipment_id where s.order_id = oid), 0)
  where o.id = oid;
  return null;
end $$;
create trigger freight_costs_rollup after insert or update or delete on freight_costs
  for each row execute function recalc_order_freight();

-- ---------- helper functions for RLS ----------
create or replace function current_role_of() returns user_role language sql stable security definer as $$
  select role from profiles where id = auth.uid()
$$;
create or replace function current_org() returns uuid language sql stable security definer as $$
  select org_id from profiles where id = auth.uid()
$$;
create or replace function is_staff() returns boolean language sql stable security definer as $$
  select coalesce((select role in ('admin','staff') from profiles where id = auth.uid()), false)
$$;

-- ---------- RLS ----------
alter table organizations enable row level security;
alter table profiles enable row level security;
alter table invitations enable row level security;
alter table settings enable row level security;
alter table suppliers enable row level security;
alter table products enable row level security;
alter table forwarders enable row level security;
alter table requests enable row level security;
alter table quotes enable row level security;
alter table orders enable row level security;
alter table order_items enable row level security;
alter table shipments enable row level security;
alter table freight_costs enable row level security;
alter table packing_lists enable row level security;
alter table documents enable row level security;
alter table activity_log enable row level security;

-- staff: full access everywhere
create policy staff_all_organizations on organizations for all using (is_staff()) with check (is_staff());
create policy staff_all_profiles on profiles for all using (is_staff()) with check (is_staff());
create policy staff_all_invitations on invitations for all using (is_staff()) with check (is_staff());
create policy staff_all_settings on settings for all using (is_staff()) with check (is_staff());
create policy staff_all_suppliers on suppliers for all using (is_staff()) with check (is_staff());
create policy staff_all_products on products for all using (is_staff()) with check (is_staff());
create policy staff_all_forwarders on forwarders for all using (is_staff()) with check (is_staff());
create policy staff_all_requests on requests for all using (is_staff()) with check (is_staff());
create policy staff_all_quotes on quotes for all using (is_staff()) with check (is_staff());
create policy staff_all_orders on orders for all using (is_staff()) with check (is_staff());
create policy staff_all_order_items on order_items for all using (is_staff()) with check (is_staff());
create policy staff_all_shipments on shipments for all using (is_staff()) with check (is_staff());
create policy staff_all_freight on freight_costs for all using (is_staff()) with check (is_staff());
create policy staff_all_packing on packing_lists for all using (is_staff()) with check (is_staff());
create policy staff_all_documents on documents for all using (is_staff()) with check (is_staff());
create policy staff_all_activity on activity_log for all using (is_staff()) with check (is_staff());

-- clients: own org only; never see costs/suppliers/freight
create policy client_own_org on organizations for select using (id = current_org());
create policy client_own_profile on profiles for select using (id = auth.uid() or org_id = current_org());
create policy client_requests_select on requests for select using (org_id = current_org());
create policy client_requests_insert on requests for insert with check (org_id = current_org() and created_by = auth.uid());
create policy client_requests_update on requests for update using (org_id = current_org() and status in ('new','quoted'));
create policy client_quotes_select on quotes for select
  using (status in ('sent','accepted','rejected','expired') and request_id in (select id from requests where org_id = current_org()));
create policy client_orders_select on orders for select using (org_id = current_org());
create policy client_order_items_select on order_items for select using (order_id in (select id from orders where org_id = current_org()));
create policy client_shipments_select on shipments for select using (order_id in (select id from orders where org_id = current_org()));
create policy client_packing_select on packing_lists for select using (order_id in (select id from orders where org_id = current_org()));
create policy client_documents_select on documents for select using (
  client_visible and (
    (entity_type = 'order' and entity_id in (select id from orders where org_id = current_org())) or
    (entity_type = 'shipment' and entity_id in (select s.id from shipments s join orders o on o.id = s.order_id where o.org_id = current_org())) or
    (entity_type = 'request' and entity_id in (select id from requests where org_id = current_org()))
  ));
create policy client_activity_select on activity_log for select using (
  client_visible and (
    (entity_type = 'order' and entity_id in (select id from orders where org_id = current_org())) or
    (entity_type = 'request' and entity_id in (select id from requests where org_id = current_org()))
  ));

-- ---------- storage ----------
insert into storage.buckets (id, name, public) values ('documents', 'documents', false)
  on conflict (id) do nothing;
create policy staff_storage_all on storage.objects for all
  using (bucket_id = 'documents' and is_staff()) with check (bucket_id = 'documents' and is_staff());
-- clients download via signed URLs generated server-side; no direct policy needed.

-- ---------- views ----------
create or replace view order_overview as
select o.*, org.name as client_name, s.name as supplier_name,
  (select count(*) from shipments sh where sh.order_id = o.id) as shipment_count,
  (select max(sh.eta) from shipments sh where sh.order_id = o.id) as latest_eta,
  case when o.cost_total > 0 then round((o.subtotal - o.cost_total) / o.cost_total * 100, 2) end as margin_pct,
  case when o.subtotal > 0 then round((o.subtotal - o.cost_total - o.freight_total), 2) end as gross_profit
from orders o
join organizations org on org.id = o.org_id
left join suppliers s on s.id = o.supplier_id;
