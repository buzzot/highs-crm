-- 0003: table privileges for the API roles.
-- Newer Supabase projects don't auto-grant new tables to the API roles, which shows up as
-- "permission denied for table ...". Safe to run on any project (and more than once).

grant usage on schema public to anon, authenticated, service_role;

-- Server (staff pages, invites, uploads) uses the service role: full access.
grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
alter default privileges in schema public grant execute on functions to service_role;

-- Client portal (signed-in client users). Row policies still limit them to their own company,
-- and costs/margins/suppliers stay hidden by the column grants below.
grant execute on function current_org(), is_staff(), current_role_of() to authenticated;
grant select on organizations, profiles, packing_lists, documents, activity_log to authenticated;
grant insert on requests to authenticated;

grant select (id, ref, org_id, created_by, title, description, quantity, target_unit_price, target_currency,
  destination_country, destination_city, needed_by, status, created_at, updated_at) on requests to authenticated;
grant update (title, description, quantity, target_unit_price, target_currency, destination_country, destination_city, needed_by)
  on requests to authenticated;
grant select (id, request_id, quantity, sell_currency, unit_price, freight_estimate, duties_estimate, other_costs,
  landed_unit_price, incoterm, lead_time_days, valid_until, status, notes, created_at) on quotes to authenticated;
grant select (id, order_no, org_id, request_id, status, currency, subtotal, client_notes, expected_ship_date,
  created_at, updated_at) on orders to authenticated;
grant select (id, order_id, product_id, description, quantity, unit_price, hs_code) on order_items to authenticated;
grant select (id, order_id, mode, incoterm, origin_port, destination_port, container_no, tracking_no, bl_no,
  export_declaration_no, export_official, etd, eta, atd, ata, status, gross_weight_kg, volume_cbm, cartons, created_at)
  on shipments to authenticated;

-- Never to the anonymous role, never the staff-only summary view.
revoke all on order_overview from anon, authenticated;
