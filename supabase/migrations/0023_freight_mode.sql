-- one switch per quotation: show freight separately, or include it in the unit prices the client sees
alter table quotes add column if not exists freight_mode text not null default 'separate' check (freight_mode in ('separate', 'included'));
grant select (freight_mode) on quotes to authenticated;
