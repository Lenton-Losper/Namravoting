-- Match Umoja members to their Microsoft (Entra) accounts ahead of time, because staff accounts have no employeeId.
-- Only the account's object id (oid) and its lower-cased mail address are stored. NO names (the matching script uses
-- names in memory only). Both columns are nullable: not every member will match.
-- The app role keeps SELECT only on this table (migration 004 granted table-level SELECT, which covers new columns).
ALTER TABLE umoja_members ADD COLUMN entra_oid uuid UNIQUE;
ALTER TABLE umoja_members ADD COLUMN email text;
ALTER TABLE umoja_members ADD CONSTRAINT umoja_members_email_lower CHECK (email IS NULL OR email = lower(email));
-- A mail address only makes sense together with the account it belongs to.
ALTER TABLE umoja_members ADD CONSTRAINT umoja_members_email_needs_oid CHECK (email IS NULL OR entra_oid IS NOT NULL);
