-- 0009: one sourcing request can contain several products
create table if not exists request_items (
  id uuid primary key default gen_random_uuid(),
  request_id uuid not null references requests(id) on delete cascade,
  position int not null default 0,
  name text not null,
  description text,
  quantity int,
  unit text not null default 'pcs',
  target_unit_price numeric(12,4),
  created_at timestamptz not null default now()
);
create index if not exists request_items_request_idx on request_items(request_id, position);

alter table request_items enable row level security;
drop policy if exists staff_all_request_items on request_items;
create policy staff_all_request_items on request_items for all using (is_staff()) with check (is_staff());
drop policy if exists client_request_items_select on request_items;
create policy client_request_items_select on request_items for select
  using (request_id in (select id from requests where org_id = current_org()));
grant select on request_items to authenticated;
grant all on request_items to service_role;

-- photos / files can belong to one product of the request
alter table documents add column if not exists request_item_id uuid references request_items(id) on delete set null;
-- a quote can answer one product of the request
alter table quotes add column if not exists request_item_id uuid references request_items(id) on delete set null;
grant select (request_item_id) on quotes to authenticated;

-- existing requests become one-product requests
insert into request_items (request_id, position, name, description, quantity, target_unit_price)
select r.id, 0, r.title, r.description, r.quantity, r.target_unit_price
from requests r
where not exists (select 1 from request_items i where i.request_id = r.id);
