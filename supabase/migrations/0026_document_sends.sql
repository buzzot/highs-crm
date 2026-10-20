-- 0026: history of documents e-mailed by hand to a client (or anyone else) from the shipping documents panel
create table if not exists document_sends (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  sent_at timestamptz not null default now(),
  sent_by uuid references profiles(id) on delete set null,
  to_emails text[] not null default '{}',
  message text
);
create index if not exists document_sends_doc_idx on document_sends(document_id, sent_at desc);
alter table document_sends enable row level security;
create policy staff_all_document_sends on document_sends for all using (is_staff()) with check (is_staff());
