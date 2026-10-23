-- 0031: supplier product editing. A supplier can edit a product until staff approve it; after approval they ask for
-- an edit, staff release it, the supplier changes it (status "updated") and staff apply the changes to the catalog.
-- Run once in the Supabase SQL editor.
alter table supplier_products drop constraint if exists supplier_products_status_check;
alter table supplier_products add constraint supplier_products_status_check
  check (status in ('draft', 'submitted', 'returned', 'approved', 'edit_requested', 'unlocked', 'updated'));
alter table supplier_products add column if not exists edit_reason text;   -- why the supplier wants to change an approved product
