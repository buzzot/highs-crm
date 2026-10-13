-- Optional demo data. Run after 0001_schema.sql.
insert into organizations (id, name, country) values
  ('11111111-1111-1111-1111-111111111111', 'Acme Retail LLC', 'USA'),
  ('22222222-2222-2222-2222-222222222222', 'Nordic Home AB', 'Sweden');

insert into suppliers (id, name, city, contact_name, wechat, lead_time_days, rating, can_export_official) values
  ('33333333-3333-3333-3333-333333333333', 'Shenzhen Brightway Electronics', 'Shenzhen', 'Li Wei', 'liwei_bw', 30, 4, true),
  ('44444444-4444-4444-4444-444444444444', 'Yiwu Sunhome Houseware', 'Yiwu', 'Chen Fang', 'sunhome88', 25, 3, false);

insert into products (sku, name, category, supplier_id, unit_cost, cost_currency, moq, hs_code, unit_weight_kg, carton_qty, carton_cbm, carton_weight_kg) values
  ('BW-LED-001', 'LED Desk Lamp 10W', 'Lighting', '33333333-3333-3333-3333-333333333333', 38.50, 'CNY', 500, '9405.20', 0.65, 20, 0.045, 14),
  ('SH-STB-210', 'Stainless Steel Tumbler 500ml', 'Houseware', '44444444-4444-4444-4444-444444444444', 12.20, 'CNY', 1000, '9617.00', 0.30, 48, 0.062, 16);

insert into forwarders (name, contact_name, email, modes) values
  ('Oceanlink Logistics', 'Amy Zhou', 'amy@oceanlink.example', '{sea_fcl,sea_lcl}'),
  ('SkyFast Freight', 'Ken Huang', 'ken@skyfast.example', '{air,express}');
