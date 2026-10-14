-- A shipment can carry only part of an order (the rest goes on a later shipment).
alter table shipments add column if not exists partial boolean not null default false;
