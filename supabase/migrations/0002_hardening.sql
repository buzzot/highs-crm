-- 0002: client column security + extras used by the admin app.
-- Clients query through PostgREST with their own JWT (role "authenticated").
-- Row policies already scope them to their org; these column grants make sure
-- they can never read costs, margins, suppliers or internal notes even with a raw API call.
-- Staff pages use the service-role key, which is not affected.

alter table requests add column if not exists ai_brief text;

revoke select on requests from authenticated;
grant select (id, ref, org_id, created_by, title, description, quantity, target_unit_price, target_currency,
  destination_country, destination_city, needed_by, status, created_at, updated_at) on requests to authenticated;

revoke select on quotes from authenticated;
grant select (id, request_id, quantity, sell_currency, unit_price, freight_estimate, duties_estimate, other_costs,
  landed_unit_price, incoterm, lead_time_days, valid_until, status, notes, created_at) on quotes to authenticated;

revoke select on orders from authenticated;
grant select (id, order_no, org_id, request_id, status, currency, subtotal, client_notes, expected_ship_date,
  created_at, updated_at) on orders to authenticated;

revoke select on order_items from authenticated;
grant select (id, order_id, product_id, description, quantity, unit_price, hs_code) on order_items to authenticated;

revoke select on shipments from authenticated;
grant select (id, order_id, mode, incoterm, origin_port, destination_port, container_no, tracking_no, bl_no,
  export_declaration_no, export_official, etd, eta, atd, ata, status, gross_weight_kg, volume_cbm, cartons, created_at)
  on shipments to authenticated;

-- clients may only write the client-editable request fields
revoke update on requests from authenticated;
grant update (title, description, quantity, target_unit_price, target_currency, destination_country, destination_city, needed_by)
  on requests to authenticated;

-- Role and organisation come ONLY from a staff-created invitation, never from user-supplied
-- signup metadata (otherwise anyone able to call auth.signUp could make themselves admin).
-- Also turn OFF "Allow new users to sign up" in Supabase → Authentication → Providers → Email.
create or replace function handle_new_user() returns trigger language plpgsql security definer set search_path = public as $$
declare inv record;
begin
  select * into inv from invitations where lower(email) = lower(new.email) and accepted_at is null order by created_at desc limit 1;
  insert into profiles(id, email, full_name, role, org_id, active)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name', ''),
          coalesce(inv.role, 'client'), inv.org_id, inv.id is not null);
  if inv.id is not null then update invitations set accepted_at = now() where id = inv.id; end if;
  return new;
end $$;
