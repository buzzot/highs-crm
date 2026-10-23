-- 0030: product details on a sourcing request line (material, certifications, terms, ETD, validity …).
-- Same keys as the supplier "Add product" wizard (see src/lib/request-spec.js), so a supplier's RFQ answer can later become a product.
alter table request_items add column if not exists spec jsonb not null default '{}'::jsonb;
alter table documents add column if not exists request_item_id uuid references request_items(id) on delete set null;
