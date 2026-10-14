-- 0019: client purchase orders (PO) and proforma invoices (PI)
create table if not exists purchase_orders (
  id uuid primary key default gen_random_uuid(),
  po_no text unique not null default ('PO-' || to_char(now(), 'YYMM') || '-' || lpad(floor(random()*9999)::text, 4, '0')),
  quote_id uuid references quotes(id) on delete set null,
  request_id uuid references requests(id) on delete cascade,
  org_id uuid not null references organizations(id),
  order_id uuid references orders(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'submitted', 'approved', 'rejected')),
  client jsonb not null default '{}'::jsonb,       -- company, contact, email, phone, address, delivery_address, ref
  lines jsonb not null default '[]'::jsonb,        -- [{description, sku, quantity, unit, unit_price}]
  currency text not null default 'USD',
  incoterm text,
  lead_time_days int,
  client_notes text,
  terms text,
  admin_comment text,                               -- internal
  admin_note text,                                  -- shown to the client when rejected
  created_by uuid references profiles(id),
  submitted_at timestamptz,
  decided_at timestamptz,
  decided_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists purchase_orders_quote_live on purchase_orders(quote_id) where status in ('draft', 'submitted', 'approved');
create index if not exists purchase_orders_status_idx on purchase_orders(status, submitted_at desc);
create index if not exists purchase_orders_org_idx on purchase_orders(org_id);

create table if not exists proforma_invoices (
  id uuid primary key default gen_random_uuid(),
  pi_no text unique not null default ('PI-' || to_char(now(), 'YYMM') || '-' || lpad(floor(random()*9999)::text, 4, '0')),
  order_id uuid not null references orders(id) on delete cascade,
  po_id uuid references purchase_orders(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'sent')),
  data jsonb not null default '{}'::jsonb,          -- buyer, lines, currency, incoterm, payment_terms, bank, notes, valid_until
  sent_at timestamptz,
  sent_by uuid references profiles(id),
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists proforma_invoices_order_idx on proforma_invoices(order_id);

alter table purchase_orders enable row level security;
alter table proforma_invoices enable row level security;
drop policy if exists staff_all_purchase_orders on purchase_orders;
create policy staff_all_purchase_orders on purchase_orders for all using (is_staff()) with check (is_staff());
drop policy if exists staff_all_proforma_invoices on proforma_invoices;
create policy staff_all_proforma_invoices on proforma_invoices for all using (is_staff()) with check (is_staff());
grant all on purchase_orders, proforma_invoices to service_role;
