-- Orders sent from the client portal ("New order") are real orders from the start: status 'new', source 'portal'.
-- The team checks them, fills in prices / supplier / costs, then moves the status on (Confirmed …).
-- Clients cannot read these new columns directly (column-level grants stay as they are); the portal reads them server-side.
alter table orders add column if not exists source text not null default 'staff';
alter table orders add column if not exists order_info jsonb;                 -- delivery, incoterm, contact, client PO number …
alter table orders add column if not exists submitted_by uuid references profiles(id);
do $$ begin
  alter table orders add constraint orders_source_check check (source in ('staff', 'portal'));
exception when duplicate_object then null; end $$;
create index if not exists orders_portal_new_idx on orders (source, status) where source = 'portal';

alter table order_items add column if not exists sku text;
alter table order_items add column if not exists unit text;
alter table order_items add column if not exists target_unit_price numeric(12,4);   -- what the client hopes to pay (staff only)

-- Orders the clients already sent as "order requests" (migration 0042) become real orders. Each request is closed afterwards
-- (status 'accepted', linked through orders.request_id) so it is not counted twice. Safe to run again: done requests are skipped.
do $$
declare r record; oid uuid; info jsonb;
begin
  for r in
    select * from requests
    where kind = 'order' and status in ('new', 'reviewing', 'quoted')
      and not exists (select 1 from orders o where o.request_id = requests.id)
  loop
    info := coalesce(r.order_info, '{}'::jsonb) || jsonb_build_object(
      'destination_country', r.destination_country, 'destination_city', r.destination_city,
      'needed_by', r.needed_by, 'delivery_mode', r.delivery_mode, 'request_ref', r.ref);
    insert into orders (org_id, request_id, status, currency, subtotal, client_notes, source, order_info, submitted_by, created_at)
    values (r.org_id, r.id, 'new', coalesce(r.target_currency, 'USD'), 0, r.description, 'portal', info, r.created_by, r.created_at)
    returning id into oid;
    insert into order_items (order_id, description, quantity, unit_price, sku, unit, target_unit_price)
    select oid, coalesce(nullif(trim(i.name), ''), 'Item'), greatest(coalesce(round(i.quantity)::int, 0), 0), 0, i.sku, i.unit, i.target_unit_price
    from request_items i where i.request_id = r.id order by i.position;
    update documents set entity_type = 'order', entity_id = oid where entity_type = 'request' and entity_id = r.id;
    update requests set status = 'accepted' where id = r.id;
  end loop;
end $$;
