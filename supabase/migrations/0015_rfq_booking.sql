-- Accepting a freight quote: remember the shipment it created and when the booking confirmation went out.
alter table freight_rfqs add column if not exists shipment_id uuid references shipments(id) on delete set null;
alter table freight_rfqs add column if not exists booking_sent_at timestamptz;
