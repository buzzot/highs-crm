-- 0020: payments against the proforma invoice (order status 'new', payment tracking)
alter type order_status add value if not exists 'new' before 'confirmed';
alter type document_kind add value if not exists 'payment_proof';

alter table orders
  add column if not exists payment_status text not null default 'unpaid' check (payment_status in ('unpaid', 'partial', 'paid')),
  add column if not exists amount_due numeric(14,2),            -- proforma invoice total
  add column if not exists amount_paid numeric(14,2) not null default 0,  -- submitted + confirmed payments (not rejected)
  add column if not exists payment_due_date date,               -- next unpaid instalment
  add column if not exists payment_schedule jsonb not null default '[]'::jsonb;  -- [{label, percent, amount, due}]

create table if not exists order_payments (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references orders(id) on delete cascade,
  org_id uuid not null references organizations(id),
  amount numeric(14,2) not null check (amount > 0),
  currency text not null,
  paid_on date,
  label text,                                   -- Deposit / Balance / ...
  reference text,                               -- bank reference, transfer id
  note text,
  proof_doc_ids jsonb not null default '[]'::jsonb,
  status text not null default 'submitted' check (status in ('submitted', 'confirmed', 'rejected')),
  admin_note text,
  created_by uuid references profiles(id),
  decided_by uuid references profiles(id),
  decided_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists order_payments_order_idx on order_payments(order_id, created_at);
create index if not exists order_payments_status_idx on order_payments(status);

alter table order_payments enable row level security;
drop policy if exists staff_all_order_payments on order_payments;
create policy staff_all_order_payments on order_payments for all using (is_staff()) with check (is_staff());
grant all on order_payments to service_role;

-- clients read these order columns (column-level grants, see 0002)
grant select (payment_status, amount_due, amount_paid, payment_due_date, payment_schedule) on orders to authenticated;
