-- 0028: products added by suppliers themselves (supplier portal "Add product" wizard).
-- A submission lives here until staff approve it; approving creates the real product, so nothing
-- in quotes, orders or pricing sees an unreviewed product. Run once in the Supabase SQL editor.
create table if not exists supplier_products (
  id uuid primary key default gen_random_uuid(),
  supplier_id uuid not null references suppliers(id) on delete cascade,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'returned', 'approved')),
  data jsonb not null default '{}'::jsonb,       -- everything the supplier filled in; photo document ids are in data.photo_ids
  review_note text,                              -- why staff sent it back
  product_id uuid references products(id) on delete set null,   -- the product created on approval
  created_by uuid references profiles(id) on delete set null,
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supplier_products_supplier_idx on supplier_products(supplier_id, status);
create index if not exists supplier_products_status_idx on supplier_products(status, submitted_at);
alter table supplier_products enable row level security;
create policy staff_all_supplier_products on supplier_products for all using (is_staff()) with check (is_staff());
