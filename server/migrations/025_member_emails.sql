-- Member email addresses, loaded from the Umoja member list (server/src/importMembers.ts).
--
-- umoja_members.email used to exist only together with an Entra account id (migration 006: the match script set both). The member list the
-- DBA loads carries the address first, before anyone has signed in, so an address no longer needs an account id. An address still belongs to
-- ONE member: it is unique. (Display names are never stored: see docs/retention.md.)

ALTER TABLE umoja_members DROP CONSTRAINT umoja_members_email_needs_oid;
CREATE UNIQUE INDEX umoja_members_email_key ON umoja_members (email) WHERE email IS NOT NULL;
