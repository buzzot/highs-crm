-- 0005: product import (Excel template / supplier price lists / PDF with AI) with manual confirmation.

-- products: supplier's own SKU + unit and carton sizes
alter table products add column if not exists supplier_sku text;
alter table products add column if not exists unit_length_cm numeric(10,2);
alter table products add column if not exists unit_width_cm numeric(10,2);
alter table products add column if not exists unit_height_cm numeric(10,2);
alter table products add column if not exists carton_length_cm numeric(10,2);
alter table products add column if not exists carton_width_cm numeric(10,2);
alter table products add column if not exists carton_height_cm numeric(10,2);
create index if not exists products_supplier_sku on products (supplier_id, lower(supplier_sku));

-- suppliers: address
alter table suppliers add column if not exists address text;

-- staged imports: nothing touches suppliers/products until an admin confirms
create table if not exists product_imports (
  id uuid primary key default gen_random_uuid(),
  file_name text not null,
  file_path text,                         -- original file in the "documents" bucket
  method text not null,                   -- 'template' | 'spreadsheet' | 'ai'
  status text not null default 'review' check (status in ('review', 'committed', 'cancelled')),
  supplier jsonb not null default '{}',   -- extracted supplier details
  supplier_match jsonb,                   -- { status, candidates[] }
  rows jsonb not null default '[]',       -- products being reviewed
  ai_notes text,
  ai_model text,
  result jsonb,                           -- { supplier_id, created, updated, skipped }
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  committed_at timestamptz,
  committed_by uuid references profiles(id)
);
alter table product_imports enable row level security;
drop policy if exists staff_all_product_imports on product_imports;
create policy staff_all_product_imports on product_imports for all using (is_staff()) with check (is_staff());
grant all on product_imports to service_role;

-- Clients have no access to products, suppliers or imports (staff only).
