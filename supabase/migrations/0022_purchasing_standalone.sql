-- 0022: a supplier PO can exist before (or without) a client order, and be linked to one later
alter table supplier_pos alter column order_id drop not null;
alter table supplier_pos add column if not exists title text;  -- internal label, e.g. "Stock for November"
