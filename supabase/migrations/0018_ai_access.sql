-- AI on/off per company (client or supplier), and who used how many tokens
alter table organizations add column if not exists ai_enabled boolean not null default false;
alter table suppliers add column if not exists ai_enabled boolean not null default false;
alter table ai_usage add column if not exists org_id uuid references organizations(id) on delete set null;
alter table ai_usage add column if not exists supplier_id uuid references suppliers(id) on delete set null;
create index if not exists ai_usage_org_idx on ai_usage(org_id, created_at desc);
create index if not exists ai_usage_supplier_idx on ai_usage(supplier_id, created_at desc);
