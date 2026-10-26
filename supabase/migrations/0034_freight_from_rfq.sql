-- 0034: freight quote requests can be sent straight from an RFQ's draft packing list, before there is an order.
-- Run once in the Supabase SQL editor.
alter table freight_requests alter column order_id drop not null;
alter table freight_rfqs alter column order_id drop not null;
alter table freight_requests add column if not exists rfq_id uuid references rfqs(id) on delete set null;   -- the RFQ whose answer this packing came from
alter table freight_requests add column if not exists label text;                                           -- shown to staff instead of an order number
alter table freight_requests add column if not exists cargo jsonb;                                          -- the packing lines as sent (there is no order to read them from)
create index if not exists freight_requests_rfq_idx on freight_requests(rfq_id);
