-- 0032: interface / email language. A company has a default (English or Russian); a person can pick their own.
-- Run once in the Supabase SQL editor.
alter table organizations add column if not exists language text not null default 'en' check (language in ('en', 'ru'));
alter table profiles add column if not exists language text check (language in ('en', 'ru'));   -- null = follow the company
