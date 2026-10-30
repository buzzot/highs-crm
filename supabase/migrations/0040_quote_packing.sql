-- 0040: internal packing weight / volume per quote line, and the shared logistics line of a quotation.
-- Run once in the Supabase SQL editor. Nothing here is shown to the client.
alter table quotes add column if not exists pack_kg numeric(14,3);      -- total gross weight of this line (internal)
alter table quotes add column if not exists pack_cbm numeric(14,4);     -- total volume of this line (internal)
alter table quotes add column if not exists freight_basis text;         -- 'sea' = split by volume, 'air' = by chargeable weight
alter table quotes add column if not exists freight_total numeric(14,2); -- logistics amount for the whole quotation, selling currency
alter table quotes add column if not exists freight_note text;          -- internal note: where the amount came from
