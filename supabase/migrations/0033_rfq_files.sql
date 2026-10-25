-- 0033: files attached to an RFQ (the client's original documents + extra files) and the AI check of those files.
-- Run once in the Supabase SQL editor.
alter table rfqs add column if not exists file_ids jsonb not null default '[]'::jsonb;        -- ids in documents, shown to every supplier of this RFQ
alter table rfqs add column if not exists file_review jsonb not null default '{}'::jsonb;     -- document id -> { status: ok|warn|unchecked, language, issues[], note }

-- files uploaded straight to an RFQ are stored with entity_type 'rfq'
alter table documents drop constraint if exists documents_entity_type_check;
alter table documents add constraint documents_entity_type_check check (entity_type in ('request','quote','order','shipment','product','supplier','rfq'));
