-- First admin: run ONCE before creating the user, replacing the email.
-- Then in Supabase → Authentication → Users → "Invite user" (or "Add user") with the same email.
insert into invitations (email, role) values ('marsel@luminaton.com', 'admin');
