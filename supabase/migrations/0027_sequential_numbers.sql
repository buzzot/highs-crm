-- 0027: sequential document numbers per month instead of random ones:
--   orders LT-YYMM-0001, proforma invoices PI-…, purchase orders PO-…, and (allocated by the app) commercial invoices CI-… and packing lists PL-…
-- Existing numbers are left as they are. Run this once in the Supabase SQL editor.

create table if not exists doc_counters (
  prefix text not null,
  ym text not null,
  last int not null default 0,
  primary key (prefix, ym)
);
alter table doc_counters enable row level security;   -- only the functions below touch it

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
    -- skip a number that an old random one already uses
    taken := case p
      when 'LT' then exists (select 1 from orders where order_no = cand)
      when 'PI' then exists (select 1 from proforma_invoices where pi_no = cand)
      when 'PO' then exists (select 1 from purchase_orders where po_no = cand)
      else false end;
    exit when not taken;
  end loop;
  return cand;
end $$;
grant execute on function next_doc_no(text) to service_role, authenticated;

alter table orders alter column order_no set default next_doc_no('LT');
alter table proforma_invoices alter column pi_no set default next_doc_no('PI');
alter table purchase_orders alter column po_no set default next_doc_no('PO');
