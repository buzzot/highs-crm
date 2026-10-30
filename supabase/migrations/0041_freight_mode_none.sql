-- 0041: third freight option on a quotation — "No freight" (the client sees goods only; freight figures stay internal).
-- Run once in the Supabase SQL editor.
alter table quotes drop constraint if exists quotes_freight_mode_check;
alter table quotes add constraint quotes_freight_mode_check check (freight_mode in ('separate', 'included', 'none'));
