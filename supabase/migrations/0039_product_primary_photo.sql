-- 0039: lets staff choose which photo is the main one for a product.
-- Optional: until this is run the product pages keep working and the first uploaded photo stays the main one.
alter table products add column if not exists primary_photo_id uuid references documents(id) on delete set null;
