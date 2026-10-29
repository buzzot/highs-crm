-- 0037: the supplier's proforma invoice (PI) and our payments to the supplier. Run once in the Supabase SQL editor.
-- (Replaces an earlier draft of supplier_payments that hung on the order; payments now belong to the supplier PO.)
drop table if exists supplier_payments cascade;

create table if not exists supplier_pis (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references supplier_pos(id) on delete cascade,
  pi_no text,                                          -- the supplier's own number
  pi_date date,
  currency text not null,
  lines jsonb not null default '[]'::jsonb,            -- [{product_id, description, sku, quantity, unit, unit_price}]
  total numeric(14,2) not null default 0,              -- sum of the lines
  declared_total numeric(14,2),                        -- the total printed on the supplier's PI (must match)
  file_doc_ids jsonb not null default '[]'::jsonb,     -- the supplier's PI file(s)
  status text not null default 'draft' check (status in ('draft', 'confirmed')),   -- confirmed = lines add up to the printed total
  notes text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists supplier_pis_po_idx on supplier_pis(po_id, created_at);

create table if not exists supplier_payments (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references supplier_pos(id) on delete cascade,
  amount numeric(14,2) not null check (amount > 0),
  currency text not null,
  paid_on date,
  label text,                                          -- Deposit / Balance / ...
  reference text,
  proof_doc_ids jsonb not null default '[]'::jsonb,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists supplier_payments_po_idx on supplier_payments(po_id, created_at);

alter table supplier_pis enable row level security;
alter table supplier_payments enable row level security;
drop policy if exists staff_all_supplier_pis on supplier_pis;
create policy staff_all_supplier_pis on supplier_pis for all using (is_staff()) with check (is_staff());
drop policy if exists staff_all_supplier_payments on supplier_payments;
create policy staff_all_supplier_payments on supplier_payments for all using (is_staff()) with check (is_staff());
grant all on supplier_pis to service_role;
grant all on supplier_payments to service_role;
