-- 0025: road transport (truck / auto) as a shipment and forwarder mode
-- Run this statement on its own in the Supabase SQL editor.
alter type shipment_mode add value if not exists 'truck';
