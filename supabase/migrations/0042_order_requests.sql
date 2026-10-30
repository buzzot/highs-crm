-- "New order" in the client portal: the client sends an order (products, delivery, their PO) that the team reviews.
-- It is stored as a sourcing request marked kind = 'order', with the extra order details next to it.
alter table requests add column if not exists kind text not null default 'request';
alter table requests add column if not exists order_info jsonb;
do $$ begin
  alter table requests add constraint requests_kind_check check (kind in ('request', 'order'));
exception when duplicate_object then null; end $$;
