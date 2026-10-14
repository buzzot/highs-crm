-- 0013: one row per AI call — who, what for, which model, how many tokens
create table if not exists ai_usage (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  user_id uuid references profiles(id) on delete set null,
  feature text not null,              -- quote_check, sourcing_brief, product_extract, product_review, product_compare
  model text,
  input_tokens int not null default 0,
  output_tokens int not null default 0,
  cache_read_tokens int not null default 0,
  cache_write_tokens int not null default 0,
  entity_type text,
  entity_id text,
  ok boolean not null default true,
  error text
);
create index if not exists ai_usage_created_idx on ai_usage(created_at desc);
create index if not exists ai_usage_entity_idx on ai_usage(entity_type, entity_id, created_at desc);

alter table ai_usage enable row level security;
drop policy if exists staff_read_ai_usage on ai_usage;
create policy staff_read_ai_usage on ai_usage for select using (is_staff());
grant all on ai_usage to service_role;
grant usage, select on sequence ai_usage_id_seq to service_role;
