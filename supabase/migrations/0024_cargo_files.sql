-- 0024: internal cargo photos and document drafts (never shown to clients, never printed or emailed)
-- Run this statement on its own in the Supabase SQL editor.
alter type document_kind add value if not exists 'cargo_photo';
alter type document_kind add value if not exists 'cargo_draft';
