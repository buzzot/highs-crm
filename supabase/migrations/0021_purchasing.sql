-- 0021: purchasing — purchase orders we send to suppliers after a client order is confirmed
create table if not exists supplier_pos (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null default ('SPO-' || to_char(now(), 'YYMM') || '-' || lpad(floor(random()*9999)::text, 4, '0')),
  token text unique not null default substr(md5(random()::text || clock_timestamp()::text), 1, 10), -- matches email replies
  order_id uuid not null references orders(id) on delete cascade,
  supplier_id uuid references suppliers(id) on delete set null,
  status text not null default 'draft' check (status in ('draft', 'sent', 'replied', 'confirmed', 'declined', 'cancelled')),
  currency text not null default 'CNY',
  lines jsonb not null default '[]'::jsonb,   -- [{description, sku, quantity, unit, unit_price, product_id, order_item_id}]
  total numeric(14,2) not null default 0,
  required_date date,                          -- when we need the goods ready
  payment_terms text,
  ship_to text,                                -- delivery / pickup instructions
  notes text,
  message text,                                -- personal note in the email
  want_packing boolean not null default true,  -- ask for an estimated packing list with the PO
  sent_to text,
  sent_at timestamptz,
  sent_by uuid references profiles(id),
  confirmed_at timestamptz,
  last_reply_at timestamptz,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists supplier_pos_order_idx on supplier_pos(order_id);
create index if not exists supplier_pos_status_idx on supplier_pos(status, created_at desc);

-- every answer from the supplier (email reply, pasted WeChat message, typed by hand)
create table if not exists supplier_po_responses (
  id uuid primary key default gen_random_uuid(),
  po_id uuid not null references supplier_pos(id) on delete cascade,
  channel text not null default 'email' check (channel in ('email', 'wechat', 'manual')),
  from_address text,
  subject text,
  body text,
  outcome text check (outcome in ('confirmed', 'declined', 'question', 'info')),
  extracted jsonb,        -- { summary, ready_date, pi_no, pi_amount, pi_currency, packing, changes, questions, files: [{id,name}] }
  received_at timestamptz not null default now(),
  created_by uuid references profiles(id)
);
create index if not exists supplier_po_responses_idx on supplier_po_responses(po_id, received_at desc);

alter table supplier_pos enable row level security;
alter table supplier_po_responses enable row level security;
drop policy if exists staff_all_supplier_pos on supplier_pos;
create policy staff_all_supplier_pos on supplier_pos for all using (is_staff()) with check (is_staff());
drop policy if exists staff_all_supplier_po_responses on supplier_po_responses;
create policy staff_all_supplier_po_responses on supplier_po_responses for all using (is_staff()) with check (is_staff());
grant all on supplier_pos, supplier_po_responses to service_role;
