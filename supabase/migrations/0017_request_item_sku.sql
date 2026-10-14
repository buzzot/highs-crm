-- optional SKU / part number per requested product
alter table request_items add column if not exists sku text;
