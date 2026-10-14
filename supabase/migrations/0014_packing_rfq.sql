-- 0014: packing list lines (a line can cover several identical cartons), packing-list header,
--       and freight quote requests sent to forwarders
alter table packing_lists add column if not exists cartons int not null default 1 check (cartons > 0);
alter table packing_lists add column if not exists sku text;
alter table packing_lists add column if not exists hs_code text;
alter table packing_lists add column if not exists position int not null default 0;

-- header of the standard packing list (ready date, ports, marks, cargo notes…)
alter table orders add column if not exists packing_info jsonb not null default '{}';

-- one quote request = one send-out of a packing list to one or more forwarders
create table if not exists freight_requests (
  id uuid primary key default gen_random_uuid(),
  ref text unique not null default ('FQ-' || to_char(now(), 'YYMM') || '-' || lpad(floor(random()*9999)::text, 4, '0')),
  order_id uuid not null references orders(id) on delete cascade,
  info jsonb not null default '{}',       -- mode, ports, ready date… as sent
  totals jsonb not null default '{}',     -- cartons, pieces, gross, cbm as sent
  message text,
  created_by uuid references profiles(id),
  created_at timestamptz not null default now()
);
create index if not exists freight_requests_created_idx on freight_requests(created_at desc);

-- one row per forwarder the request went to
create table if not exists freight_rfqs (
  id uuid primary key default gen_random_uuid(),
  request_id uuid references freight_requests(id) on delete cascade,
  token text unique not null default substr(md5(random()::text || clock_timestamp()::text), 1, 10), -- matches email replies
  order_id uuid not null references orders(id) on delete cascade,
  forwarder_id uuid references forwarders(id) on delete set null,
  sent_to text,                     -- email address used
  channel text not null default 'email' check (channel in ('email', 'wechat')),
  message text,
  status text not null default 'sent' check (status in ('sent', 'quoted', 'declined', 'accepted')),
  quote_amount numeric(12,2),
  quote_currency text,
  quote_notes text,
  sent_by uuid references profiles(id),
  sent_at timestamptz not null default now(),
  quoted_at timestamptz,
  transit_days int,
  valid_until date
);

-- every answer received (email reply, pasted WeChat message, typed by hand)
create table if not exists freight_responses (
  id uuid primary key default gen_random_uuid(),
  rfq_id uuid references freight_rfqs(id) on delete cascade,
  request_id uuid references freight_requests(id) on delete cascade,
  channel text not null default 'email' check (channel in ('email', 'wechat', 'manual')),
  from_address text,
  subject text,
  body text,
  extracted jsonb,                         -- { amount, currency, transit_days, valid_until, mode, includes, excludes, notes }
  received_at timestamptz not null default now(),
  created_by uuid references profiles(id)
);
create index if not exists freight_responses_req_idx on freight_responses(request_id, received_at desc);
alter table freight_requests enable row level security;
alter table freight_responses enable row level security;
drop policy if exists staff_all_freight_requests on freight_requests;
create policy staff_all_freight_requests on freight_requests for all using (is_staff()) with check (is_staff());
drop policy if exists staff_all_freight_responses on freight_responses;
create policy staff_all_freight_responses on freight_responses for all using (is_staff()) with check (is_staff());
grant all on freight_requests, freight_responses to service_role;
create index if not exists freight_rfqs_order_idx on freight_rfqs(order_id, sent_at desc);
alter table freight_rfqs enable row level security;
drop policy if exists staff_all_freight_rfqs on freight_rfqs;
create policy staff_all_freight_rfqs on freight_rfqs for all using (is_staff()) with check (is_staff());
grant all on freight_rfqs to service_role;
