-- 0035: forwarder invoice files attached to a freight cost line (entity_type 'freight_cost'). Run once in the Supabase SQL editor.
alter table documents drop constraint if exists documents_entity_type_check;
alter table documents add constraint documents_entity_type_check check (entity_type in ('request','quote','order','shipment','product','supplier','rfq','freight_cost'));
