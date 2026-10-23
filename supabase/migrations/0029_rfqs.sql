-- 0029: requests for quotation (RFQ) sent to several suppliers at once. One RFQ → many suppliers → one comparison.
-- Run once in the Supabase SQL editor (after 0027, which provides next_doc_no).

create table if not exists rfqs (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null default next_doc_no('RFQ'),
  title text not null,
  request_id uuid references requests(id) on delete set null,       -- the sourcing request this RFQ came from (optional)
  currency text not null default 'USD',                              -- currency we would like prices in (suppliers may quote another)
  deadline date,
  message text,
  items jsonb not null default '[]'::jsonb,                          -- [{id, description, sku, quantity, unit, notes, product_id, request_item_id}]
  status text not null default 'draft' check (status in ('draft', 'open', 'closed')),
  awarded jsonb not null default '{}'::jsonb,                        -- item id → rfq_supplier id (filled by the comparison, later)
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists rfqs_request_idx on rfqs(request_id);

create table if not exists rfq_suppliers (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  token text unique not null default substr(md5(random()::text || clock_timestamp()::text), 1, 10),   -- matches email replies
  status text not null default 'draft' check (status in ('draft', 'sent', 'replied', 'declined')),
  sent_to text,
  sent_at timestamptz,
  replied_at timestamptz,
  created_at timestamptz not null default now(),
  unique (rfq_id, supplier_id)
);
create index if not exists rfq_suppliers_supplier_idx on rfq_suppliers(supplier_id, status);

-- one row per answer; the newest confirmed one counts. source: portal | email | manual. status 'parsed' = read by AI, waiting for staff to confirm.
create table if not exists rfq_responses (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid not null references rfqs(id) on delete cascade,
  rfq_supplier_id uuid not null references rfq_suppliers(id) on delete cascade,
  supplier_id uuid not null references suppliers(id) on delete cascade,
  source text not null default 'portal' check (source in ('portal', 'email', 'manual')),
  status text not null default 'confirmed' check (status in ('parsed', 'confirmed', 'declined')),
  lines jsonb not null default '[]'::jsonb,                          -- [{item_id, unit_price, currency, moq, lead_days, carton_qty, carton_l, carton_w, carton_h, gross_kg, note}]
  terms jsonb not null default '{}'::jsonb,                          -- {incoterm, fob_port, payment_terms, valid_until}
  note text,
  raw_text text,                                                     -- original email text (email source)
  file_ids jsonb not null default '[]'::jsonb,                       -- attachments, ids in documents
  created_by uuid references profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index if not exists rfq_responses_rfq_idx on rfq_responses(rfq_id, created_at desc);

alter table rfqs enable row level security;
alter table rfq_suppliers enable row level security;
alter table rfq_responses enable row level security;
create policy staff_all_rfqs on rfqs for all using (is_staff()) with check (is_staff());
create policy staff_all_rfq_suppliers on rfq_suppliers for all using (is_staff()) with check (is_staff());
create policy staff_all_rfq_responses on rfq_responses for all using (is_staff()) with check (is_staff());

create or replace function next_doc_no(p text) returns text
language plpgsql security definer set search_path = public as $$
declare
  v_ym text := to_char(now(), 'YYMM');
  n int;
  cand text;
  taken boolean;
begin
  loop
    insert into doc_counters(prefix, ym, last) values (p, v_ym, 1)
      on conflict (prefix, ym) do update set last = doc_counters.last + 1
      returning doc_counters.last into n;
    cand := p || '-' || v_ym || '-' || lpad(n::text, 4, '0');
    taken := case p
      when 'LT' then exists (select 1 from orders where order_no = cand)
      when 'PI' then exists (select 1 from proforma_invoices where pi_no = cand)
      when 'PO' then exists (select 1 from purchase_orders where po_no = cand)
      when 'RFQ' then exists (select 1 from rfqs where ref = cand)
      else false end;
    exit when not taken;
  end loop;
  return cand;
end $$;
